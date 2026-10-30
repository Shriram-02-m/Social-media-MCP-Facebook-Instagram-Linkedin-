import { ApiError, apiErrorResponse, requireApiSession } from "@/lib/api";
import {
  config,
  createScheduledImageUrl,
  matchesMediaSignature,
  uploadScheduledDocument,
  uploadScheduledImage,
  uploadScheduledVideo,
} from "@/lib/backend";

export const dynamic = "force-dynamic";

type MediaKind = "image" | "video" | "document";

const contentTypeByExtension: Record<string, { contentType: string; kind: MediaKind }> = {
  "image/jpeg": { contentType: "image/jpeg", kind: "image" },
  "image/png": { contentType: "image/png", kind: "image" },
  "image/gif": { contentType: "image/gif", kind: "image" },
  "video/mp4": { contentType: "video/mp4", kind: "video" },
  "video/quicktime": { contentType: "video/quicktime", kind: "video" },
  "application/pdf": { contentType: "application/pdf", kind: "document" },
};

const extensionByContentType: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "application/pdf": ".pdf",
};

// Authenticated upload bridge for remote MCP clients such as Claude.ai.
//
// The published MCP spec has no client-to-server file-upload primitive, so a
// remote tool receives neither image bytes nor a browser file handle. A
// signed-in user uploads the image/video/PDF here. The file is validated,
// stored under a per-user prefix in the private Supabase bucket, and the
// response contains the *permanent* object path (`storagePath`). Scheduling
// tools persist that path; the worker downloads the object with server-side
// credentials at publish time and only then creates a short-lived signed URL
// for platforms that require one. A `url` is also returned for immediate use,
// but it is never the durable reference.
//
// The Supabase service-role key is read only on the server. It is never placed
// in the response, a client bundle, or a NEXT_PUBLIC_* variable.
export async function POST(request: Request) {
  try {
    const session = await requireApiSession();
    if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
      throw new ApiError(
        "Media upload is not configured on this deployment. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on the server.",
        503,
      );
    }

    const form = await request.formData().catch(() => null);
    if (!form) throw new ApiError("Upload must be multipart/form-data with a 'file' field.");
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      throw new ApiError("Attach a non-empty file in the 'file' field.");
    }

    const mediaType = contentTypeByExtension[file.type];
    const extension = extensionByContentType[file.type];
    if (!mediaType || !extension) {
      throw new ApiError("Only JPEG, PNG, or GIF images, MP4 or MOV videos, and PDF documents are supported.");
    }

    const maxBytes = mediaType.kind === "image"
      ? config.scheduleImageMaxBytes
      : mediaType.kind === "video"
        ? config.scheduleVideoMaxBytes
        : config.scheduleDocumentMaxBytes;
    if (file.size > maxBytes) {
      throw new ApiError(`File exceeds the ${maxBytes}-byte limit for ${mediaType.kind} uploads.`, 413);
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    if (!matchesMediaSignature(bytes, mediaType.contentType)) {
      throw new ApiError("File contents do not match the declared content type.");
    }

    // Namespaced by the authenticated user so one account can never reference
    // another account's object. The scheduler re-validates ownership too.
    const storagePath = mediaType.kind === "image"
      ? await uploadScheduledImage(bytes, mediaType.contentType, extension, session.user.id)
      : mediaType.kind === "video"
        ? await uploadScheduledVideo(bytes, mediaType.contentType, extension, session.user.id)
        : await uploadScheduledDocument(bytes, mediaType.contentType, extension, session.user.id);
    const url = await createScheduledImageUrl(storagePath);

    return Response.json(
      {
        // Permanent reference: pass this as imageStoragePath, media[].storagePath,
        // or documentStoragePath. It never expires.
        storagePath,
        kind: mediaType.kind,
        contentType: mediaType.contentType,
        bytes: bytes.byteLength,
        // Convenience URL for an immediate publish; do not store it for later.
        url,
        expiresInSeconds: config.scheduleSignedUrlTtlSeconds,
        note: "Use storagePath (permanent) when scheduling. The signed url expires and is only for immediate use.",
      },
      { status: 201 },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}