import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";

// Directory for local-only state (developer token vault, scheduled-media files).
// `USERPROFILE`/`HOME` are unset inside serverless runtimes; falling back to the
// OS temp directory keeps the path absolute there so local-mode code never
// attempts a relative mkdir like `.social-media-mcp` (ENOENT). Production must
// use the cloud backends (`TOKEN_STORE_BACKEND=supabase` /
// `SCHEDULED_IMAGE_STORAGE=supabase`) instead of this local fallback.
function localStateDirectory(): string {
  const configured = process.env["USERPROFILE"] || process.env["HOME"];
  if (configured) return configured;
  try {
    return os.homedir() || os.tmpdir();
  } catch {
    return os.tmpdir();
  }
}

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.env") });

function value(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

function integer(name: string, fallback: string, minimum: number): number {
  const parsed = Number(value(name, fallback));
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}.`);
  }
  return parsed;
}

const imageServerPort = integer("IMAGE_SERVER_PORT", value("OAUTH_CALLBACK_PORT", "8787"), 1);
const defaultLocalBaseUrl = `http://localhost:${imageServerPort}`;
const databasePoolMax = integer("DATABASE_POOL_MAX", "5", 1);
const databaseConnectionTimeoutMs = integer("DATABASE_CONNECTION_TIMEOUT_MS", "10000", 1);
const databaseIdleTimeoutMs = integer("DATABASE_IDLE_TIMEOUT_MS", "30000", 1);
// Lifetime of a single-use MCP media upload intent and its upload token. It
// only has to outlive a curl upload, not a scheduled post; the returned
// reference is a permanent object path, never an expiring URL.
const mediaUploadIntentTtlSeconds = integer("MCP_UPLOAD_INTENT_TTL_SECONDS", "900", 60);
// Maximum upload intents one authenticated user may request per rolling
// 10-minute window (per cloud-worker process).
const mediaUploadIntentRateLimit = integer("MCP_UPLOAD_INTENT_RATE_LIMIT", "20", 1);
const tokenStoreBackend = value("TOKEN_STORE_BACKEND", "local");
const scheduledImageStorage = value("SCHEDULED_IMAGE_STORAGE", "local");
const schedulerMode = value("SCHEDULER_MODE", "local");
// How browser OAuth callbacks are handled. `local` (default) keeps the
// localhost/ngrok listener and in-memory sessions; `cloud` persists sessions in
// PostgreSQL and receives callbacks on the public worker routes. This is
// independent of SCHEDULER_MODE, TOKEN_STORE_BACKEND, and SCHEDULED_IMAGE_STORAGE.
const oauthCallbackMode = value("OAUTH_CALLBACK_MODE", "local");
// Public Streamable HTTP MCP endpoint exposed by the cloud worker. Remote MCP
// clients (Claude.ai, Claude Code) authenticate against this resource with
// OAuth 2.1, so the value is also the RFC 8707 resource indicator and the
// audience bound into issued access tokens.
const mcpPublicUrl = value(
  "MCP_PUBLIC_URL",
  `${value("OAUTH_REDIRECT_BASE_URL", defaultLocalBaseUrl)}/mcp`,
).replace(/\/+$/, "");

export const config = {
  metaAppId: value("META_APP_ID"),
  metaAppSecret: value("META_APP_SECRET"),
  metaGraphVersion: value("META_GRAPH_API_VERSION", "v25.0"),
  instagramAppId: value("INSTAGRAM_APP_ID"),
  instagramAppSecret: value("INSTAGRAM_APP_SECRET"),
  instagramScopes: ["instagram_business_basic", "instagram_business_content_publish"],
  linkedinClientId: value("LINKEDIN_CLIENT_ID"),
  linkedinClientSecret: value("LINKEDIN_CLIENT_SECRET"),
  linkedinApiVersion: value("LINKEDIN_API_VERSION", "202609"),
  linkedinScopes: value("LINKEDIN_SCOPES", "openid profile w_member_social").split(/\s+/).filter(Boolean),
  redirectBaseUrl: value("OAUTH_REDIRECT_BASE_URL", defaultLocalBaseUrl).replace(/\/+$/, ""),
  oauthFrontendBaseUrl: value("OAUTH_FRONTEND_BASE_URL").replace(/\/+$/, ""),
  oauthCallbackMode,
  // Remote MCP OAuth settings. The worker is the authorization server and
  // resource server; Vercel only renders consent and creates the one-time code.
  mcpPublicUrl,
  mcpOauthScope: value("MCP_OAUTH_SCOPE", "mcp"),
  mcpAuthorizationCodeTtlSeconds: integer("MCP_AUTHORIZATION_CODE_TTL_SECONDS", "300", 30),
  mcpAccessTokenTtlSeconds: integer("MCP_ACCESS_TOKEN_TTL_SECONDS", "3600", 60),
  mcpRefreshTokenTtlSeconds: integer("MCP_REFRESH_TOKEN_TTL_SECONDS", "2592000", 3600),
  mcpAllowedRedirectOrigins: value(
    "MCP_ALLOWED_REDIRECT_ORIGINS",
    "https://claude.ai,https://claude.com",
  ).split(/[\s,]+/).filter(Boolean),
  mcpAllowLoopbackRedirects: value("MCP_ALLOW_LOOPBACK_REDIRECTS", "true") !== "false",
  imagePublicBaseUrl: value("IMAGE_PUBLIC_BASE_URL", value("OAUTH_REDIRECT_BASE_URL", defaultLocalBaseUrl)).replace(/\/+$/, ""),
  imageServerPort,
  scheduleImageTimeoutMs: integer("SCHEDULE_IMAGE_TIMEOUT_MS", "10000", 1),
  scheduleImageMaxBytes: integer("SCHEDULE_IMAGE_MAX_BYTES", "10485760", 1),
  scheduleDocumentMaxBytes: integer("SCHEDULE_DOCUMENT_MAX_BYTES", "10485760", 1),
  scheduleVideoMaxBytes: integer("SCHEDULE_VIDEO_MAX_BYTES", "52428800", 1),
  scheduleMediaMaxItems: integer("SCHEDULE_MEDIA_MAX_ITEMS", "10", 1),
  scheduleImageMaxAttempts: integer("SCHEDULE_IMAGE_MAX_ATTEMPTS", "3", 1),
  scheduleImageRetryBaseDelayMs: integer("SCHEDULE_IMAGE_RETRY_BASE_DELAY_MS", "1000", 0),
  scheduleImageRetryMaxDelayMs: integer("SCHEDULE_IMAGE_RETRY_MAX_DELAY_MS", "30000", 0),
  // Lifetime of the Supabase Storage signed URL that is generated at publish
  // time (never stored). It only has to outlive the destination platform's
  // fetch of the media; the worker always re-signs a fresh URL from the
  // permanent object path, so this TTL never affects a still-scheduled post.
  scheduleSignedUrlTtlSeconds: integer("SCHEDULE_SIGNED_URL_TTL_SECONDS", "86400", 60),
  mediaUploadIntentTtlSeconds,
  mediaUploadIntentRateLimit,
  facebookPageId: value("META_FACEBOOK_PAGE_ID"),
  linkedinAuthorUrn: value("LINKEDIN_AUTHOR_URN"),
  databaseUrl: value("DATABASE_URL"),
  // Identity used by the single-user stdio MCP server and by rows created before
  // multi-user support existed. The web app always passes the authenticated
  // better-auth user id instead of this fallback.
  ownerUserId: value("MCP_OWNER_USER_ID", "local-owner"),
  databasePoolMax,
  databaseConnectionTimeoutMs,
  databaseIdleTimeoutMs,
  supabaseUrl: value("SUPABASE_URL").replace(/\/+$/, ""),
  supabaseServiceRoleKey: value("SUPABASE_SERVICE_ROLE_KEY"),
  supabaseStorageBucket: "social-media-images",
  tokenStoreBackend,
  cloudTokenEncryptionKey: value("CLOUD_TOKEN_ENCRYPTION_KEY"),
  // Encrypts user-owned Developer App secrets (AES-256-GCM). It is validated on
  // use rather than at startup so a deployment can add the key without breaking
  // existing shared-credential users. Required in every runtime that encrypts or
  // decrypts an app secret (the web API on Vercel and the cloud worker on Render).
  appCredentialEncryptionKey: value("APP_CREDENTIAL_ENCRYPTION_KEY"),
  scheduledImageStorage,
  schedulerMode,
  workerPort: integer("PORT", "10000", 1),
  workerTriggerSecret: value("WORKER_TRIGGER_SECRET"),
  tokenEncryptionKey: value("SOCIAL_MCP_TOKEN_ENCRYPTION_KEY"),
  tokenFile: value(
    "SOCIAL_MCP_TOKEN_FILE",
    path.join(localStateDirectory(), ".social-media-mcp", "tokens.enc"),
  ),
};

if (config.tokenStoreBackend !== "local" && config.tokenStoreBackend !== "supabase") {
  throw new Error("TOKEN_STORE_BACKEND must be either local or supabase.");
}
if (config.scheduledImageStorage !== "local" && config.scheduledImageStorage !== "supabase") {
  throw new Error("SCHEDULED_IMAGE_STORAGE must be either local or supabase.");
}
if (config.schedulerMode !== "local" && config.schedulerMode !== "cloud" && config.schedulerMode !== "disabled") {
  throw new Error("SCHEDULER_MODE must be local, cloud, or disabled.");
}
if (config.oauthCallbackMode !== "local" && config.oauthCallbackMode !== "cloud") {
  throw new Error("OAUTH_CALLBACK_MODE must be either local or cloud.");
}
if (!/^[A-Za-z0-9._:-]{1,64}$/.test(config.mcpOauthScope)) {
  throw new Error("MCP_OAUTH_SCOPE must be a single OAuth scope token.");
}
if (config.mcpAuthorizationCodeTtlSeconds > 3600) {
  throw new Error("MCP_AUTHORIZATION_CODE_TTL_SECONDS must not exceed 3600.");
}
if (config.mcpAccessTokenTtlSeconds > 86400) {
  throw new Error("MCP_ACCESS_TOKEN_TTL_SECONDS must not exceed 86400.");
}
if (config.mcpRefreshTokenTtlSeconds > 31536000) {
  throw new Error("MCP_REFRESH_TOKEN_TTL_SECONDS must not exceed 31536000.");
}
try {
  const mcpUrl = new URL(config.mcpPublicUrl);
  if (mcpUrl.username || mcpUrl.password || mcpUrl.hash) {
    throw new Error("MCP_PUBLIC_URL must not contain credentials or a fragment.");
  }
  const loopback = mcpUrl.hostname === "localhost" || mcpUrl.hostname === "127.0.0.1" || mcpUrl.hostname === "[::1]";
  if (mcpUrl.protocol !== "https:" && !loopback) {
    throw new Error("MCP_PUBLIC_URL must use HTTPS outside localhost.");
  }
} catch (error) {
  if (error instanceof Error && error.message.startsWith("MCP_PUBLIC_URL")) throw error;
  throw new Error("MCP_PUBLIC_URL must be a valid absolute URL.");
}
for (const origin of config.mcpAllowedRedirectOrigins) {
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "https:" || parsed.origin !== origin.replace(/\/+$/, "")) {
      throw new Error();
    }
  } catch {
    throw new Error("MCP_ALLOWED_REDIRECT_ORIGINS entries must be HTTPS origins such as https://claude.ai.");
  }
}
if (config.tokenStoreBackend === "supabase" && (!config.databaseUrl || !config.cloudTokenEncryptionKey)) {
  throw new Error("TOKEN_STORE_BACKEND=supabase requires DATABASE_URL and CLOUD_TOKEN_ENCRYPTION_KEY.");
}
if (config.scheduledImageStorage === "supabase" && (!config.supabaseUrl || !config.supabaseServiceRoleKey)) {
  throw new Error("SCHEDULED_IMAGE_STORAGE=supabase requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
}
if (config.imageServerPort > 65535) {
  throw new Error("IMAGE_SERVER_PORT must be a valid TCP port.");
}
if (config.workerPort > 65535) {
  throw new Error("PORT must be a valid TCP port.");
}

if (config.scheduleImageMaxAttempts > 10) {
  throw new Error("SCHEDULE_IMAGE_MAX_ATTEMPTS must not exceed 10.");
}
if (config.scheduleImageMaxBytes > 10485760) {
  throw new Error("SCHEDULE_IMAGE_MAX_BYTES must not exceed the private Storage bucket's 10 MiB limit.");
}
if (config.scheduleDocumentMaxBytes > 10485760) {
  throw new Error("SCHEDULE_DOCUMENT_MAX_BYTES must not exceed the private Storage bucket's 10 MiB limit.");
}
if (config.scheduleVideoMaxBytes > 52428800) {
  throw new Error("SCHEDULE_VIDEO_MAX_BYTES must not exceed the private Storage bucket's 50 MiB limit.");
}
if (config.scheduleMediaMaxItems > 10) {
  throw new Error("SCHEDULE_MEDIA_MAX_ITEMS must not exceed 10 (the Instagram carousel limit).");
}
if (config.scheduleImageRetryBaseDelayMs > 300000 || config.scheduleImageRetryMaxDelayMs > 300000) {
  throw new Error("Scheduled image retry delays must not exceed 300000 milliseconds.");
}
if (config.scheduleSignedUrlTtlSeconds > 604800) {
  throw new Error("SCHEDULE_SIGNED_URL_TTL_SECONDS must not exceed 604800 (seven days).");
}
if (mediaUploadIntentTtlSeconds > 3600) {
  throw new Error("MCP_UPLOAD_INTENT_TTL_SECONDS must not exceed 3600 (one hour).");
}
if (mediaUploadIntentRateLimit > 200) {
  throw new Error("MCP_UPLOAD_INTENT_RATE_LIMIT must not exceed 200 intents per 10-minute window.");
}