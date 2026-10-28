"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

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

type ProviderId = "facebook" | "instagram" | "linkedin";

interface CredentialStatus {
  provider: ProviderId;
  configured: boolean;
  source: "user" | "shared";
  clientId?: string;
  updatedAt?: string;
}

interface ProviderMeta {
  label: string;
  idLabel: string;
  secretLabel: string;
}

// Facebook, Instagram and LinkedIn each issue their own app/client id, so the
// user configures one record per provider.
const PROVIDERS: Record<ProviderId, ProviderMeta> = {
  facebook: { label: "Facebook (Meta App)", idLabel: "App ID", secretLabel: "App Secret" },
  instagram: { label: "Instagram (Instagram App)", idLabel: "App ID", secretLabel: "App Secret" },
  linkedin: { label: "LinkedIn", idLabel: "Client ID", secretLabel: "Client Secret" },
};

const PROVIDER_ORDER: ProviderId[] = ["facebook", "instagram", "linkedin"];

interface FormState {
  clientId: string;
  clientSecret: string;
}

function emptyForms(): Record<ProviderId, FormState> {
  return {
    facebook: { clientId: "", clientSecret: "" },
    instagram: { clientId: "", clientSecret: "" },
    linkedin: { clientId: "", clientSecret: "" },
  };
}

export function DeveloperAppSettings() {
  const [statuses, setStatuses] = useState<CredentialStatus[] | null>(null);
  const [active, setActive] = useState(true);
  const [forms, setForms] = useState<Record<ProviderId, FormState>>(emptyForms);
  const [busy, setBusy] = useState<ProviderId | null>(null);

  const load = useCallback(() => {
    return fetch("/api/credentials", { cache: "no-store" })
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as {
          active?: boolean;
          credentials?: CredentialStatus[];
          error?: string;
        };
        if (!response.ok) {
          toast.error(body.error ?? "Could not load developer app settings.");
          setStatuses([]);
          return;
        }
        setActive(body.active ?? true);
        const credentials = body.credentials ?? [];
        setStatuses(credentials);
        // Prefill the (public) client id so an update only needs a changed value;
        // the secret is never returned and stays blank unless the user types one.
        setForms((current) => {
          const next = { ...current };
          for (const entry of credentials) {
            next[entry.provider] = {
              clientId: entry.clientId ?? current[entry.provider]?.clientId ?? "",
              clientSecret: "",
            };
          }
          return next;
        });
      })
      .catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : "Could not load developer app settings.");
        setStatuses([]);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const configuredFor = (provider: ProviderId) =>
    statuses?.find((entry) => entry.provider === provider)?.configured ?? false;

  const save = useCallback(
    async (provider: ProviderId) => {
      const form = forms[provider];
      setBusy(provider);
      try {
        const response = await fetch("/api/credentials", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider,
            clientId: form.clientId.trim(),
            // Omit the secret when the field is blank so the stored one is kept.
            ...(form.clientSecret.trim() ? { clientSecret: form.clientSecret.trim() } : {}),
          }),
        });
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        if (!response.ok) {
          toast.error(body.error ?? "Could not save credentials.");
          return;
        }
        toast.success(`${PROVIDERS[provider].label} credentials saved.`);
        await load();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not save credentials.");
      } finally {
        setBusy(null);
      }
    },
    [forms, load],
  );

  const remove = useCallback(
    async (provider: ProviderId) => {
      setBusy(provider);
      try {
        const response = await fetch(`/api/credentials?provider=${provider}`, { method: "DELETE" });
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        if (!response.ok) {
          toast.error(body.error ?? "Could not delete credentials.");
          return;
        }
        // Deleting app credentials never disconnects the account or removes
        // scheduled posts; the account simply falls back to the shared app.
        toast.success(`${PROVIDERS[provider].label} credentials removed. Connected accounts were not changed.`);
        setForms((current) => ({ ...current, [provider]: { clientId: "", clientSecret: "" } }));
        await load();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not delete credentials.");
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">Developer App Settings</h2>
        <p className="text-sm text-muted-foreground">
          Connect through your own Meta, Instagram, and LinkedIn apps. Accounts without their
          own credentials keep using the shared app. App secrets are encrypted at rest and are
          never shown again after saving.
        </p>
      </div>

      {!active ? (
        <p className="text-sm text-muted-foreground">
          You can save credentials when the platform is running against the cloud backend.
        </p>
      ) : null}

      {statuses === null ? (
        <div className="grid gap-4 lg:grid-cols-3">
          <Skeleton className="h-56 w-full" />
          <Skeleton className="h-56 w-full" />
          <Skeleton className="h-56 w-full" />
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          {PROVIDER_ORDER.map((provider) => {
            const meta = PROVIDERS[provider];
            const configured = configuredFor(provider);
            const form = forms[provider];
            return (
              <Card key={provider}>
                <CardHeader className="flex flex-row items-start justify-between gap-3">
                  <div>
                    <CardTitle>{meta.label}</CardTitle>
                    <CardDescription>
                      {configured ? "Using your app" : "Using the shared app"}
                    </CardDescription>
                  </div>
                  <Badge variant={configured ? "default" : "secondary"}>
                    {configured ? "Your app" : "Shared app"}
                  </Badge>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`${provider}-client-id`}>{meta.idLabel}</Label>
                    <Input
                      id={`${provider}-client-id`}
                      value={form.clientId}
                      autoComplete="off"
                      spellCheck={false}
                      disabled={!active || busy !== null}
                      onChange={(event) =>
                        setForms((current) => ({
                          ...current,
                          [provider]: { ...current[provider], clientId: event.target.value },
                        }))
                      }
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`${provider}-client-secret`}>{meta.secretLabel}</Label>
                    <Input
                      id={`${provider}-client-secret`}
                      type="password"
                      value={form.clientSecret}
                      autoComplete="off"
                      spellCheck={false}
                      disabled={!active || busy !== null}
                      placeholder={configured ? "Leave blank to keep the saved secret" : ""}
                      onChange={(event) =>
                        setForms((current) => ({
                          ...current,
                          [provider]: { ...current[provider], clientSecret: event.target.value },
                        }))
                      }
                    />
                  </div>
                  {configured && configuredStatus(statuses, provider)?.updatedAt ? (
                    <p className="text-xs text-muted-foreground">
                      Updated {new Date(configuredStatus(statuses, provider)!.updatedAt!).toLocaleDateString()}
                    </p>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      disabled={!active || busy !== null || !form.clientId.trim()}
                      onClick={() => void save(provider)}
                    >
                      {busy === provider ? "Saving..." : configured ? "Update" : "Save"}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!active || busy !== null || !configured}
                      onClick={() => void remove(provider)}
                    >
                      Delete
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </section>
  );
}

function configuredStatus(
  statuses: CredentialStatus[] | null,
  provider: ProviderId,
): CredentialStatus | undefined {
  return statuses?.find((entry) => entry.provider === provider);
}
