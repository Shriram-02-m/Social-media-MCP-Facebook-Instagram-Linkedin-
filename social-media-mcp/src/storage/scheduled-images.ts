import { randomBytes } from "node:crypto";
import { config } from "../config/env.js";
import type { ScheduledImageValidation } from "../utils/scheduled-image.js";

export interface StoredImage {
  bytes: Buffer;
  contentType: string;
}

const allowedTypes = new Set(["image/jpeg", "image/png", "image/gif"]);

function matchesSignature(bytes: Uint8Array, mimeType: string): boolean {
  if (mimeType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === "image/png") {
    return bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e
      && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
  }
  return mimeType === "image/gif" && bytes.length >= 6
    && /^GIF8[79]a$/.test(String.fromCharCode(...bytes.subarray(0, 6)));
}

async function readBounded(response: Response): Promise<Buffer> {
  if (!response.body) throw new Error("Image endpoint returned an empty response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > config.scheduleImageMaxBytes) {
        await reader.cancel();
        throw new Error("Image endpoint exceeds SCHEDULE_IMAGE_MAX_BYTES.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), length);
}

function storageUrl(path = ""): string {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `${config.supabaseUrl}/storage/v1/object/${encodedPath}`;
}

function storageHeaders(contentType?: string): HeadersInit {
  return {
    apikey: config.supabaseServiceRoleKey,
    authorization: `Bearer ${config.supabaseServiceRoleKey}`,
    ...(contentType ? { "content-type": contentType } : {}),
  };
}

async function responseError(response: Response): Promise<never> {
  await response.body?.cancel();
  throw new Error(`Supabase Storage request failed with HTTP ${response.status}.`);
}

export async function uploadScheduledImage(
  bytes: Buffer,
  contentType: string,
  extension: string,
): Promise<string> {
  if (!allowedTypes.has(contentType)) throw new Error(`Unsupported scheduled image MIME type: ${contentType}.`);
  if (bytes.byteLength === 0 || bytes.byteLength > config.scheduleImageMaxBytes) {
    throw new Error("Scheduled image is empty or exceeds SCHEDULE_IMAGE_MAX_BYTES.");
  }
  if (!matchesSignature(bytes, contentType)) throw new Error(`Selected image data does not match ${contentType}.`);
  const objectPath = `scheduled/${randomBytes(24).toString("hex")}${extension}`;
  const imageBody = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(imageBody).set(bytes);
  const url = storageUrl(`${config.supabaseStorageBucket}/${objectPath}`);
  for (let attempt = 1; attempt <= config.scheduleImageMaxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { ...storageHeaders(contentType), "x-upsert": "true" },
        body: imageBody,
        signal: AbortSignal.timeout(config.scheduleImageTimeoutMs),
      });
      if (response.ok) return objectPath;
      const retryable = [408, 425, 429].includes(response.status) || response.status >= 500;
      const status = response.status;
      await response.body?.cancel();
      if (!retryable || attempt === config.scheduleImageMaxAttempts) {
        throw new Error(`Supabase Storage image upload failed with HTTP ${status}.`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown Storage upload error.";
      const retryable = error instanceof TypeError
        || (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name));
      if (!retryable || attempt === config.scheduleImageMaxAttempts) {
        throw new Error(`Supabase Storage image upload failed after ${attempt} attempt(s): ${message}`);
      }
    }
    const delayMs = Math.min(
      config.scheduleImageRetryBaseDelayMs * 2 ** (attempt - 1),
      config.scheduleImageRetryMaxDelayMs,
    );
    console.warn(JSON.stringify({
      event: "scheduled_image_storage_upload_retry",
      retryCount: attempt,
      delayMs,
    }));
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error("Supabase Storage image upload retry loop ended unexpectedly.");
}

export async function deleteScheduledImage(objectPath: string): Promise<void> {
  const response = await fetch(storageUrl(`${config.supabaseStorageBucket}/${objectPath}`), {
    method: "DELETE",
    headers: storageHeaders(),
    signal: AbortSignal.timeout(config.scheduleImageTimeoutMs),
  });
  if (!response.ok) await responseError(response);
}

export async function downloadScheduledImage(objectPath: string): Promise<StoredImage> {
  const response = await fetch(storageUrl(`${config.supabaseStorageBucket}/${objectPath}`), {
    headers: storageHeaders(),
    signal: AbortSignal.timeout(config.scheduleImageTimeoutMs),
  });
  if (!response.ok) await responseError(response);
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (!allowedTypes.has(contentType)) throw new Error(`Stored image has invalid MIME type: ${contentType || "missing"}.`);
  if (declaredLength > config.scheduleImageMaxBytes) throw new Error("Stored image exceeds SCHEDULE_IMAGE_MAX_BYTES.");
  const bytes = await readBounded(response);
  if (bytes.byteLength === 0 || bytes.byteLength > config.scheduleImageMaxBytes) {
    throw new Error("Stored image is empty or exceeds SCHEDULE_IMAGE_MAX_BYTES.");
  }
  if (!matchesSignature(bytes, contentType)) throw new Error(`Stored image data does not match ${contentType}.`);
  return { bytes, contentType };
}

export async function createScheduledImageUrl(objectPath: string): Promise<string> {
  const response = await fetch(storageUrl(`sign/${config.supabaseStorageBucket}/${objectPath}`), {
    method: "POST",
    headers: { ...storageHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ expiresIn: 3600 }),
    signal: AbortSignal.timeout(config.scheduleImageTimeoutMs),
  });
  if (!response.ok) await responseError(response);
  const result = await response.json() as { signedURL?: string };
  if (!result.signedURL) throw new Error("Supabase Storage did not return a signed image URL.");
  return new URL(result.signedURL, `${config.supabaseUrl}/storage/v1/`).toString();
}

export async function validatePublicImageUrl(url: string, expectedType: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(config.scheduleImageTimeoutMs) });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error("Signed public image URL validation timed out.");
    }
    throw new Error("Signed public image URL is not reachable.");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Signed public image URL returned HTTP ${response.status}.`);
  }
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!allowedTypes.has(contentType) || contentType !== expectedType) {
    await response.body?.cancel();
    throw new Error(`Signed public image URL returned invalid MIME type: ${contentType || "missing"}.`);
  }
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (declaredLength > config.scheduleImageMaxBytes) {
    await response.body?.cancel();
    throw new Error("Signed public image URL exceeds SCHEDULE_IMAGE_MAX_BYTES.");
  }
  const bytes = await readBounded(response);
  if (!bytes.byteLength || bytes.byteLength > config.scheduleImageMaxBytes) {
    throw new Error("Signed public image URL returned empty or oversized data.");
  }
  if (!matchesSignature(bytes, contentType)) throw new Error(`Signed public image URL did not contain valid ${contentType} data.`);
}

export async function validateStoredImage(
  objectPath: string,
  checkPublic: boolean,
): Promise<ScheduledImageValidation> {
  const checkedAt = new Date().toISOString();
  try {
    const image = await downloadScheduledImage(objectPath);
    const local = { valid: true, contentType: image.contentType, bytes: image.bytes.byteLength };
    if (!checkPublic) return { valid: true, checkedAt, local, retryable: false };
    const imageUrl = await createScheduledImageUrl(objectPath);
    try {
      await validatePublicImageUrl(imageUrl, image.contentType);
      return {
        valid: true,
        checkedAt,
        local,
        public: { valid: true, contentType: image.contentType, bytes: image.bytes.byteLength },
        retryable: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Signed public image URL validation failed.";
      const retryable = /timed out|not reachable|fetch failed|connection|HTTP (408|425|429|5\d\d)/i.test(message);
      const publicResult = { valid: false, error: message, retryable };
      return { valid: false, checkedAt, local, public: publicResult, error: message, retryable };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Stored image validation failed.";
    const retryable = /timed out|not reachable|fetch failed|connection|HTTP (408|425|429|5\d\d)/i.test(message);
    const local = { valid: false, error: message, retryable };
    return { valid: false, checkedAt, local, error: message, retryable };
  }
}
