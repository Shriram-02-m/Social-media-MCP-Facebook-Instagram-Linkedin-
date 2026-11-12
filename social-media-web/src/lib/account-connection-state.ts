// Pure connection-state derivation shared by the Accounts UI and its tests.
// The card border is driven only by the live OAuth connection status, never by
// whether developer app credentials have been saved.

export interface PlatformConnectionLike {
  connected?: boolean;
  tokenExpired?: boolean;
}

export type AccountConnectionState = "connected" | "expired" | "disconnected";

export function accountConnectionState(
  status?: PlatformConnectionLike | null,
): AccountConnectionState {
  if (!status?.connected) return "disconnected";
  if (status.tokenExpired) return "expired";
  return "connected";
}
