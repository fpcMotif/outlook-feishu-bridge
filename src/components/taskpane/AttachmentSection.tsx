/* eslint-disable max-lines, max-lines-per-function */
import { useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

import { formatBytes, MAX_ATTACHMENT_COUNT } from "../../office/attachments";
import type { AttachmentInfo } from "../../office/mailItem";
import { attachmentCount, canAddMore } from "./attachmentSelection";
import { AttachmentListCard, META_CLASS } from "./AttachmentSectionPrimitives";
import { AttachmentItemRow } from "./AttachmentSectionRows";
import {
  allValidUploadsSelected,
  buildMailRows,
  buildUploadRows,
  selectedMailAttachmentCount,
  selectedTotalBytes,
  toggleAllMailAttachments,
  uploadedSelection,
  type AttachmentRowItem,
} from "./AttachmentSectionModel";
import {
  SourceGroupSeparator,
  SourceHeader,
  type AttachmentSourceKind,
} from "./AttachmentSourceHeader";
import { UploadDropZone } from "./AttachmentUploadDropZone";
import type { UploadedFile } from "./intakeReducer";
import { collectFailedUploadIds } from "./uploadError";
import { SectionLabel } from "./SectionLabel";

function AttachmentSourceGroup({
  source,
  rows,
  selectAllLabel,
  onSelectAll,
  notice,
}: {
  source: AttachmentSourceKind;
  rows: AttachmentRowItem[];
  selectAllLabel: string;
  onSelectAll: () => void;
  notice?: ReactNode;
}) {
  if (rows.length === 0) return null;

  return (
    <>
      <SourceHeader
        source={source}
        count={rows.length}
        onSelectAll={onSelectAll}
        selectAllLabel={selectAllLabel}
      />
      {notice}
      <div className="divide-y divide-border">
        {rows.map((row) => (
          <AttachmentItemRow key={row.id} {...row} />
        ))}
      </div>
    </>
  );
}

// Failed uploads are parked out of the selection and synced-without, so the user
// needs to know they won't be attached unless they act.
function UploadedFailedNotice({ count }: { count: number }) {
  return (
    <p className="text-destructive/90 px-4 pb-2 text-[11px] leading-4">
      {count === 1
        ? "1 file couldn't upload and will be skipped — Retry or remove it."
        : `${count} files couldn't upload and will be skipped — Retry or remove them.`}
    </p>
  );
}

function OutlookAttachmentGroup({
  mailAttachments,
  selectedIds,
  uploadedFiles,
  canSelectMore,
  onToggleMail,
  onRemoveMail,
}: {
  mailAttachments: AttachmentInfo[];
  selectedIds: string[];
  uploadedFiles: UploadedFile[];
  canSelectMore: boolean;
  onToggleMail: (id: string) => void;
  onRemoveMail: (id: string) => void;
}) {
  const selectedMailCount = selectedMailAttachmentCount(
    mailAttachments,
    selectedIds,
  );
  const allSelected =
    mailAttachments.length > 0 && selectedMailCount === mailAttachments.length;
  const rows = buildMailRows({
    mailAttachments,
    selectedIds,
    canSelectMore,
    onToggleMail,
    onRemoveMail,
  });

  return (
    <AttachmentSourceGroup
      source="outlook"
      rows={rows}
      selectAllLabel={allSelected ? "Deselect all" : "Select all"}
      onSelectAll={() =>
        toggleAllMailAttachments({
          allSelected,
          mailAttachments,
          selectedIds,
          uploadedFiles,
          onToggleMail,
        })
      }
    />
  );
}

function UploadedAttachmentGroup({
  mailAttachments,
  selectedIds,
  uploadedFiles,
  canSelectMore,
  onToggleUpload,
  onSetUploadedSelection,
  onRemoveUpload,
  onRetryUpload,
  onReplaceUpload,
}: {
  mailAttachments: AttachmentInfo[];
  selectedIds: string[];
  uploadedFiles: UploadedFile[];
  canSelectMore: boolean;
  onToggleUpload: (id: string) => void;
  onSetUploadedSelection: (ids: string[]) => void;
  onRemoveUpload: (id: string) => void;
  onRetryUpload?: (id: string) => void;
  onReplaceUpload?: (id: string, file: File) => void;
}) {
  const selectedMailCount = selectedMailAttachmentCount(
    mailAttachments,
    selectedIds,
  );
  const allSelected = allValidUploadsSelected(uploadedFiles);
  const failedCount = collectFailedUploadIds(uploadedFiles).length;
  const rows = buildUploadRows({
    uploadedFiles,
    canSelectMore,
    onToggleUpload,
    onRemoveUpload,
    onRetryUpload,
    onReplaceUpload,
  });

  return (
    <AttachmentSourceGroup
      source="uploaded"
      rows={rows}
      selectAllLabel={allSelected ? "Deselect all" : "Select all"}
      onSelectAll={() =>
        onSetUploadedSelection(
          allSelected
            ? []
            : uploadedSelection({ uploadedFiles, selectedMailCount }),
        )
      }
      notice={
        failedCount > 0 ? (
          <UploadedFailedNotice count={failedCount} />
        ) : undefined
      }
    />
  );
}

type AttachmentFileListProps = {
  mailAttachments: AttachmentInfo[];
  selectedIds: string[];
  uploadedFiles: UploadedFile[];
  canSelectMore: boolean;
  onToggleMail: (id: string) => void;
  onRemoveMail: (id: string) => void;
  onToggleUpload: (id: string) => void;
  onSetUploadedSelection: (ids: string[]) => void;
  onRemoveUpload: (id: string) => void;
  onRetryUpload?: (id: string) => void;
  onReplaceUpload?: (id: string, file: File) => void;
};

function AttachmentFileList({
  mailAttachments,
  selectedIds,
  uploadedFiles,
  canSelectMore,
  onToggleMail,
  onRemoveMail,
  onToggleUpload,
  onSetUploadedSelection,
  onRemoveUpload,
  onRetryUpload,
  onReplaceUpload,
}: AttachmentFileListProps) {
  const hasMail = mailAttachments.length > 0;
  const hasUploads = uploadedFiles.length > 0;
  if (!hasMail && !hasUploads) return null;

  return (
    <AttachmentListCard>
      {hasMail ? (
        <OutlookAttachmentGroup
          mailAttachments={mailAttachments}
          selectedIds={selectedIds}
          uploadedFiles={uploadedFiles}
          canSelectMore={canSelectMore}
          onToggleMail={onToggleMail}
          onRemoveMail={onRemoveMail}
        />
      ) : null}
      {hasMail && hasUploads ? <SourceGroupSeparator /> : null}
      {hasUploads ? (
        <UploadedAttachmentGroup
          mailAttachments={mailAttachments}
          selectedIds={selectedIds}
          uploadedFiles={uploadedFiles}
          canSelectMore={canSelectMore}
          onToggleUpload={onToggleUpload}
          onSetUploadedSelection={onSetUploadedSelection}
          onRemoveUpload={onRemoveUpload}
          onRetryUpload={onRetryUpload}
          onReplaceUpload={onReplaceUpload}
        />
      ) : null}
    </AttachmentListCard>
  );
}

function AttachmentSectionHeader({
  count,
  total,
}: {
  count: number;
  total: number;
}) {
  const prevCountRef = useRef(count);
  const [countBounceKey, setCountBounceKey] = useState(0);
  const [isCountBouncing, setIsCountBouncing] = useState(false);

  const prevCount = prevCountRef.current;
  if (count !== prevCount) {
    if (count < prevCount) {
      setIsCountBouncing(true);
      setCountBounceKey((key) => key + 1);
    } else {
      setIsCountBouncing(false);
    }
    prevCountRef.current = count;
  }

  return (
    <header className="flex flex-wrap items-center justify-between gap-3 px-1">
      <SectionLabel id="attachments-title">Attachments</SectionLabel>
      <div className="flex shrink-0 flex-wrap items-center gap-3">
        <span className={META_CLASS}>
          {formatBytes(total)} total
          <span className="text-border mx-1.5" aria-hidden="true">
            &bull;
          </span>
          <span
            key={countBounceKey}
            className={cn(
              "inline-flex items-center rounded-full border px-1.5 py-0.5 font-semibold tabular-nums transition-[background-color,border-color,color] duration-200 ease-[var(--ease-out-strong)]",
              isCountBouncing ? "attachment-count-down-bounce" : null,
              count > 0
                ? "border-primary/20 bg-primary/10 text-primary"
                : "border-border/70 bg-muted/30 text-muted-foreground",
            )}
          >
            {count}/{MAX_ATTACHMENT_COUNT}
          </span>
        </span>
      </div>
    </header>
  );
}

export function AttachmentSection({
  mailAttachments,
  selectedIds,
  uploadedFiles,
  onToggleMail,
  onRemoveMail,
  onToggleUpload,
  onSetUploadedSelection,
  onAddFiles,
  onRetryUpload,
  onReplaceUpload,
  onRemoveUpload,
}: {
  mailAttachments: AttachmentInfo[];
  selectedIds: string[];
  uploadedFiles: UploadedFile[];
  onToggleMail: (id: string) => void;
  onRemoveMail: (id: string) => void;
  onToggleUpload: (id: string) => void;
  onSetUploadedSelection: (ids: string[]) => void;
  onAddFiles: (files: File[]) => void;
  onRetryUpload?: (id: string) => void;
  onReplaceUpload?: (id: string, file: File) => void;
  onRemoveUpload: (id: string) => void;
}) {
  const count = attachmentCount(selectedIds, uploadedFiles);
  const total = selectedTotalBytes(mailAttachments, selectedIds, uploadedFiles);

  return (
    <section aria-labelledby="attachments-title" className="space-y-3">
      <AttachmentSectionHeader count={count} total={total} />
      <AttachmentFileList
        mailAttachments={mailAttachments}
        selectedIds={selectedIds}
        uploadedFiles={uploadedFiles}
        canSelectMore={canAddMore(count)}
        onToggleMail={onToggleMail}
        onRemoveMail={onRemoveMail}
        onToggleUpload={onToggleUpload}
        onSetUploadedSelection={onSetUploadedSelection}
        onRemoveUpload={onRemoveUpload}
        onRetryUpload={onRetryUpload}
        onReplaceUpload={onReplaceUpload}
      />
      <div>
        <UploadDropZone disabled={false} onPick={onAddFiles} />
      </div>
    </section>
  );
}
