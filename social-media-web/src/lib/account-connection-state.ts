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

export type ConnectionAction = "connect" | "reconnect";

// Truth table for the Accounts card action button:
// - "connected"          -> Reconnect (management action on a live connection)
// - previously connected -> Reconnect (expired, revoked, or disconnected
//                            token record still proves an earlier consent)
// - never connected      -> Connect (also when developer app credentials are
//                            saved: credentials are not connection history)
export function connectionAction(
  state: AccountConnectionState,
  previouslyConnected?: boolean,
): ConnectionAction {
  if (state === "connected" || previouslyConnected === true) return "reconnect";
  return "connect";
}
