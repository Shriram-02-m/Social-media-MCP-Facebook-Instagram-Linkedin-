import { PageHeader } from "@/components/page-header";

import { AccountsPanel } from "./accounts-panel";

export default function AccountsPage() {
  return (
    <>
      <PageHeader
        title="Accounts"
        description="Connect Facebook, Instagram, and LinkedIn to publish to them. Developer app credentials are encrypted at rest and never shown again."
      />
      <AccountsPanel />
    </>
  );
}
