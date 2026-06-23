// Submit-time attachment pipeline (ADR-0027): the one seam RequestIntakeScreen
// calls. Downloads checked mail attachments (Office.js getAttachmentContentAsync)
// + collects valid uploads and stages the bytes to Convex File Storage. The
// Feishu Drive upload_all that mints `file_token`s runs LATER, server-side in the
// deferred Attachment Fill — the submit path no longer blocks on it. Best-effort:
// a failed mail download is reported, never fatal. Returns the staged
// { storageId, fileName }[] the syncRequest payload carries as `attachmentSources`.

import { useCallback } from "react";

import {
  downloadMailAttachment,
  type AttachmentContentReader,
} from "../../office/attachmentDownload";
import {
  stageAttachmentSources,
  type AttachmentSource,
  type AttachmentStagingDeps,
  type StagedAttachmentSource,
} from "../../office/attachmentUpload";
import { dlog, dtime } from "../../debug";
import type { OfficeLike } from "../../office/mailItem";
import { useAttachmentStaging } from "../../hooks/useAttachmentStaging";
import {
  gatherAttachmentSources,
  type AttachmentFailure,
} from "./gatherAttachmentSources";
import type { UploadedFile } from "./intakeReducer";

export interface AttachmentSyncResult {
  sources: StagedAttachmentSource[];
  failed: AttachmentFailure[];
}

async function runAttachmentSync(
  stagingDeps: AttachmentStagingDeps,
  selectedMail: { id: string; name: string }[],
  uploads: UploadedFile[],
): Promise<AttachmentSyncResult> {
  const started = performance.now();
  const selectedUploads = uploads.filter(
    (upload) => upload.rejection === null && upload.selected,
  ).length;
  dlog(
    `attachment sync start: mail=${selectedMail.length} uploads=${selectedUploads}`,
  );
  const office = (globalThis as { Office?: OfficeLike }).Office;
  const item = office?.context?.mailbox?.item as
    | AttachmentContentReader
    | undefined;
  const downloadMail = (attachment: {
    id: string;
    name: string;
  }): Promise<AttachmentSource> =>
    office && item
      ? downloadMailAttachment(office, item, attachment)
      : Promise.reject(
          new Error("Mail attachment download is unavailable in this host"),
        );

  const gatherStarted = performance.now();
  const { sources: gathered, failed } = await gatherAttachmentSources(
    downloadMail,
    selectedMail,
    uploads,
  );
  dtime(
    `attachment source gather (${gathered.length} ready, ${failed.length} failed)`,
    gatherStarted,
  );
  // Stage the bytes to Convex — the only wait before the row exists, and the
  // hard deadline (Office.js bytes die once the pane closes). The Drive mint +
  // any per-file skip now happen server-side in the Attachment Fill, surfaced
  // via getBitableSyncByConversation.attachmentStatus (ADR-0027).
  const stageStarted = performance.now();
  const sources =
    gathered.length > 0 ? await stageAttachmentSources(stagingDeps, gathered) : [];
  dtime(`attachment stage (${sources.length} staged)`, stageStarted);
  dtime(
    `attachment sync total (${sources.length} staged, ${failed.length} failed)`,
    started,
  );
  return { sources, failed };
}

export function useAttachmentSync(): (
  selectedMail: { id: string; name: string }[],
  uploads: UploadedFile[],
) => Promise<AttachmentSyncResult> {
  const stagingDeps = useAttachmentStaging();
  return useCallback(
    (selectedMail, uploads) =>
      runAttachmentSync(stagingDeps, selectedMail, uploads),
    [stagingDeps],
  );
}
