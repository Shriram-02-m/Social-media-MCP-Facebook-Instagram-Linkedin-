import { CloudUpload } from "lucide-react";

import { PageHeader } from "@/components/page-header";

import { MediaUploader } from "./media-uploader";

export default function MediaPage() {
  return (
    <>
      <PageHeader
        title="Media Library"
        description="Upload images, videos, and documents to your private storage, then use them in the Composer or in Claude."
      />
      <MediaUploader />
      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <CloudUpload className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        Files stay private to your account. Uploads are permanent references;
        expiring links are generated fresh only when a post is published.
      </p>
    </>
  );
}
