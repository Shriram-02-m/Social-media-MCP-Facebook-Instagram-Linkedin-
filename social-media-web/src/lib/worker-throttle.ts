// Lightweight per-user cooldown for the "Run now" publishing trigger.
//
// The worker itself is already safe under concurrency (database row locks with
// FOR UPDATE SKIP LOCKED and `social_media_account_is_active`). This throttle
// only prevents an authenticated user from hammering the endpoint and creating
// pointless load. It is deliberately in-memory: it is a best-effort UX guard,
// not a security boundary.

const WINDOW_MS = 10_000;
const MAX_TRACKED_USERS = 1000;

const lastRunByUser = new Map<string, number>();

export interface WorkerSlot {
  allowed: boolean;
  retryAfterMs: number;
}

export function tryAcquireWorkerSlot(
  userId: string,
  now: number = Date.now(),
  windowMs: number = WINDOW_MS,
): WorkerSlot {
  const last = lastRunByUser.get(userId);
  if (last !== undefined && now - last < windowMs) {
    return { allowed: false, retryAfterMs: windowMs - (now - last) };
  }
  lastRunByUser.set(userId, now);
  if (lastRunByUser.size > MAX_TRACKED_USERS) {
    const cutoff = now - windowMs;
    for (const [id, timestamp] of lastRunByUser) {
      if (timestamp < cutoff) lastRunByUser.delete(id);
    }
  }
  return { allowed: true, retryAfterMs: 0 };
}

export function resetWorkerThrottleForTests(): void {
  lastRunByUser.clear();
}

export const WORKER_THROTTLE_WINDOW_MS = WINDOW_MS;
