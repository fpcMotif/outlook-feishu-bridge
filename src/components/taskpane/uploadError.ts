// Pure helpers for the failed-upload row UI (ADR-0019 extract-then-test seam).
// The raw thrown message (e.g. "Convex storage upload failed (network)") is great
// for Sentry grouping but too technical for a 320px Outlook taskpane row, so the
// row shows a humanized line and keeps the raw reason on a hover title.

import { UNREADABLE_FILE_MESSAGE } from "../../office/attachmentUpload";
import type { UploadedFile } from "./intakeTypes";

const FRIENDLY_DEFAULT = "Couldn't upload — tap Retry";

/**
 * True when a row's failure is an unreadable file (a dehydrated Dropbox/OneDrive
 * placeholder). Retry is futile here — it re-reads the same dead File handle — so
 * the row offers Re-add (re-pick a fresh handle) instead. Keyed off the exact
 * thrown message so it stays in lock-step with readFileBytesWithRetry.
 */
export function isUnreadableUploadError(raw?: string | null): boolean {
  return raw === UNREADABLE_FILE_MESSAGE;
}

/**
 * Turn a raw upload error into a short, human line for the attachment row. The
 * cloud-placeholder read error is already a full actionable sentence, so it is
 * passed through verbatim; network/timeout/HTTP failures map to friendly copy.
 */
export function humanizeUploadError(raw?: string | null): string {
  if (!raw) return FRIENDLY_DEFAULT;
  if (/Dropbox|OneDrive|Couldn't read/i.test(raw)) return raw;
  if (/network/i.test(raw)) {
    return "Couldn't upload — check your connection, then Retry";
  }
  if (/tim(e|ed)? ?out/i.test(raw)) return "Upload timed out — tap Retry";
  if (/\((4\d\d|5\d\d)\)/.test(raw)) return "Upload was rejected — tap Retry";
  return FRIENDLY_DEFAULT;
}

/** Ids of uploads that failed and can be retried (valid picks only). */
export function collectFailedUploadIds(files: UploadedFile[]): string[] {
  const ids: string[] = [];
  for (const u of files) {
    if (u.rejection === null && u.status === "error") {
      ids.push(u.id);
    }
  }
  return ids;
}

export function countFailedUploads(files: UploadedFile[]): number {
  return collectFailedUploadIds(files).length;
}
