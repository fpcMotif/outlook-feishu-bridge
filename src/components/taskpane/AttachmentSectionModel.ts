import { MAX_ATTACHMENT_COUNT } from "../../office/attachments";
import type { AttachmentInfo } from "../../office/mailItem";
import { attachmentCount, occupiesSlot } from "./attachmentSelection";
import type { UploadedFile, UploadStatus } from "./intakeReducer";

export type AttachmentRowItem = {
  id: string;
  name: string;
  size: number;
  selected: boolean;
  disabled: boolean;
  rejection?: string | null;
  uploadStatus?: UploadStatus;
  progress?: number;
  uploadError?: string | null;
  onToggle: () => void;
  onRemove: () => void;
  onRetry?: () => void;
  onReplace?: (file: File) => void;
};

export function selectedTotalBytes(
  mailAttachments: AttachmentInfo[],
  selectedIds: string[],
  uploadedFiles: UploadedFile[],
): number {
  const selected = new Set(selectedIds);
  const mail = mailAttachments
    .filter((a) => selected.has(a.id))
    .reduce((n, a) => n + a.size, 0);
  const uploads = uploadedFiles
    .filter((u) => occupiesSlot(u))
    .reduce((n, u) => n + u.file.size, 0);
  return mail + uploads;
}

export function selectedMailAttachmentCount(
  mailAttachments: AttachmentInfo[],
  selectedIds: string[],
): number {
  const mailIds = new Set(mailAttachments.map((a) => a.id));
  return selectedIds.filter((id) => mailIds.has(id)).length;
}

export function toggleAllMailAttachments({
  allSelected,
  mailAttachments,
  selectedIds,
  uploadedFiles,
  onToggleMail,
}: {
  allSelected: boolean;
  mailAttachments: AttachmentInfo[];
  selectedIds: string[];
  uploadedFiles: UploadedFile[];
  onToggleMail: (id: string) => void;
}) {
  const mailIds = new Set(mailAttachments.map((a) => a.id));
  if (allSelected) {
    for (const id of selectedIds) {
      if (mailIds.has(id)) onToggleMail(id);
    }
    return;
  }

  const selected = new Set(selectedIds);
  let slots =
    MAX_ATTACHMENT_COUNT - attachmentCount(selectedIds, uploadedFiles);
  for (const attachment of mailAttachments) {
    if (selected.has(attachment.id) || slots <= 0) continue;
    onToggleMail(attachment.id);
    slots -= 1;
  }
}

export function buildMailRows({
  mailAttachments,
  selectedIds,
  canSelectMore,
  onToggleMail,
  onRemoveMail,
}: {
  mailAttachments: AttachmentInfo[];
  selectedIds: string[];
  canSelectMore: boolean;
  onToggleMail: (id: string) => void;
  onRemoveMail: (id: string) => void;
}): AttachmentRowItem[] {
  const selected = new Set(selectedIds);
  return mailAttachments.map((attachment) => {
    const checked = selected.has(attachment.id);
    return {
      id: attachment.id,
      name: attachment.name,
      size: attachment.size,
      selected: checked,
      disabled: !checked && !canSelectMore,
      onToggle: () => onToggleMail(attachment.id),
      onRemove: () => onRemoveMail(attachment.id),
    };
  });
}

export function buildUploadRows({
  uploadedFiles,
  canSelectMore,
  onToggleUpload,
  onRemoveUpload,
  onRetryUpload,
  onReplaceUpload,
}: {
  uploadedFiles: UploadedFile[];
  canSelectMore: boolean;
  onToggleUpload: (id: string) => void;
  onRemoveUpload: (id: string) => void;
  onRetryUpload?: (id: string) => void;
  onReplaceUpload?: (id: string, file: File) => void;
}): AttachmentRowItem[] {
  return uploadedFiles.map((upload) => ({
    id: upload.id,
    name: upload.file.name,
    size: upload.file.size,
    // A failed upload reads as UNCHECKED (occupiesSlot is false for status
    // "error") even though `selected` stays true underneath, so Retry can restore
    // it to the selection the moment it completes.
    selected: occupiesSlot(upload),
    disabled:
      upload.rejection !== null ||
      upload.status === "uploading" ||
      upload.status === "pending" ||
      upload.status === "processing" ||
      // Only a successfully-staged file can be selected; a failed one must be
      // retried or removed, so its checkbox is locked until it recovers.
      upload.status === "error" ||
      (!upload.selected && !canSelectMore),
    rejection: upload.rejection,
    uploadStatus: upload.status,
    progress: upload.progress,
    uploadError: upload.uploadError,
    onToggle: () => onToggleUpload(upload.id),
    onRemove: () => onRemoveUpload(upload.id),
    onRetry:
      upload.status === "error" && onRetryUpload
        ? () => onRetryUpload(upload.id)
        : undefined,
    onReplace:
      upload.status === "error" && onReplaceUpload
        ? (file: File) => onReplaceUpload(upload.id, file)
        : undefined,
  }));
}

export function uploadedSelection({
  uploadedFiles,
  selectedMailCount,
}: {
  uploadedFiles: UploadedFile[];
  selectedMailCount: number;
}): string[] {
  let slots = MAX_ATTACHMENT_COUNT - selectedMailCount;
  const ids: string[] = [];
  for (const upload of uploadedFiles) {
    // Skip rejected AND failed picks — neither can be staged, so "Select all"
    // must not promise them.
    if (upload.rejection !== null || upload.status === "error" || slots <= 0) {
      continue;
    }
    ids.push(upload.id);
    slots -= 1;
  }
  return ids;
}

export function allValidUploadsSelected(
  uploadedFiles: UploadedFile[],
): boolean {
  // Only selectable rows (not rejected, not failed) decide the header toggle;
  // a failed row can't be selected, so it never holds the label on "Select all".
  const selectable = uploadedFiles.filter(
    (upload) => upload.rejection === null && upload.status !== "error",
  );
  return selectable.length > 0 && selectable.every((u) => occupiesSlot(u));
}
