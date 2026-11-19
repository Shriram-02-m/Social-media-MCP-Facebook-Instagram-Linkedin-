"use client";

import { useCallback, useEffect, useState } from "react";
import {
  CircleAlert,
  CircleCheck,
  ExternalLink,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { cn } from "cn";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { PlatformLogo } from "@/components/platform-logo";
import { SocialStatusBadge } from "@/components/status-badge";
import {
  accountConnectionState,
  connectionAction,
  type AccountConnectionState,
} from "@/lib/account-connection-state";

type PlatformId = "facebook" | "instagram" | "linkedin";

type AuthSessionStatus = "pending" | "connected" | "cancelled" | "failed" | "expired";

interface PlatformStatus {
  platform: PlatformId;
  connected?: boolean;
  reason?: string;
  error?: string;
  accountName?: string | null;
  expiresAt?: number | null;
  tokenExpired?: boolean;
  missingPermissions?: string[];
  grantedScopes?: string[];
  grantedPermissions?: string[];
  warning?: string;
  connectedAt?: string | null;
  previouslyConnected?: boolean;
}

interface CredentialStatus {
  provider: PlatformId;
  configured: boolean;
  source: "user" | "shared";
  clientId?: string;
  updatedAt?: string;
}

interface ProviderMeta {
  label: string;
  idLabel: string;
  secretLabel: string;
  description: string;
  idPlaceholder: string;
  secretPlaceholder: string;
}

interface FormState {
  clientId: string;
  clientSecret: string;
}

type BusyState = { platform: PlatformId; action: "save" | "connect" } | null;

// Facebook, Instagram and LinkedIn each issue their own app/client id, so a user
// configures one credential record per provider.
const PROVIDERS: Record<PlatformId, ProviderMeta> = {
  facebook: {
    label: "Facebook",
    idLabel: "App ID",
    secretLabel: "App Secret",
    description: "Meta app for Facebook Pages",
    idPlaceholder: "Your Meta app ID",
    secretPlaceholder: "Your Meta app secret",
  },
  instagram: {
    label: "Instagram",
    idLabel: "App ID",
    secretLabel: "App Secret",
    description: "Instagram Login app",
    idPlaceholder: "Your Instagram app ID",
    secretPlaceholder: "Your Instagram app secret",
  },
  linkedin: {
    label: "LinkedIn",
    idLabel: "Client ID",
    secretLabel: "Client Secret",
    description: "LinkedIn developer app",
    idPlaceholder: "Your LinkedIn client ID",
    secretPlaceholder: "Your LinkedIn client secret",
  },
};

const PLATFORM_ORDER: PlatformId[] = ["facebook", "instagram", "linkedin"];

const MAX_WAIT_LOOPS = 18;

const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatDateTime(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return dateTimeFormatter.format(date);
}

function emptyForms(): Record<PlatformId, FormState> {
  return {
    facebook: { clientId: "", clientSecret: "" },
    instagram: { clientId: "", clientSecret: "" },
    linkedin: { clientId: "", clientSecret: "" },
  };
}

function emptyEditing(): Record<PlatformId, boolean> {
  return { facebook: false, instagram: false, linkedin: false };
}

function emptyStatuses(): Record<PlatformId, PlatformStatus> {
  return {
    facebook: { platform: "facebook", connected: false },
    instagram: { platform: "instagram", connected: false },
    linkedin: { platform: "linkedin", connected: false },
  };
}

function emptyCredentials(): Record<PlatformId, CredentialStatus> {
  return {
    facebook: { provider: "facebook", configured: false, source: "shared" },
    instagram: { provider: "instagram", configured: false, source: "shared" },
    linkedin: { provider: "linkedin", configured: false, source: "shared" },
  };
}

function indexStatuses(list: PlatformStatus[]): Record<PlatformId, PlatformStatus> {
  const indexed = emptyStatuses();
  for (const status of list) {
    if (status.platform in indexed) indexed[status.platform] = status;
  }
  return indexed;
}

function indexCredentials(list: CredentialStatus[]): Record<PlatformId, CredentialStatus> {
  const indexed = emptyCredentials();
  for (const credential of list) {
    if (credential.provider in indexed) indexed[credential.provider] = credential;
  }
  return indexed;
}

function connectionReason(status: PlatformStatus): string {
  if (status.error) return status.error;
  const reason = status.reason;
  if (!reason) return "Connect this platform to authorize publishing.";
  // The low-level tooling hint is not useful in this UI.
  if (/social_authorization_start/i.test(reason)) {
    return "Connect this platform to authorize publishing.";
  }
  return reason;
}

function expiryLabel(status: PlatformStatus): string {
  const formatted = formatDateTime(status.expiresAt);
  if (status.tokenExpired) {
    return formatted
      ? `Access token expired on ${formatted}.`
      : "The access token has expired.";
  }
  if (formatted) return `Access token expires ${formatted}.`;
  return "No token expiry reported.";
}

function authStatusMessage(platform: PlatformId, status: AuthSessionStatus): string {
  const label = PROVIDERS[platform].label;
  if (status === "cancelled") {
    return `${label} authorization was cancelled. You can try again.`;
  }
  if (status === "expired") {
    return `${label} authorization expired before it completed. Try again.`;
  }
  return `${label} authorization failed. Check the app ID, app secret, and callback URL, then try again.`;
}

function cardRingClass(state: AccountConnectionState): string {
  // Only a live connection earns a coloured outline. Expired tokens get a
  // warning accent, while never-connected / disconnected cards stay neutral so
  // the page does not read as a wall of errors.
  if (state === "connected") return "ring-2 ring-success/60";
  if (state === "expired") return "ring-2 ring-warning/60";
  return "ring-1 ring-foreground/10";
}

export function AccountsPanel() {
  const [statuses, setStatuses] = useState<Record<PlatformId, PlatformStatus> | null>(null);
  const [credentials, setCredentials] =
    useState<Record<PlatformId, CredentialStatus> | null>(null);
  const [active, setActive] = useState(true);
  const [forms, setForms] = useState<Record<PlatformId, FormState>>(emptyForms);
  const [editing, setEditing] = useState<Record<PlatformId, boolean>>(emptyEditing);
  const [busy, setBusy] = useState<BusyState>(null);
  const [errors, setErrors] = useState<Partial<Record<PlatformId, string>>>({});
  const [messages, setMessages] = useState<Partial<Record<PlatformId, string>>>({});
  // Removing saved credentials is destructive (the OAuth app config is lost),
  // so it asks for confirmation with the app's standard dialog.
  const [removing, setRemoving] = useState<PlatformId | null>(null);

  const setCardError = useCallback((platform: PlatformId, message: string | null) => {
    setErrors((current) => {
      const next = { ...current };
      if (message) next[platform] = message;
      else delete next[platform];
      return next;
    });
  }, []);

  const setCardMessage = useCallback((platform: PlatformId, message: string | null) => {
    setMessages((current) => {
      const next = { ...current };
      if (message) next[platform] = message;
      else delete next[platform];
      return next;
    });
  }, []);

  const load = useCallback(() => {
    return Promise.all([
      fetch("/api/platforms", { cache: "no-store" }),
      fetch("/api/credentials", { cache: "no-store" }),
    ])
      .then(async ([platformsResponse, credentialsResponse]) => {
        const platformsBody = (await platformsResponse.json().catch(() => ({}))) as {
          platforms?: PlatformStatus[];
          error?: string;
        };
        if (!platformsResponse.ok) {
          toast.error(platformsBody.error ?? "Could not load connection status.");
          setStatuses((current) => current ?? emptyStatuses());
        } else {
          setStatuses(indexStatuses(platformsBody.platforms ?? []));
        }

        const credentialsBody = (await credentialsResponse.json().catch(() => ({}))) as {
          active?: boolean;
          credentials?: CredentialStatus[];
          error?: string;
        };
        if (!credentialsResponse.ok) {
          toast.error(
            credentialsBody.error ?? "Could not load developer app credentials.",
          );
          setCredentials((current) => current ?? emptyCredentials());
          return;
        }

        const list = credentialsBody.credentials ?? [];
        setActive(credentialsBody.active ?? true);
        setCredentials(indexCredentials(list));
        // Prefill the (public) app/client id so an update only needs a changed
        // value. Secrets are never returned, so the secret field stays blank.
        setForms((current) => {
          const next = { ...current };
          for (const entry of list) {
            next[entry.provider] = {
              clientId: entry.clientId ?? next[entry.provider].clientId,
              clientSecret: next[entry.provider].clientSecret,
            };
          }
          return next;
        });
      })
      .catch((error: unknown) => {
        toast.error(
          error instanceof Error ? error.message : "Could not load account settings.",
        );
        setStatuses((current) => current ?? emptyStatuses());
        setCredentials((current) => current ?? emptyCredentials());
      });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The provider redirects the OAuth tab back to a fixed /accounts page. Surface
  // the coarse result on the matching card and refresh both connection and
  // credential state even if the original tab's polling already finished.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauth = params.get("oauth");
    if (!oauth) return;
    const platformParam = params.get("platform");
    const platform =
      platformParam && PLATFORM_ORDER.includes(platformParam as PlatformId)
        ? (platformParam as PlatformId)
        : null;
    const label = platform ? PROVIDERS[platform].label : "Social account";

    let errorMessage: string | null = null;
    if (oauth === "connected") {
      toast.success(`${label} connected.`);
    } else {
      errorMessage =
        oauth === "cancelled"
          ? `${label} connection was cancelled. You can try again.`
          : oauth === "expired"
            ? `${label} connection request expired. Try again.`
            : `${label} connection failed. Check the saved credentials and callback URL, then try again.`;
      toast.error(errorMessage);
    }

    const clean = new URL(window.location.href);
    clean.searchParams.delete("oauth");
    clean.searchParams.delete("platform");
    window.history.replaceState({}, "", `${clean.pathname}${clean.search}${clean.hash}`);
    void load().then(() => {
      if (platform && errorMessage) setCardError(platform, errorMessage);
    });
  }, [load, setCardError]);

  const save = useCallback(
    async (platform: PlatformId, options: { silent?: boolean } = {}): Promise<boolean> => {
      const form = forms[platform];
      const clientId = form.clientId.trim();
      const clientSecret = form.clientSecret.trim();
      const configured = credentials?.[platform].configured ?? false;
      const meta = PROVIDERS[platform];

      if (!active) {
        const message =
          "Saving user-owned credentials requires the cloud backend (TOKEN_STORE_BACKEND=supabase).";
        setCardError(platform, message);
        if (!options.silent) toast.error(message);
        return false;
      }
      if (!clientId) {
        const message = `Enter the ${meta.idLabel.toLowerCase()}.`;
        setCardError(platform, message);
        if (!options.silent) toast.error(message);
        return false;
      }
      if (!configured && !clientSecret) {
        const message = `Enter the ${meta.secretLabel.toLowerCase()}.`;
        setCardError(platform, message);
        if (!options.silent) toast.error(message);
        return false;
      }

      setBusy({ platform, action: "save" });
      setCardError(platform, null);
      try {
        const response = await fetch("/api/credentials", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: platform,
            clientId,
            // Omit the secret when the field is blank so the stored one is kept.
            ...(clientSecret ? { clientSecret } : {}),
          }),
        });
        const body = (await response.json().catch(() => ({}))) as {
          credentials?: CredentialStatus[];
          error?: string;
        };
        if (!response.ok) {
          const message = body.error ?? "Could not save credentials.";
          setCardError(platform, message);
          if (!options.silent) toast.error(message);
          return false;
        }

        if (body.credentials) {
          setCredentials(indexCredentials(body.credentials));
        } else {
          setCredentials((current) => ({
            ...(current ?? emptyCredentials()),
            [platform]: {
              provider: platform,
              configured: true,
              source: "user",
              clientId,
              updatedAt: new Date().toISOString(),
            },
          }));
        }
        setForms((current) => ({
          ...current,
          [platform]: {
            clientId,
            // Never keep the submitted secret in component state after saving.
            clientSecret: "",
          },
        }));
        setEditing((current) => ({ ...current, [platform]: false }));
        if (!options.silent) toast.success(`${meta.label} credentials saved.`);
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not save credentials.";
        setCardError(platform, message);
        if (!options.silent) toast.error(message);
        return false;
      } finally {
        setBusy(null);
      }
    },
    [active, credentials, forms, setCardError],
  );

  const connect = useCallback(
    async (platform: PlatformId) => {
      setCardError(platform, null);
      setCardMessage(platform, null);

      // Open the provider tab now, while we still have the click gesture. Some
      // browsers block window.open after an awaited save/fetch, even when the
      // user initiated the action.
      const authWindow = window.open("about:blank", "_blank");
      if (!authWindow) {
        const message =
          "Allow pop-ups for this site so the provider sign-in tab can open.";
        setCardError(platform, message);
        toast.error(message);
        return;
      }
      try {
        authWindow.opener = null;
      } catch {
        // Some browsers restrict this; the navigation below still replaces the
        // blank document with the provider page.
      }
      const closePendingWindow = () => {
        try {
          authWindow.close();
        } catch {
          // Ignore: the browser may already have closed the tab.
        }
      };

      // If the user typed credentials but has not saved them yet, save first so
      // the OAuth flow always runs against the values shown in the card.
      const form = forms[platform];
      const configured = credentials?.[platform].configured ?? false;
      const shouldSave =
        Boolean(form.clientId.trim()) && (!configured || editing[platform]);
      if (shouldSave) {
        const saved = await save(platform, { silent: true });
        if (!saved) {
          closePendingWindow();
          return;
        }
      }

      setBusy({ platform, action: "connect" });
      try {
        const startResponse = await fetch("/api/platforms/authorize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ platform }),
        });
        const startBody = (await startResponse.json().catch(() => ({}))) as {
          authorizationUrl?: string;
          sessionId?: string;
          error?: string;
        };
        if (!startResponse.ok || !startBody.authorizationUrl || !startBody.sessionId) {
          const message = startBody.error ?? "Could not start authorization.";
          setCardError(platform, message);
          toast.error(message);
          closePendingWindow();
          return;
        }

        try {
          authWindow.location.href = startBody.authorizationUrl;
        } catch {
          const message =
            "Could not open the provider sign-in tab. Allow pop-ups for this site and try again.";
          setCardError(platform, message);
          toast.error(message);
          closePendingWindow();
          return;
        }
        setCardMessage(
          platform,
          `Complete the ${PROVIDERS[platform].label} sign-in in the new tab. This card updates automatically.`,
        );

        let finalStatus: AuthSessionStatus | null = null;
        let finalError: string | undefined;
        for (let attempt = 0; attempt < MAX_WAIT_LOOPS; attempt += 1) {
          const waitResponse = await fetch("/api/platforms/authorize/wait", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId: startBody.sessionId, timeoutSeconds: 5 }),
          });
          const waitBody = (await waitResponse.json().catch(() => ({}))) as {
            status?: { status?: AuthSessionStatus; error?: string };
            error?: string;
          };
          if (!waitResponse.ok) {
            const message = waitBody.error ?? "Could not confirm the authorization result.";
            setCardError(platform, message);
            toast.error(message);
            return;
          }
          const status = waitBody.status?.status;
          if (status && status !== "pending") {
            finalStatus = status;
            finalError = waitBody.status?.error;
            break;
          }
        }

        if (finalStatus === "connected") {
          toast.success(`${PROVIDERS[platform].label} connected.`);
          setCardMessage(platform, null);
        } else if (finalStatus) {
          const message = finalError ?? authStatusMessage(platform, finalStatus);
          setCardError(platform, message);
          toast.error(message);
        } else {
          setCardMessage(
            platform,
            "Authorization did not finish in time. Approve the sign-in in the opened tab, or try again.",
          );
        }
        await load();
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Could not connect the platform.";
        setCardError(platform, message);
        toast.error(message);
      } finally {
        setBusy(null);
      }
    },
    [credentials, editing, forms, load, save, setCardError, setCardMessage],
  );

  const remove = useCallback(
    async (platform: PlatformId) => {
      setRemoving(null);
      const label = PROVIDERS[platform].label;
      setBusy({ platform, action: "save" });
      setCardError(platform, null);
      try {
        const response = await fetch(`/api/credentials?provider=${platform}`, {
          method: "DELETE",
        });
        const body = (await response.json().catch(() => ({}))) as {
          credentials?: CredentialStatus[];
          error?: string;
        };
        if (!response.ok) {
          const message = body.error ?? "Could not remove credentials.";
          setCardError(platform, message);
          toast.error(message);
          return;
        }
        if (body.credentials) {
          setCredentials(indexCredentials(body.credentials));
        } else {
          setCredentials((current) => ({
            ...(current ?? emptyCredentials()),
            [platform]: { provider: platform, configured: false, source: "shared" },
          }));
        }
        setForms((current) => ({
          ...current,
          [platform]: { clientId: "", clientSecret: "" },
        }));
        setEditing((current) => ({ ...current, [platform]: false }));
        toast.success(
          `${label} developer credentials removed. Connected accounts were not changed.`,
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Could not remove credentials.";
        setCardError(platform, message);
        toast.error(message);
      } finally {
        setBusy(null);
      }
    },
    [setCardError],
  );

  const cancelEdit = useCallback(
    (platform: PlatformId) => {
      setForms((current) => ({
        ...current,
        [platform]: {
          clientId: credentials?.[platform].clientId ?? "",
          clientSecret: "",
        },
      }));
      setEditing((current) => ({ ...current, [platform]: false }));
      setCardError(platform, null);
    },
    [credentials, setCardError],
  );

  const updateForm = useCallback(
    (platform: PlatformId, field: keyof FormState, value: string) => {
      setForms((current) => ({
        ...current,
        [platform]: { ...current[platform], [field]: value },
      }));
    },
    [],
  );

  if (statuses === null || credentials === null) {
    return (
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Skeleton className="h-[26rem] w-full" />
        <Skeleton className="h-[26rem] w-full" />
        <Skeleton className="h-[26rem] w-full" />
      </div>
    );
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <p className="text-sm text-muted-foreground">
          Each card is one platform: save your developer app credentials, then
          connect the social account. The border turns green only after the
          provider confirms the authorization.
        </p>
        {!active ? (
          <p className="flex items-start gap-2 text-sm text-muted-foreground">
            <ShieldCheck className="mt-0.5 size-4 shrink-0" />
            User-owned credentials are unavailable because this deployment is not
            using the cloud token store. Connections still use the shared app.
          </p>
        ) : null}
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {PLATFORM_ORDER.map((platform) => {
          const meta = PROVIDERS[platform];
          const connection = statuses[platform];
          const credential = credentials[platform];
          const state = accountConnectionState(connection);
          const configured = credential.configured;
          const form = forms[platform];
          const isEditing = editing[platform] || !configured;
          const busyHere = busy?.platform === platform;
          const cardError = errors[platform];
          const cardMessage = messages[platform];
          const missingPermissions = connection.missingPermissions ?? [];
          const isSaving = busyHere && busy.action === "save";
          const isConnecting = busyHere && busy.action === "connect";
          const accountName = connection.accountName?.trim();
          // "Reconnect" is right whenever an OAuth consent completed before
          // (live connection or a stored token record); everyone else,
          // including users who only saved developer credentials, sees
          // "Connect".
          const action = connectionAction(state, connection.previouslyConnected);

          return (
            <Card
              key={platform}
              className={cn(
                "shadow-card transition-colors duration-200",
                cardRingClass(state),
              )}
            >
              <CardHeader className="flex flex-row items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-3">
                  <PlatformLogo platform={platform} className="size-10" />
                  <div className="min-w-0">
                    <CardTitle className="truncate">{meta.label}</CardTitle>
                    <CardDescription className="truncate">
                      {state === "connected"
                        ? accountName ?? "Authorized account"
                        : state === "expired"
                          ? "Reconnect to renew access"
                          : "Not connected"}
                    </CardDescription>
                  </div>
                </div>
                <SocialStatusBadge status={state} />
              </CardHeader>

              <CardContent className="flex flex-1 flex-col gap-4">
                <div className="rounded-lg border bg-muted/30 p-3">
                  {state === "connected" ? (
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-1.5 text-sm font-medium text-success">
                        <CircleCheck className="size-4" />
                        Connected
                      </div>
                      <p
                        className="truncate text-sm font-medium"
                        title={accountName ?? undefined}
                      >
                        {accountName ?? "Authorized account"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {expiryLabel(connection)}
                      </p>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-1.5 text-sm font-medium text-destructive">
                        <CircleAlert className="size-4" />
                        {state === "expired" ? "Reconnect required" : "Not connected"}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {state === "expired"
                          ? expiryLabel(connection)
                          : connectionReason(connection)}
                      </p>
                    </div>
                  )}
                  {missingPermissions.length > 0 ? (
                    <p className="mt-2 text-xs text-destructive">
                      Missing permissions: {missingPermissions.join(", ")}.
                      Reconnect and grant them.
                    </p>
                  ) : null}
                  {connection.warning ? (
                    <p className="mt-2 text-xs text-warning">
                      {connection.warning}
                    </p>
                  ) : null}
                </div>

                {cardError ? (
                  <div
                    role="alert"
                    className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
                  >
                    <CircleAlert className="mt-0.5 size-4 shrink-0" />
                    <span>{cardError}</span>
                  </div>
                ) : null}

                {cardMessage ? (
                  <p className="text-xs text-muted-foreground">{cardMessage}</p>
                ) : null}

                {/* Developer App Settings is its own clearly-titled section so
                    the credential form reads apart from the connection state. */}
                <div className="flex flex-col gap-3 rounded-lg border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 text-sm font-semibold">
                      <KeyRound className="size-4 text-muted-foreground" />
                      Developer App Settings
                    </div>
                    <Badge variant="outline" className="text-[10px]">
                      {configured ? "Credentials saved" : "Using shared app"}
                    </Badge>
                  </div>

                  {!isEditing ? (
                    <>
                      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
                        <dt className="text-xs text-muted-foreground">
                          {meta.idLabel}
                        </dt>
                        <dd
                          className="truncate font-mono text-sm font-medium"
                          title={credential.clientId}
                        >
                          {credential.clientId ?? "—"}
                        </dd>
                        <dt className="text-xs text-muted-foreground">
                          {meta.secretLabel}
                        </dt>
                        <dd className="text-sm font-medium text-muted-foreground">
                          •••••••• (saved)
                        </dd>
                      </dl>
                      {credential.updatedAt ? (
                        <p className="text-[11px] text-muted-foreground">
                          Updated {formatDateTime(credential.updatedAt) ?? "recently"}
                        </p>
                      ) : null}
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy !== null}
                          onClick={() =>
                            setEditing((current) => ({ ...current, [platform]: true }))
                          }
                        >
                          Update credentials
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          disabled={busy !== null}
                          onClick={() => setRemoving(platform)}
                        >
                          Remove
                        </Button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor={`${platform}-client-id`}>{meta.idLabel}</Label>
                        <Input
                          id={`${platform}-client-id`}
                          value={form.clientId}
                          autoComplete="off"
                          spellCheck={false}
                          placeholder={meta.idPlaceholder}
                          disabled={!active || busy !== null}
                          onChange={(event) =>
                            updateForm(platform, "clientId", event.target.value)
                          }
                        />
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor={`${platform}-client-secret`}>
                          {meta.secretLabel}
                        </Label>
                        <Input
                          id={`${platform}-client-secret`}
                          type="password"
                          value={form.clientSecret}
                          autoComplete="new-password"
                          spellCheck={false}
                          placeholder={
                            configured
                              ? "Leave blank to keep the saved secret"
                              : meta.secretPlaceholder
                          }
                          disabled={!active || busy !== null}
                          onChange={(event) =>
                            updateForm(platform, "clientSecret", event.target.value)
                          }
                        />
                        <p className="text-[11px] text-muted-foreground">
                          Encrypted before storage and never shown again after
                          saving.
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          disabled={!active || busy !== null || !form.clientId.trim()}
                          onClick={() => void save(platform)}
                        >
                          {isSaving
                            ? "Saving..."
                            : configured
                              ? "Update credentials"
                              : "Save credentials"}
                        </Button>
                        {configured ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={busy !== null}
                            onClick={() => cancelEdit(platform)}
                          >
                            Cancel
                          </Button>
                        ) : null}
                      </div>
                    </>
                  )}
                </div>

                <div className="mt-auto flex flex-wrap items-center gap-2 border-t pt-3">
                  {/* Primary while action is needed; a live connection only
                      offers outline-styled reconnect management. */}
                  <Button
                    variant={state === "connected" ? "outline" : "default"}
                    disabled={busy !== null}
                    onClick={() => void connect(platform)}
                  >
                    {isConnecting ? (
                      <>
                        <LoaderCircle className="animate-spin" />
                        Waiting for sign-in...
                      </>
                    ) : action === "reconnect" ? (
                      <>
                        <RefreshCw />
                        Reconnect
                      </>
                    ) : (
                      <>
                        <ExternalLink />
                        Connect
                      </>
                    )}
                  </Button>
                  <span className="text-[11px] text-muted-foreground">
                    {configured
                      ? "OAuth uses your saved developer app."
                      : "OAuth uses the shared app until you save your own."}
                  </span>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {removing
                ? `Remove the saved ${PROVIDERS[removing].label} developer credentials?`
                : ""}
            </AlertDialogTitle>
            <AlertDialogDescription>
              The saved app ID and secret will be deleted. Connected accounts
              are not disconnected, but you will need the credentials again to
              reconnect later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep credentials</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (removing) void remove(removing);
              }}
            >
              Remove credentials
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
