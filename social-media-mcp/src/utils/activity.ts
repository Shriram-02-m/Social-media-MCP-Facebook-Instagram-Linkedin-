import { randomBytes } from "node:crypto";
import { databasePool } from "../database.js";
import { explainError } from "./http.js";

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

// Defense-in-depth: every caller passes non-sensitive metadata, but a stray
// credential-bearing object must never reach activity_log.
const FORBIDDEN_META_KEYS = /^(passw(or)?d|token|access_?token|refresh_?token|secret|client_?secret|encryption_?key|api_?key|authorization)$/i;

function sanitizeMetadata(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeMetadata(item, depth + 1));
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_META_KEYS.test(key)) continue;
      output[key] = sanitizeMetadata(item, depth + 1);
    }
    return output;
  }
  if (typeof value === "string" && value.length > 2000) return value.slice(0, 2000);
  return value;
}

// Best-effort audit write. Publishing, scheduling, and hold/resume flows use
// this so a logging failure (missing table on an unmigrated database, storage
// outage, ...) can never corrupt or abort the critical operation.
export async function recordActivity(entry: ActivityLogEntry): Promise<void> {
  try {
    await databasePool().query(
      `INSERT INTO public.activity_log
         (id, actor_user_id, target_user_id, action, resource_type, resource_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        randomBytes(16).toString("hex"),
        entry.actorUserId ?? null,
        entry.targetUserId ?? null,
        entry.action,
        entry.resourceType,
        entry.resourceId ?? null,
        JSON.stringify(sanitizeMetadata(entry.metadata ?? {})),
      ],
    );
  } catch (error: unknown) {
    console.error(JSON.stringify({
      event: "activity_log_write_failed",
      action: entry.action,
      message: explainError(error),
    }));
  }
}
