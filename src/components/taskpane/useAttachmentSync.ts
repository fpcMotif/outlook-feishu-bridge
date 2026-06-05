// Submit-time attachment pipeline (ADR-0022): the one seam RequestIntakeScreen
// calls. Downloads checked mail attachments (Office.js getAttachmentContentAsync)
// + collects valid uploads and stages the bytes to Convex File Storage. The
// Feishu Drive upload_all that mints `file_token`s runs LATER, server-side in the
// deferred Base-write worker — the submit path no longer blocks on it (ADR-0022
// latency optimization). Best-effort — a failed mail download is reported, never
// fatal. Returns the staged { storageId, fileName }[] the syncRequest payload
// carries as `attachmentSources`.

import { useCallback } from "react";

import {
  downloadMailAttachment,
  type AttachmentContentReader,
} from "../../office/attachmentDownload";
import {
  stageAttachmentSources,
  type AttachmentSource,
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

export function useAttachmentSync(): (
  selectedMail: { id: string; name: string }[],
  uploads: UploadedFile[],
) => Promise<AttachmentSyncResult> {
  const stagingDeps = useAttachmentStaging();
  return useCallback(
    async (selectedMail, uploads) => {
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
      const stageStarted = performance.now();
      const sources =
        gathered.length > 0
          ? await stageAttachmentSources(stagingDeps, gathered)
          : [];
      dtime(`attachment storage pipeline (${sources.length} staged)`, stageStarted);
      dtime(
        `attachment sync total (${sources.length} staged, ${failed.length} failed)`,
        started,
      );
      return { sources, failed };
    },
    [stagingDeps],
  );
}
