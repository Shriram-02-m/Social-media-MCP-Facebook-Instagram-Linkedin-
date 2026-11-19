import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { withDatabaseRecovery } from "@/lib/db";
import {
  databaseErrorCategory,
  databaseErrorCode,
  isCapacityError,
  isConnectionError,
  recordDatabaseError,
  redactDatabaseError,
  retryDelayMs,
} from "@/lib/db/diagnostics";

describe("database diagnostics", () => {
  it("classifies wrapped connection errors without misclassifying query failures", () => {
    const socketError = Object.assign(new Error("Connection terminated unexpectedly"), {
      code: "ECONNRESET",
    });
    const wrapped = new Error("adapter failure", { cause: socketError });
    const queryError = new Error('column "x" does not exist');

    expect(isConnectionError(socketError)).toBe(true);
    expect(isConnectionError(wrapped)).toBe(true);
    expect(isConnectionError(new Error("timeout exceeded when trying to connect"))).toBe(true);
    expect(databaseErrorCategory(wrapped)).toBe("connection");
    expect(databaseErrorCode(wrapped)).toBe("ECONNRESET");

    expect(databaseErrorCategory(queryError)).toBe("query");
    expect(databaseErrorCategory("unknown failure")).toBe("unknown");
  });

  it("classifies Supavisor/PostgreSQL capacity limits without treating them as transient", () => {
    const sessionCap = Object.assign(new Error(
      "max clients reached in session mode - max clients are limited to pool_size: 10",
    ), { code: "EMAXCONNSESSION" });
    const transactionCap = Object.assign(new Error("max client connections reached, limit: 100"), {
      code: "EMAXCONN",
    });
    const postgresCap = Object.assign(new Error("sorry, too many clients already"), {
      code: "53300",
    });
    const wrapped = new Error("adapter failure", { cause: sessionCap });

    for (const error of [sessionCap, transactionCap, postgresCap, wrapped]) {
      expect(isCapacityError(error)).toBe(true);
      expect(databaseErrorCategory(error)).toBe("capacity");
      // Capacity must not be classified as a retryable socket failure.
      expect(isConnectionError(error)).toBe(false);
    }
    expect(databaseErrorCode(wrapped)).toBe("EMAXCONNSESSION");
  });

  it("redacts database URLs from free-form error text", () => {
    const redacted = redactDatabaseError(
      'connect postgresql://user:secret@db.example.com:5432/app failed for token=abc',
    );
    expect(redacted).not.toContain("secret");
    expect(redacted).not.toContain("db.example.com");
    expect(redacted).toContain("[database URL redacted]");
  });

  it("uses exponential backoff with bounded jitter", () => {
    expect(retryDelayMs(1, () => 0)).toBe(60);
    expect(retryDelayMs(1, () => 1)).toBe(100);
    expect(retryDelayMs(2, () => 0.5)).toBe(160);
    expect(retryDelayMs(10, () => 0)).toBe(300);
    expect(retryDelayMs(10, () => 1)).toBe(500);
  });
});

describe("withDatabaseRecovery", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  function loggedEvents(): Array<Record<string, unknown>> {
    return consoleError.mock.calls
      .map(([line]) => {
        try {
          return JSON.parse(String(line)) as Record<string, unknown>;
        } catch {
          return {};
        }
      })
      .filter((event) => typeof event.event === "string");
  }

  it("returns the first successful result without touching the pool", async () => {
    const operation = vi.fn().mockResolvedValue("ok");
    const recover = vi.fn().mockResolvedValue(true);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(withDatabaseRecovery(operation, {
      operation: "test.read",
      correlationId: "corr-ok",
      recover,
      sleep,
    })).resolves.toBe("ok");

    expect(operation).toHaveBeenCalledTimes(1);
    expect(recover).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
    expect(loggedEvents()).toHaveLength(0);
  });

  it("retries once with backoff when Better Auth captured a connection error", async () => {
    const opaqueError = Object.assign(new Error("Failed to get session"), {
      body: { code: "FAILED_TO_GET_SESSION" },
    });
    const socketError = Object.assign(new Error("Connection terminated unexpectedly"), {
      code: "ECONNRESET",
    });
    const operation = vi.fn()
      .mockImplementationOnce(async () => {
        // Better Auth's logger records the real DB error in the active context.
        recordDatabaseError(socketError);
        throw opaqueError;
      })
      .mockResolvedValueOnce("recovered");
    const recover = vi.fn().mockResolvedValue(true);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(withDatabaseRecovery(operation, {
      operation: "auth.get_session",
      correlationId: "corr-transient",
      recover,
      sleep,
    })).resolves.toBe("recovered");

    expect(operation).toHaveBeenCalledTimes(2);
    expect(recover).toHaveBeenCalledWith({
      correlationId: "corr-transient",
      operation: "auth.get_session",
      attempt: 1,
    });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0]?.[0]).toBeGreaterThan(0);

    const failed = loggedEvents().find((event) => event.event === "database_operation_failed");
    expect(failed).toMatchObject({
      correlationId: "corr-transient",
      operation: "auth.get_session",
      attempt: 1,
      maxAttempts: 2,
      category: "connection",
      code: "ECONNRESET",
      retryable: true,
    });
    expect(failed?.pool).toMatchObject({ total: expect.any(Number) });

    const recovery = loggedEvents().find((event) => event.event === "database_recovery_attempt");
    expect(recovery).toMatchObject({
      correlationId: "corr-transient",
      operation: "auth.get_session",
      recovered: true,
    });
  });

  it("does not retry a captured query failure", async () => {
    const queryError = new Error('column "x" does not exist');
    const operation = vi.fn().mockImplementationOnce(async () => {
      recordDatabaseError(queryError);
      throw queryError;
    });
    const recover = vi.fn().mockResolvedValue(true);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(withDatabaseRecovery(operation, {
      operation: "auth.get_session",
      correlationId: "corr-query",
      recover,
      sleep,
    })).rejects.toThrow(queryError);

    expect(operation).toHaveBeenCalledTimes(1);
    expect(recover).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
    expect(loggedEvents().find((event) => event.event === "database_operation_failed"))
      .toMatchObject({ category: "query", retryable: false });
  });

  it("never retries pool-capacity exhaustion", async () => {
    const capacityError = Object.assign(new Error(
      "max clients reached in session mode - max clients are limited to pool_size: 10",
    ), { code: "EMAXCONNSESSION" });
    const operation = vi.fn().mockImplementationOnce(async () => {
      recordDatabaseError(capacityError);
      throw capacityError;
    });
    const recover = vi.fn().mockResolvedValue(true);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(withDatabaseRecovery(operation, {
      operation: "auth.get_session",
      correlationId: "corr-capacity",
      recover,
      sleep,
    })).rejects.toThrow(capacityError);

    expect(operation).toHaveBeenCalledTimes(1);
    expect(recover).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
    expect(loggedEvents().find((event) => event.event === "database_operation_failed"))
      .toMatchObject({ category: "capacity", code: "EMAXCONNSESSION", retryable: false });
    expect(loggedEvents().find((event) => event.event === "database_capacity_exhausted"))
      .toMatchObject({ correlationId: "corr-capacity", code: "EMAXCONNSESSION" });
  });

  it("does not retry an opaque session failure when no DB error was captured", async () => {
    // Better Auth uses this path for a falsy session update (e.g. concurrent
    // deletion). It is permanent and must not be treated as an outage.
    const opaqueError = Object.assign(new Error("Failed to get session"), {
      body: { code: "FAILED_TO_GET_SESSION" },
    });
    const operation = vi.fn().mockRejectedValueOnce(opaqueError);
    const recover = vi.fn().mockResolvedValue(true);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(withDatabaseRecovery(operation, {
      operation: "auth.get_session",
      correlationId: "corr-permanent",
      recover,
      sleep,
    })).rejects.toThrow(opaqueError);

    expect(operation).toHaveBeenCalledTimes(1);
    expect(recover).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
    expect(loggedEvents().find((event) => event.event === "database_operation_failed"))
      .toMatchObject({ category: "unknown", retryable: false });
  });

  it("fails closed when pool recovery cannot establish a healthy connection", async () => {
    const socketError = Object.assign(new Error("Connection reset by peer"), {
      code: "ECONNRESET",
    });
    const operation = vi.fn().mockImplementationOnce(async () => {
      recordDatabaseError(socketError);
      throw socketError;
    });
    const recover = vi.fn().mockResolvedValue(false);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(withDatabaseRecovery(operation, {
      operation: "auth.get_session",
      correlationId: "corr-outage",
      recover,
      sleep,
    })).rejects.toThrow(socketError);

    expect(operation).toHaveBeenCalledTimes(1);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(loggedEvents().find((event) => event.event === "database_recovery_attempt"))
      .toMatchObject({ recovered: false, correlationId: "corr-outage" });
  });

  it("bypasses framework control-flow errors entirely", async () => {
    const controlError = Object.assign(new Error("dynamic usage"), {
      name: "NextControlFlowError",
    });
    const operation = vi.fn().mockRejectedValueOnce(controlError);
    const recover = vi.fn().mockResolvedValue(true);

    await expect(withDatabaseRecovery(operation, {
      operation: "auth.get_session",
      correlationId: "corr-framework",
      recover,
      shouldHandleError: (error) => (error as Error)?.name !== "NextControlFlowError",
    })).rejects.toThrow(controlError);

    expect(recover).not.toHaveBeenCalled();
    expect(loggedEvents()).toHaveLength(0);
  });

  it("keeps diagnostics isolated across concurrent requests", async () => {
    const socketError = Object.assign(new Error("Connection reset by peer"), {
      code: "ECONNRESET",
    });
    const failingOperation = vi.fn()
      .mockImplementationOnce(async () => {
        recordDatabaseError(socketError);
        throw socketError;
      })
      .mockResolvedValueOnce("a-recovered");
    const healthyOperation = vi.fn().mockResolvedValue("b");
    const recover = vi.fn().mockResolvedValue(true);
    const sleep = vi.fn().mockResolvedValue(undefined);

    const [first, second] = await Promise.all([
      withDatabaseRecovery(failingOperation, {
        operation: "auth.get_session",
        correlationId: "corr-a",
        recover,
        sleep,
      }),
      withDatabaseRecovery(healthyOperation, {
        operation: "auth.get_session",
        correlationId: "corr-b",
        recover,
        sleep,
      }),
    ]);

    expect([first, second]).toEqual(["a-recovered", "b"]);
    expect(loggedEvents().filter((event) => event.correlationId === "corr-b")).toHaveLength(0);
    expect(loggedEvents().some((event) =>
      event.correlationId === "corr-a"
      && event.event === "database_operation_failed"
      && event.code === "ECONNRESET",
    )).toBe(true);
  });
});
