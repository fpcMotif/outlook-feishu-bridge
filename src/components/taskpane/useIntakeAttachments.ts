// Attachment concern for the intake screen (ADR-0022): derives the selectable
// mail attachments, the Add-file handler (validate + auto-select slots), and the
// submit-time stageSelected() that downloads the checked mail attachments +
// uploads and mints Feishu Drive file_tokens. Keeps RequestIntakeScreen focused
// and the Convex/Office coupling out of the component body.

import { useCallback, useMemo, useRef, type Dispatch } from "react";

import {
  MAX_ATTACHMENT_COUNT,
  selectableMailAttachments,
} from "../../office/attachments";
import type { AttachmentInfo } from "../../office/mailItem";
import type { MailItemData } from "../../office/useMailItem";
import {
  attachmentCount,
  buildUploadedFiles,
  filterDuplicateUploadFiles,
} from "./attachmentSelection";
import type { IntakeAction, IntakeState } from "./intakeReducer";
import { useAttachmentStaging } from "../../hooks/useAttachmentStaging";
import {
  awaitIntakeUploads,
  mergeStagedUploads,
  queueIntakeFileUploads,
  retryIntakeFileUpload,
} from "./uploadIntakeFile";
import {
  useAttachmentSync,
  type AttachmentSyncResult,
} from "./useAttachmentSync";

type IntakeAttachmentApi = {
  mailAttachments: AttachmentInfo[];
  addFiles: (files: File[]) => void;
  retryUpload: (id: string) => void;
  stageSelected: () => Promise<AttachmentSyncResult>;
};

function existingAttachmentNames(
  mailAttachments: AttachmentInfo[],
  state: IntakeState,
): string[] {
  return [
    ...mailAttachments.map((a) => a.name),
    ...state.uploadedFiles.map((u) => u.file.name),
  ];
}

function remainingSelectionSlots(state: IntakeState): number {
  return (
    MAX_ATTACHMENT_COUNT -
    attachmentCount(state.selectedAttachmentIds, state.uploadedFiles)
  );
}

function selectableMail(
  attachments: AttachmentInfo[],
  dismissedIds: IntakeState["dismissedMailAttachmentIds"],
): AttachmentInfo[] {
  const dismissed = new Set(dismissedIds);
  return selectableMailAttachments(attachments).filter(
    (attachment) => !dismissed.has(attachment.id),
  );
}

function collectPendingUploadIds(
  uploadedFiles: IntakeState["uploadedFiles"],
): string[] {
  const pendingIds: string[] = [];
  for (const u of uploadedFiles) {
    if (
      u.rejection === null &&
      u.selected &&
      u.status !== "complete" &&
      u.status !== "error"
    ) {
      pendingIds.push(u.id);
    }
  }
  return pendingIds;
}

function collectSelectedMail(
  mailAttachments: AttachmentInfo[],
  selectedIds: IntakeState["selectedAttachmentIds"],
): { id: string; name: string }[] {
  const selected = new Set(selectedIds);
  const selectedMail: { id: string; name: string }[] = [];
  for (const a of mailAttachments) {
    if (selected.has(a.id)) {
      selectedMail.push({ id: a.id, name: a.name });
    }
  }
  return selectedMail;
}

function addNovelUploads(
  files: File[],
  mailAttachments: AttachmentInfo[],
  state: IntakeState,
  dispatch: Dispatch<IntakeAction>,
  stagingDeps: ReturnType<typeof useAttachmentStaging>,
): void {
  const novel = filterDuplicateUploadFiles(
    files,
    existingAttachmentNames(mailAttachments, state),
  );
  if (novel.length === 0) return;

  const newUploads = buildUploadedFiles(
    novel,
    () => crypto.randomUUID(),
    remainingSelectionSlots(state),
  );
  dispatch({ type: "filesAdded", files: newUploads });
  queueIntakeFileUploads(stagingDeps, newUploads, dispatch);
}

export function useIntakeAttachments(
  mailItem: MailItemData,
  state: IntakeState,
  dispatch: Dispatch<IntakeAction>,
): IntakeAttachmentApi {
  const stage = useAttachmentSync();
  const stagingDeps = useAttachmentStaging();
  const uploadsRef = useRef(state.uploadedFiles);
  uploadsRef.current = state.uploadedFiles;
  const mailAttachments = useMemo(
    () => selectableMail(mailItem.attachments, state.dismissedMailAttachmentIds),
    [mailItem.attachments, state.dismissedMailAttachmentIds],
  );

  const addFiles = useCallback(
    (files: File[]) =>
      addNovelUploads(files, mailAttachments, state, dispatch, stagingDeps),
    [mailAttachments, state, dispatch, stagingDeps],
  );

  const retryUpload = useCallback(
    (id: string) => {
      const target = state.uploadedFiles.find((file) => file.id === id);
      if (!target || target.rejection !== null) return;
      retryIntakeFileUpload(stagingDeps, target, dispatch);
    },
    [state.uploadedFiles, dispatch, stagingDeps],
  );

  const stageSelected = useCallback(async () => {
    const pendingIds = collectPendingUploadIds(state.uploadedFiles);
    if (pendingIds.length > 0) {
      await awaitIntakeUploads(pendingIds);
    }
    const selectedMail = collectSelectedMail(
      mailAttachments,
      state.selectedAttachmentIds,
    );
    return stage(selectedMail, mergeStagedUploads(uploadsRef.current));
  }, [stage, mailAttachments, state]);

  return { mailAttachments, addFiles, retryUpload, stageSelected };
}
