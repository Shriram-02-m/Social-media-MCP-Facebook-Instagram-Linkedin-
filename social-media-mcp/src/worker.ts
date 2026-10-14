import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { closeDatabasePool } from "./database.js";
import { config } from "./config/env.js";
import { processDueJobs } from "./scheduler.js";

let activeWorkerRun: Promise<void> | undefined;

function respond(response: ServerResponse, status: number, value: Record<string, unknown>): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

export function isWorkerTriggerAuthorized(authorization: string | undefined, secret: string): boolean {
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(authorization ?? "");
  return expected.byteLength >= 33 && actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown worker error.";
  return message
    .replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, "[database URL redacted]")
    .replace(/(client_secret|access_token|refresh_token|authorization_code|code)=([^&\s]+)/gi, "$1=[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .slice(0, 500);
}

function validateWorkerConfiguration(): void {
  if (!config.databaseUrl) throw new Error("Cloud worker requires DATABASE_URL.");
  if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
    throw new Error("Cloud worker requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  }
  if (config.tokenStoreBackend !== "supabase" || config.scheduledImageStorage !== "supabase") {
    throw new Error("Cloud worker requires TOKEN_STORE_BACKEND=supabase and SCHEDULED_IMAGE_STORAGE=supabase.");
  }
  if (!config.cloudTokenEncryptionKey || !/^[0-9a-fA-F]{64}$/.test(config.cloudTokenEncryptionKey)) {
    throw new Error("Cloud worker requires a 64-character hex CLOUD_TOKEN_ENCRYPTION_KEY.");
  }
  if (config.schedulerMode !== "cloud") {
    throw new Error("Cloud worker requires SCHEDULER_MODE=cloud so no local timer is started.");
  }
  if (Buffer.byteLength(config.workerTriggerSecret) < 32) {
    throw new Error("WORKER_TRIGGER_SECRET must contain at least 32 characters.");
  }
}

export function startWorkerServer(): ReturnType<typeof createServer> {
  validateWorkerConfiguration();
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      respond(response, 200, { status: "ok" });
      return;
    }
    if (request.method !== "POST" || request.url !== "/worker/run") {
      respond(response, 404, { error: "Not found." });
      return;
    }
    if (Number(request.headers["content-length"] ?? "0") > 1024) {
      request.resume();
      respond(response, 413, { error: "Request body is too large." });
      return;
    }
    if (!isWorkerTriggerAuthorized(request.headers.authorization, config.workerTriggerSecret)) {
      request.resume();
      respond(response, 401, { error: "Unauthorized." });
      return;
    }
    request.resume();
    if (activeWorkerRun) {
      respond(response, 202, { accepted: true, state: "already_running" });
      return;
    }
    const runId = randomUUID();
    activeWorkerRun = (async () => {
      console.info(JSON.stringify({ event: "cloud_worker_run_started", runId }));
      try {
        const processed = await processDueJobs();
        console.info(JSON.stringify({ event: "cloud_worker_run_completed", runId, processed }));
      } catch (error) {
        console.error(JSON.stringify({
          event: "cloud_worker_run_failed",
          runId,
          error: safeError(error),
        }));
      } finally {
        activeWorkerRun = undefined;
      }
    })();
    respond(response, 202, { accepted: true, runId });
  });
  server.listen(config.workerPort, "0.0.0.0", () => {
    console.info(JSON.stringify({ event: "cloud_worker_listening", port: config.workerPort }));
  });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const server = startWorkerServer();
  const shutdown = () => {
    server.close(() => {
      void Promise.resolve(activeWorkerRun)
        .then(() => closeDatabasePool())
        .finally(() => process.exit(0));
    });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
