import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { oauthMetadataResponse, type AuthMetadataOptions } from "@modelcontextprotocol/server";
import { closeDatabasePool } from "./database.js";
import { config } from "./config/env.js";
import { handleOAuthCallback } from "./auth/oauth-callback.js";
import { isOAuthCallbackPath } from "./auth/oauth-sessions.js";
import {
  McpOAuthError,
  authenticateMcpClient,
  exchangeMcpAuthorizationCode,
  getMcpClient,
  isRegisteredMcpRedirectUri,
  mcpAuthorizationServerMetadata,
  refreshMcpTokens,
  registerMcpClient,
  revokeMcpToken,
  validateMcpAuthorizationRequest,
} from "./auth/mcp-oauth.js";
import { mcpAuthGate, mcpHandler } from "./mcp/handler.js";
import { HttpBodyTooLargeError, sendWebResponse, toWebRequest } from "./mcp/http-adapter.js";
import { mediaUploadBodyLimit, mediaUploadResponse } from "./media/upload-endpoint.js";
import { processDueJobs } from "./scheduler.js";

let activeWorkerRun: Promise<void> | undefined;

const mcpUrl = new URL(config.mcpPublicUrl);
const authMetadataOptions: AuthMetadataOptions = {
  oauthMetadata: mcpAuthorizationServerMetadata(),
  resourceServerUrl: mcpUrl,
  scopesSupported: [config.mcpOauthScope],
  resourceName: "Social Media MCP",
};

const authorizationKeys = [
  "client_id",
  "redirect_uri",
  "response_type",
  "state",
  "code_challenge",
  "code_challenge_method",
  "scope",
  "resource",
] as const;

function respond(
  response: ServerResponse,
  status: number,
  value: Record<string, unknown>,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(value));
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function html(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    "x-content-type-options": "nosniff",
  });
  response.end(`<!doctype html><html><head><meta charset="utf-8"><title>Social Media MCP</title></head><body><p>${escapeHtml(message)}</p></body></html>`);
}

function redirect(response: ServerResponse, location: URL): void {
  response.writeHead(302, {
    location: location.toString(),
    "cache-control": "no-store",
  });
  response.end();
}

function methodNotAllowed(response: ServerResponse, allow: string): void {
  response.writeHead(405, {
    allow,
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify({ error: "Method not allowed." }));
}

function oauthErrorResponse(response: ServerResponse, error: McpOAuthError): void {
  respond(
    response,
    error.status,
    { error: error.code, error_description: error.message },
    {
      pragma: "no-cache",
      ...(error.code === "invalid_client" ? { "www-authenticate": 'Basic realm="mcp"' } : {}),
    },
  );
}

export function isWorkerTriggerAuthorized(authorization: string | undefined, secret: string): boolean {
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(authorization ?? "");
  return expected.byteLength >= 33 && actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown worker error.";
  return message
    .replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, "[database URL redacted]")
    .replace(/(client_secret|access_token|refresh_token|authorization_code|code)=([^&\s]+)/gi, "$1=[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .slice(0, 500);
}

function validateWorkerConfiguration(): void {
  if (!config.databaseUrl) throw new Error("Cloud worker requires DATABASE_URL.");
  if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
    throw new Error("Cloud worker requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  }
  if (config.tokenStoreBackend !== "supabase" || config.scheduledImageStorage !== "supabase") {
    throw new Error("Cloud worker requires TOKEN_STORE_BACKEND=supabase and SCHEDULED_IMAGE_STORAGE=supabase.");
  }
  if (!config.cloudTokenEncryptionKey || !/^[0-9a-fA-F]{64}$/.test(config.cloudTokenEncryptionKey)) {
    throw new Error("Cloud worker requires a 64-character hex CLOUD_TOKEN_ENCRYPTION_KEY.");
  }
  if (config.schedulerMode !== "cloud") {
    throw new Error("Cloud worker requires SCHEDULER_MODE=cloud so no local timer is started.");
  }
  if (Buffer.byteLength(config.workerTriggerSecret) < 32) {
    throw new Error("WORKER_TRIGGER_SECRET must contain at least 32 characters.");
  }
  if (config.oauthCallbackMode !== "cloud") {
    throw new Error("Cloud worker requires OAUTH_CALLBACK_MODE=cloud for remote MCP OAuth.");
  }
  if (!config.oauthFrontendBaseUrl) {
    throw new Error("Cloud worker requires OAUTH_FRONTEND_BASE_URL for the MCP consent screen.");
  }
  if (!config.mcpPublicUrl.startsWith("https://")) {
    throw new Error("Cloud worker requires an HTTPS MCP_PUBLIC_URL.");
  }
}

async function readWebRequest(
  request: IncomingMessage,
  maxBytes: number,
): Promise<Request> {
  return toWebRequest(request, config.mcpPublicUrl, maxBytes);
}

function formValue(form: FormData, key: string): string | undefined {
  const value = form.get(key);
  return typeof value === "string" ? value : undefined;
}

async function handleRegister(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== "POST") {
    request.resume();
    methodNotAllowed(response, "POST");
    return;
  }
  const webRequest = await readWebRequest(request, 32 * 1024);
  let body: unknown;
  try {
    body = await webRequest.json();
  } catch {
    throw new McpOAuthError("invalid_client_metadata", "Dynamic client registration requires a JSON body.");
  }
  const client = await registerMcpClient(body);
  respond(response, 201, client as unknown as Record<string, unknown>, { pragma: "no-cache" });
}

async function handleAuthorize(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== "GET") {
    request.resume();
    methodNotAllowed(response, "GET");
    return;
  }
  const url = new URL(request.url ?? "/", config.mcpPublicUrl);
  const params = url.searchParams;
  const clientId = params.get("client_id");
  const redirectUri = params.get("redirect_uri");
  const state = params.get("state");
  if (!clientId || !redirectUri) {
    html(response, 400, "The authorization request is missing client_id or redirect_uri.");
    return;
  }
  const client = await getMcpClient(clientId);
  if (!client) {
    html(response, 400, "Unknown OAuth client.");
    return;
  }
  if (!isRegisteredMcpRedirectUri(client, redirectUri)) {
    html(response, 400, "The redirect_uri is not registered for this client.");
    return;
  }

  const redirectError = (code: string, description: string): void => {
    const target = new URL(redirectUri);
    target.searchParams.set("error", code);
    target.searchParams.set("error_description", description);
    if (state) target.searchParams.set("state", state);
    redirect(response, target);
  };

  if (params.get("response_type") !== "code") {
    redirectError("unsupported_response_type", "Only response_type=code is supported.");
    return;
  }
  if (params.get("code_challenge_method") !== "S256") {
    redirectError("invalid_request", "PKCE code_challenge_method must be S256.");
    return;
  }
  let validated;
  try {
    validated = await validateMcpAuthorizationRequest({
      clientId,
      redirectUri,
      responseType: "code",
      ...(params.get("scope") !== null ? { scope: params.get("scope")! } : {}),
      ...(params.get("resource") !== null ? { resource: params.get("resource")! } : {}),
      ...(params.get("code_challenge") !== null ? { codeChallenge: params.get("code_challenge")! } : {}),
      codeChallengeMethod: "S256",
    });
  } catch (error) {
    if (error instanceof McpOAuthError) {
      redirectError(error.code, error.message);
      return;
    }
    throw error;
  }
  if (!config.oauthFrontendBaseUrl) {
    html(response, 500, "OAUTH_FRONTEND_BASE_URL is not configured on the worker.");
    return;
  }
  const target = new URL("/mcp/authorize", config.oauthFrontendBaseUrl);
  for (const key of authorizationKeys) {
    const value = params.get(key);
    if (value !== null) target.searchParams.set(key, value);
  }
  target.searchParams.set("scope", validated.scope);
  target.searchParams.set("resource", validated.resource);
  redirect(response, target);
}

async function handleToken(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== "POST") {
    request.resume();
    methodNotAllowed(response, "POST");
    return;
  }
  const webRequest = await readWebRequest(request, 32 * 1024);
  const contentType = webRequest.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/x-www-form-urlencoded")) {
    throw new McpOAuthError("invalid_request", "Token requests must use application/x-www-form-urlencoded.");
  }
  const form = await webRequest.formData();
  const clientId = formValue(form, "client_id");
  const clientSecret = formValue(form, "client_secret");
  const authorizationHeader = request.headers.authorization;
  const client = await authenticateMcpClient({
    ...(authorizationHeader ? { authorizationHeader } : {}),
    ...(clientId !== undefined ? { clientId } : {}),
    ...(clientSecret !== undefined ? { clientSecret } : {}),
  });
  const grantType = formValue(form, "grant_type");
  if (grantType === "authorization_code") {
    const code = formValue(form, "code");
    const redirectUri = formValue(form, "redirect_uri");
    const codeVerifier = formValue(form, "code_verifier");
    const resource = formValue(form, "resource");
    const tokens = await exchangeMcpAuthorizationCode(client, {
      ...(code !== undefined ? { code } : {}),
      ...(redirectUri !== undefined ? { redirectUri } : {}),
      ...(codeVerifier !== undefined ? { codeVerifier } : {}),
      ...(resource !== undefined ? { resource } : {}),
    });
    respond(response, 200, tokens as unknown as Record<string, unknown>, { pragma: "no-cache" });
    return;
  }
  if (grantType === "refresh_token") {
    const tokens = await refreshMcpTokens(client, formValue(form, "refresh_token") ?? "");
    respond(response, 200, tokens as unknown as Record<string, unknown>, { pragma: "no-cache" });
    return;
  }
  throw new McpOAuthError("unsupported_grant_type", "Only authorization_code and refresh_token are supported.");
}

async function handleRevoke(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== "POST") {
    request.resume();
    methodNotAllowed(response, "POST");
    return;
  }
  const webRequest = await readWebRequest(request, 16 * 1024);
  const contentType = webRequest.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/x-www-form-urlencoded")) {
    throw new McpOAuthError("invalid_request", "Revocation requests must use application/x-www-form-urlencoded.");
  }
  const form = await webRequest.formData();
  const clientId = formValue(form, "client_id");
  const clientSecret = formValue(form, "client_secret");
  const authorizationHeader = request.headers.authorization;
  const client = await authenticateMcpClient({
    ...(authorizationHeader ? { authorizationHeader } : {}),
    ...(clientId !== undefined ? { clientId } : {}),
    ...(clientSecret !== undefined ? { clientSecret } : {}),
  });
  await revokeMcpToken(client, formValue(form, "token") ?? "");
  response.writeHead(200, { "cache-control": "no-store", pragma: "no-cache" });
  response.end();
}

async function handleWellKnown(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS") {
    request.resume();
    methodNotAllowed(response, "GET, HEAD, OPTIONS");
    return;
  }
  const webRequest = await readWebRequest(request, 0);
  const metadata = oauthMetadataResponse(webRequest, authMetadataOptions);
  if (!metadata) {
    respond(response, 404, { error: "Not found." });
    return;
  }
  await sendWebResponse(response, metadata);
}

async function handleMcp(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method === "OPTIONS") {
    request.resume();
    response.writeHead(204, {
      allow: "POST, GET, DELETE, OPTIONS",
      "cache-control": "no-store",
    });
    response.end();
    return;
  }
  if (request.method !== "POST" && request.method !== "GET" && request.method !== "DELETE") {
    request.resume();
    methodNotAllowed(response, "POST, GET, DELETE, OPTIONS");
    return;
  }
  const webRequest = await readWebRequest(request, 4 * 1024 * 1024);
  const auth = await mcpAuthGate(webRequest);
  if (auth instanceof Response) {
    await sendWebResponse(response, auth);
    return;
  }
  const mcpResponse = await mcpHandler.fetch(webRequest, { authInfo: auth });
  await sendWebResponse(response, mcpResponse);
}

async function handleWorkerRun(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== "POST") {
    request.resume();
    methodNotAllowed(response, "POST");
    return;
  }
  if (Number(request.headers["content-length"] ?? "0") > 1024) {
    request.resume();
    respond(response, 413, { error: "Request body is too large." });
    return;
  }
  if (!isWorkerTriggerAuthorized(request.headers.authorization, config.workerTriggerSecret)) {
    request.resume();
    respond(response, 401, { error: "Unauthorized." });
    return;
  }
  request.resume();
  if (activeWorkerRun) {
    respond(response, 202, { accepted: true, state: "already_running" });
    return;
  }
  const runId = randomUUID();
  activeWorkerRun = (async () => {
    console.info(JSON.stringify({ event: "cloud_worker_run_started", runId }));
    try {
      const processed = await processDueJobs();
      console.info(JSON.stringify({ event: "cloud_worker_run_completed", runId, processed }));
    } catch (error) {
      console.error(JSON.stringify({
        event: "cloud_worker_run_failed",
        runId,
        error: safeError(error),
      }));
    } finally {
      activeWorkerRun = undefined;
    }
  })();
  respond(response, 202, { accepted: true, runId });
}

async function handleMediaUpload(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== "POST") {
    request.resume();
    methodNotAllowed(response, "POST");
    return;
  }
  const webRequest = await readWebRequest(request, mediaUploadBodyLimit);
  const webResponse = await mediaUploadResponse(webRequest);
  await sendWebResponse(response, webResponse);
}

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  if (request.method === "GET" && pathname === "/health") {
    respond(response, 200, { status: "ok" });
    return;
  }
  if (request.method === "GET" && isOAuthCallbackPath(request.url)) {
    await handleOAuthCallback(request, response);
    return;
  }
  if (pathname.startsWith("/.well-known/")) {
    await handleWellKnown(request, response);
    return;
  }
  if (pathname === "/oauth/register") {
    await handleRegister(request, response);
    return;
  }
  if (pathname === "/oauth/authorize") {
    await handleAuthorize(request, response);
    return;
  }
  if (pathname === "/oauth/token") {
    await handleToken(request, response);
    return;
  }
  if (pathname === "/oauth/revoke") {
    await handleRevoke(request, response);
    return;
  }
  if (pathname === "/mcp" || pathname === "/mcp/") {
    await handleMcp(request, response);
    return;
  }
  if (pathname === "/worker/run") {
    await handleWorkerRun(request, response);
    return;
  }
  if (pathname === "/media/upload" || pathname === "/media/upload/") {
    await handleMediaUpload(request, response);
    return;
  }
  request.resume();
  respond(response, 404, { error: "Not found." });
}

export function startWorkerServer(): ReturnType<typeof createServer> {
  validateWorkerConfiguration();
  const server = createServer((request, response) => {
    void route(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.end();
        return;
      }
      if (error instanceof HttpBodyTooLargeError) {
        respond(response, 413, { error: "Request body is too large." });
        return;
      }
      if (error instanceof McpOAuthError) {
        oauthErrorResponse(response, error);
        return;
      }
      console.error(JSON.stringify({
        event: "cloud_worker_request_failed",
        error: safeError(error),
      }));
      respond(response, 500, { error: "Internal server error." });
    });
  });
  server.listen(config.workerPort, "0.0.0.0", () => {
    console.info(JSON.stringify({ event: "cloud_worker_listening", port: config.workerPort }));
  });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const server = startWorkerServer();
  const shutdown = () => {
    server.close(() => {
      void Promise.resolve(activeWorkerRun)
        .then(() => closeDatabasePool())
        .finally(() => process.exit(0));
    });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
