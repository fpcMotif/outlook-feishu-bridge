import {
  MAX_ATTACHMENT_COUNT,
  mailAttachmentRejectionReason,
} from "../../office/attachments";
import type { AttachmentInfo } from "../../office/mailItem";
import { attachmentCount } from "./attachmentSelection";
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
    .filter((u) => u.rejection === null && u.selected)
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
    // Never auto-select an oversized attachment — it would fail the Drive upload.
    if (mailAttachmentRejectionReason(attachment) !== null) continue;
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
    // Oversized mail attachments would fail the 20 MB Drive upload; surface them
    // as blocked (like a rejected upload) so they can't be selected (#34).
    const rejection = mailAttachmentRejectionReason(attachment);
    return {
      id: attachment.id,
      name: attachment.name,
      size: attachment.size,
      selected: checked,
      disabled: rejection !== null || (!checked && !canSelectMore),
      rejection,
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
}: {
  uploadedFiles: UploadedFile[];
  canSelectMore: boolean;
  onToggleUpload: (id: string) => void;
  onRemoveUpload: (id: string) => void;
  onRetryUpload?: (id: string) => void;
}): AttachmentRowItem[] {
  return uploadedFiles.map((upload) => ({
    id: upload.id,
    name: upload.file.name,
    size: upload.file.size,
    selected: upload.selected,
    disabled:
      upload.rejection !== null ||
      upload.status === "uploading" ||
      upload.status === "pending" ||
      upload.status === "processing" ||
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
    if (upload.rejection !== null || slots <= 0) continue;
    ids.push(upload.id);
    slots -= 1;
  }
  return ids;
}

export function allValidUploadsSelected(
  uploadedFiles: UploadedFile[],
): boolean {
  const validUploads = uploadedFiles.filter(
    (upload) => upload.rejection === null,
  );
  return (
    validUploads.length > 0 && validUploads.every((upload) => upload.selected)
  );
}
