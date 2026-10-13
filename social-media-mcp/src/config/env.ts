import { fileURLToPath } from "node:url";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config({ path: fileURLToPath(new URL("../../.env", import.meta.url)) });

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
  imagePublicBaseUrl: value("IMAGE_PUBLIC_BASE_URL", value("OAUTH_REDIRECT_BASE_URL", defaultLocalBaseUrl)).replace(/\/+$/, ""),
  imageServerPort,
  scheduleImageTimeoutMs: integer("SCHEDULE_IMAGE_TIMEOUT_MS", "10000", 1),
  scheduleImageMaxBytes: integer("SCHEDULE_IMAGE_MAX_BYTES", "10485760", 1),
  scheduleImageMaxAttempts: integer("SCHEDULE_IMAGE_MAX_ATTEMPTS", "3", 1),
  scheduleImageRetryBaseDelayMs: integer("SCHEDULE_IMAGE_RETRY_BASE_DELAY_MS", "1000", 0),
  scheduleImageRetryMaxDelayMs: integer("SCHEDULE_IMAGE_RETRY_MAX_DELAY_MS", "30000", 0),
  facebookPageId: value("META_FACEBOOK_PAGE_ID"),
  linkedinAuthorUrn: value("LINKEDIN_AUTHOR_URN"),
  databaseUrl: value("DATABASE_URL"),
  tokenEncryptionKey: value("SOCIAL_MCP_TOKEN_ENCRYPTION_KEY"),
  tokenFile: value(
    "SOCIAL_MCP_TOKEN_FILE",
    path.join(process.env["USERPROFILE"] ?? process.env["HOME"] ?? ".", ".social-media-mcp", "tokens.enc"),
  ),
};

if (config.imageServerPort > 65535) {
  throw new Error("IMAGE_SERVER_PORT must be a valid TCP port.");
}

if (config.scheduleImageMaxAttempts > 10) {
  throw new Error("SCHEDULE_IMAGE_MAX_ATTEMPTS must not exceed 10.");
}
if (config.scheduleImageRetryBaseDelayMs > 300000 || config.scheduleImageRetryMaxDelayMs > 300000) {
  throw new Error("Scheduled image retry delays must not exceed 300000 milliseconds.");
}