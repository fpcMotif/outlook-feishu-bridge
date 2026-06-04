// Pure helpers for the attachment picker (ADR-0022). No Office.js and no I/O;
// selection filtering and upload validation are unit-tested here in isolation.

import type { AttachmentInfo } from "./mailItem";

// ADR-0022 decision #4: single-shot Feishu Drive upload caps a file at 20 MB, and
// v1 caps the selected cell payload at 10 files.
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENT_COUNT = 10;

// ADR-0022: MIME is derived from the file extension; these are the accepted
// upload kinds (pdf / excel / word / image). Single source of truth — both the
// allow-list and the MIME mapping (attachmentUpload.ts) derive from this table.
// Existing mail attachments are offered as-is because they are already real
// files from the inbox.
export const UPLOAD_MIME_BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};

// Extensions accepted for user uploads, derived from the MIME table above.
export const ALLOWED_UPLOAD_EXTENSIONS = Object.keys(UPLOAD_MIME_BY_EXTENSION);

// Mail attachments the picker may offer: real file attachments only. Inline
// images and cloud/item attachment types are dropped (ADR-0022).
export function selectableMailAttachments(
  attachments: AttachmentInfo[],
): AttachmentInfo[] {
  return attachments.filter((a) => a.attachmentType === "file" && !a.isInline);
}

// The lowercased final extension, or "" when the name has none.
export function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function isAllowedUploadName(name: string): boolean {
  return ALLOWED_UPLOAD_EXTENSIONS.includes(fileExtension(name));
}

// Human-readable size for the row label (e.g. "1.5 KB", "5.0 MB").
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Attachment row subtitle: size only (no date or other metadata).
export function formatAttachmentMeta(bytes: number): string {
  return formatBytes(bytes);
}

// Validate one candidate upload by name + size. Returns null when acceptable,
// otherwise a short human reason shown inline next to the file.
export function uploadRejectionReason(file: {
  name: string;
  size: number;
}): string | null {
  if (!isAllowedUploadName(file.name)) return "unsupported type";
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return `${formatBytes(file.size)} exceeds 20 MB`;
  }
  return null;
}
