import { MediaUploader } from "./media-uploader";

export default function MediaPage() {
  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold">Media Library</h1>
        <p className="text-sm text-muted-foreground">
          Upload images, videos, and PDFs to private storage and receive a permanent
          <code className="mx-1 rounded bg-muted px-1 py-0.5 text-xs">storagePath</code>
          to use in the Composer or in Claude.
        </p>
      </div>
      <MediaUploader />
    </>
  );
}
