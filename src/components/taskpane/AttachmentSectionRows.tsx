/* eslint-disable max-lines, max-lines-per-function */
import { AlertCircle, RotateCw } from "lucide-react";
import { useMemo, useRef, type ReactNode } from "react";

import { Checkbox } from "@/design-system";
import { cn } from "@/lib/utils";

import {
  ALLOWED_UPLOAD_EXTENSIONS,
  formatAttachmentMeta,
} from "../../office/attachments";
import {
  AttachmentRow,
  FileTypeIconErrored,
  FileTypeIconWithUploadProgress,
  StatusBadge,
  type StatusTone,
} from "./AttachmentSectionPrimitives";
import type { UploadStatus } from "./intakeReducer";
import { Button } from "@/design-system";
import { nameWithoutExt } from "./attachmentFileDisplay";
import { humanizeUploadError, isUnreadableUploadError } from "./uploadError";

const READD_ACCEPT = ALLOWED_UPLOAD_EXTENSIONS.map((e) => `.${e}`).join(",");

function mailStatus(
  checked: boolean,
  disabled: boolean,
): { label: string; tone: StatusTone } | null {
  if (checked) return null;
  return disabled ? { label: "Limit", tone: "muted" } : null;
}

function CheckboxLead({
  name,
  checked,
  disabled,
  onToggle,
}: {
  name: string;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <span className="flex size-6 items-center justify-center">
      <Checkbox
        aria-label={name}
        checked={checked}
        disabled={disabled}
        className={cn(
          "!shadow-none rounded-md border border-border/65 transition-[border-color,border-width] duration-150 ease-[var(--ease-out-strong)]",
          "data-[state=checked]:border-transparent",
          "[@media(hover:hover)_and_(pointer:fine)]:group-hover/attachment:border-2 [@media(hover:hover)_and_(pointer:fine)]:group-hover/attachment:border-foreground",
        )}
        onCheckedChange={onToggle}
      />
    </span>
  );
}

function itemStatus({
  blocked,
  checked,
  disabled,
}: {
  blocked: boolean;
  checked: boolean;
  disabled: boolean;
}): { label: string; tone: StatusTone } | null {
  if (blocked) return { label: "Blocked", tone: "blocked" };
  return mailStatus(checked, disabled);
}

function AttachmentStatusBadge({
  status,
}: {
  status: { label: string; tone: StatusTone } | null;
}) {
  if (!status) return null;
  if (status.tone !== "blocked") {
    return <StatusBadge tone={status.tone}>{status.label}</StatusBadge>;
  }

  return (
    <StatusBadge tone="blocked">
      <span className="inline-flex items-center gap-1">
        <AlertCircle className="size-3" aria-hidden="true" />
        {status.label}
      </span>
    </StatusBadge>
  );
}

function AttachmentSubtitle({
  destructive,
  subtitle,
}: {
  destructive: boolean;
  subtitle: string;
}) {
  if (destructive)
    return <span className="text-destructive normal-case">{subtitle}</span>;
  return <span>{subtitle}</span>;
}

function uploadRowStatus({
  blocked,
  checked,
  disabled,
  uploadStatus,
}: {
  blocked: boolean;
  checked: boolean;
  disabled: boolean;
  uploadStatus?: UploadStatus;
}): { label: string; tone: StatusTone } | null {
  if (blocked) return { label: "Blocked", tone: "blocked" };
  // A failed row carries NO trailing badge — failure shows on the icon + in the
  // (destructive) subtitle, leaving the trailing cluster as just Retry + trash.
  if (uploadStatus === "error") return null;
  if (
    uploadStatus === "pending" ||
    uploadStatus === "uploading" ||
    uploadStatus === "processing"
  ) {
    return null;
  }
  return mailStatus(checked, disabled);
}

type AttachmentRowSlotsArgs = {
  blocked: boolean;
  checked: boolean;
  disabled: boolean;
  errored: boolean;
  unreadable: boolean;
  name: string;
  onToggle: () => void;
  status: { label: string; tone: StatusTone } | null;
  subtitle: string;
  uploadStatus?: UploadStatus;
  onRetry?: () => void;
  onReplace?: (file: File) => void;
};

// Minimal by default: just the retry glyph (the row is tight on a ~320px pane).
// The "Retry" word reveals itself only when the pane is wide enough to spare the
// room; the accessible name stays "Retry" either way via aria-label.
function RowRetryButton({ onRetry }: { onRetry: () => void }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label="Retry"
      title="Retry"
      className="h-7 shrink-0 gap-1 rounded-md px-2 text-[11px] font-medium"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onRetry();
      }}
    >
      <RotateCw className="size-3.5" aria-hidden="true" />
      <span className="hidden min-[480px]:inline">Retry</span>
    </Button>
  );
}

// Re-add for an unreadable (cloud-placeholder) pick: a hidden file input re-opens
// the picker so the user re-selects the file, handing us a FRESH File handle that
// — unlike a Retry of the same dead handle — can actually be read once the file
// has finished downloading. Same visual footprint as Retry.
function RowReAddButton({ onReplace }: { onReplace: (file: File) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 shrink-0 rounded-md px-2 text-[11px] font-medium"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          inputRef.current?.click();
        }}
      >
        Re-add
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept={READD_ACCEPT}
        className="sr-only"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) onReplace(file);
        }}
      />
    </>
  );
}

function useAttachmentRowSlots({
  blocked,
  checked,
  disabled,
  errored,
  unreadable,
  name,
  onToggle,
  status,
  subtitle,
  uploadStatus,
  onRetry,
  onReplace,
}: AttachmentRowSlotsArgs) {
  const leadNode = useMemo(
    () => (
      <CheckboxLead
        name={name}
        checked={checked}
        disabled={disabled}
        onToggle={onToggle}
      />
    ),
    [checked, disabled, name, onToggle],
  );
  const statusNode = useMemo(
    () => <AttachmentStatusBadge status={status} />,
    [status],
  );
  const subtitleNode = useMemo(
    () => (
      <AttachmentSubtitle destructive={blocked || errored} subtitle={subtitle} />
    ),
    [blocked, errored, subtitle],
  );
  // An unreadable (cloud-placeholder) failure shows Re-add — Retry would just
  // re-read the same dead handle — while every other failure keeps Retry.
  const actionNode =
    uploadStatus === "error"
      ? unreadable && onReplace
        ? <RowReAddButton onReplace={onReplace} />
        : onRetry
          ? <RowRetryButton onRetry={onRetry} />
          : null
      : null;

  return { leadNode, statusNode, subtitleNode, actionNode };
}

export type AttachmentItemRowProps = {
  name: string;
  size: number;
  selected: boolean;
  disabled: boolean;
  rejection?: string | null;
  uploadStatus?: UploadStatus;
  progress?: number;
  uploadError?: string | null;
  onToggle: () => void;
  onRemove: () => void;
  onRetry?: () => void;
  onReplace?: (file: File) => void;
};

function deriveAttachmentRowModel({
  rejection = null,
  selected,
  disabled,
  size,
  uploadStatus,
  uploadError = null,
}: AttachmentItemRowProps) {
  const blocked = rejection !== null;
  const errored = uploadStatus === "error";
  const unreadable = errored && isUnreadableUploadError(uploadError);
  const checked = selected && !blocked;
  const subtitle = blocked
    ? (rejection ?? "")
    : errored
      ? humanizeUploadError(uploadError)
      : formatAttachmentMeta(size);
  const status =
    uploadStatus === undefined
      ? itemStatus({ blocked, checked, disabled })
      : uploadRowStatus({ blocked, checked, disabled, uploadStatus });
  return { blocked, checked, errored, unreadable, subtitle, status };
}

function buildAttachmentFileIcon(
  name: string,
  progress: number | undefined,
  uploadStatus: UploadStatus | undefined,
): ReactNode {
  if (uploadStatus === undefined) return undefined;
  // A failed upload swaps the progress ring for the errored tile (AlertCircle).
  if (uploadStatus === "error") return <FileTypeIconErrored name={name} />;
  const uploadActive =
    uploadStatus === "pending" ||
    uploadStatus === "uploading" ||
    uploadStatus === "processing";
  // Indeterminate only before upload starts; once uploading, fill uses xhr + simulated ramp.
  return (
    <FileTypeIconWithUploadProgress
      name={name}
      progress={progress ?? 0}
      active={uploadActive}
      indeterminate={uploadStatus === "pending"}
    />
  );
}

export function AttachmentItemRow(props: AttachmentItemRowProps) {
  const {
    name,
    disabled,
    onToggle,
    onRemove,
    onRetry,
    onReplace,
    uploadStatus,
    progress,
    uploadError,
  } = props;
  const { blocked, checked, errored, unreadable, subtitle, status } =
    deriveAttachmentRowModel(props);
  const { leadNode, statusNode, subtitleNode, actionNode } = useAttachmentRowSlots({
    blocked,
    checked,
    disabled,
    errored,
    unreadable,
    name,
    onToggle,
    status,
    subtitle,
    uploadStatus,
    onRetry,
    onReplace,
  });
  const fileIcon = buildAttachmentFileIcon(name, progress, uploadStatus);
  const statusSlot = useMemo(
    () => (
      <>
        {actionNode}
        {statusNode}
      </>
    ),
    [actionNode, statusNode],
  );

  return (
    <AttachmentRow
      selected={checked}
      lead={leadNode}
      fileIcon={fileIcon}
      name={name}
      displayName={nameWithoutExt(name)}
      subtitle={subtitleNode}
      inlineMeta={!blocked && !errored}
      status={statusSlot}
      removeLabel={`Remove ${name}`}
      onRemove={onRemove}
      pinControls={errored}
      // Keep the raw reason reachable for support without crowding the row.
      title={errored ? (uploadError ?? undefined) : undefined}
    />
  );
}

export { AddFileRow, UploadDropZone } from "./AttachmentUploadDropZone";
