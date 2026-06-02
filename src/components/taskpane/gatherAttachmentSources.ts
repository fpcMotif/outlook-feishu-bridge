// Best-effort source gathering for the attachment sync (ADR-0022). Turns the
// picker's selections into staging-ready AttachmentSources: checked mail
// attachments are pulled via the injected downloadMail (Office.js), and valid
// uploads' DOM Files are already Blobs. A failed mail download is recorded and
// skipped — it never aborts the sync (reconcile drops attachments anyway).

import type { AttachmentSource } from "../../office/attachmentUpload";
import type { UploadedFile } from "./intakeReducer";

export interface AttachmentFailure {
  name: string;
  reason: string;
}

export async function gatherAttachmentSources(
  downloadMail: (attachment: { id: string; name: string }) => Promise<AttachmentSource>,
  selectedMail: { id: string; name: string }[],
  uploads: UploadedFile[],
): Promise<{ sources: AttachmentSource[]; failed: AttachmentFailure[] }> {
  const sources: AttachmentSource[] = [];
  const failed: AttachmentFailure[] = [];

  for (const attachment of selectedMail) {
    try {
      sources.push(await downloadMail(attachment));
    } catch (e: unknown) {
      failed.push({ name: attachment.name, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  for (const upload of uploads) {
    if (upload.rejection === null) sources.push({ name: upload.file.name, blob: upload.file });
  }

  return { sources, failed };
}
