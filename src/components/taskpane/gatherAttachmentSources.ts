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

async function gatherMailSources(
  downloadMail: (attachment: { id: string; name: string }) => Promise<AttachmentSource>,
  selectedMail: { id: string; name: string }[],
): Promise<{ sources: AttachmentSource[]; failed: AttachmentFailure[] }> {
  const sources: AttachmentSource[] = [];
  const failed: AttachmentFailure[] = [];

  const mailResults = await Promise.all(
    selectedMail.map(async (attachment) => {
      try {
        return { ok: true as const, source: await downloadMail(attachment) };
      } catch (e: unknown) {
        return {
          ok: false as const,
          name: attachment.name,
          reason: e instanceof Error ? e.message : String(e),
        };
      }
    }),
  );
  for (const result of mailResults) {
    if (result.ok) sources.push(result.source);
    else failed.push({ name: result.name, reason: result.reason });
  }

  return { sources, failed };
}

function gatherUploadSources(uploads: UploadedFile[]): {
  sources: AttachmentSource[];
  failed: AttachmentFailure[];
} {
  const sources: AttachmentSource[] = [];
  const failed: AttachmentFailure[] = [];

  for (const upload of uploads) {
    if (upload.rejection !== null || !upload.selected) continue;
    const fileName = upload.file.name;
    if (upload.status === "error") {
      failed.push({ name: fileName, reason: upload.uploadError ?? "Upload failed" });
      continue;
    }
    if (upload.storageId && upload.status === "complete") {
      sources.push({ name: fileName, storageId: upload.storageId });
      continue;
    }
    if (
      upload.status === "pending" ||
      upload.status === "uploading" ||
      upload.status === "processing"
    ) {
      failed.push({ name: fileName, reason: "Upload did not finish" });
      continue;
    }
    sources.push({ name: fileName, blob: upload.file });
  }

  return { sources, failed };
}

export async function gatherAttachmentSources(
  downloadMail: (attachment: { id: string; name: string }) => Promise<AttachmentSource>,
  selectedMail: { id: string; name: string }[],
  uploads: UploadedFile[],
): Promise<{ sources: AttachmentSource[]; failed: AttachmentFailure[] }> {
  const mail = await gatherMailSources(downloadMail, selectedMail);
  const uploaded = gatherUploadSources(uploads);
  return {
    sources: [...mail.sources, ...uploaded.sources],
    failed: [...mail.failed, ...uploaded.failed],
  };
}
