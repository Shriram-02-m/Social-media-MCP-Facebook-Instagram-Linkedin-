import type { IncomingMessage, ServerResponse } from "node:http";
import { config } from "../config/env.js";
import { buildFrontendRedirectUrl, expectedPlatformsForCallbackPath } from "./oauth-sessions.js";
import { finishAuthorization, oauthPostgresSessionStore, processOAuthCallback } from "./oauth.js";

const resultMessages: Record<string, string> = {
  connected: "Authorization completed. You can close this tab.",
  cancelled: "Authorization was cancelled or denied. You can close this tab.",
  expired: "This authorization request expired. Start a new connection from the accounts page.",
  failed: "Authorization could not be completed. Return to the accounts page for details.",
};

function sendHtml(response: ServerResponse, message: string, status = 200): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(`<!doctype html><html><head><meta charset="utf-8"><title>Authorization</title></head><body><p>${message}</p></body></html>`);
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(302, {
    location,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  response.end();
}

// Handles GET /oauth/meta/callback and GET /oauth/linkedin/callback on the
// public worker. It returns false for any other route so the worker can keep its
// own 404 behavior. The browser only ever learns a coarse outcome: the session
// status is read by the authenticated frontend, never from this response.
export async function handleOAuthCallback(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const expectedPlatforms = expectedPlatformsForCallbackPath(url.pathname);
  if (!expectedPlatforms) return false;

  let outcome;
  try {
    outcome = await processOAuthCallback(url.searchParams, expectedPlatforms, {
      store: oauthPostgresSessionStore(),
      finish: finishAuthorization,
    });
  } catch {
    // Database or unexpected failure: never surface internals to the browser.
    outcome = { result: "failed" as const };
  }

  const location = buildFrontendRedirectUrl(config.oauthFrontendBaseUrl, outcome.result, outcome.platform);
  if (location) {
    redirect(response, location);
    return true;
  }
  sendHtml(response, resultMessages[outcome.result] ?? resultMessages["failed"]!);
  return true;
}
