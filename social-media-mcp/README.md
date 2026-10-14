# Unified Social Media MCP

An independent Node.js/TypeScript MCP server for Instagram professional accounts, Facebook Pages, and LinkedIn members or organizations. It uses official APIs, provider OAuth, encrypted local token storage, and dry-run-first publishing.

## Requirements

- Node.js 20+ and npm.
- A Meta developer app for Facebook, an Instagram app configured for Instagram Login, and a LinkedIn developer app.
- A local image file when creating a scheduled post; the selected local or cloud storage backend handles delivery.
- A public HTTPS callback/tunnel URL only when completing OAuth locally. Cloud scheduled delivery does not depend on ngrok.

Install and build from this directory:

```powershell
npm install
Copy-Item .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
npm run build
npm test
```

Put the generated 64-character hex key in `SOCIAL_MCP_TOKEN_ENCRYPTION_KEY`. The encrypted vault defaults to `%USERPROFILE%\.social-media-mcp\tokens.enc`, outside the project. Losing the key makes the vault unrecoverable. Keep `.env` and the vault private.

Set `DATABASE_URL` to your Supabase PostgreSQL connection string. Use the direct connection when IPv6 is available, or the Supabase session pooler for IPv4-only environments; URL-encode special characters in the password and require TLS (`sslmode=require`). The scheduler uses a bounded `pg` connection pool and never prints the connection string. Run `npm run db:check` to test `SELECT NOW()` without displaying credentials.

Scheduled-post records and delivery state are stored in the Supabase `public.scheduled_posts` table. `npm run db:migrate` applies the repeatable migrations `001`-`003`; they preserve rows, add constraints and cloud object references, and create the server-only token table and private Storage bucket. Migration `004` is intentionally manual because it requires a real, deployed Render URL and secrets in Supabase Vault. The app uses an atomic `FOR UPDATE SKIP LOCKED` claim so concurrent processes do not take the same due job.

By default, `SCHEDULER_MODE=local` uses a `setInterval` loop in the MCP process and local images/tokens, so the MCP process, local image server, and ngrok must stay running. The opt-in cloud configuration and deployment steps are described below. Code being present is not evidence that your Render service or Supabase Cron has been deployed.

### Supabase database setup

1. Set `DATABASE_URL` in the private `.env` using the connection URI from Supabase **Project Settings → Database**. Do not commit `.env`.
2. Check connectivity: `npm run db:check`.
3. Run `npm run db:migrate`, then `npm run build` and `npm test`. Migrations `001`-`003` are safe to rerun; the app also applies them when its scheduler starts.
4. Start or restart the MCP server. Existing scheduled-post rows are not copied from another database automatically.

Pool settings are `DATABASE_POOL_MAX` (default `5`), `DATABASE_CONNECTION_TIMEOUT_MS` (default `10000`), and `DATABASE_IDLE_TIMEOUT_MS` (default `30000`).

### Local mode and cloud scheduling

Local mode remains the default. OAuth credentials are encrypted in the local file configured by `SOCIAL_MCP_TOKEN_FILE` (default `%USERPROFILE%\.social-media-mcp\tokens.enc`) using `SOCIAL_MCP_TOKEN_ENCRYPTION_KEY`. Scheduled-image bytes are under `%USERPROFILE%\.social-media-mcp\scheduled-media`; the local scheduler's `setInterval` loop runs with the MCP process. In this mode, Meta scheduled image delivery uses the local image server and ngrok as documented below.

Cloud mode keeps the MCP server for creating/managing posts, but moves the scheduled job execution to a separate Node.js worker on Render. This project uses Node APIs, `pg`, and local file support, so the Node worker avoids assuming that the existing publishing integrations run unchanged in Deno Edge Functions. Supabase Cron calls an authenticated Render endpoint every minute; PostgreSQL row locking still provides the final concurrency protection. `SCHEDULER_MODE=cloud` disables the MCP process's local timer. Cloud jobs store object paths in the private `social-media-images` bucket; Meta receives a short-lived signed URL created at publish time and LinkedIn uploads bytes downloaded server-side. No production scheduled post depends on ngrok or a local image path.

The project code and SQL are prepared for cloud execution, but **deployment, Supabase Vault secrets, Cron activation, and live cloud publishing are manual steps and are not considered complete until verified in your accounts**.

#### Prepare the Supabase database and migrate existing data

Keep `.env` private. Required cloud-side values are `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CLOUD_TOKEN_ENCRYPTION_KEY`, and `WORKER_TRIGGER_SECRET`. Generate independent random keys:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Use the 64-character hex value for `CLOUD_TOKEN_ENCRYPTION_KEY`; use the second value as `WORKER_TRIGGER_SECRET`. Keep the latter identical in Render and Supabase Vault. Never put the service-role key or either secret in source control, client applications, or logs.

1. Set the cloud variables in the local MCP server environment, then run `npm run db:migrate`. Migrations `001`-`003` are repeatable; they preserve scheduled rows, add the cloud object-path column, add the encrypted `oauth_tokens` table, and create the private image bucket. The cloud migration refuses to use a bucket named `social-media-images` if it is public. The database connection needs permission to apply these migrations.
2. Stop any currently running local MCP scheduler before migrating pending jobs. Run `npm run tokens:migrate` while the local encrypted vault and `SOCIAL_MCP_TOKEN_ENCRYPTION_KEY` are still available. It inserts encrypted token records and refuses to overwrite existing cloud token rows unless explicitly invoked with `npm run tokens:migrate -- --overwrite`. The local vault is never removed or modified. LinkedIn refresh is attempted only when LinkedIn issued a refresh token; expired or revoked Meta tokens and tokens without a provider refresh token require provider reauthorization.
3. Run `npm run images:migrate` on the computer that has the original scheduled image files. It uploads scheduled jobs and retryable image-validation failures, stores their cloud object paths, and leaves both the local files and database `image_path` values intact. Run this before enabling cloud Cron. Jobs whose source files are missing are reported as errors and need manual repair or rescheduling.
4. Configure the MCP process for cloud job creation and management:

```dotenv
TOKEN_STORE_BACKEND=supabase
SCHEDULED_IMAGE_STORAGE=supabase
SCHEDULER_MODE=cloud
```

New scheduled images are uploaded at scheduling time. Keep using a local image file as the `social_schedule_posts` input. For cloud creation, the MCP host needs `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and database access. The local scheduler is disabled, so stop it and configure this mode before relying on the cloud worker.

#### Deploy the Render Node worker

1. Push the project to GitHub and create a Render Blueprint from `render.yaml`, or create a paid Node web service with the same build/start/health settings. The blueprint uses a paid Starter web service so it does not sleep between Cron requests.
2. Set these private Render environment variables: `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CLOUD_TOKEN_ENCRYPTION_KEY`, and `WORKER_TRIGGER_SECRET`. Also set `LINKEDIN_CLIENT_ID` and `LINKEDIN_CLIENT_SECRET` if you want the worker to refresh LinkedIn tokens that include a refresh token. Set the Render service to use the values of `SCHEDULER_MODE=cloud`, `TOKEN_STORE_BACKEND=supabase`, and `SCHEDULED_IMAGE_STORAGE=supabase` from the blueprint.
3. Confirm `https://<render-service>/health` returns `{"status":"ok"}`. The worker has no local timer; `POST /worker/run` requires `Authorization: Bearer <WORKER_TRIGGER_SECRET>` and returns `202` after accepting a processing run. Its logs include run/job IDs and statuses, never tokens or signed image URLs.
4. In Supabase Dashboard → Vault, add secrets named `social_worker_url` (the Render HTTPS base URL) and `social_worker_secret` (the same random value as Render's `WORKER_TRIGGER_SECRET`). Enable Supabase Vault, `pg_cron`, and `pg_net` if not already enabled.
5. Only after the Render service is deployed and both Vault secrets exist, run `migrations/004_supabase_cron.sql` in the Supabase SQL Editor. It schedules a one-minute HTTPS trigger and is safe to rerun. It deliberately fails rather than installing a job with a placeholder endpoint or missing secret.
6. Verify in Supabase Cron that `social-media-cloud-worker` runs every minute; inspect `cron.job_run_details`, the recent HTTP statuses in `net._http_response`, and the Render service logs. A `202` confirms the run was accepted, not that a post was published. Verify a test post end-to-end with a future schedule and authorized test content before relying on production publishing. Disable the job with `SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'social-media-cloud-worker';`.

The worker atomically claims at most 10 due posts per invocation. Stale `publishing` jobs become failed after 30 minutes and are **not** automatically requeued because the provider outcome could be uncertain. `social_retry_scheduled_post` only permits retry after recorded pre-publish token or image validation failure; for publishing failures, check the platform first and create a replacement only after confirming no post exists. LinkedIn tokens with a provider-issued refresh token are refreshed before expiry; without one, reauthorize. Meta long-lived/Page token expiry is checked and requires reauthorization if expired. `social_cancel_scheduled_post` can cancel only jobs still in `scheduled` status. Images are retained in Storage after publishing so existing result records remain auditable; no automatic retention deletion is configured.

#### Remaining operational checks and limits

- The local token vault and image files are not deleted by migration. Keep a protected backup and rotate the cloud encryption key only with a planned decrypt/re-encrypt procedure.
- Private Storage is accessed with the server-only service-role key; the worker creates one-hour signed URLs for Meta and validates them before publishing. Never expose the service-role key to a browser or frontend.
- Provider API restrictions, token expiration/revocation, insufficient scopes, rate limits, and social-platform outages can still prevent delivery. Add/verify provider reauthorization in the deployment environment when a token expires.
- Pending local image rows that could not be migrated must be resolved before Cron is enabled. The original `image_path` is retained for rollback, but a cloud worker uses `image_storage_path`.
- Supabase Cron and Render deployment cannot be activated from this code workspace. Cloud operation must be confirmed in the Render dashboard, Supabase Cron run history, and an authorized test publication.

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

For **local mode**, the MCP process must also remain running at scheduled times. The image server and OAuth listener share `IMAGE_SERVER_PORT`; ngrok must forward to that port, not to the MCP stdio transport. Local mode does not use cloud image storage. It checks the image file, local route, and (for Instagram/Facebook) public ngrok route before publishing.

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
- `social_schedule_posts`: persist posts and an image for publishing at specified ISO-8601 times. Local mode uses the local image server and ngrok; cloud mode uploads the image to private Supabase Storage and does not need the MCP host to stay on.
- `social_scheduled_posts_status`: inspect scheduled, published, and failed jobs, including validation outcome, retry count, and failure stage without exposing credentials or the tokenized image URL.
- `social_cancel_scheduled_post`: cancel a post only while it remains in `scheduled` status.
- `social_retry_scheduled_post`: requeue a failed post only when token or image validation failed before a platform publish request was made. Publishing-stage failures are deliberately blocked because their outcome may be uncertain; verify the destination before creating another post.
- `social_token_store_status`: show token presence/scopes/expiry without revealing token values.

`social_publish` defaults to `dryRun: true`. A real publish requires both `dryRun: false` and `confirmPublish: true` in the same call. No setup or automated test publishes. A success is reported only when Meta returns a post/media ID, or LinkedIn returns a successful response with `x-restli-id`.

Scheduled jobs are persisted in the PostgreSQL `scheduled_posts` table. Image validation results, retry counts, and failure stage are recorded with each job. If a worker stops during publishing, the job is marked failed for manual verification rather than retried automatically, to avoid duplicate posts. Existing jobs in an older `scheduled-posts.json` file are not imported automatically.

Platform-specific publishing:

- Instagram: `imageUrl` must be HTTPS and publicly fetchable. The server creates a media container, publishes it, and requires the returned media ID.
- Facebook: text uses the Page `/feed`; an image uses `/photos` with `imageUrl`. The returned post/photo ID is required.
- LinkedIn: text-only posts use `/rest/posts`. Manual image posts use a local `imagePath`; scheduled cloud image posts download bytes from private Storage, initialize the Images API upload, transfer the bytes, and then create the post.

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
- Cloud worker returns 401: compare `WORKER_TRIGGER_SECRET` in Render with `social_worker_secret` in Supabase Vault; do not paste either into logs or public support requests.
- Cloud image fetch fails: confirm the `social-media-images` bucket is private, the object path is present, `SUPABASE_SERVICE_ROLE_KEY` is correct on both server processes, and the short-lived signed URL is not being cached or shared.
- The cloud endpoint returns 202: that confirms the worker accepted a run, not that a post was published. Check Render run/job logs and the `social_scheduled_posts_status` tool for final status and provider response ID.
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