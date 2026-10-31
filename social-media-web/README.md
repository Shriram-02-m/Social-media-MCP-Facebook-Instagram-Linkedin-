This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Environment

Copy `.env.example` to `.env.local` and fill in the values. In addition to the
auth variables, the OAuth/worker modules read `DATABASE_URL`,
`OAUTH_CALLBACK_MODE=cloud`, `OAUTH_REDIRECT_BASE_URL`, `OAUTH_FRONTEND_BASE_URL`,
and the public `META_APP_ID` / `INSTAGRAM_APP_ID` / `LINKEDIN_CLIENT_ID` values from
the Vercel environment.

`APP_CREDENTIAL_ENCRYPTION_KEY` is also required on Vercel: `POST /api/credentials`
encrypts each signed-in user's Developer App secret before it is stored. Use the
same 64-character hex value as the Render worker, generate it with
`node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`,
and never expose it through `NEXT_PUBLIC_*`, a client bundle, an API response, or
logs. Users can save, update, and delete their Facebook, Instagram, and LinkedIn
app credentials from **Accounts → Developer App Settings**; deleting them never
disconnects an account or cancels a scheduled post.

## Authenticated media upload

Remote MCP tools (for example the Claude.ai connector) receive JSON arguments,
not uploaded files, so a local image, video, or PDF must first become a durable
media reference. Signed-in users can upload one from the **Media** page (which
posts to `POST /api/media/upload`, multipart `file` field). The endpoint
validates the type and signature, stores
the file under a per-user prefix in the private `social-media-images` Supabase
bucket, and returns:

- `storagePath` — the permanent object path. Pass this as `imageStoragePath`,
  `media[].storagePath`, or `documentStoragePath` when scheduling (or to
  `social_publish.imageStoragePath` for immediate publishing). It never
  expires and is what PostgreSQL records.
- `url` — a short-lived signed URL for an immediate publish only. Do not store
  it.

This page is also the browser fallback for Claude.ai: the MCP spec has no
client→server file-upload primitive, so when the in-chat upload tool
(`social_upload_media_intent` on the MCP server) cannot run in the model's
environment, the user uploads here and pastes the returned `storagePath` into
the Claude conversation.

At publish time the worker downloads `storagePath` with the server-side
service-role key and creates a fresh signed URL only for platforms that require
a public HTTPS URL (Instagram/Facebook). Platforms with direct upload (LinkedIn)
receive the bytes directly. Retries re-download the same original object, so a
post scheduled days ahead is unaffected by any earlier URL's expiry.

This route needs `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` on the server.
Keep the service-role key out of `NEXT_PUBLIC_*`, the browser, API responses, and
logs. The bucket stays private; the response never contains a storage
credential. `SCHEDULE_SIGNED_URL_TTL_SECONDS` (default `86400`) controls the
publish-time signed URL lifetime.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
