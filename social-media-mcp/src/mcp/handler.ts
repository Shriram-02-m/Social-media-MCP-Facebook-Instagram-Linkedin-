import {
  McpServer,
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  requireBearerAuth,
  type AuthInfo,
  type McpServerFactory,
} from "@modelcontextprotocol/server";
import { config } from "../config/env.js";
import { verifyMcpAccessToken } from "../auth/mcp-oauth.js";
import { registerTools } from "../tools/register.js";

// Per-request server factory. The bearer-auth gate verifies the opaque access
// token and puts the owning better-auth user id in `authInfo.extra.userId`.
// Every tool then reads and writes only that user's tokens, scheduled posts,
// and connected accounts.
const factory: McpServerFactory = (context) => {
  const userId = typeof context.authInfo?.extra?.["userId"] === "string"
    ? context.authInfo.extra["userId"]
    : undefined;
  if (!userId) throw new Error("MCP request is missing an authenticated user.");
  const server = new McpServer({ name: "social-media-mcp", version: "1.0.0" });
  registerTools(server, { userId, remote: true });
  return server;
};

export const mcpHandler = createMcpHandler(factory, { legacy: "stateless" });

const mcpUrl = new URL(config.mcpPublicUrl);
const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(mcpUrl);

export const mcpAuthGate = requireBearerAuth({
  verifier: { verifyAccessToken: verifyMcpAccessToken },
  requiredScopes: [config.mcpOauthScope],
  expectedResource: mcpUrl,
  resourceMetadataUrl,
});

export async function authenticateMcpRequest(request: Request): Promise<AuthInfo | Response> {
  return mcpAuthGate(request);
}
