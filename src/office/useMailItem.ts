/* eslint-disable max-lines-per-function */
import { useCallback, useEffect, useRef, useState } from "react";
import { readMailBodyText } from "./mailBody";
import {
  extractMailData,
  isComposeItem,
  type MailItemData,
  type ReadItem,
} from "./mailItem";
import { dlog, dload, dtime } from "../debug";

export type { AttachmentInfo, MailItemData } from "./mailItem";

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
        throw new Error(
          "feishu-sync works with received emails - open a received message in the reading pane (not a compose/reply window), then try again.",
        );
      }
      const body = await readMailBodyText();
      const data = extractMailData(Office, item, body);
      dlog(
        `readCurrentItem: OK subject="${data.subject.slice(0, 40)}" attachments=${data.attachments.length}`,
      );
      dtime("read mail (body + metadata)", tRead);
      dload("mail readable - load cycle done");
      setMailItem(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      dlog(`readCurrentItem: ERROR ${msg}`);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  // When the host auto-reads, also subscribe to Office ItemChanged so a user
  // selecting a different message refreshes the pane — otherwise mailItem keeps
  // showing the first email's data.
  useEffect(() => {
    if (!autoRead) return;
    if (!didAutoRead.current) {
      didAutoRead.current = true;
      void readCurrentItem();
    }
    if (typeof Office === "undefined") return;
    const mailbox = Office.context?.mailbox;
    if (!mailbox?.addHandlerAsync) return;
    const itemChanged = Office.EventType.ItemChanged;
    const onItemChanged = () => {
      void readCurrentItem();
    };
    mailbox.addHandlerAsync(itemChanged, onItemChanged);
    return () => {
      mailbox.removeHandlerAsync?.(itemChanged);
    };
  }, [autoRead, readCurrentItem]);

  return { mailItem, loading, error, readCurrentItem };
}
