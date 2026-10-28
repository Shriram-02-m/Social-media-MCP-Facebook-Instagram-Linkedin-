import { AccountsPanel } from "./accounts-panel";
import { DeveloperAppSettings } from "./developer-app-settings";

export default function AccountsPage() {
  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold">Accounts</h1>
        <p className="text-sm text-muted-foreground">
          Connection status for Facebook, Instagram, and LinkedIn.
        </p>
      </div>
      <AccountsPanel />
      <DeveloperAppSettings />
    </>
  );
}
