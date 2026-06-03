import { AlertCircle } from "lucide-react";
import { useMemo, type ReactNode } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

import { formatAttachmentMeta } from "../../office/attachments";
import {
  AttachmentRow,
  FileTypeIconWithUploadProgress,
  StatusBadge,
  type StatusTone,
} from "./AttachmentSectionPrimitives";
import type { UploadStatus } from "./intakeReducer";
import { Button } from "@/components/ui/button";
import { nameWithoutExt } from "./attachmentFileDisplay";

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
  blocked,
  subtitle,
}: {
  blocked: boolean;
  subtitle: string;
}) {
  if (blocked)
    return <span className="text-destructive normal-case">{subtitle}</span>;
  return <span>{subtitle}</span>;
}

function uploadStatusBadge(status: UploadStatus | undefined): ReactNode {
  if (status === "error") {
    return <StatusBadge tone="blocked">Failed</StatusBadge>;
  }
  return null;
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
  if (uploadStatus === "error") return { label: "Failed", tone: "blocked" };
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
  name: string;
  onToggle: () => void;
  status: { label: string; tone: StatusTone } | null;
  subtitle: string;
  uploadStatus?: UploadStatus;
  onRetry?: () => void;
};

function RowRetryButton({ onRetry }: { onRetry: () => void }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-7 shrink-0 rounded-md px-2 text-[11px] font-medium"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onRetry();
      }}
    >
      Retry
    </Button>
  );
}

function useAttachmentRowSlots({
  blocked,
  checked,
  disabled,
  name,
  onToggle,
  status,
  subtitle,
  uploadStatus,
  onRetry,
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
  const statusNode = useMemo(() => {
    const uploadIndicator = uploadStatusBadge(uploadStatus);
    if (uploadIndicator) return uploadIndicator;
    return <AttachmentStatusBadge status={status} />;
  }, [status, uploadStatus]);
  const subtitleNode = useMemo(
    () => <AttachmentSubtitle blocked={blocked} subtitle={subtitle} />,
    [blocked, subtitle],
  );
  const retryNode =
    uploadStatus === "error" && onRetry ? (
      <RowRetryButton onRetry={onRetry} />
    ) : null;

  return { leadNode, statusNode, subtitleNode, retryNode };
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
  const checked = selected && !blocked;
  const subtitle = blocked
    ? (rejection ?? "")
    : uploadStatus === "error"
      ? (uploadError ?? "Upload failed")
      : formatAttachmentMeta(size);
  const status =
    uploadStatus === undefined
      ? itemStatus({ blocked, checked, disabled })
      : uploadRowStatus({ blocked, checked, disabled, uploadStatus });
  return { blocked, checked, subtitle, status };
}

function buildAttachmentFileIcon(
  name: string,
  progress: number | undefined,
  uploadStatus: UploadStatus | undefined,
): ReactNode {
  if (uploadStatus === undefined) return undefined;
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
  const { name, disabled, onToggle, onRemove, onRetry, uploadStatus, progress } =
    props;
  const { blocked, checked, subtitle, status } = deriveAttachmentRowModel(props);
  const { leadNode, statusNode, subtitleNode, retryNode } = useAttachmentRowSlots({
    blocked,
    checked,
    disabled,
    name,
    onToggle,
    status,
    subtitle,
    uploadStatus,
    onRetry,
  });
  const fileIcon = buildAttachmentFileIcon(name, progress, uploadStatus);
  const statusSlot = useMemo(
    () => (
      <>
        {retryNode}
        {statusNode}
      </>
    ),
    [retryNode, statusNode],
  );

  return (
    <AttachmentRow
      selected={checked}
      lead={leadNode}
      fileIcon={fileIcon}
      name={name}
      displayName={nameWithoutExt(name)}
      subtitle={subtitleNode}
      status={statusSlot}
      removeLabel={`Remove ${name}`}
      onRemove={onRemove}
    />
  );
}

export { AddFileRow, UploadDropZone } from "./AttachmentUploadDropZone";
