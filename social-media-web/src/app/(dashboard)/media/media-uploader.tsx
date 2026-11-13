"use client";

import { useRef, useState } from "react";
import { Check, Copy, FileUp, LoaderCircle } from "lucide-react";
import { toast } from "sonner";

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

// Browser fallback for remote MCP clients that cannot transfer attachment
// bytes. The published MCP spec has no client-to-server file-upload primitive,
// so Claude.ai cannot hand an attached image's binary to a remote MCP tool. A
// signed-in user uploads the file here; the response's permanent storagePath
// can then be pasted back into the Claude conversation and passed to
// social_publish (imageStoragePath) or social_schedule_media
// (media[].storagePath). The path never expires; signed URLs are never stored.

const ACCEPT = "image/jpeg,image/png,image/gif,video/mp4,video/quicktime,application/pdf";

interface UploadResult {
  storagePath: string;
  kind: string;
  contentType: string;
  bytes: number;
  note?: string;
}

const KIND_LABELS: Record<string, string> = {
  image: "Image",
  video: "Video",
  document: "Document",
};

export function MediaUploader() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileLabel, setFileLabel] = useState("");
  const [result, setResult] = useState<UploadResult | null>(null);
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState(false);

  function onFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    setFileLabel(file?.name ?? "");
    setResult(null);
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = inputRef.current?.files?.[0];
    if (!file || pending) return;

    setPending(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/media/upload", { method: "POST", body: form });
      const body = (await response.json().catch(() => ({}))) as UploadResult & { error?: string };
      if (!response.ok || !body.storagePath) {
        toast.error(body.error ?? "Upload failed. Check the file type and size, then try again.");
        return;
      }
      setResult(body);
      setCopied(false);
      toast.success(`${file.name} uploaded to your private storage.`);
    } catch {
      toast.error("Upload failed. Check the file type and size, then try again.");
    } finally {
      setPending(false);
      if (inputRef.current) inputRef.current.value = "";
      setFileLabel("");
    }
  }

  async function copyStoragePath() {
    if (!result?.storagePath) return;
    try {
      await navigator.clipboard.writeText(result.storagePath);
      setCopied(true);
      toast.success("Storage path copied.");
    } catch {
      toast.error("Copy failed. Select the path text and copy it manually.");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Upload media</CardTitle>
        <CardDescription>
          Images (JPEG, PNG, GIF), videos (MP4, MOV), or PDF documents.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="media-file">File</Label>
            <Input
              id="media-file"
              ref={inputRef}
              type="file"
              accept={ACCEPT}
              onChange={onFileChange}
              disabled={pending}
            />
          </div>
          <Button type="submit" disabled={pending || !fileLabel} className="w-fit">
            {pending ? (
              <>
                <LoaderCircle className="animate-spin" aria-hidden="true" />
                Uploading…
              </>
            ) : (
              <>
                <FileUp aria-hidden="true" />
                Upload
              </>
            )}
          </Button>
        </form>
        {result && (
          <div className="flex flex-col gap-3 rounded-md border bg-muted/40 p-3">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              <span className="font-medium">
                {KIND_LABELS[result.kind] ?? result.kind} uploaded
              </span>
              <span className="text-xs text-muted-foreground">
                {(result.bytes / 1024 / 1024).toFixed(2)} MB
              </span>
            </div>
            <div className="flex items-start gap-2">
              <code className="min-w-0 flex-1 break-all rounded bg-muted px-2 py-1 text-xs">
                {result.storagePath}
              </code>
              <Button type="button" variant="outline" size="sm" onClick={copyStoragePath}>
                {copied ? (
                  <Check aria-hidden="true" />
                ) : (
                  <Copy aria-hidden="true" />
                )}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              To use it from Claude: paste this path into the conversation and
              say “Publish/schedule this image”. In the MCP tools it goes to{" "}
              <code>imageStoragePath</code> (social_publish) or{" "}
              <code>media[].storagePath</code> (social_schedule_media). The path
              is permanent — signed URLs are generated fresh at publish time and
              must never be stored.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
