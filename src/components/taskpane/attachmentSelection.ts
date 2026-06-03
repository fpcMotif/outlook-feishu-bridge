// Pure selection math for the attachment picker (ADR-0022). No React/I/O - the
// component renders from these and the intake reducer holds the state. Limits +
// per-file validation reuse the picker helpers in office/attachments.ts.

import {
  MAX_ATTACHMENT_COUNT,
  uploadRejectionReason,
} from "../../office/attachments";
import type { UploadedFile } from "./intakeReducer";

// Total attachments that will actually be staged: checked mail attachments plus
// uploads that passed validation (rejected uploads are shown but never sent).
export function attachmentCount(
  selectedIds: string[],
  uploads: UploadedFile[],
): number {
  return (
    selectedIds.length +
    uploads.filter((u) => u.rejection === null && u.selected).length
  );
}

export function canAddMore(count: number): boolean {
  return count < MAX_ATTACHMENT_COUNT;
}

// Skip picks whose full filename (name + extension) is already staged - mail
// attachments or prior uploads - and dedupe within the same batch (first wins).
export function filterDuplicateUploadFiles(
  files: File[],
  existingNames: Iterable<string>,
): File[] {
  const taken = new Set(existingNames);
  const novel: File[] = [];
  for (const file of files) {
    if (taken.has(file.name)) continue;
    taken.add(file.name);
    novel.push(file);
  }
  return novel;
}

// Turn a freshly-picked batch of DOM Files into UploadedFile rows. Valid files
// are auto-selected only while there are open selection slots; later valid files
// stay visible and selectable after the user frees a slot.
export function buildUploadedFiles(
  files: File[],
  makeId: () => string,
  remainingSlots: number,
): UploadedFile[] {
  let selected = 0;
  return files.map((file) => {
    const rejection = uploadRejectionReason(file);
    const canAutoSelect = rejection === null && selected < remainingSlots;
    if (canAutoSelect) selected += 1;
    const base = { id: makeId(), file, rejection, selected: canAutoSelect };
    if (rejection !== null) return base;
    return { ...base, status: "pending" as const, progress: 0 };
  });
}
