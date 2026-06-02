// Pure helpers for the attachment picker (ADR-0022). No Office.js and no I/O —
// the picker's selection filtering and upload validation are unit-tested here in
// isolation; the byte download + Convex/Drive upload live in their own modules.

import type { AttachmentInfo } from "./mailItem";

// ADR-0022 decision #4: single-shot Feishu Drive upload caps a file at 20 MB, and
// v1 caps the cell at 10 files (pending the UNVERIFIED per-cell Feishu limit).
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENT_COUNT = 10;

// Extensions accepted for user UPLOADS (pdf / excel / word / image). Existing mail
// attachments are offered as-is — they are already real files from the inbox.
export const ALLOWED_UPLOAD_EXTENSIONS = [
  "pdf",
  "xls", "xlsx", "csv",
  "doc", "docx",
  "png", "jpg", "jpeg", "gif", "webp", "bmp",
];

// Mail attachments the picker may offer: real file attachments only — inline
// images and cloud/item attachment types are dropped (ADR-0022).
export function selectableMailAttachments(attachments: AttachmentInfo[]): AttachmentInfo[] {
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

// Validate one candidate upload by name + size. Returns null when acceptable, else
// a short human reason shown inline next to the file (never a blocking alert).
export function uploadRejectionReason(file: { name: string; size: number }): string | null {
  if (!isAllowedUploadName(file.name)) return "unsupported type";
  if (file.size > MAX_ATTACHMENT_BYTES) return `${formatBytes(file.size)} exceeds 20 MB`;
  return null;
}
