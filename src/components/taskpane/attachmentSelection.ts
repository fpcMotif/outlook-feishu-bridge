// Pure selection math for the attachment picker (ADR-0022). No React/I/O — the
// component renders from these and the intake reducer holds the state. Limits +
// per-file validation reuse the picker helpers in office/attachments.ts.

import {
  MAX_ATTACHMENT_COUNT,
  uploadRejectionReason,
} from "../../office/attachments";
import type { UploadedFile } from "./intakeReducer";

// Total attachments that will actually be staged: checked mail attachments plus
// uploads that passed validation (rejected uploads are shown but never sent).
export function attachmentCount(selectedIds: string[], uploads: UploadedFile[]): number {
  return selectedIds.length + uploads.filter((u) => u.rejection === null).length;
}

export function canAddMore(count: number): boolean {
  return count < MAX_ATTACHMENT_COUNT;
}

// Turn a freshly-picked batch of DOM Files into UploadedFile rows: stamp a local
// id, validate type/size (uploadRejectionReason), and cap acceptances to the
// remaining slots so the cell never exceeds MAX_ATTACHMENT_COUNT. Overflow files
// are kept (so the user sees them) but rejected with the limit reason.
export function buildUploadedFiles(
  files: File[],
  makeId: () => string,
  remainingSlots: number,
): UploadedFile[] {
  let accepted = 0;
  return files.map((file) => {
    let rejection = uploadRejectionReason(file);
    if (!rejection) {
      if (accepted >= remainingSlots) rejection = `exceeds the ${MAX_ATTACHMENT_COUNT}-file limit`;
      else accepted += 1;
    }
    return { id: makeId(), file, rejection };
  });
}
