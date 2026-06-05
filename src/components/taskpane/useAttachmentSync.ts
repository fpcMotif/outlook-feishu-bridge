// Submit-time attachment pipeline (ADR-0022): the one seam RequestIntakeScreen
// calls. Downloads checked mail attachments (Office.js getAttachmentContentAsync)
// + collects valid uploads, stages the bytes to Convex File Storage, and mints
// Feishu Drive file_tokens via uploadAttachmentsToDrive. Best-effort — a failed
// mail download is reported, never fatal. Returns the { fileToken }[] the
// syncRequest payload carries.

import { useCallback } from "react";

import {
  downloadMailAttachment,
  type AttachmentContentReader,
} from "../../office/attachmentDownload";
import {
  stageAndUploadAttachments,
  type AttachmentSource,
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
  attachments: { fileToken: string }[];
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
      const { sources, failed } = await gatherAttachmentSources(
        downloadMail,
        selectedMail,
        uploads,
      );
      dtime(
        `attachment source gather (${sources.length} ready, ${failed.length} failed)`,
        gatherStarted,
      );
      const tokenStarted = performance.now();
      const attachments =
        sources.length > 0
          ? await stageAndUploadAttachments(stagingDeps, sources)
          : [];
      dtime(
        `attachment token pipeline (${attachments.length} tokens)`,
        tokenStarted,
      );
      dtime(
        `attachment sync total (${attachments.length} tokens, ${failed.length} failed)`,
        started,
      );
      return { attachments, failed };
    },
    [stagingDeps],
  );
}
