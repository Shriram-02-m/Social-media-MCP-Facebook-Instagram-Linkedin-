import { db } from "@/lib/db";
import { activityLog } from "@/lib/db/schema";

// Accepts either the main db handle or a Drizzle transaction client passed
// from callers that must log inside the same commit as the action itself.
export type ActivityLogClient
  = typeof db
    | Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

export interface ActivityLogEntry {
  /** Who performed the action (admin user id, or the user themself). */
  actorUserId?: string | undefined;
  /** Whose application data was affected, when the actor is an admin. */
  targetUserId?: string | undefined;
  action: string;
  resourceType: string;
  resourceId?: string | undefined;
  /** Non-sensitive context only. Never passwords, tokens, secrets, or keys. */
  metadata?: Record<string, unknown> | undefined;
}

// Defense-in-depth for activity logging: every caller passes non-sensitive
// metadata, but a stray credential-bearing object must never reach the log.
const FORBIDDEN_META_KEYS
  = /^(passw(or)?d|token|access_?token|refresh_?token|secret|client_?secret|encryption_?key|api_?key|authorization)$/i;

export function sanitizeActivityMetadata(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]";
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeActivityMetadata(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_META_KEYS.test(key)) continue;
      output[key] = sanitizeActivityMetadata(item, depth + 1);
    }
    return output;
  }
  if (typeof value === "string" && value.length > 2000) return value.slice(0, 2000);
  return value;
}

// Best-effort audit write. The optional `client` parameter accepts a Drizzle
// transaction so critical admin operations can log inside the same commit.
// Activity logging never throws and never aborts the operation it describes;
// failures are reported to the server logs only.
export async function logActivity(
  entry: ActivityLogEntry,
  client: ActivityLogClient = db,
): Promise<void> {
  try {
    await client.insert(activityLog).values({
      actorUserId: entry.actorUserId ?? null,
      targetUserId: entry.targetUserId ?? null,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId ?? null,
      metadata: JSON.stringify(sanitizeActivityMetadata(entry.metadata ?? {})),
    });
  } catch (error) {
    console.error("[activity] failed to write activity log entry:", error instanceof Error ? error.message : error);
  }
}
