"use client";

import { ExternalLinkIcon, EyeIcon } from "lucide-react";

import { PostStatusBadge } from "@/components/admin/status-badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { AdminUserPost } from "@/lib/admin-scheduler";

const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

const PLATFORM_LABELS: Record<AdminUserPost["platform"], string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  linkedin: "LinkedIn",
};

function dateTime(value: string | null): string {
  if (!value) return "—";
  return `${dateTimeFormatter.format(new Date(value))} UTC`;
}

function mediaLabel(mediaType: string | null): string {
  if (!mediaType || mediaType === "none") return "Text only";
  return mediaType
    .replace(/[_-]+/g, " ")
    .replace(/^\w/, (character) => character.toUpperCase());
}

function Detail({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
  );
}

export function PostDetails({ post }: { post: AdminUserPost }) {
  // Only surface absolute HTTP(S) links from the publishing result.
  const safePublishedUrl =
    post.publishedUrl && /^https?:\/\//i.test(post.publishedUrl)
      ? post.publishedUrl
      : null;

  return (
    <Dialog>
      <DialogTrigger
        render={<Button variant="outline" size="sm" />}
      >
        <EyeIcon aria-hidden="true" />
        View
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Post details</DialogTitle>
          <DialogDescription>
            Full content and publishing history for this scheduled post.
          </DialogDescription>
        </DialogHeader>

        <dl className="grid grid-cols-2 gap-4 rounded-lg border bg-muted/20 p-3">
          <Detail label="Platform">
            {PLATFORM_LABELS[post.platform]}
          </Detail>
          <Detail label="Status">
            <PostStatusBadge status={post.status} />
          </Detail>
          <Detail label="Scheduled">{dateTime(post.scheduledAt)}</Detail>
          <Detail label="Published">
            {post.publishedAt ? dateTime(post.publishedAt) : "Not published"}
          </Detail>
          <Detail label="Retries">
            <span className="tabular-nums">{post.retryCount}</span>
          </Detail>
          <Detail label="Media">{mediaLabel(post.mediaType)}</Detail>
          <Detail label="Created">{dateTime(post.createdAt)}</Detail>
          <Detail label="Post ID">
            <span className="font-mono text-xs break-all">{post.id}</span>
          </Detail>
        </dl>

        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Content
          </h3>
          <div className="max-h-[40vh] overflow-y-auto rounded-lg border bg-muted/30 p-3">
            <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">
              {post.text}
            </p>
          </div>
        </section>

        {post.error ? (
          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Error{post.failureStage ? ` · ${post.failureStage}` : ""}
            </h3>
            <div className="max-h-48 overflow-y-auto rounded-lg border border-red-200 bg-red-50/60 p-3 dark:border-red-900/50 dark:bg-red-950/30">
              <p className="text-sm leading-relaxed break-words whitespace-pre-wrap text-red-700 dark:text-red-300">
                {post.error}
              </p>
            </div>
          </section>
        ) : null}

        {safePublishedUrl ? (
          <a
            href={safePublishedUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            Open published post
            <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
          </a>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
