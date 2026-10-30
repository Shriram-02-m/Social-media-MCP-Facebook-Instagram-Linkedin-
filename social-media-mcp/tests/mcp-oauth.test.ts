import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { config } from "../src/config/env.js";
import {
  McpOAuthError,
  hashMcpSecret,
  isAllowedMcpRedirectUri,
  isRegisteredMcpRedirectUri,
  mcpAuthorizationServerMetadata,
  mcpProtectedResourceMetadata,
  normalizeMcpResource,
  normalizeMcpScope,
  type McpOAuthClient,
} from "../src/auth/mcp-oauth.js";

test("hashes bearer-style values with a stable SHA-256 digest", () => {
  const first = hashMcpSecret("a-secret-value");
  assert.equal(first, hashMcpSecret("a-secret-value"));
  assert.notEqual(first, hashMcpSecret("another-secret-value"));
  assert.match(first, /^[0-9a-f]{64}$/);
});

test("normalizes the supported scope and rejects anything else", () => {
  assert.equal(normalizeMcpScope(), config.mcpOauthScope);
  assert.equal(normalizeMcpScope(config.mcpOauthScope), config.mcpOauthScope);
  assert.throws(
    () => normalizeMcpScope("read write"),
    (error: unknown) => error instanceof McpOAuthError && error.code === "invalid_scope",
  );
});

test("normalizes resource indicators and rejects credentials or fragments", () => {
  assert.equal(normalizeMcpResource("https://example.com/mcp/"), "https://example.com/mcp");
  assert.equal(normalizeMcpResource("https://example.com/mcp#fragment"), "https://example.com/mcp");
  assert.throws(
    () => normalizeMcpResource("https://user:pass@example.com/mcp"),
    (error: unknown) => error instanceof McpOAuthError,
  );
  assert.throws(() => normalizeMcpResource("not-a-url"), (error: unknown) => error instanceof McpOAuthError);
});

test("only allows registered Claude origins and loopback callbacks", () => {
  assert.equal(isAllowedMcpRedirectUri("https://claude.ai/api/mcp/auth_callback"), true);
  assert.equal(isAllowedMcpRedirectUri("https://claude.com/api/mcp/auth_callback"), true);
  assert.equal(isAllowedMcpRedirectUri("https://evil.example/callback"), false);
  assert.equal(isAllowedMcpRedirectUri("http://localhost:3118/callback"), true);
  assert.equal(isAllowedMcpRedirectUri("http://127.0.0.1:3118/callback"), true);
  assert.equal(isAllowedMcpRedirectUri("http://example.com/callback"), false);
  assert.equal(isAllowedMcpRedirectUri("https://claude.ai/callback#fragment"), false);
  assert.equal(isAllowedMcpRedirectUri("https://user:pass@claude.ai/callback"), false);
});

test("matches redirect URIs against the registered client allowlist", () => {
  const client: McpOAuthClient = {
    clientId: "mcp_test",
    redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    tokenEndpointAuthMethod: "none",
  };
  assert.equal(isRegisteredMcpRedirectUri(client, "https://claude.ai/api/mcp/auth_callback"), true);
  assert.equal(isRegisteredMcpRedirectUri(client, "https://claude.ai/api/mcp/other"), false);
  assert.equal(isRegisteredMcpRedirectUri(client, "https://evil.example/callback"), false);
});

test("advertises path-aware protected-resource and authorization-server metadata", () => {
  const resource = mcpProtectedResourceMetadata();
  assert.equal(resource.resource, config.mcpPublicUrl);
  assert.deepEqual(resource.scopes_supported, [config.mcpOauthScope]);
  assert.deepEqual(resource.authorization_servers, [new URL(config.mcpPublicUrl).origin]);

  const metadata = mcpAuthorizationServerMetadata();
  assert.equal(metadata.issuer, new URL(config.mcpPublicUrl).origin);
  assert.equal(metadata.authorization_endpoint, `${metadata.issuer}/oauth/authorize`);
  assert.equal(metadata.token_endpoint, `${metadata.issuer}/oauth/token`);
  assert.equal(metadata.registration_endpoint, `${metadata.issuer}/oauth/register`);
  assert.equal(metadata.revocation_endpoint, `${metadata.issuer}/oauth/revoke`);
  assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
});

test("migration 010 stores only digests and grants no browser role access", async () => {
  const sql = await readFile(new URL("../migrations/010_mcp_oauth.sql", import.meta.url), "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.mcp_oauth_clients/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.mcp_oauth_authorization_codes/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.mcp_oauth_access_tokens/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.mcp_oauth_refresh_tokens/i);
  assert.match(sql, /code_hash TEXT PRIMARY KEY/i);
  assert.match(sql, /token_hash TEXT PRIMARY KEY/i);
  assert.match(sql, /client_secret_hash TEXT/i);
  assert.match(sql, /REVOKE ALL ON TABLE public\.mcp_oauth_clients FROM PUBLIC, anon, authenticated/i);
  assert.match(sql, /GRANT ALL ON TABLE public\.mcp_oauth_refresh_tokens TO service_role/i);
  assert.doesNotMatch(sql, /\bDROP\s+TABLE\b|\bDELETE\s+FROM\b|\bDROP\s+COLUMN\b/i);
});
