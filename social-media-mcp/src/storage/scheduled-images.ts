import { randomBytes } from "node:crypto";
import { config } from "../config/env.js";
import type { ScheduledImageValidation } from "../utils/scheduled-image.js";

export interface StoredImage {
  bytes: Buffer;
  contentType: string;
}

export interface StoredDocumentValidation {
  valid: boolean;
  checkedAt: string;
  contentType?: string;
  bytes?: number;
  error?: string;
  retryable: boolean;
}

const imageTypes = new Set(["image/jpeg", "image/png", "image/gif"]);
const documentTypes = new Set(["application/pdf"]);

export function isPdf(bytes: Uint8Array): boolean {
  return bytes.length >= 5
    && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
}

function matchesSignature(bytes: Uint8Array, mimeType: string): boolean {
  if (mimeType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === "image/png") {
    return bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e
      && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
  }
  if (mimeType === "application/pdf") return isPdf(bytes);
  return mimeType === "image/gif" && bytes.length >= 6
    && /^GIF8[79]a$/.test(String.fromCharCode(...bytes.subarray(0, 6)));
}

async function readBounded(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) throw new Error("Storage endpoint returned an empty response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new Error("Stored object exceeds its configured maximum size.");
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

interface UploadOptions {
  bytes: Buffer;
  contentType: string;
  extension: string;
  kind: "image" | "document";
  allowed: Set<string>;
  maxBytes: number;
}

async function uploadObject({ bytes, contentType, extension, kind, allowed, maxBytes }: UploadOptions): Promise<string> {
  if (!allowed.has(contentType)) throw new Error(`Unsupported scheduled ${kind} MIME type: ${contentType}.`);
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
    throw new Error(`Scheduled ${kind} is empty or exceeds its configured maximum size.`);
  }
  if (!matchesSignature(bytes, contentType)) throw new Error(`Selected ${kind} data does not match ${contentType}.`);
  const objectPath = `scheduled/${randomBytes(24).toString("hex")}${extension}`;
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  const url = storageUrl(`${config.supabaseStorageBucket}/${objectPath}`);
  for (let attempt = 1; attempt <= config.scheduleImageMaxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { ...storageHeaders(contentType), "x-upsert": "true" },
        body,
        signal: AbortSignal.timeout(config.scheduleImageTimeoutMs),
      });
      if (response.ok) return objectPath;
      const retryable = [408, 425, 429].includes(response.status) || response.status >= 500;
      const status = response.status;
      await response.body?.cancel();
      if (!retryable || attempt === config.scheduleImageMaxAttempts) {
        throw new Error(`Supabase Storage ${kind} upload failed with HTTP ${status}.`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown Storage upload error.";
      const retryable = error instanceof TypeError
        || (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name));
      if (!retryable || attempt === config.scheduleImageMaxAttempts) {
        throw new Error(`Supabase Storage ${kind} upload failed after ${attempt} attempt(s): ${message}`);
      }
    }
    const delayMs = Math.min(
      config.scheduleImageRetryBaseDelayMs * 2 ** (attempt - 1),
      config.scheduleImageRetryMaxDelayMs,
    );
    console.warn(JSON.stringify({
      event: `scheduled_${kind}_storage_upload_retry`,
      retryCount: attempt,
      delayMs,
    }));
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`Supabase Storage ${kind} upload retry loop ended unexpectedly.`);
}

export async function uploadScheduledImage(
  bytes: Buffer,
  contentType: string,
  extension: string,
): Promise<string> {
  return uploadObject({
    bytes,
    contentType,
    extension,
    kind: "image",
    allowed: imageTypes,
    maxBytes: config.scheduleImageMaxBytes,
  });
}

export async function uploadScheduledDocument(
  bytes: Buffer,
  contentType: string,
  extension: string,
): Promise<string> {
  return uploadObject({
    bytes,
    contentType,
    extension,
    kind: "document",
    allowed: documentTypes,
    maxBytes: config.scheduleDocumentMaxBytes,
  });
}

async function deleteObject(objectPath: string): Promise<void> {
  const response = await fetch(storageUrl(`${config.supabaseStorageBucket}/${objectPath}`), {
    method: "DELETE",
    headers: storageHeaders(),
    signal: AbortSignal.timeout(config.scheduleImageTimeoutMs),
  });
  if (!response.ok) await responseError(response);
}

export async function deleteScheduledImage(objectPath: string): Promise<void> {
  await deleteObject(objectPath);
}

export async function deleteScheduledDocument(objectPath: string): Promise<void> {
  await deleteObject(objectPath);
}

interface DownloadOptions {
  objectPath: string;
  kind: "image" | "document";
  allowed: Set<string>;
  maxBytes: number;
}

async function downloadObject({ objectPath, kind, allowed, maxBytes }: DownloadOptions): Promise<StoredImage> {
  const response = await fetch(storageUrl(`${config.supabaseStorageBucket}/${objectPath}`), {
    headers: storageHeaders(),
    signal: AbortSignal.timeout(config.scheduleImageTimeoutMs),
  });
  if (!response.ok) await responseError(response);
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (!allowed.has(contentType)) throw new Error(`Stored ${kind} has invalid MIME type: ${contentType || "missing"}.`);
  if (declaredLength > maxBytes) throw new Error(`Stored ${kind} exceeds its configured maximum size.`);
  const bytes = await readBounded(response, maxBytes);
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
    throw new Error(`Stored ${kind} is empty or exceeds its configured maximum size.`);
  }
  if (!matchesSignature(bytes, contentType)) throw new Error(`Stored ${kind} data does not match ${contentType}.`);
  return { bytes, contentType };
}

export async function downloadScheduledImage(objectPath: string): Promise<StoredImage> {
  return downloadObject({
    objectPath,
    kind: "image",
    allowed: imageTypes,
    maxBytes: config.scheduleImageMaxBytes,
  });
}

export async function downloadScheduledDocument(objectPath: string): Promise<StoredImage> {
  return downloadObject({
    objectPath,
    kind: "document",
    allowed: documentTypes,
    maxBytes: config.scheduleDocumentMaxBytes,
  });
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
  if (/^https?:\/\//i.test(result.signedURL)) return result.signedURL;
  const signedPath = result.signedURL.replace(/^\/+/, "");
  const storagePath = signedPath.startsWith("storage/v1/") ? signedPath : `storage/v1/${signedPath}`;
  return new URL(storagePath, `${config.supabaseUrl}/`).toString();
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
  if (!imageTypes.has(contentType) || contentType !== expectedType) {
    await response.body?.cancel();
    throw new Error(`Signed public image URL returned invalid MIME type: ${contentType || "missing"}.`);
  }
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (declaredLength > config.scheduleImageMaxBytes) {
    await response.body?.cancel();
    throw new Error("Signed public image URL exceeds SCHEDULE_IMAGE_MAX_BYTES.");
  }
  const bytes = await readBounded(response, config.scheduleImageMaxBytes);
  if (!bytes.byteLength || bytes.byteLength > config.scheduleImageMaxBytes) {
    throw new Error("Signed public image URL returned empty or oversized data.");
  }
  if (!matchesSignature(bytes, contentType)) throw new Error(`Signed public image URL did not contain valid ${contentType} data.`);
}

function retryableValidationError(message: string): boolean {
  return /timed out|not reachable|fetch failed|connection|HTTP (408|425|429|5\d\d)/i.test(message);
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
      const retryable = retryableValidationError(message);
      const publicResult = { valid: false, error: message, retryable };
      return { valid: false, checkedAt, local, public: publicResult, error: message, retryable };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Stored image validation failed.";
    const retryable = retryableValidationError(message);
    const local = { valid: false, error: message, retryable };
    return { valid: false, checkedAt, local, error: message, retryable };
  }
}

export async function validateStoredDocument(objectPath: string): Promise<StoredDocumentValidation> {
  const checkedAt = new Date().toISOString();
  try {
    const document = await downloadScheduledDocument(objectPath);
    return {
      valid: true,
      checkedAt,
      contentType: document.contentType,
      bytes: document.bytes.byteLength,
      retryable: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Stored document validation failed.";
    return { valid: false, checkedAt, error: message, retryable: retryableValidationError(message) };
  }
}
