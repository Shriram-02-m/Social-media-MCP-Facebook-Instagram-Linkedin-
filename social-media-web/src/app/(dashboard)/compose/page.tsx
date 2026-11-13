import { PageHeader } from "@/components/page-header";

import { Composer } from "./composer";

export default function ComposePage() {
  return (
    <>
      <PageHeader
        title="Composer"
        description="Create text, image, video, and carousel posts for Facebook, Instagram, and LinkedIn."
      />
      <Composer />
    </>
  );
}
