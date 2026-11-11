import { logActivity } from "@/lib/activity";
import { apiErrorResponse, requireApiSession } from "@/lib/api";
import { processDueJobs } from "@/lib/backend";
import { tryAcquireWorkerSlot } from "@/lib/worker-throttle";

// Security review (Phase 3): this endpoint is available to any approved user
// because it only asks the shared worker to claim globally due jobs. It never
// returns another user's post data, and the claim query itself enforces each
// owner's account state (`social_media_account_is_active`). A short per-user
// cooldown prevents request flooding; real duplicate protection remains the
// database FOR UPDATE SKIP LOCKED claim. Every trigger is audited.
export async function POST() {
  try {
    const session = await requireApiSession();
    const slot = tryAcquireWorkerSlot(session.user.id);
    if (!slot.allowed) {
      return Response.json(
        { error: "The publishing worker was triggered moments ago. Try again shortly." },
        {
          status: 429,
          headers: { "retry-after": String(Math.ceil(slot.retryAfterMs / 1000)) },
        },
      );
    }

    let processed = 0;
    try {
      processed = await processDueJobs();
    } catch (error) {
      await logActivity({
        actorUserId: session.user.id,
        targetUserId: session.user.id,
        action: "worker_run_failed",
        resourceType: "worker",
        metadata: { error: error instanceof Error ? error.message : "unknown" },
      });
      throw error;
    }

    await logActivity({
      actorUserId: session.user.id,
      targetUserId: session.user.id,
      action: "worker_run_requested",
      resourceType: "worker",
      metadata: { processed },
    });
    return Response.json({ processed });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
