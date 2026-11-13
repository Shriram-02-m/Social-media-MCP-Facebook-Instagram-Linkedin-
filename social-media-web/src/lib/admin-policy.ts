// Pure Phase 3 administration policy: pagination/date parsing, list filters,
// and the account-lifecycle guard. Kept free of database imports so it can be
// unit-tested without a connection and reused by API routes and server pages.

export const PLATFORMS = ["facebook", "instagram", "linkedin"] as const;
export type AdminPlatform = (typeof PLATFORMS)[number];

export const ADMIN_POST_STATUSES = [
  "scheduled",
  "publishing",
  "published",
  "failed",
  "cancelled",
  "held",
] as const;
export type AdminPostStatus = (typeof ADMIN_POST_STATUSES)[number];

export const SOCIAL_ACCOUNT_STATUSES = [
  "connected",
  "expired",
  "error",
  "disconnected",
] as const;
export type SocialAccountStatus = (typeof SOCIAL_ACCOUNT_STATUSES)[number];

export const ACCOUNT_ACTIONS = [
  "suspend",
  "reactivate",
  "soft_delete",
  "restore",
  "revoke_sessions",
] as const;
export type AccountAction = (typeof ACCOUNT_ACTIONS)[number];

export type FilterAll<T extends string> = T | "all";

export interface Pagination {
  page: number;
  pageSize: number;
  offset: number;
}

export interface DateRange {
  /** Inclusive lower bound (start of day when a date-only value is supplied). */
  from: Date;
  /** Inclusive upper bound (end of day when a date-only value is supplied). */
  to: Date;
  days: number;
  fromIso: string;
  toIso: string;
}

export interface PostFilters extends Pagination {
  query: string;
  status: FilterAll<AdminPostStatus>;
  platform: FilterAll<AdminPlatform>;
  range: DateRange;
}

export interface SocialAccountFilters extends Pagination {
  query: string;
  platform: FilterAll<AdminPlatform>;
  status: FilterAll<SocialAccountStatus>;
}

export interface AccountTarget {
  id: string;
  role: string;
  approvalStatus: string;
  banned: boolean;
  deletedAt: Date | null;
}

export interface PolicyViolation {
  message: string;
  status: number;
}

const MAX_QUERY_LENGTH = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

function readParam(
  input: URLSearchParams | Record<string, string | string[] | undefined> | null | undefined,
  key: string,
): string {
  if (!input) return "";
  if (typeof (input as URLSearchParams).get === "function") {
    return (input as URLSearchParams).get(key) ?? "";
  }
  const value = (input as Record<string, string | string[] | undefined>)[key];
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function positiveInteger(value: string, fallback: number): number {
  if (!/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Normalise page/pageSize and cap the page size. */
export function parsePagination(
  input: URLSearchParams | Record<string, string | string[] | undefined> | null | undefined,
  options: { defaultPageSize?: number; maxPageSize?: number } = {},
): Pagination {
  const defaultPageSize = options.defaultPageSize ?? 25;
  const maxPageSize = options.maxPageSize ?? 100;
  const page = positiveInteger(readParam(input, "page"), 1);
  const pageSize = Math.min(
    positiveInteger(readParam(input, "pageSize"), defaultPageSize),
    maxPageSize,
  );
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function parseBoundary(value: string, endOfDay: boolean): Date | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(trimmed);
  const date = new Date(dateOnly ? `${trimmed}T00:00:00.000Z` : trimmed);
  if (Number.isNaN(date.getTime())) return null;
  if (dateOnly && endOfDay) date.setUTCHours(23, 59, 59, 999);
  return date;
}

/**
 * Parse an inclusive `from`/`to` range. Missing values default to the last
 * `defaultDays` days. Ranges are clamped to `maxDays` and to a sane order so a
 * malicious query string cannot request an unbounded scan.
 */
export function parseDateRange(
  input: URLSearchParams | Record<string, string | string[] | undefined> | null | undefined,
  options: { defaultDays?: number; maxDays?: number; now?: number } = {},
): DateRange {
  const defaultDays = options.defaultDays ?? 30;
  const maxDays = options.maxDays ?? 366;
  const now = options.now ?? Date.now();
  const nowDate = new Date(now);

  const parsedFrom = parseBoundary(readParam(input, "from"), false);
  const parsedTo = parseBoundary(readParam(input, "to"), true);

  let to = parsedTo ?? nowDate;
  if (to.getTime() > now) to = nowDate;
  let from = parsedFrom ?? new Date(to.getTime() - (defaultDays - 1) * DAY_MS);
  from.setUTCHours(0, 0, 0, 0);

  if (from.getTime() > to.getTime()) {
    const swap = new Date(from);
    from = new Date(to);
    from.setUTCHours(0, 0, 0, 0);
    to = swap;
  }

  const spanDays = Math.floor((to.getTime() - from.getTime()) / DAY_MS) + 1;
  if (spanDays > maxDays) {
    from = new Date(to.getTime() - (maxDays - 1) * DAY_MS);
    from.setUTCHours(0, 0, 0, 0);
  }

  const days = Math.max(1, Math.floor((to.getTime() - from.getTime()) / DAY_MS) + 1);
  return {
    from,
    to,
    days,
    fromIso: from.toISOString(),
    toIso: to.toISOString(),
  };
}

export function parsePostFilters(
  input: URLSearchParams | Record<string, string | string[] | undefined> | null | undefined,
): PostFilters {
  const statusRaw = readParam(input, "status").trim().toLowerCase();
  const platformRaw = readParam(input, "platform").trim().toLowerCase();
  return {
    ...parsePagination(input),
    query: readParam(input, "q").trim().slice(0, MAX_QUERY_LENGTH),
    status: (ADMIN_POST_STATUSES as readonly string[]).includes(statusRaw)
      ? (statusRaw as AdminPostStatus)
      : "all",
    platform: (PLATFORMS as readonly string[]).includes(platformRaw)
      ? (platformRaw as AdminPlatform)
      : "all",
    range: parseDateRange(input, { defaultDays: 30, maxDays: 366 }),
  };
}

export function parseSocialAccountFilters(
  input: URLSearchParams | Record<string, string | string[] | undefined> | null | undefined,
): SocialAccountFilters {
  const platformRaw = readParam(input, "platform").trim().toLowerCase();
  const statusRaw = readParam(input, "status").trim().toLowerCase();
  return {
    ...parsePagination(input, { defaultPageSize: 50 }),
    query: readParam(input, "q").trim().slice(0, MAX_QUERY_LENGTH),
    platform: (PLATFORMS as readonly string[]).includes(platformRaw)
      ? (platformRaw as AdminPlatform)
      : "all",
    status: (SOCIAL_ACCOUNT_STATUSES as readonly string[]).includes(statusRaw)
      ? (statusRaw as SocialAccountStatus)
      : "all",
  };
}

/**
 * Server-side guard for every account-lifecycle action. `actorId` always comes
 * from the verified admin session.
 *
 * The rules are deliberately conservative:
 *  - the acting Super Admin can never suspend, delete, or revoke their own
 *    sessions (no self-lockout);
 *  - the single Super Admin account can never be suspended or deleted by any
 *    actor;
 *  - lifecycle actions are idempotent errors rather than silent no-ops.
 */
export function validateAccountAction(params: {
  action: AccountAction;
  actorId: string;
  target: AccountTarget;
}): PolicyViolation | null {
  const { action, actorId, target } = params;

  if (!(ACCOUNT_ACTIONS as readonly string[]).includes(action)) {
    return { message: "Unknown account action.", status: 400 };
  }

  if (target.id === actorId) {
    if (action === "suspend" || action === "soft_delete") {
      return {
        message: "You cannot suspend or delete your own account.",
        status: 409,
      };
    }
    if (action === "revoke_sessions") {
      return {
        message: "You cannot revoke your own sessions from the admin console.",
        status: 409,
      };
    }
  }

  if (target.role === "admin" && (action === "suspend" || action === "soft_delete")) {
    return {
      message: "The Super Admin account cannot be suspended or deleted.",
      status: 409,
    };
  }

  if (action === "suspend") {
    if (target.deletedAt) {
      return { message: "Restore this account before suspending it.", status: 409 };
    }
    if (target.banned) return { message: "This account is already suspended.", status: 409 };
  }

  if (action === "reactivate") {
    if (target.deletedAt) {
      return { message: "Restore this account before reactivating it.", status: 409 };
    }
    if (!target.banned) return { message: "This account is not suspended.", status: 409 };
  }

  if (action === "soft_delete") {
    if (target.deletedAt) return { message: "This account is already deleted.", status: 409 };
  }

  if (action === "restore") {
    if (!target.deletedAt) return { message: "This account is not deleted.", status: 409 };
  }

  if (action === "revoke_sessions" && target.deletedAt) {
    return { message: "This account is deleted and has no active access.", status: 409 };
  }

  return null;
}
