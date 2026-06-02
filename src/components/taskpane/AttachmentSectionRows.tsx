import { AlertCircle, CheckCircle2, Plus, X } from "lucide-react";

import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

import { ALLOWED_UPLOAD_EXTENSIONS, formatBytes } from "../../office/attachments";
import type { AttachmentInfo } from "../../office/mailItem";
import type { UploadedFile } from "./intakeReducer";
import {
  AttachmentRow,
  FileGlyph,
  ROW_PRESS,
  StatusBadge,
  type StatusTone,
} from "./AttachmentSectionPrimitives";

const ACCEPT = ALLOWED_UPLOAD_EXTENSIONS.map((e) => `.${e}`).join(",");

function mailStatus(checked: boolean, disabled: boolean): { label: string; tone: StatusTone } | null {
  if (checked) return null;
  return disabled ? { label: "Limit", tone: "muted" } : null;
}

function UploadLead({
  blocked,
  name,
  onRemove,
}: {
  blocked: boolean;
  name: string;
  onRemove: () => void;
}) {
  const DefaultIcon = blocked ? AlertCircle : CheckCircle2;

  return (
    <button
      type="button"
      aria-label={`Remove ${name}`}
      title={`Remove ${name}`}
      className={cn(
        "group flex size-10 items-center justify-center rounded-full outline-none transition-[scale] duration-150 ease-[var(--ease-out-strong)] active:scale-[0.96]",
        "focus-visible:ring-[3px] focus-visible:ring-destructive/20",
      )}
      onClick={onRemove}
    >
      <span
        className={cn(
          "relative flex size-5 items-center justify-center rounded-full transition-[background-color,color] duration-200 ease-[var(--ease-out-strong)]",
          blocked ? "bg-destructive/10 text-destructive" : "bg-sage-soft text-sage",
          "group-hover:bg-destructive/10 group-hover:text-destructive group-focus-visible:bg-destructive/10 group-focus-visible:text-destructive",
        )}
        aria-hidden="true"
      >
        <DefaultIcon className="absolute size-3.5 transition-[opacity,scale,filter] duration-200 ease-[var(--ease-out-strong)] group-hover:scale-[0.25] group-hover:opacity-0 group-hover:blur-[4px] group-focus-visible:scale-[0.25] group-focus-visible:opacity-0 group-focus-visible:blur-[4px]" />
        <X
          className="absolute size-3 scale-[0.25] opacity-0 blur-[4px] transition-[opacity,scale,filter] duration-200 ease-[var(--ease-out-strong)] group-hover:scale-100 group-hover:opacity-100 group-hover:blur-0 group-focus-visible:scale-100 group-focus-visible:opacity-100 group-focus-visible:blur-0"
          strokeWidth={3}
        />
      </span>
    </button>
  );
}

interface MailAttachmentRowProps {
  attachment: AttachmentInfo;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}

export function MailAttachmentRow({
  attachment,
  checked,
  disabled,
  onToggle,
}: MailAttachmentRowProps) {
  const size = formatBytes(attachment.size);
  const status = mailStatus(checked, disabled);

  return (
    <AttachmentRow
      lead={
        <CheckboxLead
          name={attachment.name}
          checked={checked}
          disabled={disabled}
          onToggle={onToggle}
        />
      }
      icon={<FileGlyph name={attachment.name} />}
      title={attachment.name}
      subtitle={size}
      status={status ? <StatusBadge tone={status.tone}>{status.label}</StatusBadge> : null}
    />
  );
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
    <Checkbox
      aria-label={name}
      checked={checked}
      disabled={disabled}
      className="!shadow-none rounded-full border border-border/65 data-[state=checked]:border-transparent"
      onCheckedChange={onToggle}
    />
  );
}

interface UploadedAttachmentRowProps {
  upload: UploadedFile;
  onRemove: () => void;
}

export function UploadedAttachmentRow({
  upload,
  onRemove,
}: UploadedAttachmentRowProps) {
  const name = upload.file.name;
  const size = formatBytes(upload.file.size);
  const blocked = upload.rejection !== null;
  const tone: StatusTone = "blocked";
  const status = blocked ? "Blocked" : null;

  return (
    <AttachmentRow
      lead={<UploadLead blocked={blocked} name={name} onRemove={onRemove} />}
      icon={<FileGlyph name={name} />}
      title={name}
      subtitle={blocked ? upload.rejection : size}
      status={status ? <StatusBadge tone={tone}>{status}</StatusBadge> : null}
    />
  );
}

export function AddFileRow({
  disabled,
  onPick,
}: {
  disabled: boolean;
  onPick: (files: File[]) => void;
}) {
  return (
    <label
      className={cn(
        "text-muted-foreground hover:bg-secondary/45 hover:text-foreground inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-md px-2 text-xs font-semibold outline-none transition-[background-color,color,scale] duration-150 ease-[var(--ease-out-strong)] focus-within:ring-[3px] focus-within:ring-ring/20",
        ROW_PRESS,
        disabled && "cursor-not-allowed opacity-50 active:scale-100",
      )}
      aria-label={disabled ? "Attachment limit reached" : "Add file"}
    >
      <Plus className="size-4 shrink-0" aria-hidden="true" />
      <span>Add file</span>
      {disabled ? <StatusBadge tone="muted">Full</StatusBadge> : null}
      <input
        data-testid="attachment-upload-input"
        type="file"
        multiple
        accept={ACCEPT}
        disabled={disabled}
        className="sr-only"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length > 0) onPick(files);
          e.target.value = "";
        }}
      />
    </label>
  );
}
