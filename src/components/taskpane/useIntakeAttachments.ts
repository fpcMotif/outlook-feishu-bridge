// Attachment concern for the intake screen (ADR-0022): derives the selectable
// mail attachments, the Add-file handler (validate + 10-file cap), and the
// submit-time stageSelected() that downloads the checked mail attachments +
// uploads and mints Feishu Drive file_tokens. Keeps RequestIntakeScreen focused
// and the Convex/Office coupling out of the component body.

import { useCallback, useMemo, type Dispatch } from "react";

import { MAX_ATTACHMENT_COUNT, selectableMailAttachments } from "../../office/attachments";
import type { AttachmentInfo } from "../../office/mailItem";
import type { MailItemData } from "../../office/useMailItem";
import { attachmentCount, buildUploadedFiles } from "./attachmentSelection";
import type { IntakeAction, IntakeState } from "./intakeReducer";
import { useAttachmentSync, type AttachmentSyncResult } from "./useAttachmentSync";

export function useIntakeAttachments(
  mailItem: MailItemData,
  state: IntakeState,
  dispatch: Dispatch<IntakeAction>,
): {
  mailAttachments: AttachmentInfo[];
  addFiles: (files: File[]) => void;
  stageSelected: () => Promise<AttachmentSyncResult>;
} {
  const stage = useAttachmentSync();
  const mailAttachments = useMemo(
    () => selectableMailAttachments(mailItem.attachments),
    [mailItem.attachments],
  );

  const addFiles = useCallback(
    (files: File[]) => {
      const remaining = MAX_ATTACHMENT_COUNT - attachmentCount(state.selectedAttachmentIds, state.uploadedFiles);
      dispatch({ type: "filesAdded", files: buildUploadedFiles(files, () => crypto.randomUUID(), remaining) });
    },
    [state.selectedAttachmentIds, state.uploadedFiles, dispatch],
  );

  const stageSelected = useCallback(() => {
    const selectedMail = mailAttachments
      .filter((a) => state.selectedAttachmentIds.includes(a.id))
      .map((a) => ({ id: a.id, name: a.name }));
    return stage(selectedMail, state.uploadedFiles);
  }, [stage, mailAttachments, state.selectedAttachmentIds, state.uploadedFiles]);

  return { mailAttachments, addFiles, stageSelected };
}
