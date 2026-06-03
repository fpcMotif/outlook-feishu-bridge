import { type ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { extOf, iconFor } from "./attachmentFileDisplay";
import { TrashIcon } from "./icons/TrashIcon";

export { FileTypeIconWithUploadProgress } from "./AttachmentUploadIcon";

export const META_CLASS =
  "shrink-0 text-[11px] text-muted-foreground tabular-nums";

export const ROW_PRESS =
  "transition-transform duration-150 ease-[var(--ease-out-strong)] active:scale-[0.96]";

/** Full utilities only — Tailwind cannot detect prefix + suffix concatenation. */
export const ROW_HOVER_FINE_STATUS_HIDE =
  "[@media(hover:hover)_and_(pointer:fine)]:group-hover/attachment:opacity-0";

export const ROW_HOVER_FINE_TRASH_SHOW =
  "[@media(hover:hover)_and_(pointer:fine)]:group-hover/attachment:opacity-100";

const ROW_HOVER_BG =
  "[@media(hover:hover)_and_(pointer:fine)]:hover:bg-muted/30";

export type StatusTone = "blocked" | "muted";

export function AttachmentListCard({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-edge">
      {children}
    </div>
  );
}

function FileTypeIcon({ name }: { name: string }) {
  const { Icon, tint, bg, border } = iconFor(name);

  return (
    <span
      className={cn(
        "flex size-10 shrink-0 items-center justify-center rounded-xl border",
        bg,
        border,
      )}
      aria-hidden="true"
    >
      <Icon className={cn("size-5", tint)} strokeWidth={1.75} />
    </span>
  );
}

function ExtBadge({ name }: { name: string }) {
  const ext = extOf(name);
  if (!ext) return null;

  return (
    <Badge
      variant="outline"
      className="h-5 shrink-0 rounded-md border-border px-1.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase"
    >
      {ext}
    </Badge>
  );
}

function RowTrashAction({
  label,
  onRemove,
}: {
  label: string;
  onRemove: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn(
        "text-destructive hover:text-destructive size-8 shrink-0 rounded-md hover:bg-muted",
        ROW_PRESS,
        "motion-reduce:active:scale-100",
      )}
      aria-label={label}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onRemove();
      }}
    >
      <TrashIcon className="size-4" />
    </Button>
  );
}

export function StatusBadge({
  tone,
  children,
}: {
  tone: StatusTone;
  children?: ReactNode;
}) {
  if (tone === "blocked") {
    return (
      <span className="bg-destructive/10 text-destructive inline-flex h-6 shrink-0 items-center rounded-full px-2 text-[10px] font-semibold tracking-wide uppercase">
        {children}
      </span>
    );
  }

  return (
    <span
      className={cn(
        "border-border/60 inline-flex h-6 shrink-0 items-center rounded-full border px-2 text-[10px] font-semibold tabular-nums",
        tone === "muted" && "text-muted-foreground opacity-70",
      )}
    >
      {children}
    </span>
  );
}

function AttachmentIdentity({
  name,
  displayName,
  subtitle,
}: {
  name: string;
  displayName?: string;
  subtitle?: ReactNode;
}) {
  return (
    <div className="min-w-0 flex-1">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-sm font-medium text-foreground">
          {displayName ?? name}
        </span>
        <ExtBadge name={name} />
      </div>
      {subtitle ? (
        <div className="text-muted-foreground mt-0.5 flex min-w-0 items-center gap-2 text-[11px] leading-4 tabular-nums">
          {subtitle}
        </div>
      ) : null}
    </div>
  );
}

function AttachmentTrailing({
  status,
  onRemove,
  removeLabel,
}: {
  status?: ReactNode;
  onRemove?: () => void;
  removeLabel?: string;
}) {
  const hideStatusOnHover = onRemove !== undefined;
  return (
    <div className="relative flex min-h-10 shrink-0 items-center justify-end gap-0.5">
      {status ? (
        <div
          className={cn(
            "flex items-center transition-opacity duration-150 ease-[var(--ease-out-strong)]",
            hideStatusOnHover && ROW_HOVER_FINE_STATUS_HIDE,
          )}
        >
          {status}
        </div>
      ) : null}
      {onRemove && removeLabel ? (
        <div
          className={cn(
            "flex items-center gap-0.5 opacity-0 transition-opacity duration-150 ease-[var(--ease-out-strong)]",
            ROW_HOVER_FINE_TRASH_SHOW,
            "focus-within:opacity-100",
          )}
        >
          <RowTrashAction label={removeLabel} onRemove={onRemove} />
        </div>
      ) : null}
    </div>
  );
}

interface AttachmentRowProps {
  lead?: ReactNode;
  name: string;
  displayName?: string;
  subtitle?: ReactNode;
  status?: ReactNode;
  selected?: boolean;
  fileIcon?: ReactNode;
  onRemove?: () => void;
  removeLabel?: string;
}

export function AttachmentRow({
  lead,
  name,
  displayName,
  subtitle,
  status,
  selected = false,
  fileIcon,
  onRemove,
  removeLabel,
}: AttachmentRowProps) {
  return (
    <div
      className={cn(
        "group/attachment relative flex items-center gap-3 px-4 py-3 transition-colors duration-150 ease-[var(--ease-out-strong)]",
        selected ? "bg-primary/5" : ROW_HOVER_BG,
      )}
    >
      <div className="flex shrink-0 items-center justify-center">{lead}</div>
      {fileIcon ?? <FileTypeIcon name={name} />}
      <AttachmentIdentity
        name={name}
        displayName={displayName}
        subtitle={subtitle}
      />
      <AttachmentTrailing
        status={status}
        onRemove={onRemove}
        removeLabel={removeLabel}
      />
    </div>
  );
}
