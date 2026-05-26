import { useCallback } from "react";

interface AttachmentContent {
  format: string;
  content: string;
}

export function useAttachments() {
  const getAttachmentContent = useCallback(
    (attachmentId: string): Promise<AttachmentContent> => {
      const item = Office.context?.mailbox?.item as
        | Office.MessageRead
        | undefined;
      if (!item) throw new Error("No mail item selected");
      return new Promise<AttachmentContent>((resolve, reject) => {
        item.getAttachmentContentAsync(
          attachmentId,
          (result: Office.AsyncResult<Office.AttachmentContent>) => {
            if (result.status === Office.AsyncResultStatus.Succeeded) {
              resolve({
                format: result.value.format.toString(),
                content: result.value.content,
              });
            } else {
              reject(new Error(result.error.message));
            }
          },
        );
      });
    },
    [],
  );

  return { getAttachmentContent };
}
