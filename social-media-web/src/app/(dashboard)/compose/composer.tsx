"use client";

import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { ImagePlus, LoaderCircle, Send, X } from "lucide-react";
import { toast } from "sonner";

import { PlatformChip } from "@/components/platform-chip";
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
import { cn } from "cn";

const PLATFORMS = [  { id: "facebook", label: "Facebook" },
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

/** A red field message shown under the field that caused it. */
function FieldError({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="text-xs text-destructive">
      {children}
    </p>
  );
}

function formatCountdown(target: string): string {
  const date = new Date(target);
  if (Number.isNaN(date.getTime())) return "";
  const diff = date.getTime() - Date.now();
  const days = Math.floor(diff / 86_400_000);
  const hours = Math.floor((diff % 86_400_000) / 3_600_000);
  const minutes = Math.round((diff % 3_600_000) / 60_000);
  if (days > 0) return `in ${days} day${days === 1 ? "" : "s"}`;
  if (hours > 0) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  if (minutes > 0) return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  return "very soon";
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

  // One error list per field, so each message renders next to its input.
  const platformError = platforms.length === 0 ? "Select at least one platform." : null;
  const textError =
    !text.trim()
      ? "Add the post text."
      : text.length > selectedLimit
        ? `Text exceeds the ${selectedLimit}-character limit for the selected platforms.`
        : null;
  const mediaError =
    files.length > MAX_ITEMS
      ? `Choose at most ${MAX_ITEMS} media items.`
      : videoCount > 0 && imageCount > 0
        ? "Use either a single video or only images."
        : platforms.includes("instagram") && files.length === 0
          ? "Instagram requires at least one image or video."
          : isCarousel && (!platforms.includes("instagram") || platforms.length > 1)
            ? "Carousels can only be published to Instagram."
            : null;
  const scheduleError = !publishNow && !scheduledAt ? "Choose a schedule time." : null;

  const issues: string[] = [];
  if (platformError) issues.push(platformError);
  if (textError) issues.push(textError);
  if (mediaError) issues.push(mediaError);
  if (scheduleError) issues.push(scheduleError);

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
    if (files.length + incoming.length > MAX_ITEMS) {
      toast.error(`Only ${MAX_ITEMS} media items can be attached.`);
    }
    setFiles(combined);
    setPreviewUrls((current) => {
      current.forEach((url) => URL.revokeObjectURL(url));
      return combined.map((file) => URL.createObjectURL(file));
    });
    if (inputRef.current) inputRef.current.value = "";
  }

  function removeFile(index: number) {
    URL.revokeObjectURL(previewUrls[index]);
    setFiles((current) => current.filter((_, i) => i !== index));
    setPreviewUrls((current) => current.filter((_, i) => i !== index));
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
          ? "Publishing now. Check the Queue for progress."
          : `Scheduled ${Array.isArray(body.scheduled) ? body.scheduled.length : 1} post(s).`,
      );
      router.push("/queue");
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not create the post. Try again.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="flex flex-col gap-6" onSubmit={onSubmit}>
      <Card>
        <CardHeader>
          <CardTitle>Post content</CardTitle>
          <CardDescription>
            Choose where to publish and write the caption.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <Label id="platforms-label">Platforms</Label>
            <div
              role="group"
              aria-labelledby="platforms-label"
              className="flex flex-wrap gap-2"
            >
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
            {platformError ? <FieldError>{platformError}</FieldError> : null}
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="text">Post text</Label>
              <span
                className={cn(
                  "text-xs text-muted-foreground",
                  text.length > selectedLimit && "font-medium text-destructive",
                )}
              >
                {text.length} / {selectedLimit}
              </span>
            </div>
            <Textarea
              id="text"
              rows={6}
              value={text}
              aria-invalid={textError !== null}
              onChange={(event) => setText(event.target.value)}
              placeholder="Write your post..."
            />
            {textError ? <FieldError>{textError}</FieldError> : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Media</CardTitle>
          <CardDescription>
            Optional: images, a video, or an Instagram carousel.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-xs text-muted-foreground">
            JPEG, PNG, or GIF images (2–10 for an Instagram carousel), or a
            single MP4/MOV video up to 50&nbsp;MB. Instagram needs at least one
            item.
          </p>
          <label
            htmlFor="media"
            className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-6 py-8 text-center transition-colors hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <ImagePlus className="size-5 text-muted-foreground" aria-hidden="true" />
            <span className="text-sm font-medium">
              Click to choose images or a video
            </span>
            <span className="text-xs text-muted-foreground">
              {files.length === 0
                ? "Nothing attached yet"
                : `${files.length} of ${MAX_ITEMS} items attached`}
            </span>
            <Input
              id="media"
              ref={inputRef}
              type="file"
              accept={ACCEPT}
              multiple
              className="sr-only"
              onChange={(event) => onFiles(event.target.files)}
            />
          </label>
          {mediaError ? <FieldError>{mediaError}</FieldError> : null}
          {previews.length > 0 ? (
            <ul className="flex flex-wrap gap-3">
              {previews.map((item, index) => (
                <li key={`${item.file.name}-${index}`} className="w-24">
                  <figure className="flex flex-col gap-1">
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
                      <button
                        type="button"
                        aria-label={`Remove ${item.file.name}`}
                        className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-full bg-background/80 text-foreground shadow-sm transition-colors hover:bg-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                        onClick={() => removeFile(index)}
                      >
                        <X className="size-3" aria-hidden="true" />
                      </button>
                    </div>
                    <figcaption className="flex items-center gap-1">
                      <span className="truncate text-[10px] text-muted-foreground">
                        {item.file.name}
                      </span>
                      <Badge variant="secondary" className="shrink-0 text-[9px]">
                        {item.kind}
                      </Badge>
                    </figcaption>
                  </figure>
                </li>
              ))}
            </ul>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Publish options</CardTitle>
          <CardDescription>
            Publish immediately, or schedule for a future time.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div
            role="radiogroup"
            aria-label="When to publish"
            className="grid gap-2 sm:grid-cols-2"
          >
            {(
              [
                {
                  value: true,
                  title: "Publish Now",
                  description: "Queue the post and let the worker publish it right away.",
                },
                {
                  value: false,
                  title: "Schedule Post",
                  description: "Publish automatically at the chosen date and time.",
                },
              ] as const
            ).map((option) => {
              const active = publishNow === option.value;
              return (
                <button
                  key={option.title}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setPublishNow(option.value)}
                  className={cn(
                    "flex flex-col gap-1 rounded-lg border p-3 text-left transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                    active
                      ? "border-primary bg-primary/5"
                      : "hover:bg-muted/50",
                  )}
                >
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <span
                      aria-hidden="true"
                      className={cn(
                        "size-3 rounded-full border",
                        active ? "border-primary bg-primary" : "border-muted-foreground/50",
                      )}
                    />
                    {option.title}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {option.description}
                  </span>
                </button>
              );
            })}
          </div>

          {!publishNow ? (
            <div className="flex max-w-xs flex-col gap-2">
              <Label htmlFor="scheduledAt">Publish at</Label>
              <Input
                id="scheduledAt"
                type="datetime-local"
                value={scheduledAt}
                min={localDateTimeDefault(1)}
                aria-invalid={scheduleError !== null}
                onChange={(event) => setScheduledAt(event.target.value)}
              />
              {scheduledAt && !scheduleError ? (
                <p className="text-xs text-muted-foreground">
                  Scheduled {formatCountdown(scheduledAt)}.
                </p>
              ) : null}
              {scheduleError ? <FieldError>{scheduleError}</FieldError> : null}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              The post is queued now and published by the worker within seconds.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2 border-t pt-4">
            <Button type="submit" disabled={issues.length > 0 || pending}>
              {pending ? (
                <>
                  <LoaderCircle className="animate-spin" aria-hidden="true" />
                  {publishNow ? "Publishing…" : "Scheduling…"}
                </>
              ) : (
                <>
                  <Send aria-hidden="true" />
                  {publishNow ? "Publish Now" : "Schedule Post"}
                </>
              )}
            </Button>
            <Button type="button" variant="ghost" onClick={() => router.push("/")}>
              Discard
            </Button>
            {issues.length > 0 ? (
              <span className="text-xs text-muted-foreground">
                Fix the highlighted fields to continue.
              </span>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Preview</CardTitle>
          <CardDescription>
            An approximate preview of what will be sent to each platform.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {platforms.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Select a platform to see its preview.
            </p>
          ) : (
            PLATFORMS.filter((platform) => platforms.includes(platform.id)).map(
              (platform) => (
                <div key={platform.id} className="rounded-lg border p-3">
                <div className="mb-2 flex items-center gap-2">
                  <PlatformChip platform={platform.id} />
                  <span className="text-sm font-medium">{platform.label}</span>
                  <Badge variant="outline" className="ml-auto text-[10px]">
                    {publishNow ? "Publishing now" : `Scheduled ${formatCountdown(scheduledAt)}`}
                  </Badge>
                </div>
                {previews.length > 0 ? (
                  <div className="mb-2 flex gap-2 overflow-x-auto">
                    {previews.slice(0, isCarousel ? 10 : 1).map((item, index) => (
                      <div
                        key={index}
                        className="h-20 w-20 shrink-0 overflow-hidden rounded-md border"
                      >
                        {item.kind === "image" && item.url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={item.url}
                            alt=""
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <video
                            src={item.url}
                            className="h-full w-full object-cover"
                            muted
                            playsInline
                          />
                        )}
                      </div>
                    ))}
                  </div>
                ) : null}
                <p className="whitespace-pre-wrap break-words text-sm">
                  {text.trim() || "No text yet."}
                </p>
                </div>
              ),
            )
          )}
        </CardContent>
      </Card>
    </form>
  );
}
