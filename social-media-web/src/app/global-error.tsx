"use client";

import { useEffect } from "react";

// Last-resort error boundary for failures in the root layout or in a layout
// that no route-level `error.tsx` can wrap (for example the dashboard layout).
// Without this file Next.js renders its built-in unstyled global error page,
// which hides the retry path and the error reference. `global-error` replaces
// the root layout, so it must provide its own document, styles, and fonts.
const styles = {
  body: {
    minHeight: "100vh",
    margin: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "24px",
    background: "#fafafa",
    color: "#18181b",
    fontFamily:
      'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  },
  card: {
    width: "100%",
    maxWidth: "32rem",
    border: "1px solid #e4e4e7",
    borderRadius: "12px",
    background: "#ffffff",
    padding: "24px",
    boxShadow: "0 1px 2px rgba(0, 0, 0, 0.04)",
  },
  title: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    margin: "0 0 8px",
    fontSize: "18px",
    fontWeight: 600,
  },
  message: {
    margin: "0 0 16px",
    fontSize: "14px",
    lineHeight: 1.5,
    color: "#52525b",
  },
  reference: {
    margin: "0 0 16px",
    fontSize: "12px",
    color: "#71717a",
  },
  code: {
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
    wordBreak: "break-all",
  },
  actions: { display: "flex", flexWrap: "wrap", gap: "8px" },
  button: {
    appearance: "none",
    border: "1px solid #18181b",
    borderRadius: "8px",
    background: "#18181b",
    color: "#ffffff",
    padding: "8px 16px",
    fontSize: "14px",
    fontWeight: 500,
    cursor: "pointer",
  },
  link: {
    display: "inline-flex",
    alignItems: "center",
    border: "1px solid #e4e4e7",
    borderRadius: "8px",
    padding: "8px 16px",
    fontSize: "14px",
    fontWeight: 500,
    color: "#18181b",
    textDecoration: "none",
  },
} as const;

export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body style={styles.body}>
        <title>Social Console</title>
        <div style={styles.card} role="alert">
          <h1 style={styles.title}>
            <span aria-hidden style={{ color: "#dc2626" }}>
              &#9888;
            </span>
            This page couldn&apos;t load
          </h1>
          <p style={styles.message}>
            A server error interrupted loading this page. Your sign-in has not
            been changed. Try again; if it keeps happening, give the error
            reference below to an administrator.
          </p>
          {error.digest ? (
            <p style={styles.reference}>
              Error reference: <code style={styles.code}>{error.digest}</code>
            </p>
          ) : null}
          <div style={styles.actions}>
            <button type="button" onClick={() => retry()} style={styles.button}>
              Try again
            </button>
            <a href="/login" style={styles.link}>
              Back to sign in
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}
