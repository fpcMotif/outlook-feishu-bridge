/* eslint-disable max-lines-per-function */
// Attachment concern for the intake screen (ADR-0022 / ADR-0027): derives the
// selectable mail attachments, the Add-file handler (validate + auto-select
// slots), and the submit-time stageSelected() that downloads the checked mail
// attachments + uploads and STAGES them to Convex (the Drive mint is now the
// server-side Attachment Fill's job). Keeps RequestIntakeScreen focused and the
// Convex/Office coupling out of the component body.

import { useCallback, useMemo, useRef, type Dispatch } from "react";

import {
  MAX_ATTACHMENT_COUNT,
  selectableMailAttachments,
  uploadRejectionReason,
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
  replaceIntakeFileUpload,
  retryIntakeFileUpload,
  retryIntakeFileUploads,
} from "./uploadIntakeFile";
import {
  useAttachmentSync,
  type AttachmentSyncResult,
} from "./useAttachmentSync";

type IntakeAttachmentApi = {
  mailAttachments: AttachmentInfo[];
  addFiles: (files: File[]) => void;
  retryUpload: (id: string) => void;
  retryAllUploads: (ids: string[]) => void;
  replaceUpload: (id: string, file: File) => void;
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
  // DEV-only override (?mock=) so Retry/Re-add behave deterministically with no
  // backend; production passes nothing and the live Convex deps are used.
  stagingDepsOverride?: ReturnType<typeof useAttachmentStaging>,
): IntakeAttachmentApi {
  const stage = useAttachmentSync();
  const liveStagingDeps = useAttachmentStaging();
  const stagingDeps = stagingDepsOverride ?? liveStagingDeps;
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

  const retryAllUploads = useCallback(
    (ids: string[]) => {
      const wanted = new Set(ids);
      const targets = state.uploadedFiles.filter(
        (file) => wanted.has(file.id) && file.rejection === null,
      );
      // Drives the batch through the same concurrency cap as the initial queue
      // so "Retry all" can't reproduce the burst that caused the failures.
      retryIntakeFileUploads(stagingDeps, targets, dispatch);
    },
    [state.uploadedFiles, dispatch, stagingDeps],
  );

  const replaceUpload = useCallback(
    (id: string, file: File) => {
      const target = state.uploadedFiles.find((u) => u.id === id);
      if (!target) return;
      // Re-validate the fresh pick (type/size) and swap it into the same row, then
      // re-queue when valid. A rejected re-pick parks the row as blocked instead.
      const rejection = uploadRejectionReason(file);
      dispatch({ type: "uploadFileReplaced", id, file, rejection });
      if (rejection === null) {
        replaceIntakeFileUpload(stagingDeps, { id, file }, dispatch);
      }
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

  return {
    mailAttachments,
    addFiles,
    retryUpload,
    retryAllUploads,
    replaceUpload,
    stageSelected,
  };
}
