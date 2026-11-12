import { AccountsPanel } from "./accounts-panel";

export default function AccountsPage() {
  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold">Accounts</h1>
        <p className="text-sm text-muted-foreground">
          Save your Facebook, Instagram, and LinkedIn developer credentials once,
          then connect each platform. Credentials are encrypted at rest and reused
          automatically for future connections.
        </p>
      </div>
      <AccountsPanel />
    </>
  );
}
