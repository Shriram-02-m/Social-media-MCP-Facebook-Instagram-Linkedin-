import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { apiRequest } from "../utils/http.js";
import { config } from "../config/env.js";
import { loadTokens, saveTokens } from "./token-store.js";
import type { MetaPage, MetaPlatform, Platform, StoredToken } from "../platforms/types.js";

interface PendingAuthorization {
  platform: Platform;
  userId: string;
  sessionId: string;
  expiresAt: number;
  timer: NodeJS.Timeout;
  status: "pending" | "connected" | "cancelled" | "failed" | "expired";
  error?: string;
  completedAt?: number;
  waiters: Set<(status: AuthorizationSessionStatus) => void>;
}

export interface AuthorizationSessionStatus {
  sessionId: string;
  platform: Platform;
  status: PendingAuthorization["status"];
  expiresAt: number;
  error?: string;
}

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

const pending = new Map<string, PendingAuthorization>();
const sessions = new Map<string, PendingAuthorization>();
const scheduledMedia = new Map<string, { imagePath: string; contentType: string }>();
let callbackServer: ReturnType<typeof createServer> | undefined;
let callbackServerPromise: Promise<void> | undefined;

const authorizationLifetimeMs = 15 * 60 * 1000;
const sessionRetentionMs = 24 * 60 * 60 * 1000;

export function instagramPermissionScopes(permissions: string | string[] | undefined): string[] {
  if (Array.isArray(permissions)) return permissions.flatMap((permission) => permission.split(/[,\s]+/)).filter(Boolean);
  return permissions?.split(/[,\s]+/).filter(Boolean) ?? [];
}

function callbackUrl(platform: Platform): string {
  return `${config.redirectBaseUrl}/oauth/${platform === "linkedin" ? "linkedin" : "meta"}/callback`;
}

function html(response: ServerResponse, message: string, status = 200): void {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html><body><p>${message}</p><p>You may close this tab.</p></body></html>`);
}

function sessionStatus(sessionId: string, session: PendingAuthorization): AuthorizationSessionStatus {
  return {
    sessionId,
    platform: session.platform,
    status: session.status,
    expiresAt: session.expiresAt,
    ...(session.error ? { error: session.error } : {}),
  };
}

function completeSession(session: PendingAuthorization, status: PendingAuthorization["status"], error?: string): void {
  session.status = status;
  if (error) session.error = error;
  else delete session.error;
  session.completedAt = Date.now();
  const result = sessionStatus(session.sessionId, session);
  for (const resolve of session.waiters) resolve(result);
  session.waiters.clear();
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown token exchange or storage error.";
  return message
    .replace(/(client_secret|access_token|refresh_token|authorization_code|code)=([^&\s]+)/gi, "$1=[redacted]")
    .slice(0, 700);
}

function pruneSessions(): void {
  const cutoff = Date.now() - sessionRetentionMs;
  for (const [sessionId, session] of sessions) {
    if (session.completedAt !== undefined && session.completedAt < cutoff) sessions.delete(sessionId);
  }
}

function handleCallback(request: IncomingMessage, response: ServerResponse): void {
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
  if (url.pathname !== "/oauth/meta/callback" && url.pathname !== "/oauth/linkedin/callback") {
    html(response, "This OAuth callback route does not exist.", 404);
    return;
  }
  const isLinkedIn = url.pathname === "/oauth/linkedin/callback";
  const state = url.searchParams.get("state");
  const authorization = state ? pending.get(state) : undefined;
  if (!authorization || (authorization.platform === "linkedin") !== isLinkedIn) {
    html(response, "This authorization request is expired or invalid.", 400);
    return;
  }
  clearTimeout(authorization.timer);
  pending.delete(state!);
  const code = url.searchParams.get("code");
  const providerError = url.searchParams.get("error_description")
    ?? url.searchParams.get("error_reason")
    ?? url.searchParams.get("error");
  if (providerError) {
    completeSession(authorization, "cancelled", "The provider authorization was cancelled or denied.");
    html(response, "Authorization was cancelled or denied. Return to the MCP client to start a new request.", 400);
    return;
  }
  if (!code) {
    completeSession(authorization, "failed", "The provider callback did not include an authorization code.");
    html(response, "Authorization failed because the provider did not return a code.", 400);
    return;
  }
  void (async () => {
    if (authorization.platform === "linkedin") {
      await finishLinkedInAuthorization(authorization.userId, code, callbackUrl("linkedin"));
    } else if (authorization.platform === "instagram") {
      await finishInstagramAuthorization(authorization.userId, code, callbackUrl("instagram"));
    } else {
      await finishMetaAuthorization(authorization.userId, code, callbackUrl(authorization.platform), authorization.platform);
    }
  })().then(
    () => {
      completeSession(authorization, "connected");
      html(response, "Authorization completed. Return to the MCP client and check the connection status.");
    },
    (error: unknown) => {
      completeSession(authorization, "failed", safeErrorMessage(error));
      html(response, "Authorization could not be completed. Return to the MCP client for status and error details.", 500);
    },
  );
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
  const server = createServer(handleCallback);
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

function addPending(platform: Platform, userId: string): { state: string; sessionId: string; session: PendingAuthorization } {
  pruneSessions();
  const state = randomBytes(32).toString("hex");
  const sessionId = randomBytes(16).toString("hex");
  const expiresAt = Date.now() + authorizationLifetimeMs;
  let session: PendingAuthorization;
  const timer = setTimeout(() => {
    pending.delete(state);
    completeSession(session, "expired", "The authorization request expired before the provider callback arrived.");
  }, authorizationLifetimeMs);
  session = {
    platform,
    userId,
    sessionId,
    expiresAt,
    timer,
    status: "pending",
    waiters: new Set(),
  };
  session.timer.unref();
  pending.set(state, session);
  sessions.set(sessionId, session);
  return { state, sessionId, session };
}

function requireOwnedSession(sessionId: string, userId: string): PendingAuthorization {
  const session = sessions.get(sessionId);
  if (!session || session.userId !== userId) {
    throw new Error("Authorization session not found or expired. Start a new authorization request.");
  }
  return session;
}

export function getAuthorizationStatus(sessionId: string, userId: string): AuthorizationSessionStatus {
  const session = requireOwnedSession(sessionId, userId);
  return sessionStatus(sessionId, session);
}

export function waitForAuthorization(
  sessionId: string,
  timeoutSeconds: number,
  userId: string,
): Promise<AuthorizationSessionStatus> {
  const session = requireOwnedSession(sessionId, userId);
  if (session.status !== "pending" || timeoutSeconds === 0) return Promise.resolve(sessionStatus(sessionId, session));
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout;
    const finish = (status: AuthorizationSessionStatus) => {
      clearTimeout(timer);
      session.waiters.delete(finish);
      resolve(status);
    };
    timer = setTimeout(() => finish(sessionStatus(sessionId, session)), timeoutSeconds * 1000);
    session.waiters.add(finish);
  });
}

function validateAuthorizationConfiguration(platform: Platform): void {
  if (platform === "linkedin" && (!config.linkedinClientId || !config.linkedinClientSecret)) {
    throw new Error("Set LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET before connecting LinkedIn.");
  }
  if (platform === "facebook" && (!config.metaAppId || !config.metaAppSecret)) {
    throw new Error("Set META_APP_ID and META_APP_SECRET before connecting Facebook.");
  }
  if (platform === "instagram" && (!config.instagramAppId || !config.instagramAppSecret)) {
    throw new Error("Set INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET before connecting Instagram.");
  }
  const redirectUri = callbackUrl(platform);
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
  validateAuthorizationConfiguration(platform);
  await ensureCallbackServer();
  const redirectUri = callbackUrl(platform);
  const { state, sessionId, session } = addPending(platform, userId);
  if (platform === "linkedin") {
    const url = new URL("https://www.linkedin.com/oauth/v2/authorization");
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: config.linkedinClientId,
      redirect_uri: redirectUri,
      state,
      scope: config.linkedinScopes.join(" "),
    }).toString();
    return { authorizationUrl: url.toString(), sessionId, expiresAt: session.expiresAt };
  }
  if (platform === "instagram") {
    const url = new URL("https://www.instagram.com/oauth/authorize");
    url.search = new URLSearchParams({
      client_id: config.instagramAppId,
      redirect_uri: redirectUri,
      state,
      response_type: "code",
      scope: config.instagramScopes.join(","),
      enable_fb_login: "false",
    }).toString();
    return { authorizationUrl: url.toString(), sessionId, expiresAt: session.expiresAt };
  }
  const url = new URL(`https://www.facebook.com/${config.metaGraphVersion}/dialog/oauth`);
  url.search = new URLSearchParams({
    client_id: config.metaAppId,
    redirect_uri: redirectUri,
    state,
    response_type: "code",
    scope: ["pages_show_list", "pages_read_engagement", "pages_manage_posts"].join(","),
  }).toString();
  return { authorizationUrl: url.toString(), sessionId, expiresAt: session.expiresAt };
}

async function finishInstagramAuthorization(userId: string, code: string, redirectUri: string): Promise<void> {
  const form = new FormData();
  form.set("client_id", config.instagramAppId);
  form.set("client_secret", config.instagramAppSecret);
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
    client_secret: config.instagramAppSecret,
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

async function finishMetaAuthorization(userId: string, code: string, redirectUri: string, platform: MetaPlatform): Promise<void> {
  const shortToken = await exchangeMetaCode(code, redirectUri);
  const tokenUrl = new URL(`https://graph.facebook.com/${config.metaGraphVersion}/oauth/access_token`);
  tokenUrl.search = new URLSearchParams({
    grant_type: "fb_exchange_token",
    client_id: config.metaAppId,
    client_secret: config.metaAppSecret,
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

async function exchangeMetaCode(code: string, redirectUri: string): Promise<string> {
  const url = new URL(`https://graph.facebook.com/${config.metaGraphVersion}/oauth/access_token`);
  url.search = new URLSearchParams({
    client_id: config.metaAppId,
    client_secret: config.metaAppSecret,
    redirect_uri: redirectUri,
    code,
  }).toString();
  const { data } = await apiRequest<TokenResponse>(url);
  return data.access_token;
}

async function finishLinkedInAuthorization(userId: string, code: string, redirectUri: string): Promise<void> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: config.linkedinClientId,
    client_secret: config.linkedinClientSecret,
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