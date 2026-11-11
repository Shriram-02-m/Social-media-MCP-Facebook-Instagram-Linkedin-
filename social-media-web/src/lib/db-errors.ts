// Database error helpers. Kept separate from the query modules so they can be
// unit-tested without a database connection.

/**
 * True when the error, or anything in its `cause` chain, is a PostgreSQL
 * unique-violation (SQLSTATE 23505). Drizzle wraps driver errors in
 * `DrizzleQueryError`, so the SQLSTATE normally lives on `cause` rather than on
 * the thrown error itself. The depth cap also makes cyclic causes safe.
 */
export function isUniqueViolation(error: unknown, depth = 0): boolean {
  if (depth > 5 || typeof error !== "object" || error === null) return false;
  if ((error as { code?: unknown }).code === "23505") return true;
  return isUniqueViolation((error as { cause?: unknown }).cause, depth + 1);
}
