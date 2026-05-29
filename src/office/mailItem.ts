export interface AttachmentInfo {
  id: string;
  name: string;
  contentType: string;
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
    contentType: a.contentType,
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
