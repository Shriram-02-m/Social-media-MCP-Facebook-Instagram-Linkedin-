"use client";

import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const PLATFORMS = [
  { id: "facebook", label: "Facebook" },
  { id: "instagram", label: "Instagram" },
  { id: "linkedin", label: "LinkedIn" },
] as const;

type PlatformId = (typeof PLATFORMS)[number]["id"];

const TEXT_LIMITS: Record<PlatformId, number> = {
  instagram: 2200,
  facebook: 63206,
  linkedin: 3000,
};

const ACCEPT = "image/jpeg,image/png,image/gif,video/mp4,video/quicktime";
const MAX_ITEMS = 10;

type MediaKind = "image" | "video";

function kindFor(file: File): MediaKind {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  throw new Error(`Unsupported file type "${file.type || file.name}".`);
}

function localDateTimeDefault(offsetMinutes: number): string {
  const date = new Date(Date.now() + offsetMinutes * 60_000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function Composer() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  const [platforms, setPlatforms] = useState<PlatformId[]>(["instagram"]);
  const [text, setText] = useState("");
  const [scheduledAt, setScheduledAt] = useState(() => localDateTimeDefault(60));
  const [publishNow, setPublishNow] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);
  const [pending, setPending] = useState(false);

  const previews = useMemo(
    () =>
      files.map((file, index) => ({
        file,
        url: previewUrls[index],
        kind: kindFor(file),
      })),
    [files, previewUrls],
  );

  const imageCount = previews.filter((item) => item.kind === "image").length;
  const videoCount = previews.filter((item) => item.kind === "video").length;
  const isCarousel = imageCount >= 2 && videoCount === 0;

  const selectedLimit = platforms.reduce(
    (limit, id) => Math.min(limit, TEXT_LIMITS[id]),
    Number.MAX_SAFE_INTEGER,
  );

  const issues: string[] = [];
  if (platforms.length === 0) issues.push("Select at least one platform.");
  if (!text.trim()) issues.push("Add post text.");
  if (text.length > selectedLimit) {
    issues.push(`Text exceeds the ${selectedLimit}-character limit for the selected platforms.`);
  }
  if (files.length > MAX_ITEMS) issues.push(`Choose at most ${MAX_ITEMS} media items.`);
  if (videoCount > 0 && imageCount > 0) {
    issues.push("Use either a single video or only images.");
  }
  if (platforms.includes("instagram") && files.length === 0) {
    issues.push("Instagram requires at least one image or video.");
  }
  if (isCarousel) {
    if (!platforms.includes("instagram") || platforms.length > 1) {
      issues.push("Carousels can only be published to Instagram.");
    }
  }
  if (!publishNow && !scheduledAt) issues.push("Choose a schedule time.");

  function togglePlatform(id: PlatformId) {
    setPlatforms((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  }

  function onFiles(next: FileList | null) {
    if (!next) return;
    const incoming = Array.from(next);
    try {
      for (const file of incoming) kindFor(file);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unsupported file.");
      return;
    }

    const combined = [...files, ...incoming].slice(0, MAX_ITEMS);
    setFiles(combined);
    setPreviewUrls((current) => {
      current.forEach((url) => URL.revokeObjectURL(url));
      return combined.map((file) => URL.createObjectURL(file));
    });
    if (inputRef.current) inputRef.current.value = "";
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (issues.length > 0 || pending) return;

    setPending(true);
    try {
      const form = new FormData();
      platforms.forEach((platform) => form.append("platforms", platform));
      form.append("text", text.trim());
      form.append("publishNow", publishNow ? "true" : "false");
      if (!publishNow) {
        form.append("scheduledAt", new Date(scheduledAt).toISOString());
      }
      files.forEach((file) => form.append("media", file));

      const response = await fetch("/api/posts", { method: "POST", body: form });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        scheduled?: unknown[];
      };

      if (!response.ok) {
        toast.error(body.error ?? "Could not schedule the post.");
        return;
      }

      toast.success(
        publishNow
          ? "Queued for immediate publishing."
          : `Scheduled ${Array.isArray(body.scheduled) ? body.scheduled.length : 1} post(s).`,
      );
      router.push("/queue");
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="flex flex-col gap-6" onSubmit={onSubmit}>
      <Card>
        <CardHeader>
          <CardTitle>Post</CardTitle>
          <CardDescription>
            Choose platforms, write the caption, and attach media.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <Label>Platforms</Label>
            <div className="flex flex-wrap gap-2">
              {PLATFORMS.map((platform) => {
                const active = platforms.includes(platform.id);
                return (
                  <Button
                    key={platform.id}
                    type="button"
                    variant={active ? "default" : "outline"}
                    size="sm"
                    aria-pressed={active}
                    onClick={() => togglePlatform(platform.id)}
                  >
                    {platform.label}
                  </Button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="text">Caption</Label>
              <span className="text-xs text-muted-foreground">
                {text.length} / {selectedLimit}
              </span>
            </div>
            <Textarea
              id="text"
              rows={6}
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="Write your caption..."
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="media">Media</Label>
            <p className="text-xs text-muted-foreground">
              JPEG, PNG, or GIF images (2–10 for an Instagram carousel), or a single MP4/MOV
              video up to 50 MB. Instagram needs at least one item.
            </p>
            <Input
              id="media"
              ref={inputRef}
              type="file"
              accept={ACCEPT}
              multiple
              onChange={(event) => onFiles(event.target.files)}
            />
            {previews.length > 0 ? (
              <div className="flex flex-wrap gap-3 pt-2">
                {previews.map((item, index) => (
                  <figure key={`${item.file.name}-${index}`} className="w-24">
                    <div className="relative overflow-hidden rounded-md border">
                      {item.kind === "image" && item.url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={item.url}
                          alt={item.file.name}
                          className="aspect-square w-full object-cover"
                        />
                      ) : (
                        <video
                          src={item.url}
                          className="aspect-square w-full object-cover"
                          muted
                          playsInline
                        />
                      )}
                    </div>
                    <figcaption className="mt-1 flex items-center justify-between gap-1">
                      <span className="truncate text-[10px] text-muted-foreground">
                        {item.file.name}
                      </span>
                      <Badge variant="secondary" className="text-[9px]">
                        {item.kind}
                      </Badge>
                    </figcaption>
                    <button
                      type="button"
                      className="mt-1 text-[10px] text-destructive hover:underline"
                      onClick={() => {
                        URL.revokeObjectURL(item.url);
                        setFiles((current) => current.filter((_, i) => i !== index));
                        setPreviewUrls((current) =>
                          current.filter((_, i) => i !== index),
                        );
                      }}
                    >
                      Remove
                    </button>
                  </figure>
                ))}
              </div>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Timing</CardTitle>
          <CardDescription>
            Publish immediately, or schedule for a future time.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant={publishNow ? "default" : "outline"}
              size="sm"
              aria-pressed={publishNow}
              onClick={() => setPublishNow(true)}
            >
              Publish now
            </Button>
            <Button
              type="button"
              variant={!publishNow ? "default" : "outline"}
              size="sm"
              aria-pressed={!publishNow}
              onClick={() => setPublishNow(false)}
            >
              Schedule
            </Button>
          </div>

          {!publishNow ? (
            <div className="flex max-w-xs flex-col gap-2">
              <Label htmlFor="scheduledAt">Publish at</Label>
              <Input
                id="scheduledAt"
                type="datetime-local"
                value={scheduledAt}
                min={localDateTimeDefault(1)}
                onChange={(event) => setScheduledAt(event.target.value)}
              />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              The post is queued now and published by the worker within seconds.
            </p>
          )}

          {issues.length > 0 ? (
            <ul className="flex flex-col gap-1 text-sm text-destructive">
              {issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          ) : null}

          <div className="flex gap-2">
            <Button type="submit" disabled={issues.length > 0 || pending}>
              {pending ? "Submitting..." : publishNow ? "Publish now" : "Schedule"}
            </Button>
            <Button type="button" variant="ghost" onClick={() => router.push("/")}>
              Cancel
            </Button>
          </div>
        </CardContent>
      </Card>
    </form>
  );
}
