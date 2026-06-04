import type { AttachmentInfo } from "../../office/mailItem";
import type { IntakeState } from "./intakeTypes";

export type SyncPreviewNote = {
  id: string;
  label: string;
  text: string;
};

export type SyncPreviewAttachment = {
  name: string;
};

export type SyncPreviewPayload = {
  customerLabel?: string;
  notes: SyncPreviewNote[];
  attachments: SyncPreviewAttachment[];
};

export type FilledRequest = {
  id: string;
  title: string;
  note: string;
};

/** Maps fulfilled intake requests to preview notes — no UI cap. */
export function buildSyncPreviewNotes(filled: FilledRequest[]): SyncPreviewNote[] {
  return filled.map((request) => ({
    id: request.id,
    label: request.title,
    text: request.note,
  }));
}

export const SYNC_PREVIEW_SINGLE_NOTE_MAX = 110;
export const SYNC_PREVIEW_MULTI_NOTE_MAX = 85;
export const SYNC_PREVIEW_MULTI_NOTE_LINE_CAP = 3;

export type SyncPreviewNotesSummary = {
  sectionLabel: string;
  countLabel: string | null;
  previewLines: string[];
};

/** Collapse whitespace and trim note text for preview. */
export function normalizePreviewNoteText(text: string): string {
  return text.trim().replaceAll(/\s+/g, " ");
}

/** Short teaser for sync Base preview — not the full intake quote. */
export function truncatePreviewNoteText(text: string, max: number): string {
  const normalized = normalizePreviewNoteText(text);
  if (normalized.length <= max) return normalized;
  const slice = normalized.slice(0, max);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}…`;
}

const EMPTY_NOTE_PLACEHOLDER = "Ready to write your note to Base.";

/** Calm sync-card copy: teasers only, no request-type labels. */
export function summarizeRequestNotes(notes: SyncPreviewNote[]): SyncPreviewNotesSummary {
  const filled: SyncPreviewNote[] = [];
  for (const note of notes) {
    const text = normalizePreviewNoteText(note.text);
    if (text.length > 0) filled.push({ ...note, text });
  }

  if (filled.length === 0) {
    return {
      sectionLabel: "Request note",
      countLabel: null,
      previewLines: [EMPTY_NOTE_PLACEHOLDER],
    };
  }

  if (filled.length === 1) {
    return {
      sectionLabel: "Request note",
      countLabel: null,
      previewLines: [truncatePreviewNoteText(filled[0].text, SYNC_PREVIEW_SINGLE_NOTE_MAX)],
    };
  }

  const shown = filled.slice(0, SYNC_PREVIEW_MULTI_NOTE_LINE_CAP);
  const previewLines = shown.map((note) =>
    truncatePreviewNoteText(note.text, SYNC_PREVIEW_MULTI_NOTE_MAX),
  );
  const remaining = filled.length - shown.length;
  if (remaining > 0) {
    previewLines.push(`+${remaining} more`);
  }

  return {
    sectionLabel: "Request notes",
    countLabel: `${filled.length} notes`,
    previewLines,
  };
}

/** Mail + upload selections staged at submit — mirrors what sync will carry. */
export function selectedAttachmentsForPreview(
  mailAttachments: AttachmentInfo[],
  state: Pick<IntakeState, "selectedAttachmentIds" | "uploadedFiles">,
): SyncPreviewAttachment[] {
  const selectedMail = new Set(state.selectedAttachmentIds);
  const fromMail: SyncPreviewAttachment[] = [];
  for (const attachment of mailAttachments) {
    if (selectedMail.has(attachment.id)) fromMail.push({ name: attachment.name });
  }
  const fromUpload: SyncPreviewAttachment[] = [];
  for (const upload of state.uploadedFiles) {
    if (upload.rejection === null && upload.selected) {
      fromUpload.push({ name: upload.file.name });
    }
  }
  return [...fromMail, ...fromUpload];
}

/** Progress thresholds for staged “row written” animation in Base preview. */
export function syncPreviewRowSynced(progress: number): boolean {
  return progress >= 34;
}

export function syncPreviewAttachmentsVisible(progress: number): boolean {
  return progress >= 52;
}
