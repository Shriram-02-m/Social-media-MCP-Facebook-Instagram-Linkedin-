"use client";

import { CircleAlertIcon, EyeIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export function ErrorCell({
  error,
  failureStage,
}: {
  error: string | null;
  failureStage: string | null;
}) {
  if (!error) {
    return <span className="text-sm text-muted-foreground">—</span>;
  }

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <p
        className="line-clamp-2 text-xs leading-snug break-words text-destructive"
        title={error}
      >
        {error}
      </p>
      <Dialog>
        <DialogTrigger
          render={
            <Button
              variant="ghost"
              size="xs"
              className="-ml-1 px-1 text-xs text-primary hover:text-primary"
            />
          }
        >
          <EyeIcon className="size-3" aria-hidden="true" />
          View error
        </DialogTrigger>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CircleAlertIcon
                className="size-4 text-rose"
                aria-hidden="true"
              />
              Publishing error
            </DialogTitle>
            <DialogDescription>
              The full failure reported by the publishing worker.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            {failureStage ? (
              <p className="text-xs text-muted-foreground">
                Stage:{" "}
                <span className="font-medium text-foreground">
                  {failureStage}
                </span>
              </p>
            ) : null}
            <div className="max-h-[60vh] overflow-y-auto rounded-lg border border-rose/25 bg-rose/5 p-3 dark:bg-rose/10">
              <p className="text-sm leading-relaxed whitespace-pre-wrap break-words text-rose">
                {error}
              </p>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
