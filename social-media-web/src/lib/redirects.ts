// Returns a safe same-origin path for post-login/post-signup navigation.
// Anything that could become an absolute or protocol-relative URL (for example
// `//evil.example`, `/\evil.example`, or encoded slashes) falls back to `/`.
export function safeRedirectPath(value: unknown, fallback = "/"): string {
  if (typeof value !== "string" || !value.startsWith("/")) return fallback;
  if (value.startsWith("//")) return fallback;

  // Only the path component can turn into an authority, so check it in
  // isolation and keep legitimate encoded characters in the query string.
  const pathPart = value.split(/[?#]/, 1)[0] ?? "";
  if (/[\\\u0000-\u001f\u007f]/.test(pathPart)) return fallback;
  if (/%5c|%2f/i.test(pathPart)) return fallback;

  try {
    const url = new URL(value, "http://localhost");
    if (url.origin !== "http://localhost") return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}
