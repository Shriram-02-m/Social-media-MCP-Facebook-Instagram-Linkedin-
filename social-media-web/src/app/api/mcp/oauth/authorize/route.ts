import { ApiError, apiErrorResponse, requireApiSession } from "@/lib/api";
import {
  McpOAuthError,
  createMcpAuthorizationCode,
  getMcpClient,
  isRegisteredMcpRedirectUri,
  validateMcpAuthorizationRequest,
} from "@/lib/backend";

// Consent approval endpoint. The Render worker redirects the browser here with
// an already validated OAuth authorization request. This route re-validates the
// request against the registered client, binds the one-time code to the signed-in
// better-auth user, and then redirects back to the client's registered callback.

function field(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === "string" ? value : undefined;
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

function redirectResponse(location: URL): Response {
  return new Response(null, {
    status: 303,
    headers: {
      location: location.toString(),
      "cache-control": "no-store",
    },
  });
}

function authorizationErrorRedirect(
  redirectUri: string,
  state: string | undefined,
  code: string,
  description: string,
): Response {
  const target = new URL(redirectUri);
  target.searchParams.set("error", code);
  target.searchParams.set("error_description", description);
  if (state) target.searchParams.set("state", state);
  return redirectResponse(target);
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return Response.json({ error: "Invalid request origin." }, { status: 403 });
  }

  try {
    const session = await requireApiSession();
    const form = await request.formData().catch(() => null);
    if (!form) throw new ApiError("Consent must be submitted as a form.");

    const clientId = field(form, "client_id");
    const redirectUri = field(form, "redirect_uri");
    const state = field(form, "state");
    if (!clientId || !redirectUri) {
      throw new ApiError("client_id and redirect_uri are required.");
    }

    // Never redirect to an unverified URI. Check the registration before using
    // the URI in any Location header, including error responses.
    const client = await getMcpClient(clientId);
    if (!client) throw new ApiError("Unknown OAuth client.");
    if (!isRegisteredMcpRedirectUri(client, redirectUri)) {
      throw new ApiError("The redirect_uri is not registered for this client.");
    }

    const action = field(form, "action");
    if (action === "deny") {
      return authorizationErrorRedirect(
        redirectUri,
        state,
        "access_denied",
        "The user denied the authorization request.",
      );
    }
    if (action !== "approve") throw new ApiError("Invalid consent action.");

    const codeChallenge = field(form, "code_challenge");
    if (!codeChallenge) throw new ApiError("A valid PKCE code_challenge is required.");

    let validated;
    try {
      validated = await validateMcpAuthorizationRequest({
        clientId,
        redirectUri,
        ...(field(form, "response_type") !== undefined
          ? { responseType: field(form, "response_type")! }
          : {}),
        ...(field(form, "scope") !== undefined ? { scope: field(form, "scope")! } : {}),
        ...(field(form, "resource") !== undefined ? { resource: field(form, "resource")! } : {}),
        codeChallenge,
        codeChallengeMethod: field(form, "code_challenge_method") ?? "S256",
      });
    } catch (error) {
      if (error instanceof McpOAuthError) {
        return authorizationErrorRedirect(redirectUri, state, error.code, error.message);
      }
      throw error;
    }

    const code = await createMcpAuthorizationCode({
      clientId: validated.client.clientId,
      userId: session.user.id,
      redirectUri,
      scope: validated.scope,
      resource: validated.resource,
      codeChallenge,
      codeChallengeMethod: "S256",
    });

    const target = new URL(redirectUri);
    target.searchParams.set("code", code);
    if (state) target.searchParams.set("state", state);
    return redirectResponse(target);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
