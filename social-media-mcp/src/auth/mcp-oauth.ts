import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AuthInfo, OAuthMetadata, OAuthProtectedResourceMetadata } from "@modelcontextprotocol/server";
import { OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";
import { z } from "zod";
import { config } from "../config/env.js";
import { databasePool } from "../database.js";
import { ensureDatabaseMigrations } from "../database-migrations.js";

// Remote MCP OAuth 2.1 authorization server and resource-server verifier.
//
// The cloud worker serves the authorization, token, registration, and revocation
// endpoints. The Vercel frontend renders consent and creates the one-time code,
// which binds the code to the signed-in better-auth user. Only SHA-256 digests
// of codes, access tokens, refresh tokens, and client secrets are persisted.

export type McpClientAuthMethod = "none" | "client_secret_basic" | "client_secret_post";

export interface McpOAuthClient {
  clientId: string;
  redirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  tokenEndpointAuthMethod: McpClientAuthMethod;
  clientName?: string;
  scope?: string;
}

export interface McpClientRegistrationResponse {
  client_id: string;
  client_secret?: string;
  client_id_issued_at: number;
  redirect_uris: string[];
  token_endpoint_auth_method: McpClientAuthMethod;
  grant_types: string[];
  response_types: string[];
  client_name?: string;
  scope?: string;
}

export interface McpTokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token?: string;
  scope: string;
}

export interface McpAuthorizationValidation {
  client: McpOAuthClient;
  scope: string;
  resource: string;
}

export class McpOAuthError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "McpOAuthError";
    this.code = code;
    this.status = status;
  }
}

const clientSecretPattern = /^[A-Za-z0-9_-]{32,256}$/;
const codeVerifierPattern = /^[A-Za-z0-9\-._~]{43,128}$/;
const codeChallengePattern = /^[A-Za-z0-9_-]{43,128}$/;

interface ClientRow {
  client_id: string;
  client_name: string | null;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: McpClientAuthMethod;
  scope: string | null;
}

interface ClientSecretRow {
  client_secret_hash: string | null;
  token_endpoint_auth_method: McpClientAuthMethod;
}

function clientFromRow(row: ClientRow): McpOAuthClient {
  return {
    clientId: row.client_id,
    redirectUris: row.redirect_uris,
    grantTypes: row.grant_types,
    responseTypes: row.response_types,
    tokenEndpointAuthMethod: row.token_endpoint_auth_method,
    ...(row.client_name ? { clientName: row.client_name } : {}),
    ...(row.scope ? { scope: row.scope } : {}),
  };
}

export function hashMcpSecret(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeHashEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

export function normalizeMcpScope(requested?: string, fallback?: string): string {
  const raw = (requested ?? fallback ?? config.mcpOauthScope).trim();
  if (!raw) return config.mcpOauthScope;
  const scopes = [...new Set(raw.split(/\s+/).filter(Boolean))];
  if (!scopes.length || scopes.some((scope) => scope !== config.mcpOauthScope)) {
    throw new McpOAuthError(
      OAuthErrorCode.InvalidScope,
      `Unsupported scope. This server supports only "${config.mcpOauthScope}".`,
    );
  }
  return config.mcpOauthScope;
}

export function normalizeMcpResource(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new McpOAuthError(OAuthErrorCode.InvalidTarget, "The resource parameter must be an absolute URL.");
  }
  if (url.username || url.password) {
    throw new McpOAuthError(OAuthErrorCode.InvalidTarget, "The resource parameter must not contain credentials.");
  }
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

export function mcpAuthorizationServerIssuer(): string {
  return new URL(config.mcpPublicUrl).origin;
}

export function mcpProtectedResourceMetadata(): OAuthProtectedResourceMetadata {
  return {
    resource: config.mcpPublicUrl,
    authorization_servers: [mcpAuthorizationServerIssuer()],
    scopes_supported: [config.mcpOauthScope],
    bearer_methods_supported: ["header"],
    resource_name: "Social Media MCP",
  };
}

export function mcpAuthorizationServerMetadata(): OAuthMetadata {
  const issuer = mcpAuthorizationServerIssuer();
  return {
    issuer,
    authorization_endpoint: new URL("/oauth/authorize", issuer).toString(),
    token_endpoint: new URL("/oauth/token", issuer).toString(),
    registration_endpoint: new URL("/oauth/register", issuer).toString(),
    revocation_endpoint: new URL("/oauth/revoke", issuer).toString(),
    scopes_supported: [config.mcpOauthScope],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
    code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: false,
    client_id_metadata_document_supported: false,
  };
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

export function isAllowedMcpRedirectUri(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash) return false;
  if (url.protocol === "https:") {
    return config.mcpAllowedRedirectOrigins.some(
      (origin) => url.origin === origin.replace(/\/+$/, ""),
    );
  }
  return config.mcpAllowLoopbackRedirects
    && url.protocol === "http:"
    && isLoopbackHostname(url.hostname);
}

function redirectUriMatches(client: McpOAuthClient, redirectUri: string): boolean {
  if (!isAllowedMcpRedirectUri(redirectUri)) return false;
  return client.redirectUris.some((registered) => {
    if (registered === redirectUri) return true;
    try {
      return new URL(registered).toString() === new URL(redirectUri).toString();
    } catch {
      return false;
    }
  });
}

export function isRegisteredMcpRedirectUri(client: McpOAuthClient, redirectUri: string): boolean {
  return redirectUriMatches(client, redirectUri);
}

export async function getMcpClient(clientId: string): Promise<McpOAuthClient | null> {
  await ensureDatabaseMigrations();
  const { rows } = await databasePool().query<ClientRow>(
    `SELECT client_id, client_name, redirect_uris, grant_types, response_types,
            token_endpoint_auth_method, scope
       FROM public.mcp_oauth_clients
      WHERE client_id = $1`,
    [clientId],
  );
  const row = rows[0];
  return row ? clientFromRow(row) : null;
}

export async function validateMcpAuthorizationRequest(input: {
  clientId?: string;
  redirectUri?: string;
  responseType?: string;
  scope?: string;
  resource?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
}): Promise<McpAuthorizationValidation> {
  if (!input.clientId) {
    throw new McpOAuthError(OAuthErrorCode.InvalidRequest, "client_id is required.");
  }
  if (!input.redirectUri) {
    throw new McpOAuthError(OAuthErrorCode.InvalidRequest, "redirect_uri is required.");
  }
  if (input.responseType !== undefined && input.responseType !== "code") {
    throw new McpOAuthError(OAuthErrorCode.UnsupportedResponseType, "Only response_type=code is supported.");
  }
  if (input.codeChallengeMethod !== undefined && input.codeChallengeMethod !== "S256") {
    throw new McpOAuthError(OAuthErrorCode.InvalidRequest, "PKCE code_challenge_method must be S256.");
  }
  if (!input.codeChallenge || !codeChallengePattern.test(input.codeChallenge)) {
    throw new McpOAuthError(OAuthErrorCode.InvalidRequest, "A valid PKCE code_challenge is required.");
  }
  const client = await getMcpClient(input.clientId);
  if (!client) {
    throw new McpOAuthError(OAuthErrorCode.InvalidClient, "Unknown OAuth client.", 401);
  }
  if (!redirectUriMatches(client, input.redirectUri)) {
    throw new McpOAuthError(OAuthErrorCode.InvalidRequest, "The redirect_uri is not registered for this client.");
  }
  if (!client.responseTypes.includes("code")) {
    throw new McpOAuthError(OAuthErrorCode.UnauthorizedClient, "This client may not use the authorization-code grant.");
  }
  const scope = normalizeMcpScope(input.scope, client.scope);
  const expectedResource = normalizeMcpResource(config.mcpPublicUrl);
  const resource = input.resource ? normalizeMcpResource(input.resource) : expectedResource;
  if (resource !== expectedResource) {
    throw new McpOAuthError(
      OAuthErrorCode.InvalidTarget,
      "The requested resource does not match this server's MCP_PUBLIC_URL.",
    );
  }
  return { client, scope, resource };
}

const registrationSchema = z.object({
  redirect_uris: z.array(z.string().min(1)).min(1).max(10),
  token_endpoint_auth_method: z
    .enum(["none", "client_secret_basic", "client_secret_post"])
    .optional(),
  grant_types: z.array(z.string().min(1)).max(5).optional(),
  response_types: z.array(z.string().min(1)).max(5).optional(),
  client_name: z.string().min(1).max(200).optional(),
  scope: z.string().min(1).max(200).optional(),
});

export async function registerMcpClient(input: unknown): Promise<McpClientRegistrationResponse> {
  const parsed = registrationSchema.safeParse(input);
  if (!parsed.success) {
    throw new McpOAuthError(
      OAuthErrorCode.InvalidClientMetadata,
      parsed.error.issues[0]?.message ?? "Invalid client metadata.",
    );
  }
  const metadata = parsed.data;
  const redirectUris = [...new Set(metadata.redirect_uris)];
  if (redirectUris.some((uri) => !isAllowedMcpRedirectUri(uri))) {
    throw new McpOAuthError(
      OAuthErrorCode.InvalidRedirectUri,
      "redirect_uris must be registered Claude origins or loopback HTTP callbacks.",
    );
  }
  const grantTypes = metadata.grant_types ?? ["authorization_code", "refresh_token"];
  if (!grantTypes.includes("authorization_code") || grantTypes.some(
    (grant) => grant !== "authorization_code" && grant !== "refresh_token",
  )) {
    throw new McpOAuthError(
      OAuthErrorCode.InvalidClientMetadata,
      "grant_types may contain only authorization_code and refresh_token.",
    );
  }
  const responseTypes = metadata.response_types ?? ["code"];
  if (responseTypes.length !== 1 || responseTypes[0] !== "code") {
    throw new McpOAuthError(OAuthErrorCode.InvalidClientMetadata, "Only response_types=[\"code\"] is supported.");
  }
  const scope = normalizeMcpScope(metadata.scope);
  const authMethod = metadata.token_endpoint_auth_method ?? "none";
  const clientId = `mcp_${randomBytes(16).toString("hex")}`;
  const clientSecret = authMethod === "none" ? undefined : randomBytes(32).toString("base64url");
  if (clientSecret && !clientSecretPattern.test(clientSecret)) {
    throw new Error("Generated client secret failed validation.");
  }
  await ensureDatabaseMigrations();
  await databasePool().query(
    `INSERT INTO public.mcp_oauth_clients
       (client_id, client_secret_hash, client_name, redirect_uris, grant_types, response_types,
        token_endpoint_auth_method, scope)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      clientId,
      clientSecret ? hashMcpSecret(clientSecret) : null,
      metadata.client_name ?? null,
      redirectUris,
      grantTypes,
      responseTypes,
      authMethod,
      scope,
    ],
  );
  void pruneMcpOAuthState().catch(() => undefined);
  return {
    client_id: clientId,
    ...(clientSecret ? { client_secret: clientSecret } : {}),
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: redirectUris,
    token_endpoint_auth_method: authMethod,
    grant_types: grantTypes,
    response_types: responseTypes,
    ...(metadata.client_name ? { client_name: metadata.client_name } : {}),
    scope,
  };
}

export async function authenticateMcpClient(input: {
  authorizationHeader?: string;
  clientId?: string;
  clientSecret?: string;
}): Promise<McpOAuthClient> {
  let clientId = input.clientId;
  let clientSecret = input.clientSecret;
  const header = input.authorizationHeader?.trim();
  if (header) {
    if (clientId !== undefined || clientSecret !== undefined) {
      throw new McpOAuthError(
        OAuthErrorCode.InvalidRequest,
        "Use either HTTP Basic client authentication or body credentials, not both.",
      );
    }
    const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header);
    if (!match) {
      throw new McpOAuthError(OAuthErrorCode.InvalidClient, "Unsupported client authentication method.", 401);
    }
    let decoded: string;
    try {
      decoded = Buffer.from(match[1]!, "base64").toString("utf8");
    } catch {
      throw new McpOAuthError(OAuthErrorCode.InvalidClient, "Malformed client authentication.", 401);
    }
    const separator = decoded.indexOf(":");
    if (separator < 0) {
      throw new McpOAuthError(OAuthErrorCode.InvalidClient, "Malformed client authentication.", 401);
    }
    try {
      clientId = decodeURIComponent(decoded.slice(0, separator));
      clientSecret = decodeURIComponent(decoded.slice(separator + 1));
    } catch {
      throw new McpOAuthError(OAuthErrorCode.InvalidClient, "Malformed client authentication.", 401);
    }
  }
  if (!clientId) {
    throw new McpOAuthError(OAuthErrorCode.InvalidClient, "Client authentication is required.", 401);
  }
  await ensureDatabaseMigrations();
  const { rows } = await databasePool().query<ClientSecretRow>(
    `SELECT client_secret_hash, token_endpoint_auth_method
       FROM public.mcp_oauth_clients
      WHERE client_id = $1`,
    [clientId],
  );
  const row = rows[0];
  if (!row) {
    throw new McpOAuthError(OAuthErrorCode.InvalidClient, "Unknown OAuth client.", 401);
  }
  if (row.token_endpoint_auth_method === "none") {
    if (clientSecret) {
      throw new McpOAuthError(OAuthErrorCode.InvalidClient, "This client does not use a client secret.", 401);
    }
  } else {
    if (!clientSecret || !row.client_secret_hash || !safeHashEqual(hashMcpSecret(clientSecret), row.client_secret_hash)) {
      throw new McpOAuthError(OAuthErrorCode.InvalidClient, "Client authentication failed.", 401);
    }
  }
  const client = await getMcpClient(clientId);
  if (!client) {
    throw new McpOAuthError(OAuthErrorCode.InvalidClient, "Unknown OAuth client.", 401);
  }
  void databasePool().query(
    "UPDATE public.mcp_oauth_clients SET last_used_at = NOW() WHERE client_id = $1",
    [clientId],
  ).catch(() => undefined);
  return client;
}

export async function createMcpAuthorizationCode(input: {
  clientId: string;
  userId: string;
  redirectUri: string;
  scope?: string;
  resource?: string;
  codeChallenge: string;
  codeChallengeMethod: string;
}): Promise<string> {
  if (!input.userId) {
    throw new McpOAuthError(OAuthErrorCode.ServerError, "The signed-in user is missing.", 500);
  }
  const validated = await validateMcpAuthorizationRequest(input);
  const code = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + config.mcpAuthorizationCodeTtlSeconds * 1000);
  await databasePool().query(
    `INSERT INTO public.mcp_oauth_authorization_codes
       (code_hash, client_id, user_id, redirect_uri, scope, resource,
        code_challenge, code_challenge_method, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'S256', $8)`,
    [
      hashMcpSecret(code),
      validated.client.clientId,
      input.userId,
      input.redirectUri,
      validated.scope,
      validated.resource,
      input.codeChallenge,
      expiresAt,
    ],
  );
  void pruneMcpOAuthState().catch(() => undefined);
  return code;
}

interface AuthorizationCodeRow {
  user_id: string;
  scope: string;
  resource: string;
  code_challenge: string;
  code_challenge_method: string;
}

interface RefreshTokenRow {
  user_id: string;
  scope: string;
  resource: string;
  family_id: string;
}

interface TokenProbeRow {
  family_id: string;
  revoked_at: Date | null;
  rotated_at: Date | null;
  expires_at: Date;
}

async function issueMcpTokens(
  client: McpOAuthClient,
  userId: string,
  scope: string,
  resource: string,
  familyId = randomBytes(16).toString("hex"),
): Promise<McpTokenResponse> {
  if (!client.grantTypes.includes("authorization_code") && !client.grantTypes.includes("refresh_token")) {
    throw new McpOAuthError(OAuthErrorCode.UnauthorizedClient, "This client may not obtain tokens.");
  }
  const accessToken = randomBytes(32).toString("base64url");
  const refreshToken = client.grantTypes.includes("refresh_token")
    ? randomBytes(48).toString("base64url")
    : undefined;
  const accessExpiresAt = new Date(Date.now() + config.mcpAccessTokenTtlSeconds * 1000);
  const refreshExpiresAt = new Date(Date.now() + config.mcpRefreshTokenTtlSeconds * 1000);
  const db = await databasePool().connect();
  let transactionStarted = false;
  try {
    await db.query("BEGIN");
    transactionStarted = true;
    await db.query(
      `INSERT INTO public.mcp_oauth_access_tokens
         (token_hash, client_id, user_id, scope, resource, family_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [hashMcpSecret(accessToken), client.clientId, userId, scope, resource, familyId, accessExpiresAt],
    );
    if (refreshToken) {
      await db.query(
        `INSERT INTO public.mcp_oauth_refresh_tokens
           (token_hash, client_id, user_id, scope, resource, family_id, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [hashMcpSecret(refreshToken), client.clientId, userId, scope, resource, familyId, refreshExpiresAt],
      );
    }
    await db.query("COMMIT");
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    db.release();
  }
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: config.mcpAccessTokenTtlSeconds,
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
    scope,
  };
}

export async function exchangeMcpAuthorizationCode(
  client: McpOAuthClient,
  input: {
    code?: string;
    redirectUri?: string;
    codeVerifier?: string;
    resource?: string;
  },
): Promise<McpTokenResponse> {
  if (!client.grantTypes.includes("authorization_code")) {
    throw new McpOAuthError(OAuthErrorCode.UnauthorizedClient, "This client may not use the authorization-code grant.");
  }
  if (!input.code) {
    throw new McpOAuthError(OAuthErrorCode.InvalidRequest, "code is required.");
  }
  if (!input.redirectUri) {
    throw new McpOAuthError(OAuthErrorCode.InvalidRequest, "redirect_uri is required.");
  }
  if (!input.codeVerifier || !codeVerifierPattern.test(input.codeVerifier)) {
    throw new McpOAuthError(OAuthErrorCode.InvalidRequest, "A valid PKCE code_verifier is required.");
  }
  const { rows } = await databasePool().query<AuthorizationCodeRow>(
    `UPDATE public.mcp_oauth_authorization_codes
        SET consumed_at = NOW()
      WHERE code_hash = $1
        AND client_id = $2
        AND redirect_uri = $3
        AND consumed_at IS NULL
        AND expires_at > NOW()
      RETURNING user_id, scope, resource, code_challenge, code_challenge_method`,
    [hashMcpSecret(input.code), client.clientId, input.redirectUri],
  );
  const row = rows[0];
  if (!row || row.code_challenge_method !== "S256") {
    throw new McpOAuthError(OAuthErrorCode.InvalidGrant, "The authorization code is invalid, expired, or already used.");
  }
  const expectedChallenge = createHash("sha256").update(input.codeVerifier, "utf8").digest("base64url");
  if (!safeHashEqual(expectedChallenge, row.code_challenge)) {
    throw new McpOAuthError(OAuthErrorCode.InvalidGrant, "PKCE verification failed.");
  }
  if (input.resource) {
    let requestedResource: string;
    try {
      requestedResource = normalizeMcpResource(input.resource);
    } catch {
      throw new McpOAuthError(OAuthErrorCode.InvalidGrant, "The resource does not match the authorization request.");
    }
    if (requestedResource !== row.resource) {
      throw new McpOAuthError(OAuthErrorCode.InvalidGrant, "The resource does not match the authorization request.");
    }
  }
  return issueMcpTokens(client, row.user_id, row.scope, row.resource);
}

async function revokeMcpTokenFamily(familyId: string): Promise<void> {
  await databasePool().query(
    "UPDATE public.mcp_oauth_access_tokens SET revoked_at = NOW() WHERE family_id = $1 AND revoked_at IS NULL",
    [familyId],
  );
  await databasePool().query(
    "UPDATE public.mcp_oauth_refresh_tokens SET revoked_at = NOW() WHERE family_id = $1 AND revoked_at IS NULL",
    [familyId],
  );
}

export async function refreshMcpTokens(
  client: McpOAuthClient,
  refreshToken: string,
): Promise<McpTokenResponse> {
  if (!client.grantTypes.includes("refresh_token")) {
    throw new McpOAuthError(OAuthErrorCode.UnauthorizedClient, "This client may not use refresh tokens.");
  }
  if (!refreshToken) {
    throw new McpOAuthError(OAuthErrorCode.InvalidRequest, "refresh_token is required.");
  }
  const tokenHash = hashMcpSecret(refreshToken);
  const { rows } = await databasePool().query<RefreshTokenRow>(
    `UPDATE public.mcp_oauth_refresh_tokens
        SET rotated_at = NOW()
      WHERE token_hash = $1
        AND client_id = $2
        AND revoked_at IS NULL
        AND rotated_at IS NULL
        AND expires_at > NOW()
      RETURNING user_id, scope, resource, family_id`,
    [tokenHash, client.clientId],
  );
  const row = rows[0];
  if (row) {
    return issueMcpTokens(client, row.user_id, row.scope, row.resource, row.family_id);
  }
  const { rows: probe } = await databasePool().query<TokenProbeRow>(
    `SELECT family_id, revoked_at, rotated_at, expires_at
       FROM public.mcp_oauth_refresh_tokens
      WHERE token_hash = $1 AND client_id = $2`,
    [tokenHash, client.clientId],
  );
  const existing = probe[0];
  if (existing?.rotated_at) {
    // Refresh-token reuse: assume the token family is compromised and revoke
    // every access and refresh token derived from the same authorization.
    await revokeMcpTokenFamily(existing.family_id);
  }
  throw new McpOAuthError(OAuthErrorCode.InvalidGrant, "The refresh token is invalid, expired, or revoked.");
}

export async function revokeMcpToken(client: McpOAuthClient, token: string): Promise<void> {
  if (!token) {
    throw new McpOAuthError(OAuthErrorCode.InvalidRequest, "token is required.");
  }
  const tokenHash = hashMcpSecret(token);
  const { rows } = await databasePool().query<{ family_id: string }>(
    `SELECT family_id
       FROM public.mcp_oauth_refresh_tokens
      WHERE token_hash = $1 AND client_id = $2`,
    [tokenHash, client.clientId],
  );
  const refresh = rows[0];
  if (refresh) {
    await revokeMcpTokenFamily(refresh.family_id);
    return;
  }
  await databasePool().query(
    `UPDATE public.mcp_oauth_access_tokens
        SET revoked_at = NOW()
      WHERE token_hash = $1 AND client_id = $2 AND revoked_at IS NULL`,
    [tokenHash, client.clientId],
  );
}

interface AccessTokenRow {
  user_id: string;
  client_id: string;
  scope: string;
  resource: string;
  expires_at: Date;
}

export async function verifyMcpAccessToken(token: string): Promise<AuthInfo> {
  if (!token) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "An access token is required.");
  }
  await ensureDatabaseMigrations();
  const { rows } = await databasePool().query<AccessTokenRow>(
    `SELECT user_id, client_id, scope, resource, expires_at
       FROM public.mcp_oauth_access_tokens
      WHERE token_hash = $1
        AND revoked_at IS NULL
        AND expires_at > NOW()`,
    [hashMcpSecret(token)],
  );
  const row = rows[0];
  if (!row) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, "The access token is invalid or expired.");
  }
  void databasePool().query(
    "UPDATE public.mcp_oauth_access_tokens SET last_used_at = NOW() WHERE token_hash = $1",
    [hashMcpSecret(token)],
  ).catch(() => undefined);
  return {
    token,
    clientId: row.client_id,
    scopes: row.scope.split(/\s+/).filter(Boolean),
    expiresAt: Math.floor(row.expires_at.getTime() / 1000),
    resource: new URL(row.resource),
    extra: { userId: row.user_id },
  };
}

export async function pruneMcpOAuthState(): Promise<void> {
  await ensureDatabaseMigrations();
  await databasePool().query(
    "DELETE FROM public.mcp_oauth_authorization_codes WHERE expires_at < NOW() - INTERVAL '1 day'",
  );
  await databasePool().query(
    "DELETE FROM public.mcp_oauth_access_tokens WHERE expires_at < NOW() - INTERVAL '7 days'",
  );
  await databasePool().query(
    "DELETE FROM public.mcp_oauth_refresh_tokens WHERE expires_at < NOW() - INTERVAL '30 days'",
  );
}
