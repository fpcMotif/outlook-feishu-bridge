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
import type { OfficeLike } from "../../office/mailItem";
import { useAttachmentStaging } from "../../hooks/useAttachmentStaging";
import { gatherAttachmentSources, type AttachmentFailure } from "./gatherAttachmentSources";
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
      const office = (globalThis as { Office?: OfficeLike }).Office;
      const item = office?.context?.mailbox?.item as AttachmentContentReader | undefined;
      const downloadMail = (attachment: { id: string; name: string }): Promise<AttachmentSource> =>
        office && item
          ? downloadMailAttachment(office, item, attachment)
          : Promise.reject(new Error("Mail attachment download is unavailable in this host"));

      const { sources, failed } = await gatherAttachmentSources(downloadMail, selectedMail, uploads);
      if (sources.length === 0) return { attachments: [], failed };
      // Best-effort: a Convex-storage / Feishu-Drive failure during staging must
      // NEVER block the authoritative Base write (ADR-0022). Degrade to "no
      // attachments + reported failures" so syncRequest still records the note,
      // customer, and coworkers; the caller surfaces the skipped files (#33).
      try {
        const attachments = await stageAndUploadAttachments(stagingDeps, sources);
        return { attachments, failed };
      } catch (e: unknown) {
        const reason = e instanceof Error ? e.message : String(e);
        return { attachments: [], failed: [...failed, ...sources.map((s) => ({ name: s.name, reason }))] };
      }
    },
    [stagingDeps],
  );
}
