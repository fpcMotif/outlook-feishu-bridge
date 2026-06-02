// Attachment picker (ADR-0022): unified list of selectable mail attachments
// (opt-in checkboxes) and user uploads (removable, with inline rejection
// reasons), plus an "Add file" row. Presentational only — state lives in the
// intake reducer and submit-time staging happens in RequestIntakeScreen.

import { FileSpreadsheet, FileText, Image as ImageIcon, Plus, X } from "lucide-react";
import type { ReactNode } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

import {
  ALLOWED_UPLOAD_EXTENSIONS,
  fileExtension,
  formatBytes,
  MAX_ATTACHMENT_COUNT,
} from "../../office/attachments";
import type { AttachmentInfo } from "../../office/mailItem";
import type { UploadedFile } from "./intakeReducer";
import { attachmentCount, canAddMore } from "./attachmentSelection";
import { SectionLabel } from "./SectionLabel";

const ACCEPT = ALLOWED_UPLOAD_EXTENSIONS.map((e) => `.${e}`).join(",");
const CARD_CLASS = "bg-card rounded-[20px] p-1 shadow-edge";
// Fixed 40px lead (checkbox / spacer) + trail (remove / spacer) keep icons and filenames aligned.
const ROW_GRID =
  "grid min-h-12 min-w-0 grid-cols-[2.5rem_1rem_minmax(0,1fr)_auto_2.5rem] items-center gap-x-3 px-3 py-2";
const META_CLASS = "shrink-0 text-[11px] text-muted-foreground tabular-nums";
const ROW_PRESS =
  "transition-transform duration-150 ease-[var(--ease-out-strong)] active:scale-[0.97]";
const ICON_ACTION_CLASS = cn(
  "text-muted-foreground inline-flex size-10 shrink-0 items-center justify-center rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/20",
  ROW_PRESS,
);

function AttachmentRow({
  lead,
  icon,
  name,
  meta,
  trail,
}: {
  lead?: ReactNode;
  icon: ReactNode;
  name: ReactNode;
  meta?: ReactNode;
  trail?: ReactNode;
}) {
  return (
    <div className={ROW_GRID}>
      <div className="flex size-10 shrink-0 items-center justify-center">{lead}</div>
      <div className="flex size-4 shrink-0 items-center justify-center [&_svg]:translate-y-px">{icon}</div>
      <div className="min-w-0 truncate text-xs font-semibold">{name}</div>
      <div className="justify-self-end">{meta}</div>
      <div className="flex size-10 shrink-0 items-center justify-center">{trail}</div>
    </div>
  );
}

const SPREADSHEET_EXT = new Set(["xls", "xlsx", "csv"]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);

function FileGlyph({ name }: { name: string }) {
  const ext = fileExtension(name);
  const Icon = SPREADSHEET_EXT.has(ext) ? FileSpreadsheet : IMAGE_EXT.has(ext) ? ImageIcon : FileText;
  return <Icon className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />;
}

function MailRow({
  attachment,
  checked,
  disabled,
  onToggle,
}: {
  attachment: AttachmentInfo;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <AttachmentRow
      lead={
        <Checkbox
          aria-label={attachment.name}
          checked={checked}
          disabled={disabled}
          onCheckedChange={onToggle}
        />
      }
      icon={<FileGlyph name={attachment.name} />}
      name={attachment.name}
      meta={<span className={META_CLASS}>{formatBytes(attachment.size)}</span>}
    />
  );
}

function UploadRow({ upload, onRemove }: { upload: UploadedFile; onRemove: () => void }) {
  return (
    <AttachmentRow
      icon={<FileGlyph name={upload.file.name} />}
      name={upload.file.name}
      meta={
        upload.rejection ? (
          <span className="text-destructive shrink-0 text-[11px] font-medium">{upload.rejection}</span>
        ) : (
          <span className={META_CLASS}>{formatBytes(upload.file.size)}</span>
        )
      }
      trail={
        <button type="button" aria-label={`Remove ${upload.file.name}`} onClick={onRemove} className={ICON_ACTION_CLASS}>
          <X className="size-4" aria-hidden="true" />
        </button>
      }
    />
  );
}

function AddFileRow({ disabled, onPick }: { disabled: boolean; onPick: (files: File[]) => void }) {
  return (
    <label
      className={cn(
        "block cursor-pointer outline-none focus-within:ring-[3px] focus-within:ring-ring/20 rounded-lg",
        ROW_PRESS,
        disabled && "cursor-not-allowed opacity-50 active:scale-100",
      )}
    >
      <AttachmentRow
        icon={<Plus className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />}
        name="Add file"
        meta={<span className={cn(META_CLASS, "font-normal")}>pdf · xls · doc · image</span>}
      />
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

export function AttachmentSection({
  mailAttachments,
  selectedIds,
  uploadedFiles,
  onToggleMail,
  onAddFiles,
  onRemoveUpload,
}: {
  mailAttachments: AttachmentInfo[];
  selectedIds: string[];
  uploadedFiles: UploadedFile[];
  onToggleMail: (id: string) => void;
  onAddFiles: (files: File[]) => void;
  onRemoveUpload: (id: string) => void;
}) {
  const count = attachmentCount(selectedIds, uploadedFiles);
  const addMore = canAddMore(count);

  return (
    <section aria-labelledby="attachments-title" className="space-y-3">
      <header className="flex items-center justify-between px-1">
        <SectionLabel id="attachments-title">Attachments</SectionLabel>
        <span className={META_CLASS}>{`${count} / ${MAX_ATTACHMENT_COUNT}`}</span>
      </header>
      <div className={CARD_CLASS}>
        {mailAttachments.map((a) => {
          const checked = selectedIds.includes(a.id);
          return (
            <MailRow
              key={a.id}
              attachment={a}
              checked={checked}
              disabled={!checked && !addMore}
              onToggle={() => onToggleMail(a.id)}
            />
          );
        })}
        {uploadedFiles.map((u) => (
          <UploadRow key={u.id} upload={u} onRemove={() => onRemoveUpload(u.id)} />
        ))}
        <AddFileRow disabled={!addMore} onPick={onAddFiles} />
      </div>
    </section>
  );
}
