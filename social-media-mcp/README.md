# Unified Social Media MCP

An independent Node.js/TypeScript MCP server for Instagram professional accounts, Facebook Pages, and LinkedIn members or organizations. It uses official APIs, provider OAuth, encrypted local token storage, and dry-run-first publishing.

## Requirements

- Node.js 20+ and npm.
- A Meta developer app for Facebook, an Instagram app configured for Instagram Login, and a LinkedIn developer app.
- Public HTTPS image URLs for Instagram/Facebook image posts; a local image file for LinkedIn image posts.
- A public HTTPS callback/tunnel URL for Instagram and LinkedIn OAuth. Facebook development OAuth can use localhost.

Install and build from this directory:

```powershell
npm install
Copy-Item .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
npm run build
npm test
```

Put the generated 64-character hex key in `SOCIAL_MCP_TOKEN_ENCRYPTION_KEY`. The encrypted vault defaults to `%USERPROFILE%\.social-media-mcp\tokens.enc`, outside the project. Losing the key makes the vault unrecoverable. Keep `.env` and the vault private.

Set `DATABASE_URL` to your PostgreSQL connection string. On startup, the scheduler applies the idempotent SQL in `migrations/001_scheduled_posts.sql`; scheduled post records and their state are stored in PostgreSQL, not a JSON schedule file. Scheduled image files remain in local scheduler storage, so the MCP server and media tunnel must continue running and the local media directory must remain available.

## Local Image Server and ngrok

The MCP server uses stdio; it does not listen on a TCP port. The same Node.js process starts a local HTTP server for OAuth callbacks and scheduled-image delivery. `IMAGE_SERVER_PORT` configures this listener (default `8787`). `OAUTH_CALLBACK_PORT` is a backwards-compatible fallback when `IMAGE_SERVER_PORT` is not set.

Set these values in `.env`:

```dotenv
IMAGE_SERVER_PORT=8787
IMAGE_PUBLIC_BASE_URL=https://YOUR-NGROK-HOST
OAUTH_REDIRECT_BASE_URL=https://YOUR-NGROK-HOST
SCHEDULE_IMAGE_TIMEOUT_MS=10000
SCHEDULE_IMAGE_MAX_BYTES=10485760
SCHEDULE_IMAGE_MAX_ATTEMPTS=3
SCHEDULE_IMAGE_RETRY_BASE_DELAY_MS=1000
SCHEDULE_IMAGE_RETRY_MAX_DELAY_MS=30000
```

Replace the example port with the configured image-server port and the hostname with the HTTPS URL assigned/reserved for your ngrok tunnel. Keep `IMAGE_PUBLIC_BASE_URL` and `OAUTH_REDIRECT_BASE_URL` aligned when using one tunnel for media and OAuth. Do not commit `.env`. If ngrok assigns a different URL, update both values and restart the MCP server so it uses the new configuration.

Start the MCP server through VS Code/OpenCode as usual. In a separate PowerShell terminal, start ngrok and leave it running while scheduled Meta posts may execute:

```powershell
$settings = @{}
Get-Content .env | ForEach-Object {
  if ($_ -match '^(IMAGE_SERVER_PORT|OAUTH_CALLBACK_PORT)=(.*)$') {
    $settings[$matches[1]] = $matches[2].Trim()
  }
}
$imageServerPort = $settings['IMAGE_SERVER_PORT']
if (-not $imageServerPort) { $imageServerPort = $settings['OAUTH_CALLBACK_PORT'] }
if (-not $imageServerPort) { throw 'Set IMAGE_SERVER_PORT in .env before starting ngrok.' }
ngrok http $imageServerPort
```

For a reserved ngrok domain:

Use the same `$imageServerPort` with a reserved domain:

```powershell
ngrok http --url=YOUR-NGROK-HOST $imageServerPort
```

The MCP process must also remain running at scheduled times. The image server and OAuth listener share `IMAGE_SERVER_PORT`; ngrok must forward to that port, not to the MCP stdio transport. No cloud image storage is used. The scheduler checks the image file, local route, and (for Instagram/Facebook) public ngrok route before publishing. It verifies HTTP 200, allowed MIME type, matching image bytes, and the configured size limit, with request timeouts. Temporary connection/5xx failures and public ngrok 404s get bounded exponential-backoff retries; a local-route 404 and invalid image data fail without retrying.

## Facebook App Setup

Create a Meta app in the [Meta for Developers dashboard](https://developers.facebook.com/apps/), configure Facebook Login, and add the exact HTTPS callback URL `https://YOUR-NGROK-HOST/oauth/meta/callback` to its valid OAuth redirect URIs. Also add the tunnel hostname (without `https://` or a path) to the Facebook app's **App Domains**. The tunnel must forward requests to the configured `IMAGE_SERVER_PORT`. Copy the app ID and secret to `META_APP_ID` and `META_APP_SECRET`. These credentials are used for Facebook only.

Facebook Page posting requires a Page access token and a Page task that permits content creation. The server requests `pages_show_list`, `pages_read_engagement`, and `pages_manage_posts`. `pages_manage_posts` depends on the other two permissions.

## Instagram App Setup

This server uses **Instagram API with Instagram Login** for Instagram, independently of the Facebook app. In the Meta developer dashboard, configure the app's Instagram product/API setup with Instagram Login and Business Login settings. Add the app's Instagram App ID and App Secret to `INSTAGRAM_APP_ID` and `INSTAGRAM_APP_SECRET` (not the `META_APP_*` fields).

Set `OAUTH_REDIRECT_BASE_URL` and `IMAGE_PUBLIC_BASE_URL` to your public HTTPS tunnel URL and forward it to the configured `IMAGE_SERVER_PORT`. Add the exact callback URL `https://YOUR-NGROK-HOST/oauth/meta/callback` to the Instagram app's OAuth redirect URIs. Instagram Login needs HTTPS; plain localhost is not sufficient. The Instagram account must be a **professional Business or Creator account**, but it does not need to be linked to a Facebook Page.

The server requests `instagram_business_basic` for account/media access and `instagram_business_content_publish` for publishing. Instagram image posts require a publicly reachable HTTPS image URL; text-only Instagram posts are not supported. Meta may require app review and Advanced Access when serving accounts beyond the app's own or managed accounts. This Instagram Login integration does not use Facebook Page tokens or permissions.

Start OAuth with `social_authorization_start`, open its URL promptly, and keep the same MCP server process running until the callback finishes. The request remains valid for 15 minutes. Pass its `authorizationSessionId` to `social_authorization_status`, or call `social_authorization_wait` with a short timeout (up to 20 seconds) and call it again if it is still pending. Long MCP tool calls may be timed out by the client. Restarting the MCP process invalidates pending OAuth state; start a fresh request after a restart.

In development mode, Meta generally limits app use to app-role users and test assets. Supporting people outside the app roles requires the appropriate Advanced Access and App Review; business verification and annual Data Use Checkup may apply.

## LinkedIn App Setup

Create an app in the [LinkedIn Developer Portal](https://www.linkedin.com/developers/apps), associate it with a LinkedIn Page, and add the exact HTTPS redirect URL `https://YOUR-NGROK-HOST/oauth/linkedin/callback`.

Set `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, and `OAUTH_REDIRECT_BASE_URL=https://YOUR-NGROK-HOST`. Forward that HTTPS tunnel to `http://localhost:IMAGE_SERVER_PORT` (replace with the configured numeric port). The app's Auth tab must allow each requested scope. The default `LINKEDIN_SCOPES` is `openid profile w_member_social`.

The **Share on LinkedIn** product supplies member-post access subject to its current grant. Organization publishing needs the Community Management API product and `w_organization_social`. Organization post reads use `r_organization_social`; member post reads use `r_member_social`, which LinkedIn marks restricted to approved users. The latter scopes are not requested by default. LinkedIn can require separate product/scope approval.

An organization author URN (`urn:li:organization:...`) also requires an approved Page role, such as `ADMINISTRATOR`, `DIRECT_SPONSORED_CONTENT_POSTER`, or `CONTENT_ADMINISTRATOR`, and the matching scope. Set `LINKEDIN_AUTHOR_URN` or pass `authorUrn` to the account, read, or publish tool. If omitted, the authenticated member URN is used. LinkedIn REST calls send `Linkedin-Version` (default `202609`) and `X-Restli-Protocol-Version: 2.0.0`. Tokens expire; reconnect when status reports an expired/invalid token. Programmatic refresh tokens are available only to selected LinkedIn partners and are not assumed here.

## OpenCode

`opencode.json` is the OpenCode local MCP configuration for this Windows workspace. It starts `node dist/index.js` with this project as the working directory, so `.env` is loaded. If the directory moves, update `cwd`. Build first, then from this project folder run:

```powershell
npm install
npm run build
opencode mcp list
opencode mcp debug social-media
```

Restart OpenCode after config changes. The server's tools are named with the `social-media_` prefix. OpenCode uses its supported local-server format (`type: "local"`, `command`, `cwd`, `enabled`). `.vscode/mcp.json` separately registers this stdio server when this project folder is opened in VS Code.

## Tools

- `social_authorization_start`: start provider OAuth and return a browser URL.
- `social_connection_status`: make a harmless identity check and report granted scopes, token validity, and account/Page availability.
- `social_account_info`: return the Instagram account, Facebook account and Pages, or LinkedIn member identity.
- `social_recent_posts`: read posts only when the connected token has sufficient provider access.
- `social_publish`: validate or publish to one or more platforms, with independent outcomes.
- `social_schedule_posts`: persist posts and a local image for publishing at specified ISO-8601 times. The MCP process, its local image server, and ngrok tunnel must be running at the due times; Instagram/Facebook fetch the image from an unguessable HTTPS tunnel URL.
- `social_scheduled_posts_status`: inspect scheduled, published, and failed jobs, including validation outcome, retry count, and failure stage without exposing credentials or the tokenized image URL.
- `social_retry_scheduled_post`: requeue a failed post only when the recorded failure happened during image validation, before a platform publish request was made. Publishing-stage failures are deliberately blocked because their outcome may be uncertain; verify the destination before creating another post.
- `social_token_store_status`: show token presence/scopes/expiry without revealing token values.

`social_publish` defaults to `dryRun: true`. A real publish requires both `dryRun: false` and `confirmPublish: true` in the same call. No setup or automated test publishes. A success is reported only when Meta returns a post/media ID, or LinkedIn returns a successful response with `x-restli-id`.

Scheduled jobs are persisted in the PostgreSQL `scheduled_posts` table and resume when the MCP server starts. Image validation results, retry counts, and failure stage are recorded with each job. Keep the server and public tunnel running at scheduled times. If the process is stopped during publishing, the job is marked failed for manual verification rather than retried automatically, to avoid duplicate posts. Existing jobs in an older `scheduled-posts.json` file are not imported automatically.

Platform-specific publishing:

- Instagram: `imageUrl` must be HTTPS and publicly fetchable. The server creates a media container, publishes it, and requires the returned media ID.
- Facebook: text uses the Page `/feed`; an image uses `/photos` with `imageUrl`. The returned post/photo ID is required.
- LinkedIn: text-only posts use `/rest/posts`. Image posts require a local `imagePath`; the server initializes the Images API upload, transfers the file, then creates the post.

For a multi-platform request, each target is attempted independently. One platform's API rejection does not mask another platform's result.

## Testing and Troubleshooting

`npm test` exercises offline validation; `npm run typecheck` checks strict TypeScript. `npm run build` prepares the configured OpenCode command. No real post is needed to test the MCP handshake or dry-run.

- OAuth callback errors: check the exact registered redirect URI and `OAUTH_REDIRECT_BASE_URL`. LinkedIn requires HTTPS; tunnel it to the configured `IMAGE_SERVER_PORT`.
- Local image route connection refused: confirm the MCP process is running and `IMAGE_SERVER_PORT` matches the port passed to `ngrok http`.
- Local route returns 404: the scheduled image token is missing from the running process or the tunnel is aimed at the wrong local application/port. Restart the MCP server with pending jobs loaded, and verify the ngrok target.
- Public route returns 404 while the local route is healthy: the ngrok tunnel may be stopped, forwarding to the wrong port, or using an outdated hostname. Update `IMAGE_PUBLIC_BASE_URL` (and OAuth URL when needed), restart the MCP server, and rerun `ngrok http` against `IMAGE_SERVER_PORT`.
- Invalid MIME, empty image, or size-limit failure: verify the stored image file is PNG, JPEG, or GIF, matches its extension, is non-empty, and is below `SCHEDULE_IMAGE_MAX_BYTES`.
- Temporary local/network/5xx failures retry up to `SCHEDULE_IMAGE_MAX_ATTEMPTS`; adjust `SCHEDULE_IMAGE_RETRY_BASE_DELAY_MS` and `SCHEDULE_IMAGE_RETRY_MAX_DELAY_MS` to tune exponential backoff. A validation-stage failure can be manually requeued with `social_retry_scheduled_post`. Publishing-stage failures require destination-side verification to avoid duplicates.
- The previous Facebook image failure occurred because the local route had the image, but the public ngrok URL returned HTTP 404. Meta could not fetch the image and rejected the photo post; the scheduler recorded “Missing or invalid image file.” A local HTTP 200 alongside a public 404 points to a stopped/misrouted tunnel or stale public URL, not cloud storage or a missing local image.
- No Facebook Pages: verify `pages_show_list`, app mode, and that the authorizing user has Page access.
- Instagram account missing: switch to a professional account, link it to a managed Page, verify requested/granted scopes, then reconnect.
- HTTP 403: the token may lack a granted permission, Page task, LinkedIn API product, or organization role. Do not work around the restriction.
- Instagram media rejected: ensure the URL is public without cookies and serves supported JPEG content.
- Token expired: re-run OAuth. The server records expiries and does not assume refresh support.
- Never include credentials, authorization URLs, OAuth codes, or access tokens in logs or support requests.

## Official Documentation

- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [OpenCode MCP servers](https://opencode.ai/docs/mcp-servers/)
- [Instagram content publishing](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/content-publishing/)
- [Meta Pages posts](https://developers.facebook.com/docs/pages-api/posts/)
- [Meta permissions](https://developers.facebook.com/docs/permissions/reference/)
- [Meta access levels](https://developers.facebook.com/docs/graph-api/overview/access-levels/)
- [LinkedIn authorization code flow](https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow)
- [LinkedIn Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api)
- [LinkedIn Images API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api)
- [LinkedIn organization roles](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-access-control-by-role)