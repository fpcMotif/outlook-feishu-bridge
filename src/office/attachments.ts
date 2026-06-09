// Pure helpers for the attachment picker (ADR-0022). No Office.js and no I/O;
// selection filtering and upload validation are unit-tested here in isolation.

import type { AttachmentInfo } from "./mailItem";

// ADR-0022 decision #4: single-shot Feishu Drive upload caps a file at 20 MB, and
// v1 caps the selected cell payload at 10 files.
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

// The COUNT cap is the single knob the upload-latency experiment turns: set
// VITE_ATTACHMENT_CAP=50 (build-time) to lift the picker to 50 files and measure
// the click-to-fully-written time at scale. Absent/unparseable → the conservative
// default. The 20 MB per-file BYTE cap above is orthogonal and never moves. The
// server enforces the same default+override via ATTACHMENT_CAP (convex/feishu/
// attachmentLimits.ts) so the cap is one source of truth across both runtimes.
export const DEFAULT_ATTACHMENT_COUNT = 10;

function resolveAttachmentCount(): number {
  const raw = import.meta.env.VITE_ATTACHMENT_CAP as string | undefined;
  const parsed = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isInteger(parsed) && parsed >= 1
    ? parsed
    : DEFAULT_ATTACHMENT_COUNT;
}

export const MAX_ATTACHMENT_COUNT = resolveAttachmentCount();

// Extensions accepted for user uploads. Existing mail attachments are offered
// as-is because they are already real files from the inbox.
export const ALLOWED_UPLOAD_EXTENSIONS = [
  "pdf",
  "xls",
  "xlsx",
  "csv",
  "doc",
  "docx",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
];

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
