import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { apiRequest } from "../utils/http.js";
import { config } from "../config/env.js";
import { loadTokens, saveTokens } from "./token-store.js";
import {
  assertAppCredentialFingerprint,
  resolveAppCredentials,
  type ResolvedAppCredentials,
} from "./app-credentials.js";
import type { MetaPage, MetaPlatform, Platform, StoredToken } from "../platforms/types.js";
import {
  InMemoryOAuthSessionStore,
  PostgresOAuthSessionStore,
  authorizationLifetimeMs,
  claimFailureResult,
  expectedPlatformsForCallbackPath,
  type AuthorizationSessionStatus,
  type OAuthSessionStore,
} from "./oauth-sessions.js";

export type { AuthorizationSessionStatus, OAuthSessionStore } from "./oauth-sessions.js";

interface MetaPermissions {
  data?: Array<{ permission: string; status: string }>;
}

interface MetaPagesResponse {
  data?: Array<{
    id: string;
    name: string;
    access_token: string;
    tasks?: string[];
    instagram_business_account?: { id: string; username?: string };
  }>;
}

interface TokenResponse {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

interface InstagramTokenResponse {
  access_token?: string;
  user_id?: string | number;
  permissions?: string | string[];
  expires_in?: number;
  data?: Array<{
    access_token?: string;
    user_id?: string | number;
    permissions?: string | string[];
    expires_in?: number;
  }>;
}

export type OAuthCallbackOutcome =
  | { result: "connected"; platform: Platform; sessionId: string }
  | { result: "cancelled" | "failed" | "expired"; platform?: Platform; sessionId?: string };

export interface OAuthCallbackDependencies {
  store: OAuthSessionStore;
  finish: (
    platform: Platform,
    userId: string,
    code: string,
    redirectUri: string,
    appCredentialFingerprint?: string,
  ) => Promise<void>;
}

const scheduledMedia = new Map<string, { imagePath: string; contentType: string }>();
const inMemoryOAuthSessionStore = new InMemoryOAuthSessionStore();
const postgresOAuthSessionStore = new PostgresOAuthSessionStore();
let callbackServer: ReturnType<typeof createServer> | undefined;
let callbackServerPromise: Promise<void> | undefined;

export function instagramPermissionScopes(permissions: string | string[] | undefined): string[] {
  if (Array.isArray(permissions)) return permissions.flatMap((permission) => permission.split(/[,\s]+/)).filter(Boolean);
  return permissions?.split(/[,\s]+/).filter(Boolean) ?? [];
}

// The exact callback URL registered with each provider. It is derived from the
// configured base URL (an ngrok tunnel locally, the Render worker in cloud mode)
// and is persisted with the authorization session so the token exchange reuses
// byte-identical `redirect_uri` values.
export function oauthCallbackUrl(platform: Platform): string {
  return `${config.redirectBaseUrl}/oauth/${platform === "linkedin" ? "linkedin" : "meta"}/callback`;
}

// Store selected by OAUTH_CALLBACK_MODE. Local mode keeps the original in-memory
// behavior; cloud mode persists sessions in PostgreSQL.
export function oauthSessionStore(): OAuthSessionStore {
  return config.oauthCallbackMode === "cloud" ? postgresOAuthSessionStore : inMemoryOAuthSessionStore;
}

// The public worker always completes callbacks against PostgreSQL, even if it is
// started without OAUTH_CALLBACK_MODE so an existing deployment cannot break.
export function oauthPostgresSessionStore(): OAuthSessionStore {
  return postgresOAuthSessionStore;
}

function html(response: ServerResponse, message: string, status = 200): void {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html><body><p>${message}</p><p>You may close this tab.</p></body></html>`);
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown token exchange or storage error.";
  return message
    .replace(/(client_secret|access_token|refresh_token|authorization_code|code)=([^&\s]+)/gi, "$1=[redacted]")
    .slice(0, 700);
}

function requireClientSecret(credentials: ResolvedAppCredentials, provider: string): void {
  if (credentials.clientSecret) return;
  if (credentials.source === "user") {
    throw new Error(`Your saved ${provider} app secret could not be read on this server. Re-save it in Developer App Settings, or check APP_CREDENTIAL_ENCRYPTION_KEY.`);
  }
  throw new Error(`Set the shared ${provider} app secret environment variable before completing this authorization.`);
}

async function handleCallback(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", `http://localhost:${config.imageServerPort}`);
  const mediaMatch = /^\/scheduled-media\/([a-f0-9]{64})$/.exec(url.pathname);
  if (mediaMatch && (request.method === "GET" || request.method === "HEAD")) {
    const media = scheduledMedia.get(mediaMatch[1]!);
    if (!media) {
      html(response, "Scheduled media was not found.", 404);
      return;
    }
    void readFile(media.imagePath).then(
      (image) => {
        response.writeHead(200, {
          "content-type": media.contentType,
          "content-length": image.byteLength,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        response.end(request.method === "HEAD" ? undefined : image);
      },
      () => html(response, "Scheduled media is temporarily unavailable.", 503),
    );
    return;
  }
  const expectedPlatforms = expectedPlatformsForCallbackPath(url.pathname);
  if (!expectedPlatforms) {
    html(response, "This OAuth callback route does not exist.", 404);
    return;
  }
  // Claim from the same store the session was created in. `beginAuthorization`
  // persists sessions in PostgreSQL when OAUTH_CALLBACK_MODE=cloud, so a local
  // listener receiving tunneled callbacks in that mode must claim from the
  // Postgres store too; claiming from process memory would always fail.
  const outcome = await processOAuthCallback(url.searchParams, expectedPlatforms, {
    store: oauthSessionStore(),
    finish: finishAuthorization,
  });
  if (outcome.result === "connected") {
    html(response, "Authorization completed. Return to the MCP client and check the connection status.");
  } else if (outcome.result === "cancelled") {
    html(response, "Authorization was cancelled or denied. Return to the MCP client to start a new request.", 400);
  } else if (outcome.result === "expired") {
    html(response, "This authorization request is expired or invalid.", 400);
  } else {
    html(response, "Authorization could not be completed. Return to the MCP client for status and error details.", 400);
  }
}

export async function registerScheduledMedia(
  mediaToken: string,
  imagePath: string,
  contentType: string,
): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(mediaToken)) throw new Error("Scheduled media token is invalid.");
  await ensureCallbackServer();
  scheduledMedia.set(mediaToken, { imagePath, contentType });
}

export function unregisterScheduledMedia(mediaToken: string): void {
  scheduledMedia.delete(mediaToken);
}

async function ensureCallbackServer(): Promise<void> {
  if (callbackServer?.listening) return;
  if (callbackServerPromise) return callbackServerPromise;
  const server = createServer((request, response) => {
    void handleCallback(request, response).catch(() => {
      if (response.headersSent) {
        response.end();
        return;
      }
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end("OAuth callback failed.");
    });
  });
  callbackServer = server;
  callbackServerPromise = new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      if (callbackServer === server) callbackServer = undefined;
      callbackServerPromise = undefined;
      reject(new Error(`Could not start the local image/OAuth server on port ${config.imageServerPort}: ${error.message}`));
    };
    const onListening = () => {
      server.off("error", onError);
      callbackServerPromise = undefined;
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(config.imageServerPort, "127.0.0.1");
  });
  return callbackServerPromise;
}

// Shared callback core used by both the local listener and the public worker
// callback handler. It claims the state atomically, handles provider
// cancellation, exchanges the code, and records the terminal status. It never
// logs or returns the state, code, tokens, or client secrets.
export async function processOAuthCallback(
  searchParams: URLSearchParams,
  expectedPlatforms: readonly Platform[],
  dependencies: OAuthCallbackDependencies,
): Promise<OAuthCallbackOutcome> {
  const state = searchParams.get("state");
  if (!state) return { result: "failed" };

  const claim = await dependencies.store.claim(state, expectedPlatforms);
  if (!claim.claimed) return { result: claimFailureResult(claim.reason) };
  const session = claim.session;

  const providerError = searchParams.get("error_description")
    ?? searchParams.get("error_reason")
    ?? searchParams.get("error");
  if (providerError) {
    await dependencies.store.updateStatus(session.sessionId, "cancelled", "The provider authorization was cancelled or denied.");
    return { result: "cancelled", platform: session.platform, sessionId: session.sessionId };
  }

  const code = searchParams.get("code");
  if (!code) {
    await dependencies.store.updateStatus(session.sessionId, "failed", "The provider callback did not include an authorization code.");
    return { result: "failed", platform: session.platform, sessionId: session.sessionId };
  }

  try {
    await dependencies.finish(session.platform, session.userId, code, session.redirectUri, session.appCredentialFingerprint);
    await dependencies.store.updateStatus(session.sessionId, "connected");
    return { result: "connected", platform: session.platform, sessionId: session.sessionId };
  } catch (error) {
    await dependencies.store.updateStatus(session.sessionId, "failed", safeErrorMessage(error));
    return { result: "failed", platform: session.platform, sessionId: session.sessionId };
  }
}

export async function getAuthorizationStatus(sessionId: string, userId: string): Promise<AuthorizationSessionStatus> {
  return oauthSessionStore().getStatus(sessionId, userId);
}

export async function waitForAuthorization(
  sessionId: string,
  timeoutSeconds: number,
  userId: string,
): Promise<AuthorizationSessionStatus> {
  return oauthSessionStore().waitForStatus(sessionId, userId, timeoutSeconds);
}

function appLabel(platform: Platform): string {
  if (platform === "facebook") return "Facebook";
  if (platform === "instagram") return "Instagram";
  return "LinkedIn";
}

export function validateAuthorizationConfiguration(platform: Platform, credentials: ResolvedAppCredentials): void {
  const cloud = config.oauthCallbackMode === "cloud";
  if (!credentials.clientId) {
    throw new Error(credentials.source === "user"
      ? `Your saved ${appLabel(platform)} app/client ID is missing. Re-save it in Developer App Settings.`
      : `Set the shared ${appLabel(platform)} app/client ID before connecting.`);
  }
  // In cloud mode the secret is only needed by the worker that runs the code
  // exchange, never by the request that builds the consent URL.
  if (!cloud && !credentials.clientSecret) {
    throw new Error(credentials.source === "user"
      ? `Your saved ${appLabel(platform)} app secret is not available on this server. Re-save it in Developer App Settings.`
      : `Set the shared ${appLabel(platform)} app secret before connecting.`);
  }
  const redirectUri = oauthCallbackUrl(platform);
  if (cloud && !redirectUri.startsWith("https://")) {
    throw new Error("OAUTH_CALLBACK_MODE=cloud requires OAUTH_REDIRECT_BASE_URL to be a public HTTPS base URL (for example the deployed worker URL).");
  }
  if (platform === "linkedin" && !redirectUri.startsWith("https://")) {
    throw new Error("LinkedIn requires an HTTPS callback URL. Set OAUTH_REDIRECT_BASE_URL to an HTTPS tunnel URL and register the matching callback in your LinkedIn app.");
  }
  if (platform === "instagram" && !redirectUri.startsWith("https://")) {
    throw new Error("Instagram Login requires an HTTPS callback URL. Set OAUTH_REDIRECT_BASE_URL to an HTTPS tunnel URL and register the matching callback in your Instagram app.");
  }
}

export async function beginAuthorization(platform: Platform, userId: string): Promise<{
  authorizationUrl: string;
  sessionId: string;
  expiresAt: number;
}> {
  // Build the consent URL with the user's own Developer App when configured,
  // otherwise the shared environment app. The secret is only decrypted when this
  // process also runs the token exchange (local mode); a cloud request needs only
  // the public client id and the version fingerprint.
  const credentials = await resolveAppCredentials(userId, platform, {
    includeSecret: config.oauthCallbackMode !== "cloud",
  });
  validateAuthorizationConfiguration(platform, credentials);
  const redirectUri = oauthCallbackUrl(platform);
  // Only local development needs the localhost listener. A cloud worker or
  // Vercel request must not bind a local port to receive the callback.
  if (config.oauthCallbackMode !== "cloud") await ensureCallbackServer();
  const state = randomBytes(32).toString("hex");
  const sessionId = randomBytes(16).toString("hex");
  const expiresAt = Date.now() + authorizationLifetimeMs;
  await oauthSessionStore().create({
    sessionId,
    state,
    userId,
    platform,
    redirectUri,
    expiresAt,
    appCredentialFingerprint: credentials.fingerprint,
  });
  if (platform === "linkedin") {
    const url = new URL("https://www.linkedin.com/oauth/v2/authorization");
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: credentials.clientId,
      redirect_uri: redirectUri,
      state,
      scope: config.linkedinScopes.join(" "),
    }).toString();
    return { authorizationUrl: url.toString(), sessionId, expiresAt };
  }
  if (platform === "instagram") {
    const url = new URL("https://www.instagram.com/oauth/authorize");
    url.search = new URLSearchParams({
      client_id: credentials.clientId,
      redirect_uri: redirectUri,
      state,
      response_type: "code",
      scope: config.instagramScopes.join(","),
      enable_fb_login: "false",
    }).toString();
    return { authorizationUrl: url.toString(), sessionId, expiresAt };
  }
  const url = new URL(`https://www.facebook.com/${config.metaGraphVersion}/dialog/oauth`);
  url.search = new URLSearchParams({
    client_id: credentials.clientId,
    redirect_uri: redirectUri,
    state,
    response_type: "code",
    scope: ["pages_show_list", "pages_read_engagement", "pages_manage_posts"].join(","),
  }).toString();
  return { authorizationUrl: url.toString(), sessionId, expiresAt };
}

// Dispatches to the correct provider exchange. The platform stored in the
// authorization session decides which credentials and token slot are used, so a
// Facebook authorization can never overwrite an Instagram token. The optional
// fingerprint is the credential version recorded when the flow started; a
// mismatch means the user edited their app mid-flow, so the exchange is refused
// rather than run against a different app.
export async function finishAuthorization(
  platform: Platform,
  userId: string,
  code: string,
  redirectUri: string,
  appCredentialFingerprint?: string,
): Promise<void> {
  const credentials = await resolveAppCredentials(userId, platform);
  assertAppCredentialFingerprint(appCredentialFingerprint, credentials.fingerprint);
  if (platform === "linkedin") {
    requireClientSecret(credentials, "LinkedIn");
    await finishLinkedInAuthorization(userId, code, redirectUri, credentials);
    return;
  }
  if (platform === "instagram") {
    requireClientSecret(credentials, "Instagram");
    await finishInstagramAuthorization(userId, code, redirectUri, credentials);
    return;
  }
  requireClientSecret(credentials, "Facebook");
  await finishMetaAuthorization(userId, code, redirectUri, platform, credentials);
}

async function finishInstagramAuthorization(
  userId: string,
  code: string,
  redirectUri: string,
  credentials: ResolvedAppCredentials,
): Promise<void> {
  const form = new FormData();
  form.set("client_id", credentials.clientId);
  form.set("client_secret", credentials.clientSecret ?? "");
  form.set("grant_type", "authorization_code");
  form.set("redirect_uri", redirectUri);
  form.set("code", code);
  const { data: shortResponse } = await apiRequest<InstagramTokenResponse>(
    "https://api.instagram.com/oauth/access_token",
    { method: "POST", body: form },
  );
  const shortToken = shortResponse.data?.[0] ?? shortResponse;
  if (!shortToken.access_token || shortToken.user_id === undefined) {
    throw new Error("Instagram did not return an access token and user ID.");
  }

  const longTokenUrl = new URL("https://graph.instagram.com/access_token");
  longTokenUrl.search = new URLSearchParams({
    grant_type: "ig_exchange_token",
    client_secret: credentials.clientSecret ?? "",
    access_token: shortToken.access_token,
  }).toString();
  const { data: longToken } = await apiRequest<TokenResponse>(longTokenUrl);
  const { data: profile } = await apiRequest<{ user_id?: string | number; id?: string; username?: string }>(
    `https://graph.instagram.com/${config.metaGraphVersion}/me?fields=user_id,username`,
    { accessToken: longToken.access_token },
  );
  const accountId = profile.user_id ?? profile.id ?? shortToken.user_id;
  const scopes = instagramPermissionScopes(shortToken.permissions);
  const vault = await loadTokens(userId);
  vault.instagram = {
    accessToken: longToken.access_token,
    ...(longToken.expires_in ? { expiresAt: Date.now() + longToken.expires_in * 1000 } : {}),
    scopes,
    connectedAt: Date.now(),
    accountId: String(accountId),
    ...(profile.username ? { accountName: profile.username } : {}),
  };
  await saveTokens(userId, vault);
}

async function finishMetaAuthorization(
  userId: string,
  code: string,
  redirectUri: string,
  platform: MetaPlatform,
  credentials: ResolvedAppCredentials,
): Promise<void> {
  const shortToken = await exchangeMetaCode(code, redirectUri, credentials);
  const tokenUrl = new URL(`https://graph.facebook.com/${config.metaGraphVersion}/oauth/access_token`);
  tokenUrl.search = new URLSearchParams({
    grant_type: "fb_exchange_token",
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret ?? "",
    fb_exchange_token: shortToken,
  }).toString();
  const { data: longToken } = await apiRequest<TokenResponse>(tokenUrl);
  const { data: profile } = await apiRequest<{ id: string; name?: string }>(
    `https://graph.facebook.com/${config.metaGraphVersion}/me?fields=id,name`,
    { accessToken: longToken.access_token },
  );
  let scopes: string[] = [];
  try {
    const { data } = await apiRequest<MetaPermissions>(
      `https://graph.facebook.com/${config.metaGraphVersion}/me/permissions`,
      { accessToken: longToken.access_token },
    );
    scopes = (data.data ?? []).filter((entry) => entry.status === "granted").map((entry) => entry.permission);
  } catch {
    scopes = [];
  }
  let pages: MetaPage[] = [];
  try {
    const { data } = await apiRequest<MetaPagesResponse>(
      `https://graph.facebook.com/${config.metaGraphVersion}/me/accounts?fields=id,name,access_token,tasks,instagram_business_account{id,username}`,
      { accessToken: longToken.access_token },
    );
    pages = (data.data ?? []).map((page) => ({
      id: page.id,
      name: page.name,
      accessToken: page.access_token,
      tasks: page.tasks ?? [],
      ...(page.instagram_business_account ? { instagramAccount: page.instagram_business_account } : {}),
    }));
  } catch {
    pages = [];
  }
  const vault = await loadTokens(userId);
  const record: StoredToken = {
    accessToken: longToken.access_token,
    ...(longToken.expires_in ? { expiresAt: Date.now() + longToken.expires_in * 1000 } : {}),
    scopes,
    connectedAt: Date.now(),
    accountId: profile.id,
    ...(profile.name ? { accountName: profile.name } : {}),
    pages,
  };
  vault[platform] = record;
  await saveTokens(userId, vault);
}

async function exchangeMetaCode(
  code: string,
  redirectUri: string,
  credentials: ResolvedAppCredentials,
): Promise<string> {
  const url = new URL(`https://graph.facebook.com/${config.metaGraphVersion}/oauth/access_token`);
  url.search = new URLSearchParams({
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret ?? "",
    redirect_uri: redirectUri,
    code,
  }).toString();
  const { data } = await apiRequest<TokenResponse>(url);
  return data.access_token;
}

async function finishLinkedInAuthorization(
  userId: string,
  code: string,
  redirectUri: string,
  credentials: ResolvedAppCredentials,
): Promise<void> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret ?? "",
    redirect_uri: redirectUri,
  });
  const { data: token } = await apiRequest<TokenResponse>("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const { data: profile } = await apiRequest<{ sub: string; name?: string }>(
    "https://api.linkedin.com/v2/userinfo",
    { accessToken: token.access_token },
  );
  const vault = await loadTokens(userId);
  vault.linkedin = {
    accessToken: token.access_token,
    ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
    ...(token.expires_in ? { expiresAt: Date.now() + token.expires_in * 1000 } : {}),
    scopes: token.scope?.split(/[,\s]+/).filter(Boolean) ?? config.linkedinScopes,
    connectedAt: Date.now(),
    accountId: profile.sub,
    ...(profile.name ? { accountName: profile.name } : {}),
  };
  await saveTokens(userId, vault);
}
