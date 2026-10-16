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
import { Skeleton } from "@/components/ui/skeleton";

type PlatformId = "facebook" | "instagram" | "linkedin";

type PlatformStatus = PlatformStatusResult & { platform: PlatformId };

interface PlatformStatusResult {
  connected?: boolean;
  reason?: string;
  accountName?: string;
  grantedPermissions?: string[];
  grantedScopes?: string[];
  missingPermissions?: string[];
  expiresAt?: number;
  tokenExpired?: boolean;
}

type AuthSessionStatus = "pending" | "connected" | "cancelled" | "failed" | "expired";

const PLATFORM_LABELS: Record<PlatformId, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  linkedin: "LinkedIn",
};

const MAX_WAIT_LOOPS = 18;

export function AccountsPanel() {
  const [statuses, setStatuses] = useState<PlatformStatus[] | null>(null);
  const [busy, setBusy] = useState<PlatformId | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(() => {
    return fetch("/api/platforms", { cache: "no-store" })
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as {
          platforms?: PlatformStatus[];
          error?: string;
        };
        if (!response.ok) {
          toast.error(body.error ?? "Could not load account status.");
          return;
        }
        setStatuses(body.platforms ?? []);
      })
      .catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : "Could not load account status.");
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const reconnect = useCallback(
    async (platform: PlatformId) => {
      setBusy(platform);
      setMessage(null);
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
          toast.error(startBody.error ?? "Could not start authorization.");
          return;
        }

        window.open(startBody.authorizationUrl, "_blank", "noopener,noreferrer");
        setMessage(
          `Complete the ${PLATFORM_LABELS[platform]} sign-in in the new tab, then approve here.`,
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
            setMessage(waitBody.error ?? "Authorization wait failed.");
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
          toast.success(`${PLATFORM_LABELS[platform]} reconnected.`);
          setMessage(null);
        } else if (finalStatus) {
          toast.error(
            finalError ?? `Authorization ended as "${finalStatus}".`,
          );
        } else {
          setMessage("Authorization did not finish. Check the callback tunnel is running.");
        }
        await load();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Reconnect failed.");
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  if (statuses === null) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Reconnecting opens the provider sign-in in a new tab and waits for the OAuth
        callback. The callback tunnel (OAUTH_REDIRECT_BASE_URL) must be reachable while
        you approve.
      </p>
      {message ? <p className="text-sm text-muted-foreground">{message}</p> : null}

      <div className="grid gap-4 lg:grid-cols-3">
        {statuses.map((status) => (
          <Card key={status.platform}>
            <CardHeader className="flex flex-row items-start justify-between gap-3">
              <div>
                <CardTitle>{PLATFORM_LABELS[status.platform]}</CardTitle>
                <CardDescription>{status.accountName ?? "Provider account"}</CardDescription>
              </div>
              <Badge variant={status.connected ? "default" : "destructive"}>
                {status.connected ? "Connected" : "Disconnected"}
              </Badge>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {!status.connected && status.reason ? (
                <p className="text-sm text-destructive">{status.reason}</p>
              ) : null}
              {status.expiresAt ? (
                <p className="text-xs text-muted-foreground">
                  {status.tokenExpired ? "Token expired" : "Token valid"} ·{" "}
                  {new Date(status.expiresAt).toLocaleDateString()}
                </p>
              ) : null}
              {status.missingPermissions && status.missingPermissions.length > 0 ? (
                <p className="text-xs text-destructive">
                  Missing: {status.missingPermissions.join(", ")}
                </p>
              ) : null}
              <div className="flex flex-wrap gap-1">
                {(status.grantedScopes ?? status.grantedPermissions ?? []).slice(0, 6).map(
                  (permission) => (
                    <Badge key={permission} variant="outline" className="text-[10px]">
                      {permission}
                    </Badge>
                  ),
                )}
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={() => void reconnect(status.platform)}
              >
                {busy === status.platform ? "Waiting for sign-in..." : "Reconnect"}
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
