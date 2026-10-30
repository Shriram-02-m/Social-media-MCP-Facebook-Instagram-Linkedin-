# Unified Social Media MCP

An independent Node.js/TypeScript MCP server for Instagram professional accounts, Facebook Pages, and LinkedIn members or organizations. It uses official APIs, provider OAuth, encrypted local token storage, and dry-run-first publishing. The same tools are also served over remote Streamable HTTP from the Render worker for Claude.ai and Claude Code; see the Remote MCP section below.

## Requirements

- Node.js 20+ and npm.
- A Meta developer app for Facebook, an Instagram app configured for Instagram Login, and a LinkedIn developer app.
- A local image file when creating a scheduled post; the selected local or cloud storage backend handles delivery.
- A public HTTPS callback URL when completing OAuth. Use a local ngrok tunnel in `local` mode or the deployed Render worker in `cloud` mode. Cloud scheduled delivery does not depend on ngrok.

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

Scheduled-post records and delivery state are stored in the Supabase `public.scheduled_posts` table. `npm run db:migrate` applies the repeatable migrations `001`-`003` and `005`-`010`; they preserve rows, add constraints and cloud object references, add optional LinkedIn document columns and the `application/pdf` Storage MIME type, create the server-only token table and private Storage bucket, add multi-user ownership, create the server-only `oauth_authorization_sessions` table used by cloud OAuth callbacks, create the user-owned `oauth_app_credentials` table for Developer App Settings, and create the remote MCP OAuth tables used by Claude. Migration `004` is intentionally manual because it requires a real, deployed Render URL and secrets in Supabase Vault. The app uses an atomic `FOR UPDATE SKIP LOCKED` claim so concurrent processes do not take the same due job.

By default, `SCHEDULER_MODE=local` uses a `setInterval` loop in the MCP process and local images/tokens, so the MCP process, local image server, and ngrok must stay running. The opt-in cloud configuration and deployment steps are described below. Code being present is not evidence that your Render service or Supabase Cron has been deployed.

### Supabase database setup

1. Set `DATABASE_URL` in the private `.env` using the connection URI from Supabase **Project Settings → Database**. Do not commit `.env`.
2. Check connectivity: `npm run db:check`.
3. Run `npm run db:migrate`, then `npm run build` and `npm test`. Migrations `001`-`003` and `005`-`010` are safe to rerun; the app also applies them when its scheduler starts.
4. Start or restart the MCP server. Existing scheduled-post rows are not copied from another database automatically.

Pool settings are `DATABASE_POOL_MAX` (default `5`), `DATABASE_CONNECTION_TIMEOUT_MS` (default `10000`), and `DATABASE_IDLE_TIMEOUT_MS` (default `30000`).

### Local mode and cloud scheduling

Local mode remains the default. OAuth credentials are encrypted in the local file configured by `SOCIAL_MCP_TOKEN_FILE` (default `%USERPROFILE%\.social-media-mcp\tokens.enc`) using `SOCIAL_MCP_TOKEN_ENCRYPTION_KEY`. Scheduled-image bytes are under `%USERPROFILE%\.social-media-mcp\scheduled-media`; the local scheduler's `setInterval` loop runs with the MCP process. In this mode, Meta scheduled image delivery uses the local image server and ngrok as documented below.

Cloud mode keeps the MCP server for creating/managing posts, but moves the scheduled job execution to a separate Node.js worker on Render. This project uses Node APIs, `pg`, and local file support, so the Node worker avoids assuming that the existing publishing integrations run unchanged in Deno Edge Functions. Supabase Cron calls an authenticated Render endpoint every minute; PostgreSQL row locking still provides the final concurrency protection. `SCHEDULER_MODE=cloud` disables the MCP process's local timer. Cloud jobs store object paths in the private `social-media-images` bucket; Meta receives a short-lived signed URL created at publish time and LinkedIn uploads bytes downloaded server-side. An optional PDF scheduled with `documentPath` is stored the same way and published as a native LinkedIn document. No production scheduled post depends on ngrok or a local image path.

The project code and SQL are prepared for cloud execution, but **deployment, Supabase Vault secrets, Cron activation, and live cloud publishing are manual steps and are not considered complete until verified in your accounts**.

#### Prepare the Supabase database and migrate existing data

Keep `.env` private. Required cloud-side values are `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CLOUD_TOKEN_ENCRYPTION_KEY`, `APP_CREDENTIAL_ENCRYPTION_KEY`, and `WORKER_TRIGGER_SECRET`. Generate independent random keys:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Use one 64-character hex value for `CLOUD_TOKEN_ENCRYPTION_KEY` and a second, independent 64-character hex value for `APP_CREDENTIAL_ENCRYPTION_KEY`; use the base64url value as `WORKER_TRIGGER_SECRET`. Keep `APP_CREDENTIAL_ENCRYPTION_KEY` identical on Render **and** Vercel, and keep `WORKER_TRIGGER_SECRET` identical in Render and Supabase Vault. Never put the service-role key or any secret in source control, client applications, or logs.

1. Set the cloud variables in the local MCP server environment, then run `npm run db:migrate`. Migrations `001`-`003` and `005`-`010` are repeatable; they preserve scheduled rows, add the cloud object-path and optional LinkedIn document columns, add the encrypted `oauth_tokens` table, add multi-user ownership, create the server-only `oauth_authorization_sessions` table, create the user-owned `oauth_app_credentials` table, create the private image bucket, and create the remote MCP OAuth tables. The cloud migration refuses to use a bucket named `social-media-images` if it is public. The database connection needs permission to apply these migrations.
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

1. Push the project to GitHub and create a Render Blueprint from `render.yaml`, or create a Node web service with the same build/start/health settings. The checked-in blueprint uses `plan: free`. A free instance sleeps after inactivity, which is fine for the one-minute Cron trigger (the next request wakes it) but adds cold-start latency to OAuth callbacks; a paid always-on instance is advisable if you need callbacks to be consistently fast. Do not assume the plan was changed automatically.
2. Set these private Render environment variables: `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CLOUD_TOKEN_ENCRYPTION_KEY`, `APP_CREDENTIAL_ENCRYPTION_KEY`, and `WORKER_TRIGGER_SECRET`. Also set `OAUTH_CALLBACK_MODE=cloud`, `OAUTH_REDIRECT_BASE_URL` (the public Render HTTPS base URL), `OAUTH_FRONTEND_BASE_URL` (the deployed Vercel origin), and — as the shared fallback for users without their own app — `META_APP_ID`, `META_APP_SECRET`, `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, `LINKEDIN_CLIENT_ID`, and `LINKEDIN_CLIENT_SECRET` so the worker can complete Facebook, Instagram, and LinkedIn callbacks and refresh LinkedIn tokens. Set the Render service to use the values of `SCHEDULER_MODE=cloud`, `TOKEN_STORE_BACKEND=supabase`, and `SCHEDULED_IMAGE_STORAGE=supabase` from the blueprint.
3. Confirm `https://<render-service>/health` returns `{"status":"ok"}`. The worker has no local timer; `POST /worker/run` requires `Authorization: Bearer <WORKER_TRIGGER_SECRET>` and returns `202` after accepting a processing run. Its logs include run/job IDs and statuses, never tokens or signed image URLs.
4. In Supabase Dashboard → Vault, add secrets named `social_worker_url` (the Render HTTPS base URL) and `social_worker_secret` (the same random value as Render's `WORKER_TRIGGER_SECRET`). Enable Supabase Vault, `pg_cron`, and `pg_net` if not already enabled.
5. Only after the Render service is deployed and both Vault secrets exist, run `migrations/004_supabase_cron.sql` in the Supabase SQL Editor. It schedules a one-minute HTTPS trigger and is safe to rerun. It deliberately fails rather than installing a job with a placeholder endpoint or missing secret.
6. Verify in Supabase Cron that `social-media-cloud-worker` runs every minute; inspect `cron.job_run_details`, the recent HTTP statuses in `net._http_response`, and the Render service logs. A `202` confirms the run was accepted, not that a post was published. Verify a test post end-to-end with a future schedule and authorized test content before relying on production publishing. Disable the job with `SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'social-media-cloud-worker';`.

#### Cloud OAuth callbacks (Facebook, Instagram, LinkedIn)

`OAUTH_CALLBACK_MODE` selects how browser OAuth is completed and is independent of scheduler, token-store, and image-storage modes; it defaults to `local`.

- `local` (default): the MCP process and the same Node process's HTTP listener on `IMAGE_SERVER_PORT` (with an ngrok tunnel) receive callbacks, and authorization sessions live in process memory. Restarting the process invalidates pending authorizations.
- `cloud`: the frontend starts OAuth, the backend persists the state, session id, user id, platform, exact redirect URI, status, and expiry in the `public.oauth_authorization_sessions` table, and the public Render worker receives the callback. No local listener is started from a Vercel request, and pending state survives restarts and multiple instances. The callback claims the state with a single atomic conditional `UPDATE`, rejects unknown, expired, already-used, and wrong-platform states, and stores only the SHA-256 digest of the state value. OAuth codes, access tokens, refresh tokens, client secrets, and raw provider errors are never written to the browser response or to logs.

Set the same `OAUTH_CALLBACK_MODE=cloud`, `OAUTH_REDIRECT_BASE_URL`, and `OAUTH_FRONTEND_BASE_URL` on Render **and** Vercel, then register the public callback URLs in the provider dashboards:

- Facebook and Instagram: `https://social-media-cloud-worker.onrender.com/oauth/meta/callback`
- LinkedIn: `https://social-media-cloud-worker.onrender.com/oauth/linkedin/callback`

Vercel needs only the public client IDs (`META_APP_ID`, `INSTAGRAM_APP_ID`, `LINKEDIN_CLIENT_ID`), `DATABASE_URL`, `OAUTH_CALLBACK_MODE=cloud`, `OAUTH_REDIRECT_BASE_URL`, and `OAUTH_FRONTEND_BASE_URL`. It also needs `APP_CREDENTIAL_ENCRYPTION_KEY` because `POST /api/credentials` encrypts each user's Developer App secret before storing it (the credential-building path itself only reads the public client id). Never put provider client secrets, `CLOUD_TOKEN_ENCRYPTION_KEY`, or `WORKER_TRIGGER_SECRET` on Vercel. The frontend redirect target is fixed to `<OAUTH_FRONTEND_BASE_URL>/accounts`, so a callback can never be turned into an open redirect. If `OAUTH_FRONTEND_BASE_URL` is unset, the worker renders a static result page instead of redirecting.

#### Remote MCP for Claude.ai and Claude Code (Streamable HTTP)

The cloud worker exposes the same tools over a remote Streamable HTTP MCP endpoint so Claude can create, schedule, publish, reschedule, retry, cancel, and inspect posts without a local process. The stdio server and `MCP_OWNER_USER_ID` behavior are unchanged.

- Endpoint: `https://social-media-cloud-worker.onrender.com/mcp`
- Protected-resource metadata: `https://social-media-cloud-worker.onrender.com/.well-known/oauth-protected-resource/mcp`
- Authorization-server metadata: `https://social-media-cloud-worker.onrender.com/.well-known/oauth-authorization-server`
- Authorization flow: OAuth 2.1 authorization code with PKCE (`S256`) and Dynamic Client Registration. Claude's callback is `https://claude.ai/api/mcp/auth_callback`; Claude Code may use a loopback callback such as `http://localhost:3118/callback`.
- Consent: the worker's `/oauth/authorize` validates the request and redirects to `<OAUTH_FRONTEND_BASE_URL>/mcp/authorize` on Vercel. The signed-in better-auth user approves or denies there. Vercel creates a one-time code bound to that user; the worker's `/oauth/token` exchanges it. Every MCP request is then bound to that user, so a connector can only read and change that user's own connected accounts and scheduled posts.
- Storage: only SHA-256 digests of authorization codes, access tokens, refresh tokens, and client secrets are stored. Refresh tokens rotate, and reuse of an already-rotated token revokes the whole token family. Codes, tokens, client secrets, and signed media URLs are never logged.
- Database: apply migration `010_mcp_oauth.sql` (`npm run db:migrate`) before enabling the connector.

Set these on **Render** and the matching public values on **Vercel**:

```dotenv
MCP_PUBLIC_URL=https://social-media-cloud-worker.onrender.com/mcp
MCP_OAUTH_SCOPE=mcp
MCP_ALLOWED_REDIRECT_ORIGINS=https://claude.ai,https://claude.com
MCP_ALLOW_LOOPBACK_REDIRECTS=true
```

`MCP_PUBLIC_URL` is also the RFC 8707 resource indicator bound into access tokens, so it must match the connector URL exactly. Keep `MCP_OAUTH_SCOPE` and the redirect-origin allowlist identical on both services. `MCP_AUTHORIZATION_CODE_TTL_SECONDS`, `MCP_ACCESS_TOKEN_TTL_SECONDS`, and `MCP_REFRESH_TOKEN_TTL_SECONDS` are optional (defaults `300`, `3600`, and `2592000`). The worker reads `SCHEDULE_SIGNED_URL_TTL_SECONDS` (optional, default `86400`, max `604800`) for the publish-time signed URL. The Vercel deployment also needs `OAUTH_CALLBACK_MODE=cloud`, `OAUTH_REDIRECT_BASE_URL` (the Render origin), `OAUTH_FRONTEND_BASE_URL` (the Vercel origin), and `DATABASE_URL`. If you enable remote media uploads (`POST /api/media/upload`), Vercel also needs `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`; keep the service-role key server-side and never expose it through `NEXT_PUBLIC_*`, the browser, or an API response. Do not put provider client secrets, `CLOUD_TOKEN_ENCRYPTION_KEY`, or `WORKER_TRIGGER_SECRET` on Vercel.

To add the connector in Claude.ai:

1. Open **Settings → Connectors → Add custom connector**.
2. Enter the name `Social Media` and the URL `https://social-media-cloud-worker.onrender.com/mcp`.
3. Leave the optional OAuth client ID and client secret blank so Claude uses Dynamic Client Registration.
4. Click **Connect**. Claude opens the Vercel consent page; sign in with the account whose social accounts you want to use and click **Approve**.
5. Confirm the connector is listed as connected, then ask Claude to list the available social tools or to check connection status. The tool names and inputs are the same as the stdio server.

For Claude Code:

```powershell
claude mcp add --transport http social-media https://social-media-cloud-worker.onrender.com/mcp
claude mcp list
```

Run `/mcp` in Claude Code and complete the browser authorization if prompted. The loopback callback only works while `MCP_ALLOW_LOOPBACK_REDIRECTS=true`; set it to `false` to require HTTPS callbacks.

**Remote media.** A Render worker cannot read paths on the computer running Claude, and the published MCP specification has no client-to-server file-upload primitive: tools receive JSON arguments, not image bytes or a browser file handle. Claude.ai therefore cannot attach an uploaded image directly to a remote tool.

The durable remote media reference is a **permanent private-storage object path**, not a URL. Upload the file through the authenticated web endpoint `POST /api/media/upload` (multipart `file` field). It validates the image, video, or PDF, stores it under a per-user prefix in the private `social-media-images` bucket, and returns `storagePath`. Pass that as `imageStoragePath`, `media[].storagePath`, or `documentStoragePath` when scheduling. The scheduling row stores only that path (plus content type/title metadata); an expiring signed URL is never persisted.

At publish time the worker downloads the object with the server-side service-role key. It creates a fresh signed URL only for platforms that require a public HTTPS URL (Instagram/Facebook), with a lifetime controlled by `SCHEDULE_SIGNED_URL_TTL_SECONDS` (default `86400`; it only needs to outlive the platform's fetch). Platforms with direct upload (LinkedIn) receive the bytes directly. Every retry re-downloads the same original object, so a post scheduled hours or days ahead is unaffected by any earlier URL expiry. Public HTTPS `imageUrl`, `media[].url`, and `documentUrl` inputs are still accepted; they are downloaded immediately, validated, and stored privately at scheduling time.

The remote endpoint rejects `imagePath`, `media[].path`, and `documentPath` before any filesystem access; those fields remain available to the local stdio server. The upload endpoint keeps `SUPABASE_SERVICE_ROLE_KEY` server-side and never returns a storage credential. The vetted remote fetcher accepts HTTPS only, rejects embedded credentials and private/loopback/reserved addresses, re-validates every redirect, enforces the configured byte limits and timeouts, and checks the returned MIME type and file signature.

**Operational notes.**

- The Render blueprint still uses `plan: free`. A sleeping free instance adds cold-start latency to OAuth discovery, consent, and token exchange; use a paid always-on instance for dependable Claude connections. Cold starts can also make the first connection attempt time out, in which case retry after the service wakes.
- Connecting Claude does not connect Instagram, Facebook, or LinkedIn. Each user must still complete the provider OAuth flow on the Vercel **Accounts** page.
- Verify the deployment before relying on it: `GET /health` returns `{"status":"ok"}`, the protected-resource metadata advertises the `/mcp` resource, an unauthenticated `POST /mcp` returns `401` with a `WWW-Authenticate` header, and a real Claude connector completes consent and lists tools. Code being present is not proof that the Render/Vercel deployment or the database migration is live.

#### Developer App Settings (user-owned OAuth apps)

Each signed-in user can connect through their own Meta, Instagram, and LinkedIn apps from the **Accounts → Developer App Settings** section. This lets a user publish through their own app instead of the deployment's shared app.

- Storage: `public.oauth_app_credentials` holds one row per `(user_id, provider)` with the (public) `client_id` and an AES-256-GCM `client_secret_ciphertext` envelope. The authenticated additional data binds the ciphertext to the owning user and provider, so a record cannot be replayed as another user's or provider's secret. Plaintext secrets are never written to PostgreSQL.
- Resolution: when a user has stored credentials, the OAuth consent URL is built from their client id, and the callback/worker decrypts only that client id's secret to exchange the code. Users without stored credentials — and any local (stdio) MCP install — fall back to the shared `META_/INSTAGRAM_/LINKEDIN_` environment app.
- Mid-flow safety: the authorization session stores a non-reversible SHA-256 fingerprint of the credential version (source, provider, client id, and updated-at). The callback refuses the exchange if the fingerprint no longer matches, so editing credentials during an active flow can never swap the app. OAuth sessions created before this feature (no fingerprint) skip the check.
- LinkedIn refresh: the refresh call resolves the user's own LinkedIn app credentials; a user who changed apps after connecting gets an actionable "reconnect LinkedIn" error rather than a silent wrong-app refresh.
- Deleting Developer App credentials only removes the app configuration. It never deletes stored social tokens, disconnects accounts, or cancels scheduled posts; the account simply falls back to the shared app.
- Manual provider step: users must register the shared callback URLs below in their own app dashboards, and any publishing permissions/scopes must be approved for their own app.

The key used to encrypt and decrypt is `APP_CREDENTIAL_ENCRYPTION_KEY` and it must be the same 64-character hex value in every runtime that handles a secret: the web API on Vercel (`POST /api/credentials`) and the worker on Render (OAuth code exchange and LinkedIn refresh). It is never exposed through `NEXT_PUBLIC_*`, a client bundle, an API response, or logs.

`social-media-web/vercel.json` builds the backend first (`npm run build` in `social-media-mcp`) so the generated `dist/` that the frontend imports exists before `next build`; both `package-lock.json` files are respected. Set the Vercel project **Root Directory** to `social-media-web`.

The worker atomically claims at most 10 due posts per invocation. Stale `publishing` jobs become failed after 30 minutes and are **not** automatically requeued because the provider outcome could be uncertain. `social_retry_scheduled_post` only permits retry after recorded pre-publish token or image validation failure; for publishing failures, check the platform first and create a replacement only after confirming no post exists. LinkedIn tokens with a provider-issued refresh token are refreshed before expiry; without one, reauthorize. Meta long-lived/Page token expiry is checked and requires reauthorization if expired. `social_cancel_scheduled_post` can cancel only jobs still in `scheduled` status. Images are retained in Storage after publishing so existing result records remain auditable; no automatic retention deletion is configured.

#### Remaining operational checks and limits

- The local token vault and image files are not deleted by migration. Keep a protected backup and rotate the cloud encryption key only with a planned decrypt/re-encrypt procedure.
- Private Storage is accessed with the server-only service-role key; the worker downloads the stored object path at publish time and creates a fresh signed URL (default 24 hours, `SCHEDULE_SIGNED_URL_TTL_SECONDS`) for Meta, validating it before publishing. Signed URLs are never stored in PostgreSQL. Never expose the service-role key to a browser or frontend.
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

Create a Meta app in the [Meta for Developers dashboard](https://developers.facebook.com/apps/), configure Facebook Login, and add the exact HTTPS callback URL `https://YOUR-NGROK-HOST/oauth/meta/callback` (for cloud mode, `https://social-media-cloud-worker.onrender.com/oauth/meta/callback`) to its valid OAuth redirect URIs. Also add the tunnel hostname (without `https://` or a path) to the Facebook app's **App Domains**. The tunnel must forward requests to the configured `IMAGE_SERVER_PORT`. Copy the app ID and secret to `META_APP_ID` and `META_APP_SECRET`. These credentials are used for Facebook only.

Facebook Page posting requires a Page access token and a Page task that permits content creation. The server requests `pages_show_list`, `pages_read_engagement`, and `pages_manage_posts`. `pages_manage_posts` depends on the other two permissions.

## Instagram App Setup

This server uses **Instagram API with Instagram Login** for Instagram, independently of the Facebook app. In the Meta developer dashboard, configure the app's Instagram product/API setup with Instagram Login and Business Login settings. Add the app's Instagram App ID and App Secret to `INSTAGRAM_APP_ID` and `INSTAGRAM_APP_SECRET` (not the `META_APP_*` fields).

Set `OAUTH_REDIRECT_BASE_URL` and `IMAGE_PUBLIC_BASE_URL` to your public HTTPS tunnel URL and forward it to the configured `IMAGE_SERVER_PORT`. Add the exact callback URL `https://YOUR-NGROK-HOST/oauth/meta/callback` (for cloud mode, `https://social-media-cloud-worker.onrender.com/oauth/meta/callback`) to the Instagram app's OAuth redirect URIs. Instagram Login needs HTTPS; plain localhost is not sufficient. The Instagram account must be a **professional Business or Creator account**, but it does not need to be linked to a Facebook Page.

The server requests `instagram_business_basic` for account/media access and `instagram_business_content_publish` for publishing. Instagram image posts require a publicly reachable HTTPS image URL; text-only Instagram posts are not supported. Meta may require app review and Advanced Access when serving accounts beyond the app's own or managed accounts. This Instagram Login integration does not use Facebook Page tokens or permissions.

Start OAuth with `social_authorization_start`, open its URL promptly, and keep the same MCP server process running until the callback finishes. The request remains valid for 15 minutes. Pass its `authorizationSessionId` to `social_authorization_status`, or call `social_authorization_wait` with a short timeout (up to 20 seconds) and call it again if it is still pending. Long MCP tool calls may be timed out by the client. Restarting the MCP process invalidates pending OAuth state; start a fresh request after a restart.

In development mode, Meta generally limits app use to app-role users and test assets. Supporting people outside the app roles requires the appropriate Advanced Access and App Review; business verification and annual Data Use Checkup may apply.

## LinkedIn App Setup

Create an app in the [LinkedIn Developer Portal](https://www.linkedin.com/developers/apps), associate it with a LinkedIn Page, and add the exact HTTPS redirect URL `https://YOUR-NGROK-HOST/oauth/linkedin/callback` (for cloud mode, `https://social-media-cloud-worker.onrender.com/oauth/linkedin/callback`).

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
- `social_schedule_posts`: persist posts and an image for publishing at specified ISO-8601 times. Local mode uses the local image server and ngrok; cloud mode uploads the image to private Supabase Storage and does not need the MCP host to stay on. An optional `documentPath` PDF (with an optional `documentTitle`) is attached only to the LinkedIn post as a native document; Instagram and Facebook ignore it.
- `social_scheduled_posts_status`: inspect scheduled, published, and failed jobs, including validation outcome, retry count, failure stage, and attached document metadata without exposing credentials or the tokenized image URL.
- `social_cancel_scheduled_post`: cancel a post only while it remains in `scheduled` status.
- `social_retry_scheduled_post`: requeue a failed post only when token, image, or document validation failed before a platform publish request was made. Publishing-stage failures are deliberately blocked because their outcome may be uncertain; verify the destination before creating another post.
- `social_token_store_status`: show token presence/scopes/expiry without revealing token values.

`social_publish` defaults to `dryRun: true`. A real publish requires both `dryRun: false` and `confirmPublish: true` in the same call. No setup or automated test publishes. A success is reported only when Meta returns a post/media ID, or LinkedIn returns a successful response with `x-restli-id`.

Scheduled jobs are persisted in the PostgreSQL `scheduled_posts` table. Image validation results, retry counts, and failure stage are recorded with each job. If a worker stops during publishing, the job is marked failed for manual verification rather than retried automatically, to avoid duplicate posts. Existing jobs in an older `scheduled-posts.json` file are not imported automatically.

Platform-specific publishing:

- Instagram: `imageUrl` must be HTTPS and publicly fetchable. The server creates a media container, publishes it, and requires the returned media ID.
- Facebook: text uses the Page `/feed`; an image uses `/photos` with `imageUrl`. The returned post/photo ID is required.
- LinkedIn: text-only posts use `/rest/posts`. Manual image posts use a local `imagePath`; scheduled cloud image posts download bytes from private Storage, initialize the Images API upload, transfer the bytes, and then create the post. When a scheduled job has a PDF document, the worker downloads the document bytes, initializes a Documents API upload (`/rest/documents?action=initializeUpload`), transfers the PDF, and creates a post whose `content.media` is the returned `urn:li:document:...` with a title.

For a multi-platform request, each target is attempted independently. One platform's API rejection does not mask another platform's result.

## Testing and Troubleshooting

`npm test` exercises offline validation; `npm run typecheck` checks strict TypeScript. `npm run build` prepares the configured OpenCode command. No real post is needed to test the MCP handshake or dry-run.

- OAuth callback errors: check the exact registered redirect URI and `OAUTH_REDIRECT_BASE_URL`. LinkedIn requires HTTPS; tunnel it to the configured `IMAGE_SERVER_PORT`.
- Cloud OAuth callback 404: the worker commit is missing the `/oauth/*/callback` routes or Render is running a branch other than `dev`. Confirm `GET /health` returns `{"status":"ok"}` and redeploy the current commit.
- Cloud callback redirects to `/accounts?oauth=failed`: the state was unknown, expired, already used, or presented on the wrong platform route, or the token exchange failed. Check the authorization-session status and the worker logs; never log or share OAuth codes, state values, or tokens.
- Cloud callback redirects to `/accounts?oauth=connected` but the account still shows disconnected: verify the token was saved for the same user id and that `TOKEN_STORE_BACKEND`, `DATABASE_URL`, and `CLOUD_TOKEN_ENCRYPTION_KEY` match between the worker and the deployment that reads the status.
- Local image route connection refused: confirm the MCP process is running and `IMAGE_SERVER_PORT` matches the port passed to `ngrok http`.
- Local route returns 404: the scheduled image token is missing from the running process or the tunnel is aimed at the wrong local application/port. Restart the MCP server with pending jobs loaded, and verify the ngrok target.
- Public route returns 404 while the local route is healthy: the ngrok tunnel may be stopped, forwarding to the wrong port, or using an outdated hostname. Update `IMAGE_PUBLIC_BASE_URL` (and OAuth URL when needed), restart the MCP server, and rerun `ngrok http` against `IMAGE_SERVER_PORT`.
- Invalid MIME, empty image, or size-limit failure: verify the stored image file is PNG, JPEG, or GIF, matches its extension, is non-empty, and is below `SCHEDULE_IMAGE_MAX_BYTES`.
- Invalid document: the scheduled document must be a PDF named with a `.pdf` extension, start with the `%PDF-` signature, and be below `SCHEDULE_DOCUMENT_MAX_BYTES`. Documents are supported only for LinkedIn.
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
- [LinkedIn Documents API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/documents-api)
- [LinkedIn organization roles](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-access-control-by-role)