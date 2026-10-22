import path from "node:path";

import { after } from "next/server";
import { z } from "zod";

import { ApiError, apiErrorResponse, requireApiSession } from "@/lib/api";
import {
  processDueJobs,
  scheduleMediaPosts,
  scheduledPostStatus,
  type NewScheduledMedia,
} from "@/lib/backend";

const platformEnum = z.enum(["facebook", "instagram", "linkedin"]);

const imageTypes = new Set(["image/jpeg", "image/png", "image/gif"]);
const videoTypes = new Set(["video/mp4", "video/quicktime"]);

const fallbackExtension: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
};

async function fileToMedia(file: File): Promise<NewScheduledMedia> {
  const contentType = file.type;
  const hasDotExtension = path.extname(file.name).toLowerCase();
  const extension = hasDotExtension || fallbackExtension[contentType] || "";

  let kind: "image" | "video";
  if (imageTypes.has(contentType)) kind = "image";
  else if (videoTypes.has(contentType)) kind = "video";
  else {
    throw new ApiError(
      `Unsupported media type "${contentType || "unknown"}". Use JPEG, PNG, GIF, MP4, or MOV.`,
    );
  }

  return {
    kind,
    bytes: Buffer.from(await file.arrayBuffer()),
    contentType,
    extension,
  };
}

export async function GET() {
  try {
    const session = await requireApiSession();
    const posts = await scheduledPostStatus(session.user.id);
    return Response.json({ posts });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireApiSession();

    const form = await request.formData();

    const platforms = form
      .getAll("platforms")
      .map((value) => String(value).toLowerCase());
    const parsed = z
      .object({
        platforms: z.array(platformEnum).min(1, "Select at least one platform."),
        scheduledAt: z.string().optional(),
        publishNow: z.enum(["true", "false"]).optional(),
        text: z.string().min(1, "Post text is required."),
      })
      .safeParse({
        platforms,
        scheduledAt: form.get("scheduledAt") ? String(form.get("scheduledAt")) : undefined,
        publishNow: form.get("publishNow") ? String(form.get("publishNow")) : "false",
        text: String(form.get("text") ?? ""),
      });

    if (!parsed.success) {
      throw new ApiError(parsed.error.issues[0]?.message ?? "Invalid request.");
    }

    const { publishNow, text } = parsed.data;
    const files = form
      .getAll("media")
      .filter((value): value is File => value instanceof File && value.size > 0);

    const media: NewScheduledMedia[] = [];
    for (const file of files) media.push(await fileToMedia(file));

    const scheduledAt =
      publishNow === "true"
        ? new Date(Date.now() + 5_000).toISOString()
        : parsed.data.scheduledAt;

    if (!scheduledAt) throw new ApiError("Choose a schedule time.");

    let scheduled: Awaited<ReturnType<typeof scheduleMediaPosts>>;
    try {
      scheduled = await scheduleMediaPosts(
        session.user.id,
        parsed.data.platforms.map((platform) => ({ platform, scheduledAt, text })),
        media,
      );
    } catch (error) {
      throw new ApiError(
        error instanceof Error ? error.message : "Could not schedule the post.",
      );
    }

    if (publishNow === "true") {
      after(async () => {
        await new Promise((resolve) => setTimeout(resolve, 6_000));
        try {
          await processDueJobs();
        } catch (error) {
          console.error("[api] immediate publish failed:", error);
        }
      });
    }

    return Response.json({ scheduled }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
