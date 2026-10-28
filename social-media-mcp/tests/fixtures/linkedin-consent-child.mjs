// Test fixture: produces the real LinkedIn consent URL via beginAuthorization
// in an isolated process whose environment is provided by the parent test.
// It performs no network requests to any provider: only the URL is built and
// printed, using the local in-memory authorization-session store.
import { beginAuthorization } from "../../src/auth/oauth.js";

try {
  const { authorizationUrl, sessionId, expiresAt } = await beginAuthorization("linkedin", "consent-url-probe");
  process.stdout.write(JSON.stringify({ authorizationUrl, sessionId, expiresAt }));
  process.exit(0);
} catch (error) {
  process.stdout.write(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
}
