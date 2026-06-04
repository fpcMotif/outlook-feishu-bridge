import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { readMailBodyText } from "./mailBody";
import {
  extractMailData,
  isComposeItem,
  type MailItemData,
  type ReadItem,
} from "./mailItem";
import { dlog, dload, dtime } from "../debug";

export type { AttachmentInfo, MailItemData } from "./mailItem";

function readBodyInBackground(
  generation: number,
  readGeneration: { current: number },
  setMailItem: Dispatch<SetStateAction<MailItemData | null>>,
): void {
  const tBody = performance.now();
  void readMailBodyText()
    .then((body) => {
      if (readGeneration.current !== generation) return;
      setMailItem((current) => (current ? { ...current, body } : current));
      dtime("read mail body (background)", tBody);
    })
    .catch((err: unknown) => {
      if (readGeneration.current !== generation) return;
      const msg = err instanceof Error ? err.message : "Unknown body read error";
      dlog(`readCurrentItem: body read skipped/failed in background: ${msg}`);
    });
}

export function useMailItem(autoRead = false) {
  const [mailItem, setMailItem] = useState<MailItemData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const didAutoRead = useRef(false);
  const readGeneration = useRef(0);

  const readCurrentItem = useCallback(() => {
    const generation = readGeneration.current + 1;
    readGeneration.current = generation;
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
      const data = extractMailData(Office, item, "");
      dlog(
        `readCurrentItem: OK subject="${data.subject.slice(0, 40)}" attachments=${data.attachments.length}`,
      );
      dtime("read mail metadata", tRead);
      dload("mail metadata readable - load cycle done");
      setMailItem(data);
      setLoading(false);
      readBodyInBackground(generation, readGeneration, setMailItem);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      dlog(`readCurrentItem: ERROR ${msg}`);
      setError(msg);
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
