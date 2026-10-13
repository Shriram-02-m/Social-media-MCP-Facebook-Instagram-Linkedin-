import { stat } from "node:fs/promises";
import { config } from "../config/env.js";

const allowedMimeTypes = new Set(["image/jpeg", "image/png", "image/gif"]);
const imageRoute = (token: string) => `/scheduled-media/${token}`;

export interface ImageEndpointValidation {
  valid: boolean;
  status?: number;
  contentType?: string;
  bytes?: number;
  error?: string;
  retryable?: boolean;
}

export interface ScheduledImageValidation {
  valid: boolean;
  checkedAt: string;
  local: ImageEndpointValidation;
  public?: ImageEndpointValidation;
  error?: string;
  retryable: boolean;
}

export interface ScheduledImageValidationOptions {
  imagePath: string;
  imageToken: string;
  contentType: string;
  checkPublic: boolean;
  localBaseUrl?: string;
  publicBaseUrl?: string;
  timeoutMs?: number;
  maxBytes?: number;
  fetcher?: typeof fetch;
}

export class ScheduledImageError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ScheduledImageError";
  }
}

export class ScheduledImageRetryError extends Error {
  constructor(
    public readonly validation: ScheduledImageValidation,
    public readonly attempts: number,
  ) {
    super(`Scheduled image validation failed after ${attempts} attempt(s): ${validation.error ?? "unknown image validation error"}`);
    this.name = "ScheduledImageRetryError";
  }
}

export interface ScheduledImageAttempt {
  validation: ScheduledImageValidation;
  attempt: number;
  retries: number;
  willRetry: boolean;
  delayMs: number;
}

export async function validateScheduledImageWithRetries(
  options: ScheduledImageValidationOptions,
  maxAttempts: number,
  retryBaseDelayMs: number,
  onAttempt: (attempt: ScheduledImageAttempt) => Promise<void> | void,
  retryMaxDelayMs = 30000,
  sleep: (delayMs: number) => Promise<void> = (delayMs) =>
    new Promise((resolve) => setTimeout(resolve, delayMs)),
): Promise<{ validation: ScheduledImageValidation; retries: number }> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const validation = await validateScheduledImage(options);
    const willRetry = !validation.valid && validation.retryable && attempt < maxAttempts;
    const retries = attempt - 1;
    const delayMs = Math.min(retryBaseDelayMs * 2 ** (attempt - 1), retryMaxDelayMs);
    await onAttempt({ validation, attempt, retries, willRetry, delayMs });
    if (validation.valid) return { validation, retries };
    if (!willRetry) throw new ScheduledImageRetryError(validation, attempt);
    await sleep(delayMs);
  }
  throw new Error("Scheduled image retry loop ended unexpectedly.");
}

function matchesImageSignature(bytes: Uint8Array, mimeType: string): boolean {
  if (mimeType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === "image/png") {
    return bytes.length >= 8
      && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
      && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
  }
  return mimeType === "image/gif"
    && bytes.length >= 6
    && String.fromCharCode(...bytes.subarray(0, 6)).match(/^GIF8[79]a$/) !== null;
}

function networkFailure(error: unknown): ScheduledImageError {
  if (error instanceof ScheduledImageError) return error;
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return new ScheduledImageError("Image endpoint request timed out.", true);
  }
  const cause = error instanceof Error ? error.cause : undefined;
  const code = cause && typeof cause === "object" && "code" in cause ? String(cause.code) : "";
  if (code === "ECONNREFUSED") {
    return new ScheduledImageError("Image server connection refused; check IMAGE_SERVER_PORT and ensure the server is running.", true);
  }
  return new ScheduledImageError("Image endpoint request failed; check the local image server and ngrok tunnel.", true);
}

async function readAndValidateResponse(
  response: Response,
  endpoint: string,
  isPublic: boolean,
  expectedMimeType: string,
  maxBytes: number,
): Promise<number> {
  if (response.status !== 200) {
    throw new ScheduledImageError(
      `${endpoint} returned HTTP ${response.status}; check the configured image-server port, route, and ngrok forwarding.`,
      (isPublic && response.status === 404)
        || response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500,
      response.status,
    );
  }

  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!allowedMimeTypes.has(contentType)) {
    throw new ScheduledImageError(`${endpoint} returned an invalid image MIME type (${contentType || "missing"}).`, false, response.status);
  }
  if (contentType !== expectedMimeType) {
    throw new ScheduledImageError(`${endpoint} image MIME type does not match the scheduled image file.`, false, response.status);
  }

  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new ScheduledImageError(`${endpoint} image exceeds the configured ${maxBytes}-byte size limit.`, false, response.status);
  }

  if (!response.body) throw new ScheduledImageError(`${endpoint} returned an empty image response.`, false, response.status);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new ScheduledImageError(`${endpoint} image exceeds the configured ${maxBytes}-byte size limit.`, false, response.status);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (totalBytes === 0) throw new ScheduledImageError(`${endpoint} returned an empty image response.`, false, response.status);

  const signature = new Uint8Array(Math.min(totalBytes, 8));
  let offset = 0;
  for (const chunk of chunks) {
    const copyLength = Math.min(chunk.byteLength, signature.length - offset);
    if (copyLength <= 0) break;
    signature.set(chunk.subarray(0, copyLength), offset);
    offset += copyLength;
  }
  if (!matchesImageSignature(signature, contentType)) {
    throw new ScheduledImageError(`${endpoint} response is not valid ${contentType} image data.`, false, response.status);
  }
  return totalBytes;
}

async function validateEndpoint(
  url: string,
  label: string,
  expectedMimeType: string,
  timeoutMs: number,
  maxBytes: number,
  fetcher: typeof fetch,
): Promise<ImageEndpointValidation> {
  try {
    const response = await fetcher(url, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "image/jpeg,image/png,image/gif" },
    });
    const bytes = await readAndValidateResponse(
      response,
      label,
      label === "Public ngrok image route",
      expectedMimeType,
      maxBytes,
    );
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    return {
      valid: true,
      status: response.status,
      ...(contentType ? { contentType } : {}),
      bytes,
    };
  } catch (error) {
    const failure = networkFailure(error);
    return {
      valid: false,
      ...(failure.status !== undefined ? { status: failure.status } : {}),
      error: failure.message,
      retryable: failure.retryable,
    };
  }
}

export async function validateScheduledImage(
  options: ScheduledImageValidationOptions,
): Promise<ScheduledImageValidation> {
  const {
    imagePath,
    imageToken,
    contentType,
    checkPublic,
    localBaseUrl = `http://127.0.0.1:${config.imageServerPort}`,
    publicBaseUrl = config.imagePublicBaseUrl,
    timeoutMs = config.scheduleImageTimeoutMs,
    maxBytes = config.scheduleImageMaxBytes,
    fetcher = fetch,
  } = options;
  const checkedAt = new Date().toISOString();
  if (!/^[a-f0-9]{64}$/.test(imageToken)) {
    const error = "Scheduled image token is invalid.";
    return { valid: false, checkedAt, local: { valid: false, error, retryable: false }, error, retryable: false };
  }
  if (!allowedMimeTypes.has(contentType)) {
    const error = `Scheduled image MIME type is not allowed (${contentType}).`;
    return { valid: false, checkedAt, local: { valid: false, error, retryable: false }, error, retryable: false };
  }

  try {
    const file = await stat(imagePath);
    if (!file.isFile()) throw new ScheduledImageError("Scheduled image path is not a regular file.", false);
    if (file.size === 0) throw new ScheduledImageError("Scheduled image file is empty.", false);
    if (file.size > maxBytes) throw new ScheduledImageError(`Scheduled image file exceeds the configured ${maxBytes}-byte size limit.`, false);
  } catch (error) {
    const fileErrorCode = error instanceof Error && "code" in error ? error.code : undefined;
    const failure = error instanceof ScheduledImageError
      ? error
      : fileErrorCode === "ENOENT"
        ? new ScheduledImageError("Scheduled image file is missing from local scheduler storage.", false)
        : fileErrorCode === "EACCES" || fileErrorCode === "EPERM" || fileErrorCode === "ENOTDIR"
          ? new ScheduledImageError("Scheduled image file cannot be read from local scheduler storage.", false)
          : networkFailure(error);
    return {
      valid: false,
      checkedAt,
      local: { valid: false, error: failure.message, retryable: failure.retryable },
      error: failure.message,
      retryable: failure.retryable,
    };
  }

  const route = imageRoute(imageToken);
  const local = await validateEndpoint(
    `${localBaseUrl.replace(/\/+$/, "")}${route}`,
    "Local image route",
    contentType,
    timeoutMs,
    maxBytes,
    fetcher,
  );
  if (!local.valid) {
    return {
      valid: false,
      checkedAt,
      local,
      ...(local.error ? { error: local.error } : {}),
      retryable: local.retryable ?? false,
    };
  }

  if (!checkPublic) return { valid: true, checkedAt, local, retryable: false };

  let publicUrl: URL;
  try {
    publicUrl = new URL(`${publicBaseUrl.replace(/\/+$/, "")}${route}`);
  } catch {
    const error = "IMAGE_PUBLIC_BASE_URL is not a valid URL.";
    return { valid: false, checkedAt, local, public: { valid: false, error, retryable: false }, error, retryable: false };
  }
  if (publicUrl.protocol !== "https:") {
    const error = "IMAGE_PUBLIC_BASE_URL must use HTTPS for Meta image publishing.";
    return { valid: false, checkedAt, local, public: { valid: false, error, retryable: false }, error, retryable: false };
  }

  const publicResult = await validateEndpoint(
    publicUrl.toString(),
    "Public ngrok image route",
    contentType,
    timeoutMs,
    maxBytes,
    fetcher,
  );
  return {
    valid: publicResult.valid,
    checkedAt,
    local,
    public: publicResult,
    ...(publicResult.valid ? {} : { error: publicResult.error }),
    retryable: publicResult.retryable ?? false,
  };
}
