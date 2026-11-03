import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

// A tool result body parsed from the stdio client's first text content block.
function resultBody(result: { content: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  return JSON.parse(String(
    result.content[0]?.type === "text" ? result.content[0].text : "{}",
  )) as Record<string, unknown>;
}

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

async function readFileText(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

test("scheduler accepts optional images and stores text-only rows with no media", async () => {
  const scheduler = await readFileText("../src/scheduler.ts");

  assert.match(scheduler, /export async function schedulePosts\(/);
  assert.match(scheduler, /image\?: string \| NewScheduledImage/);
  assert.match(scheduler, /mediaType: document \? "document" : imageInput \? "image" : "none"/);
  assert.match(scheduler, /contentType: imageInput \? contentType : "application\/octet-stream"/);
  // Text-only is rejected for Instagram at scheduling time, before tokens/DB.
  assert.match(scheduler, /if \(!imageInput && post\.platform === "instagram"\)/);
  assert.match(scheduler, /Instagram requires an image reference; text-only posts are not supported\./);
  // Local tunnel requirement applies only when an image reference is present.
  assert.match(scheduler, /if \(imageInput && config\.scheduledImageStorage === "local"/);
});

test("publishing handles text-only jobs through the existing platform publishers", async () => {
  const scheduler = await readFileText("../src/scheduler.ts");
  const meta = await readFileText("../src/platforms/meta.ts");
  const linkedin = await readFileText("../src/platforms/linkedin.ts");

  // The no-image branches call the text-only platform publishers directly.
  assert.match(scheduler, /result = await publishLinkedIn\(job\.userId, job\.text\);/);
  assert.match(scheduler, /result = await publishMeta\(job\.userId, job\.platform as MetaPlatform, job\.text, undefined\);/);
  // Facebook publishes text-only posts to the Page feed; Instagram still needs a URL.
  assert.match(meta, /message: text \?\? ""/);
  assert.match(meta, /Instagram publishing requires a publicly reachable HTTPS image URL\./);
  // LinkedIn text-only posts use the Posts API without media.
  assert.match(linkedin, /export async function publishLinkedIn\(ownerId: string, text\?: string, imagePath\?: string/);
});

test("social_schedule_posts accepts at most one image reference and no image is valid", async () => {
  const register = await readFileText("../src/tools/register.ts");

  assert.match(register, /Provide at most one of imageUrl, imageStoragePath, or imagePath\./);
  assert.doesNotMatch(register, /Provide exactly one of imageUrl, imageStoragePath, or imagePath\./);
  // The image variable may be undefined and is passed through as-is.
  assert.match(register, /let image: string \| NewScheduledImage \| undefined;/);
  assert.match(register, /await schedulePosts\(userId, posts, image, document\)/);
  // Descriptions document the text-only behavior and the Instagram exception.
  assert.match(register, /omit every image reference for a text-only Facebook or LinkedIn post; Instagram always requires an image/);
});

test("built MCP server schedules text-only posts without an image", async () => {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const callbackPort = await availablePort();
  const tokenFile = join(await mkdtemp(join(tmpdir(), "social-mcp-text-only-")), "tokens.enc");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    cwd: projectRoot,
    stderr: "pipe",
    // Deterministic settings: the token vault is an empty temp file, and
    // dotenv never overrides an explicitly exported value, so real .env cloud
    // backends are ignored. DATABASE_URL stays configured because the stdio
    // server initializes the scheduler store at startup; the "not connected"
    // token check below throws before any row would be inserted.
    env: {
      ...process.env,
      OAUTH_CALLBACK_PORT: String(callbackPort),
      SOCIAL_MCP_TOKEN_FILE: tokenFile,
      SUPABASE_URL: "",
      SUPABASE_SERVICE_ROLE_KEY: "",
      TOKEN_STORE_BACKEND: "local",
      SCHEDULED_IMAGE_STORAGE: "local",
      SCHEDULER_MODE: "local",
      OAUTH_CALLBACK_MODE: "local",
    },
  });
  const client = new Client({ name: "social-media-mcp-text-only-test", version: "1.0.0" });
  let serverStderr = "";
  transport.stderr?.setEncoding("utf8");
  transport.stderr?.on("data", (chunk) => { serverStderr += chunk; });

  try {
    await client.connect(transport);
    const scheduledAt = new Date(Date.now() + 3_600_000).toISOString();

    // A text-only Facebook post passes image validation and reaches the token
    // check ("not connected"), proving no image is required before scheduling.
    const facebook = await client.callTool({
      name: "social_schedule_posts",
      arguments: {
        posts: [{ platform: "facebook", scheduledAt, text: "Text-only validation" }],
      },
    });
    assert.equal(facebook.isError, undefined);
    const facebookBody = resultBody(facebook);
    assert.equal(facebookBody.success, false);
    assert.match(String(facebookBody.error), /facebook is not connected; authorize it before scheduling/);

    // LinkedIn behaves identically for text-only posts.
    const linkedin = await client.callTool({
      name: "social_schedule_posts",
      arguments: {
        posts: [{ platform: "linkedin", scheduledAt, text: "Text-only validation" }],
      },
    });
    const linkedinBody = resultBody(linkedin);
    assert.equal(linkedinBody.success, false);
    assert.match(String(linkedinBody.error), /linkedin is not connected; authorize it before scheduling/);

    // Instagram keeps its image requirement for scheduled posts.
    const instagram = await client.callTool({
      name: "social_schedule_posts",
      arguments: {
        posts: [{ platform: "instagram", scheduledAt, text: "Text-only validation" }],
      },
    });
    const instagramBody = resultBody(instagram);
    assert.equal(instagramBody.success, false);
    assert.match(String(instagramBody.error), /Instagram requires an image reference/);

    // Two image references are still rejected to catch ambiguous input.
    const ambiguous = await client.callTool({
      name: "social_schedule_posts",
      arguments: {
        posts: [{ platform: "facebook", scheduledAt, text: "Text-only validation" }],
        imageUrl: "https://127.0.0.1:9/unreachable.png",
        imageStoragePath: "scheduled/local-owner/" + "0".repeat(64) + ".png",
      },
    });
    const ambiguousBody = resultBody(ambiguous);
    assert.equal(ambiguousBody.success, false);
    assert.match(String(ambiguousBody.error), /Provide at most one of imageUrl, imageStoragePath, or imagePath\./);
  } catch (error) {
    throw new Error(`stdio test failed: ${String(error)}; server stderr: ${serverStderr}`, { cause: error as Error });
  } finally {
    await client.close();
  }
});
