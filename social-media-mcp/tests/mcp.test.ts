import assert from "node:assert/strict";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { config } from "../src/config/env.js";

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not determine a free test port.");
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}

test("built MCP server exposes tools and validates dry-run publishing", async () => {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const callbackPort = await availablePort();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    cwd: projectRoot,
    stderr: "pipe",
    env: { ...process.env, OAUTH_CALLBACK_PORT: String(callbackPort) },
  });
  const client = new Client({ name: "social-media-mcp-test", version: "1.0.0" });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      "social_account_info",
      "social_authorization_start",
      "social_authorization_status",
      "social_authorization_wait",
      "social_cancel_scheduled_post",
      "social_connection_status",
      "social_publish",
      "social_recent_posts",
      "social_retry_scheduled_post",
      "social_schedule_media",
      "social_schedule_posts",
      "social_scheduled_posts_status",
      "social_token_store_status",
    ]);

    const facebookAuthorization = await client.callTool({
      name: "social_authorization_start",
      arguments: { platform: "facebook" },
    });
    const facebookAuthorizationBody = JSON.parse(String(
      facebookAuthorization.content[0]?.type === "text" ? facebookAuthorization.content[0].text : "{}",
    )) as { authorizationUrl?: string; callback?: string };
    const facebookRedirectUri = new URL(facebookAuthorizationBody.authorizationUrl ?? "").searchParams.get("redirect_uri");
    assert.equal(facebookAuthorizationBody.callback, facebookRedirectUri);
    assert.equal(
      facebookRedirectUri,
      `${config.redirectBaseUrl}/oauth/meta/callback`,
    );

    const authorizationStatus = await client.callTool({
      name: "social_authorization_status",
      arguments: { authorizationSessionId: "unknown-session" },
    });
    const authorizationStatusBody = JSON.parse(String(
      authorizationStatus.content[0]?.type === "text" ? authorizationStatus.content[0].text : "{}",
    )) as { success?: boolean; error?: string };
    assert.equal(authorizationStatusBody.success, false);
    assert.match(authorizationStatusBody.error ?? "", /session not found or expired/);

    const result = await client.callTool({
      name: "social_publish",
      arguments: { platforms: ["facebook", "linkedin"], text: "Validation only" },
    });
    assert.equal(result.isError, undefined);
    const body = JSON.parse(String(result.content[0]?.type === "text" ? result.content[0].text : "{}")) as {
      results: Array<{ platform: string; dryRun?: boolean; published: boolean }>;
    };
    assert.deepEqual(body.results.map(({ platform, dryRun, published }) => ({ platform, dryRun, published })), [
      { platform: "facebook", dryRun: true, published: false },
      { platform: "linkedin", dryRun: true, published: false },
    ]);

    const instagram = await client.callTool({
      name: "social_publish",
      arguments: { platforms: ["instagram"], text: "Text-only validation" },
    });
    const instagramBody = JSON.parse(String(instagram.content[0]?.type === "text" ? instagram.content[0].text : "{}")) as {
      results: Array<{ published: boolean; issues?: string[] }>;
    };
    assert.equal(instagramBody.results[0]?.published, false);
    assert.match(instagramBody.results[0]?.issues?.join(" ") ?? "", /requires an image URL/);
  } finally {
    await client.close();
  }
});