import { Upload } from "lucide-react";
import { useId, useState } from "react";

import { cn } from "@/lib/utils";

import { ALLOWED_UPLOAD_EXTENSIONS } from "../../office/attachments";
import { ROW_PRESS } from "./AttachmentSectionPrimitives";

const ACCEPT = ALLOWED_UPLOAD_EXTENSIONS.map((e) => `.${e}`).join(",");
const UPLOAD_HOVER_FINE = "[@media(hover:hover)_and_(pointer:fine)]:hover:";

function uploadZoneClassName(disabled: boolean, dragOver: boolean) {
  return cn(
    "bg-card-soft/50 flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-border px-6 py-8 text-center outline-none transition-[background-color,border-color] duration-150 ease-[var(--ease-out-strong)] focus-within:ring-[3px] focus-within:ring-ring/20",
    `${UPLOAD_HOVER_FINE}border-primary/40 ${UPLOAD_HOVER_FINE}bg-primary/5`,
    ROW_PRESS,
    "motion-reduce:active:scale-100",
    dragOver && !disabled && "border-primary bg-primary/5",
    disabled && "cursor-not-allowed opacity-50 active:scale-100",
  );
}

function uploadZoneDragHandlers(
  disabled: boolean,
  setDragOver: (active: boolean) => void,
  pickFiles: (files: FileList | null) => void,
) {
  return {
    onDragEnter: (e: React.DragEvent<HTMLLabelElement>) => {
      if (disabled) return;
      e.preventDefault();
      setDragOver(true);
    },
    onDragOver: (e: React.DragEvent<HTMLLabelElement>) => {
      if (disabled) return;
      e.preventDefault();
      setDragOver(true);
    },
    onDragLeave: (e: React.DragEvent<HTMLLabelElement>) => {
      if (disabled) return;
      const related = e.relatedTarget;
      if (related instanceof Node && e.currentTarget.contains(related)) return;
      setDragOver(false);
    },
    onDrop: (e: React.DragEvent<HTMLLabelElement>) => {
      if (disabled) return;
      e.preventDefault();
      setDragOver(false);
      pickFiles(e.dataTransfer.files);
    },
  };
}

function UploadZoneBody({
  disabled,
  inputId,
  onPickFiles,
}: {
  disabled: boolean;
  inputId: string;
  onPickFiles: (files: File[]) => void;
}) {
  const pickFiles = (files: FileList | null) => {
    const picked = Array.from(files ?? []);
    if (picked.length > 0) onPickFiles(picked);
  };

  return (
    <>
      <span
        className="bg-primary/10 text-primary flex size-12 items-center justify-center rounded-full"
        aria-hidden="true"
      >
        <Upload className="size-5" strokeWidth={2} />
      </span>
      <span className="space-y-1">
        <span className="block text-sm font-semibold">
          Drag & drop files or click to upload
        </span>
        <span className="text-muted-foreground block text-xs">
          PDF, XLSX, DOCX up to 10MB each
        </span>
      </span>
      <input
        id={inputId}
        data-testid="attachment-upload-input"
        type="file"
        multiple
        accept={ACCEPT}
        disabled={disabled}
        aria-label="Upload attachment files"
        className="sr-only"
        onChange={(e) => {
          pickFiles(e.target.files);
          e.target.value = "";
        }}
      />
    </>
  );
}

export function UploadDropZone({
  disabled,
  onPick,
}: {
  disabled: boolean;
  onPick: (files: File[]) => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const inputId = useId();
  const pickFiles = (files: FileList | null) => {
    const picked = Array.from(files ?? []);
    if (picked.length > 0) onPick(picked);
  };

  return (
    <label
      htmlFor={inputId}
      className={uploadZoneClassName(disabled, dragOver)}
      aria-label={
        disabled
          ? "Attachment limit reached"
          : "Drag and drop files or click to upload"
      }
      {...uploadZoneDragHandlers(disabled, setDragOver, pickFiles)}
    >
      <UploadZoneBody
        disabled={disabled}
        inputId={inputId}
        onPickFiles={onPick}
      />
    </label>
  );
}
