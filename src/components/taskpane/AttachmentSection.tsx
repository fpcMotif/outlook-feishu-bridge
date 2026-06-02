import { MAX_ATTACHMENT_COUNT } from "../../office/attachments";
import type { AttachmentInfo } from "../../office/mailItem";
import { attachmentCount, canAddMore } from "./attachmentSelection";
import { AttachmentGroup, META_CLASS } from "./AttachmentSectionPrimitives";
import { AddFileRow, MailAttachmentRow, UploadedAttachmentRow } from "./AttachmentSectionRows";
import type { UploadedFile } from "./intakeReducer";
import { SectionLabel } from "./SectionLabel";

const CARD_CLASS = "bg-card rounded-[20px] p-2 shadow-edge";

function MailAttachmentsGroup({
  mailAttachments,
  selectedIds,
  addMore,
  onToggleMail,
}: {
  mailAttachments: AttachmentInfo[];
  selectedIds: string[];
  addMore: boolean;
  onToggleMail: (id: string) => void;
}) {
  if (mailAttachments.length === 0) return null;

  return (
    <AttachmentGroup title="Outlook" count={mailAttachments.length}>
      {mailAttachments.map((a) => {
        const checked = selectedIds.includes(a.id);
        return (
          <MailAttachmentRow
            key={a.id}
            attachment={a}
            checked={checked}
            disabled={!checked && !addMore}
            onToggle={() => onToggleMail(a.id)}
          />
        );
      })}
    </AttachmentGroup>
  );
}

function UploadedFilesGroup({
  uploadedFiles,
  onRemoveUpload,
}: {
  uploadedFiles: UploadedFile[];
  onRemoveUpload: (id: string) => void;
}) {
  if (uploadedFiles.length === 0) return null;

  return (
    <AttachmentGroup title="Uploaded" count={uploadedFiles.length}>
      {uploadedFiles.map((u) => (
        <UploadedAttachmentRow
          key={u.id}
          upload={u}
          onRemove={() => onRemoveUpload(u.id)}
        />
      ))}
    </AttachmentGroup>
  );
}

interface AttachmentCardProps {
  mailAttachments: AttachmentInfo[];
  selectedIds: string[];
  uploadedFiles: UploadedFile[];
  addMore: boolean;
  onToggleMail: (id: string) => void;
  onAddFiles: (files: File[]) => void;
  onRemoveUpload: (id: string) => void;
}

function AttachmentCard({
  mailAttachments,
  selectedIds,
  uploadedFiles,
  addMore,
  onToggleMail,
  onAddFiles,
  onRemoveUpload,
}: AttachmentCardProps) {
  return (
    <div className={CARD_CLASS}>
      <MailAttachmentsGroup
        mailAttachments={mailAttachments}
        selectedIds={selectedIds}
        addMore={addMore}
        onToggleMail={onToggleMail}
      />
      <UploadedFilesGroup
        uploadedFiles={uploadedFiles}
        onRemoveUpload={onRemoveUpload}
      />
      <div className="px-1 pt-1">
        <AddFileRow disabled={!addMore} onPick={onAddFiles} />
      </div>
    </div>
  );
}

export function AttachmentSection({
  mailAttachments,
  selectedIds,
  uploadedFiles,
  onToggleMail,
  onAddFiles,
  onRemoveUpload,
}: {
  mailAttachments: AttachmentInfo[];
  selectedIds: string[];
  uploadedFiles: UploadedFile[];
  onToggleMail: (id: string) => void;
  onAddFiles: (files: File[]) => void;
  onRemoveUpload: (id: string) => void;
}) {
  const count = attachmentCount(selectedIds, uploadedFiles);
  const addMore = canAddMore(count);

  return (
    <section aria-labelledby="attachments-title" className="space-y-3">
      <header className="flex items-center justify-between px-1">
        <SectionLabel id="attachments-title">Attachments</SectionLabel>
        <span className={META_CLASS}>{`${count} / ${MAX_ATTACHMENT_COUNT}`}</span>
      </header>
      <AttachmentCard
        mailAttachments={mailAttachments}
        selectedIds={selectedIds}
        uploadedFiles={uploadedFiles}
        addMore={addMore}
        onToggleMail={onToggleMail}
        onAddFiles={onAddFiles}
        onRemoveUpload={onRemoveUpload}
      />
    </section>
  );
}
