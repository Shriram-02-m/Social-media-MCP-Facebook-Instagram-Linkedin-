import { redirect } from "next/navigation";
import { Blocks, ShieldX } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  McpOAuthError,
  getMcpClient,
  isRegisteredMcpRedirectUri,
  validateMcpAuthorizationRequest,
} from "@/lib/backend";
import { getSession } from "@/lib/session";

const oauthFields = [
  "client_id",
  "redirect_uri",
  "response_type",
  "state",
  "code_challenge",
  "code_challenge_method",
  "scope",
  "resource",
] as const;

type OAuthField = (typeof oauthFields)[number];

function single(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

// Shared premium auth shell: centered column with the brand mark above the
// card and a single subtle brand-tinted radial accent on the canvas.
function AuthMain({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-svh flex-1 flex-col items-center justify-center gap-6 bg-background px-4 py-10 [background-image:radial-gradient(60rem_40rem_at_50%_-10%,color-mix(in_oklch,var(--brand)_6%,transparent),transparent)]">
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="flex size-10 items-center justify-center rounded-xl bg-gradient-to-b from-brand to-brand/85 text-brand-foreground shadow-card ring-1 ring-foreground/10"
        >
          <Blocks className="size-5" />
        </span>
        <span className="text-sm font-semibold">Social Console</span>
      </div>
      {children}
    </main>
  );
}

function ErrorCard({ message }: { message: string }) {
  return (
    <AuthMain>
      <Card className="w-full max-w-md shadow-pop [--card-spacing:--spacing(6)]">
        <CardHeader className="gap-3">
          <span
            aria-hidden="true"
            className="flex size-11 items-center justify-center rounded-xl border bg-muted/60 text-muted-foreground shadow-card"
          >
            <ShieldX className="size-5" />
          </span>
          <div className="flex flex-col gap-1.5">
            <CardTitle className="text-lg font-semibold">
              Authorization request rejected
            </CardTitle>
            <CardDescription>
              This request could not be verified, so no access was granted.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-destructive" role="alert">
            {message}
          </p>
        </CardContent>
      </Card>
    </AuthMain>
  );
}

export default async function McpAuthorizePage({
  searchParams,
}: PageProps<"/mcp/authorize">) {
  const params = await searchParams;
  const values = Object.fromEntries(
    oauthFields.map((field) => [field, single(params[field])]),
  ) as Record<OAuthField, string | undefined>;

  const session = await getSession();
  if (!session) {
    const query = new URLSearchParams();
    for (const field of oauthFields) {
      const value = values[field];
      if (value) query.set(field, value);
    }
    redirect(`/login?next=${encodeURIComponent(`/mcp/authorize?${query.toString()}`)}`);
  }

  const clientId = values.client_id;
  const redirectUri = values.redirect_uri;
  if (!clientId || !redirectUri) {
    return <ErrorCard message="The request is missing client_id or redirect_uri." />;
  }

  let client;
  try {
    client = await getMcpClient(clientId);
  } catch (error) {
    console.error("[mcp-consent] failed to load OAuth client:", error);
    return <ErrorCard message="The authorization server is temporarily unavailable." />;
  }
  if (!client) return <ErrorCard message="Unknown OAuth client." />;
  if (!isRegisteredMcpRedirectUri(client, redirectUri)) {
    return <ErrorCard message="The redirect_uri is not registered for this client." />;
  }

  const codeChallenge = values.code_challenge;
  if (!codeChallenge) {
    return <ErrorCard message="A valid PKCE code_challenge is required." />;
  }

  let scope: string;
  let resource: string;
  try {
    const validated = await validateMcpAuthorizationRequest({
      clientId,
      redirectUri,
      ...(values.response_type !== undefined ? { responseType: values.response_type } : {}),
      ...(values.scope !== undefined ? { scope: values.scope } : {}),
      ...(values.resource !== undefined ? { resource: values.resource } : {}),
      codeChallenge,
      codeChallengeMethod: values.code_challenge_method ?? "S256",
    });
    scope = validated.scope;
    resource = validated.resource;
  } catch (error) {
    const message =
      error instanceof McpOAuthError ? error.message : "The authorization request is invalid.";
    return <ErrorCard message={message} />;
  }

  const clientName = client.clientName ?? "Claude";
  let redirectHost = redirectUri;
  try {
    redirectHost = new URL(redirectUri).host;
  } catch {
    // isRegisteredMcpRedirectUri already parsed it; keep the raw value as a
    // defensive fallback for display only.
  }

  return (
    <AuthMain>
      <Card className="w-full max-w-md shadow-pop [--card-spacing:--spacing(6)]">
        <CardHeader>
          <CardTitle className="text-lg font-semibold">
            Connect {clientName} to Social Media
          </CardTitle>
          <CardDescription>
            Signed in as {session.user.email}. {clientName} is requesting access to
            your social media console.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 text-sm">
          <div className="flex flex-col gap-3 rounded-xl border bg-muted/30 p-4">
            <div className="flex flex-col gap-1">
              <span className="font-medium">Requested access</span>
              <span className="text-muted-foreground">
                Create, schedule, publish, reschedule, retry, and cancel posts, and
                read connection status for the Instagram, Facebook Page, and LinkedIn
                accounts you have connected in this console.
              </span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="font-medium">Scope</span>
              <code className="w-fit rounded-md bg-muted px-2 py-1 font-mono text-xs">
                {scope}
              </code>
            </div>
            <div className="flex flex-col gap-1">
              <span className="font-medium">Callback host</span>
              <code className="break-all rounded-md bg-muted px-2 py-1 font-mono text-xs">
                {redirectHost}
              </code>
            </div>
            <div className="flex flex-col gap-1">
              <span className="font-medium">MCP resource</span>
              <code className="break-all rounded-md bg-muted px-2 py-1 font-mono text-xs">
                {resource}
              </code>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Only approve if you started this connection from {clientName}. This
            grants access to your account only; it does not share your password,
            provider tokens, or other users&apos; accounts.
          </p>
        </CardContent>
        <CardFooter>
          <form
            action="/api/mcp/oauth/authorize"
            method="post"
            className="flex w-full flex-col gap-2 sm:flex-row-reverse"
          >
            {oauthFields.map((field) => {
              const value = values[field];
              return value ? (
                <input key={field} type="hidden" name={field} value={value} />
              ) : null;
            })}
            <Button className="flex-1" size="lg" type="submit" name="action" value="approve">
              Approve
            </Button>
            <Button
              className="flex-1"
              size="lg"
              type="submit"
              name="action"
              value="deny"
              variant="outline"
            >
              Deny
            </Button>
          </form>
        </CardFooter>
      </Card>
    </AuthMain>
  );
}
