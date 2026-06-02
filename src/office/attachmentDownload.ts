// Office.js byte download for existing mail attachments (ADR-0022). The picker
// offers real file attachments (selectableMailAttachments); when the user syncs,
// each selected one is pulled as Base64 via getAttachmentContentAsync and decoded
// into a Blob for the Convex staging -> Feishu Drive path (see attachmentUpload).
//
// Requirement set Mailbox 1.8 (this is what raises the manifest floor). Office.js
// surfaces no usable contentType, so MIME is derived from the filename. Errors to
// expect: AttachmentTypeNotSupported, InvalidAttachmentId; cloud/item attachments
// return a non-Base64 format and are rejected (the picker already filters them).
//   https://learn.microsoft.com/en-us/javascript/api/outlook/office.attachmentcontent

import { base64ToBlob, mimeFromName, type AttachmentSource } from "./attachmentUpload";
import type { OfficeLike } from "./mailItem";

// The slice of the read Mail Item we need: just the attachment byte fetch. Kept
// structural so the wrapper is unit-testable without a live Office host.
export interface AttachmentContentReader {
  getAttachmentContentAsync(
    attachmentId: string,
    callback: (result: Office.AsyncResult<Office.AttachmentContent>) => void,
  ): void;
}

// Download one selected mail attachment and decode it to a staging-ready blob.
// Rejects on a failed async result or any non-Base64 (cloud/item) format.
export function downloadMailAttachment(
  office: OfficeLike,
  item: AttachmentContentReader,
  attachment: { id: string; name: string },
): Promise<AttachmentSource> {
  return new Promise((resolve, reject) => {
    item.getAttachmentContentAsync(attachment.id, (result) => {
      if (result.status !== office.AsyncResultStatus.Succeeded) {
        reject(new Error(result.error?.message ?? "Failed to download attachment"));
        return;
      }
      if (result.value.format !== office.MailboxEnums.AttachmentContentFormat.Base64) {
        reject(new Error(`Unsupported attachment format: ${result.value.format}`));
        return;
      }
      resolve({
        name: attachment.name,
        blob: base64ToBlob(result.value.content, mimeFromName(attachment.name)),
      });
    });
  });
}
