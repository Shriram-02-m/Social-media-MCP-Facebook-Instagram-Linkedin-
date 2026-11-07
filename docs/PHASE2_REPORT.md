# Phase 2 Completion Report — Single Super Admin / Multi-User Management

**Date:** 2026-11-06
**Scope:** `social-media-web` (Next.js) + `social-media-mcp` (Node MCP backend)

---

## 1. Executive Summary

Phase 2 adds a Single Super Admin / Multi-User management layer across both packages while
preserving all Phase 1 functionality. No system was rebuilt: Better Auth 1.7.9's native
`admin` plugin provides roles, bans, and user administration; `approval_status` /
`deleted_at` are server-managed custom user fields; scheduled posts get a new `held`
state that freezes work when an account is suspended; existing users were grandfathered
in as `approved`.

All verification gates pass:

| Check | Package | Result |
|---|---|---|
| Unit/offline tests | social-media-web (Vitest) | **38 / 38 pass** |
| Unit/offline tests | social-media-mcp (tsx --test) | **164 / 164 pass** |
| `typecheck` (tsc --noEmit) | web | pass |
| `typecheck` + `build` | mcp | pass (dist rebuilt) |
| `lint` (eslint) | web | 0 errors, 0 warnings |
| `build` (next build) | web | pass |

No destructive migration statements were used (`DROP`/`TRUNCATE`/`DELETE` are asserted
absent by tests).

---

## 2. Files Created

### social-media-web
| File | Purpose |
|---|---|
| `migrations/0002_admin_multitenant.sql` | Adds role/ban/approval columns, single-admin partial unique index, `activity_log` table |
| `src/app/(auth)/pending/page.tsx` | Signed-in pending/rejected status page (redirects approved users home) |
| `tests/phase2-authorization.test.ts` | 17 pass — `readAccountState`, `require*` helpers, ownership guard |
| `tests/phase2-security.test.ts` | 21 pass — source-level assertions for migration, auth config, seed, hold/resume |
| `vitest.config.ts` | Vitest 3 runner config (`@` alias, `tests/**`) |

### social-media-mcp
| File | Purpose |
|---|---|
| `migrations/013_account_hold.sql` | `held` status constraint, `social_media_account_is_active()` guard function, `activity_log` table |
| `src/utils/activity.ts` | `recordActivity()` — best-effort writer with secret sanitization (`FORBIDDEN_META_KEYS`) |
| `tests/scheduling-account-hold.test.ts` | 9 pass — hold/resume/claim-guard/cancel/reschedule semantics |

## 3. Files Modified

### social-media-web
- `src/lib/db/schema.ts` — `user` extended (`role`, `banned`, `banReason`, `banExpires`, `approvalStatus`, `deletedAt`); `activityLog` table (`metadata` stored via `JSON.stringify`; client-side `id` default).
- `src/lib/auth.ts` — Better Auth 1.7.9 **admin plugin** (`adminRoles: ["admin"]`, `defaultRole: "user"`); `additionalFields` for `approvalStatus`/`deletedAt` with `input: false`; `databaseHooks.user.create.before` forces every signup to `pending` + `role: "user"`; `session.create.before` blocks sessions for soft-deleted or banned accounts; signup audited as `user_signup_pending`.
- `src/lib/session.ts` — `readAccountState` (parses comma-joined or array roles, `banActive` via `banExpires`, effective-state mapping), `requireAuthenticatedUser`, `requireApprovedUser`, `requireAdmin` (real role check, no longer a no-op), `requireResourceOwnership`, `UnauthorizedError` (401) / `ApprovalRequiredError` (403 with `code`: pending/rejected/suspended/deleted).
- `src/lib/api.ts` — `requireApiSession()` → enforced by `requireApprovedUser`; error mapping for 401/403.
- `scripts/seed-admin.mts` — single-admin pre-check, transactional promotion with blocker re-check (`ne(user.id, row.id)`), `23505` unique-violation catch; audited `admin_initialized`; no hardcoded credentials.
- `src/app/(auth)/signup/signup-form.tsx` — after signup: `signOut()` + redirect to `/pending`; no client-supplied role/approval fields.
- `src/app/(auth)/login/login-form.tsx` — comment only (pending/rejected land via the dashboard layout gate).
- `src/proxy.ts` — `"/pending"` added to `PUBLIC_PREFIXES`.
- `src/app/(dashboard)/layout.tsx` — lifecycle gate: deleted/banned → `/login`, non-approved → `/pending`.
- `src/components/posts-list.tsx` — `"held"` status (union, label, tone).
- `src/app/(dashboard)/calendar/calendar-panel.tsx` — `"held"` added to `CalendarPost` status.
- `src/app/api/posts/[id]/reschedule/route.ts` — error text covers held posts.
- `src/lib/backend/index.ts` — re-exports `holdScheduledPostsForUser` / `resumeScheduledPostsForUser` etc. from `../social-media-mcp/dist`.
- `package.json` — `test` / `test:watch` scripts; dev dependency `vitest ^3.2.7`.

### social-media-mcp
- `src/scheduler.ts` —
  - Claim query gains `AND public.social_media_account_is_active(user_id)` while keeping the contiguous `WHERE status = 'scheduled' AND scheduled_at <= NOW()` line and `FOR UPDATE SKIP LOCKED` accounting.
  - New `assertAccountCanSchedule(ownerId)` gate wired into exactly 3 entry points: `schedulePosts`, `scheduleMediaPosts`, `retryScheduledPost`.
  - New `holdScheduledPostsForUser(ownerId, {actorUserId, reason})` — `WITH locked (... FOR UPDATE) UPDATE ... SET status = 'held', error = $2, claimed_at = NULL`; no deletion, `scheduled_at` and history preserved; row locks make it race-safe against a concurrent worker claim.
  - New `resumeScheduledPostsForUser(ownerId, jobId?, {actorUserId})` → `{resumed: [], stillHeld: []}`; future-dated held posts return to `scheduled` with the **original** time; overdue posts **stay `held`** (never auto-published) and require an explicit reschedule.
  - Cancellation widened to `status IN ('scheduled','held')`; reference-count cleanup statuses widened to `('scheduled','publishing','held')` so held posts' shared media survive resume.
  - Reschedule now `SET status = 'scheduled', scheduled_at = $3` (held → scheduled path) and re-registers local media for held rows.
- `src/database-migrations.ts`, `scripts/migrate-database.ts` — migration `013` registered.

### Test-fixture sync (mcp pre-existing offline tests)
`shared-storage-cleanup.test.ts`, `scheduled-reschedule.test.ts`, `multiuser.test.ts`, `cloud-worker.test.ts` — stale SQL regex assertions updated to the new (correct) predicates; no behavior weakened.

---

## 4. Migration Details

**web `0002_admin_multitenant.sql`** (idempotent, additive):
- `ALTER TABLE "user" ADD COLUMN IF NOT EXISTS ...` — `"role" text NOT NULL DEFAULT 'user'`, `"banned" boolean NOT NULL DEFAULT false`, `"ban_reason" text`, `"ban_expires" timestamptz`, `"approval_status" text NOT NULL DEFAULT 'approved'` then `SET DEFAULT 'pending'` (grandfathers existing users, new users default pending), `"deleted_at" timestamptz`.
- `UPDATE "user" SET approval_status = 'approved'"` — one-time backfill of existing users.
- `CREATE UNIQUE INDEX IF NOT EXISTS "user_single_admin_idx" ON "user"("role") WHERE "role" = 'admin'` — **single Super Admin enforced at the database level** (second admin insert fails with SQLSTATE 23505, caught in seed).
- `CREATE TABLE IF NOT EXISTS "activity_log"` — `id, actor_user_id, target_user_id, action, resource_type, resource_id, metadata jsonb NOT NULL DEFAULT '{}', created_at`.

**mcp `013_account_hold.sql`** (idempotent, additive):
- `scheduled_posts` status CHECK constraint extended to `'held'` (`NOT VALID` add + `VALIDATE` — safe on live data).
- `CREATE OR REPLACE FUNCTION public.social_media_account_is_active(owner_user_id)` — DB-level guard: fail-closed (FALSE) for unknown web users; fail-open (TRUE) for `local-owner` legacy rows and when the `public."user"` table doesn't exist (stdio-only DBs).
- Same `activity_log` DDL (mirrored; both sides idempotently create it).

The DDL is duplicated intentionally so either package can bootstrap the shared database.

## 5. Better Auth Integration

- Dependency: `better-auth@^1.7.9` with the `admin()` plugin from `better-auth/plugins/admin` (endpoints verified in `node_modules`: `banUser`, `unbanUser`, `setRole`, `revokeUserSessions`, `listUsers`, `createUser`; **`banUser` sets `banned`/`banReason`/`banExpires` AND deletes the user's sessions**).
- Suspension = native Better Auth ban (`banUser`) → sessions revoked + new logins blocked by `session.create.before` hook + `banActive` checks on every server render/API call.
- `approval_status`/`deletedAt` exposed as `user.additionalFields` with `input: false` — clients can never set them.
- Lifecycle states are computed server-side in `readAccountState`: effective state = deleted > suspended (banActive) > rejected/pending/approved.

## 6. Super Admin Seed

```bash
cd social-media-web
npm run db:migrate       # applies 0002 (must be BEFORE seeding)
npm run db:seed-admin    # prompts for target email; rerun-safe
```
- Refuses to proceed if any admin already exists ("A Super Admin already exists"); inside a transaction it re-checks blockers with `AND role = 'admin' AND id <> target.id` and catches 23505 from the unique index — two concurrent runs cannot create two admins.
- Promotes with `role: ADMIN_ROLE`, `approvalStatus: "approved"`, `banned: false`, `deletedAt: null`; writes `admin_initialized` activity.
- No credentials are hardcoded anywhere (email supplied at run time; password management stays with Better Auth flows).

## 7. Signup / Approval Workflow

1. Signup (`client complements`) → Better Auth user create hook **forces** `role: "user"`, `approval_status: "pending"` (ignores any client-sent value; `input: false` closes it again at the field level). Activity `user_signup_pending` recorded.
2. The auto-created session is discarded client-side (`authClient.signOut()`), user goes to `/pending` (public route; state-aware message for pending vs. rejected).
3. Admin approves (Better Auth admin endpoints set `approvalStatus`). Until then the dashboard layout gate blocks pending/rejected accounts at every render and `requireApprovedUser()` blocks every API route with 403 + machine-readable code.
4. Rejection maps to the "not approved" message; approval unlocks everything unchanged.

## 8. Suspension Hold / Resume Details

- **Trigger:** admin bans (`banUser`) → sessions revoked instantly.
- **Worker isolation:** the claim query itself runs `AND public.social_media_account_is_active(user_id)` inside the same `FOR UPDATE SKIP LOCKED` batch — a suspended/deleted user's jobs can never be claimed by *any* worker process (no cross-app trust needed). `assertAccountCanSchedule` (DB function call, not user-supplied flags) gates new scheduling, media scheduling, and retries — 3 call sites.
- **Hold:** `holdScheduledPostsForUser` locks pending rows (`FOR UPDATE`, no SKIP) and transitions `scheduled → held` (`scheduled_at`, text, media, failure history untouched; `claimed_at` cleared). Content and storage references stay registered (cleanup ref-count includes `held`), so nothing is deleted while frozen.
- **Resume:** explicit admin action only. Future-dated posts → `scheduled` with the original timestamp. Overdue posts **remain `held`** and are excluded from resumable results (`stillHeld`) — they are never auto-published at a stale time; recovery requires the user to explicitly reschedule (held posts are reschedulable and cancellable, `canRescheduleScheduledPost` accepts `held`), which sets a fresh `scheduled_at`.

## 9. Soft Deletion Behavior

- Deletion uses `deleted_at` (never `DELETE FROM user`); `input: false` prevents client writes.
- Login blocked (`session.create.before` returns false); lingering sessions denied by the layout gate and all `require*` helpers; effective state maps to `deleted` with a 403/`deleted` API response.
- All history preserved: scheduled posts, media, activity log, OAuth tokens untouched at the DB layer; the `social_media_account_is_active` guard additionally freezes any straggler scheduled jobs at the database level.

## 10. Activity Log

- `activity_log` shared by both apps; writers: web `logActivity(entry, client?)` (accepts transaction client so approval/seed writes commit atomically), mcp `recordActivity()`.
- Sanitization: `FORBIDDEN_META_KEYS` regex (`password|token|access_token|refresh_token|secret|client_secret|encryption_key|api_key|authorization`, case-insensitive) strips matching keys recursively; depth/length caps applied.
- **Best-effort by contract:** every write is wrapped in try/catch — logging failure is reported to server logs and can never fail the operation it describes.

## 11. Test Results (executed)

### social-media-web (`npm run test`, Vitest 3.2.7) — **38 passed / 0 failed**
- `tests/phase2-security.test.ts` — 21 pass (migration 0002 invariants, auth config, seed, hold/resume source assertions).
- `tests/phase2-authorization.test.ts` — 17 pass (state classification, role parsing, all `require*` allow/deny cases incl. expired-suspension, ownership guard).

### social-media-mcp (`npm test`, node:test via tsx, offline) — **164 passed / 0 failed**
- Includes new `tests/scheduling-account-hold.test.ts` (9 pass) and all pre-existing suites after updating stale SQL assertions to the new predicates.
- `npm run typecheck` + `npm run build` in mcp: pass, dist rebuilt (web imports it).

### social-media-web other gates
- `npm run typecheck`: pass. `npm run lint`: 0 errors / 0 warnings. `npm run build`: pass (route table includes `/pending`; `/calendar`, `/queue`, etc. unchanged).

## 12. Verification Coverage Notes

Two structural behaviors are enforced while typed and asserted offline, and will show their full effect only against a live database (deferred, see §13):
- the DB-level claim guard inside the real SQL claim path,
- the hold transaction's row-lock behavior under concurrent claims.

Both are covered by offline source assertions mirroring the exact SQL shipped.

---

## 13. Unresolved Issues & Required Manual StepsThere is **no live-DB integration run** in this session. Before deployment:

1. **Run migrations in BOTH packages** (nothing was auto-applied by this session):
   ```bash
   cd social-media-web   && npm run db:migrate   # 0002_admin_multitenant.sql
   cd social-media-mcp   && npm run db:migrate   # 013_account_hold.sql (also self-applies at scheduler boot, but run it explicitly for local parity)
   ```
2. **Seed the Super Admin** (after web migration 0002): `cd social-media-web && npm run db:seed-admin`.
3. **Live smoke test (recommended):** signup → pending screen → admin approve → schedule → ban → verify posts go `held` and worker refuses ownership → resume/reschedule.
4. Better Auth admin HTTP endpoints used for approval/suspension are available but there is **no admin UI page yet** (Phase 3 candidate); the seed + Better Auth API cover operations.
5. The `project-complete-source.txt` working-tree modification was pre-existing user work and was intentionally left untouched.
6. Vitest pinned to `^3` (not 5) because of `@types/node@20` peer conflict with `vite@8` — revisit when `@types/node` upgrades to ≥22.

---

## 14. Addendum (post-report fix): missing `session.impersonated_by`

`npm run db:seed-admin` failed with `Better Auth: Drizzle schema mismatch — Missing columns: session.impersonatedBy` because Better Auth 1.7.9's admin plugin requires a nullable `impersonatedBy` (string) column on `session` (verified in `node_modules/better-auth/dist/plugins/admin/schema.mjs`); migration 0002 predated this discovery.

Fixed 2026-11-06:
- `src/lib/db/schema.ts` — `session.impersonatedBy: text("impersonated_by")` added (nullable).
- `migrations/0003_session_impersonated_by.sql` — idempotent `ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "impersonated_by" text;` (new file; 0002 was already applied live, so a versioned migration was added instead of editing it).
- `npm run db:migrate` executed — 0001/0002 re-applied idempotently, 0003 applied; `impersonated_by text nullable=YES` verified in the live DB alongside all existing columns.
- `scripts/seed-admin.mts` hardened — earlier failed runs had left the ADMIN_EMAIL user at `role='user'`; the rerun path verified credentials but not role and exited early. It now promotes with the same transactional single-admin re-check if the credential match is not yet the Super Admin.
- `npm run db:seed-admin` run: `Super Admin shriram@social-media.local initialized (role=admin, approved).` Second run refuses as designed ("A Super Admin already exists ... Refusing"). All 4 users, 23 sessions, no data disturbed.
- Web typecheck / 38 lint-clean vitest tests / eslint all still pass after the change.

