export interface AttachmentInfo {
  id: string;
  name: string;
  // Office.js AttachmentType — "file" | "cloud" | "item". The picker offers only
  // real file attachments (`attachmentType === "file" && !isInline`). The former
  // `contentType` is deprecated (ADR-0022 derives MIME from the extension), so
  // it is dropped.
  attachmentType: string;
  size: number;
  isInline: boolean;
}

export interface MailItemData {
  subject: string;
  from: string;
  to: string[];
  cc: string[];
  /** Plain-text body via `body.getAsync(CoercionType.Text)`. */
  body: string;
  /**
   * True between the synchronous metadata publish and the background body read
   * completing (see useMailItem). The submit gate blocks Base Sync while this is
   * true so a fast Sync tap inside the read window can never persist an empty
   * `body` to the Base row — the row is the only home of the full email body
   * (ADR-0022; the Email Record keeps only a ≤500-char preview). Absent on
   * non-Outlook hosts / test fixtures, where it is treated as "ready".
   */
  bodyPending?: boolean;
  dateTimeCreated: Date | null;
  internetMessageId: string;
  /** REST/Graph id converted from the Office.js EWS item id. */
  itemId: string;
  conversationId: string;
  userEmail: string;
  attachments: AttachmentInfo[];
}

export type ReadItem = Office.MessageRead & Office.ItemRead;
export type OfficeLike = typeof Office;

export function isComposeItem(item: unknown): boolean {
  const subject = (item as { subject?: unknown } | undefined)?.subject;
  return (
    typeof subject === "object" &&
    subject !== null &&
    typeof (subject as { getAsync?: unknown }).getAsync === "function"
  );
}

export function emailList(
  value: readonly Office.EmailAddressDetails[] | undefined,
): string[] {
  return Array.isArray(value) ? value.map((r) => r.emailAddress) : [];
}

export function convertToRestId(office: OfficeLike, ewsId: string | undefined): string {
  if (!ewsId) return "";
  try {
    return office.context.mailbox.convertToRestId(
      ewsId,
      office.MailboxEnums.RestVersion.v2_0,
    );
  } catch {
    return ewsId;
  }
}

export function extractAttachments(office: OfficeLike, item: ReadItem): AttachmentInfo[] {
  const supported = office.context?.requirements?.isSetSupported?.("Mailbox", "1.8") ?? false;
  if (!supported) return [];
  return (item.attachments ?? []).map((a: Office.AttachmentDetails) => ({
    id: a.id,
    name: a.name,
    attachmentType: String(a.attachmentType),
    size: a.size,
    isInline: a.isInline,
  }));
}

export function extractMailData(
  office: OfficeLike,
  item: ReadItem,
  body: string,
): MailItemData {
  return {
    subject: item.subject ?? "",
    from: item.from?.emailAddress ?? "",
    to: emailList(item.to),
    cc: emailList(item.cc),
    body,
    dateTimeCreated: item.dateTimeCreated ?? null,
    internetMessageId: item.internetMessageId ?? "",
    itemId: convertToRestId(office, item.itemId),
    conversationId: item.conversationId ?? "",
    userEmail: office.context?.mailbox?.userProfile?.emailAddress ?? "",
    attachments: extractAttachments(office, item),
  };
}
