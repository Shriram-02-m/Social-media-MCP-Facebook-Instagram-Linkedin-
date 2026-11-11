"use client";

import { EyeIcon, ImageIcon, VideoIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

function mediaLabel(mediaType: string): string {
  if (mediaType === "image") return "Image";
  if (mediaType === "video") return "Video";
  return mediaType
    .replace(/[_-]+/g, " ")
    .replace(/^\w/, (character) => character.toUpperCase());
}

export function PostContentCell({
  text,
  textPreview,
  mediaType,
}: {
  text: string;
  textPreview: string;
  mediaType: string | null;
}) {
  // The query layer appends an ellipsis when it truncates the preview, so a
  // shorter preview means the full text is worth opening in the dialog. The
  // extra threshold covers previews that are technically complete but still
  // clamp at narrow table widths.
  const isTruncated = text.length > textPreview.length || text.length > 120;

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <p className="line-clamp-3 text-sm leading-snug break-words text-foreground/90">
        {textPreview}
      </p>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {mediaType ? (
          <span className="inline-flex items-center gap-1">
            {mediaType === "video" ? (
              <VideoIcon className="size-3.5" aria-hidden="true" />
            ) : (
              <ImageIcon className="size-3.5" aria-hidden="true" />
            )}
            {mediaLabel(mediaType)}
          </span>
        ) : null}
        {isTruncated ? (
          <Dialog>
            <DialogTrigger
              render={
                <Button
                  variant="ghost"
                  size="xs"
                  className="-ml-1 px-1 text-primary hover:text-primary"
                />
              }
            >
              <EyeIcon className="size-3" aria-hidden="true" />
              View full post
            </DialogTrigger>
            <DialogContent className="sm:max-w-lg">
              <DialogHeader>
                <DialogTitle>Post content</DialogTitle>
                <DialogDescription>
                  The complete text stored for this scheduled post.
                </DialogDescription>
              </DialogHeader>
              <div className="max-h-[60vh] overflow-y-auto rounded-lg border bg-muted/30 p-3">
                <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">
                  {text}
                </p>
              </div>
            </DialogContent>
          </Dialog>
        ) : null}
      </div>
    </div>
  );
}
