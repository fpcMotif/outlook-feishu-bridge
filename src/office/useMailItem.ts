import { useCallback, useEffect, useRef, useState } from "react";
import { readMailBodyText } from "./mailBody";
import { dlog, dload, dtime } from "../debug";

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
  body: string;
  dateTimeCreated: Date | null;
  internetMessageId: string;
  itemId: string;
  conversationId: string;
  userEmail: string;
  attachments: AttachmentInfo[];
}

type ReadItem = Office.MessageRead & Office.ItemRead;

// In compose/reply windows item.subject/to/cc are async objects (Subject,
// Recipients) exposing getAsync — NOT the string/array shapes read mode gives.
// This add-in syncs *received* mail, so we detect compose and fail with a
// clear message instead of crashing on `.map`/`.slice`.
function isComposeItem(item: unknown): boolean {
  const subject = (item as { subject?: unknown } | undefined)?.subject;
  return (
    typeof subject === "object" &&
    subject !== null &&
    typeof (subject as { getAsync?: unknown }).getAsync === "function"
  );
}

function emailList(value: readonly Office.EmailAddressDetails[] | undefined): string[] {
  return Array.isArray(value) ? value.map((r) => r.emailAddress) : [];
}

function convertToRestId(ewsId: string | undefined): string {
  if (!ewsId) return "";
  try {
    return Office.context.mailbox.convertToRestId(
      ewsId,
      Office.MailboxEnums.RestVersion.v2_0,
    );
  } catch {
    return ewsId;
  }
}

function extractAttachments(item: ReadItem): AttachmentInfo[] {
  const supported =
    Office.context?.requirements?.isSetSupported?.("Mailbox", "1.8") ?? false;
  if (!supported) return [];
  return (item.attachments ?? [])
    .map((a: Office.AttachmentDetails) => ({
      id: a.id,
      name: a.name,
      contentType: a.contentType,
      size: a.size,
      isInline: a.isInline,
    }));
}

function extractMailData(item: ReadItem, body: string): MailItemData {
  return {
    subject: item.subject ?? "",
    from: item.from?.emailAddress ?? "",
    to: emailList(item.to),
    cc: emailList(item.cc),
    body,
    dateTimeCreated: item.dateTimeCreated ?? null,
    internetMessageId: item.internetMessageId ?? "",
    itemId: convertToRestId(item.itemId),
    conversationId: item.conversationId ?? "",
    userEmail: Office.context?.mailbox?.userProfile?.emailAddress ?? "",
    attachments: extractAttachments(item),
  };
}

export function useMailItem(autoRead = false) {
  const [mailItem, setMailItem] = useState<MailItemData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const didAutoRead = useRef(false);

  const readCurrentItem = useCallback(async () => {
    setLoading(true);
    setError(null);
    dlog("readCurrentItem: start");
    const tRead = performance.now();
    try {
      const item = Office.context?.mailbox?.item as ReadItem | undefined;
      dlog(`readCurrentItem: mailbox item present=${Boolean(item)}`);
      if (!item) {
        throw new Error("No mail item selected (not inside Outlook, or no message open)");
      }
      if (isComposeItem(item)) {
        throw new Error("feishu-sync works with received emails - open a received message in the reading pane (not a compose/reply window), then try again.");
      }
      const body = await readMailBodyText();
      const data = extractMailData(item, body);
      dlog(`readCurrentItem: OK subject="${data.subject.slice(0, 40)}" attachments=${data.attachments.length}`);
      dtime("read mail (body + metadata)", tRead);
      dload("mail readable — load cycle done");
      setMailItem(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      dlog(`readCurrentItem: ERROR ${msg}`);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!autoRead || didAutoRead.current) return;
    didAutoRead.current = true;
    void readCurrentItem();
  }, [autoRead, readCurrentItem]);

  return { mailItem, loading, error, readCurrentItem };
}
