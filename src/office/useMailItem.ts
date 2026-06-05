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
      setMailItem((current) => (current ? { ...current, body, bodyPending: false } : current));
      dtime("read mail body (background)", tBody);
    })
    .catch((err: unknown) => {
      if (readGeneration.current !== generation) return;
      // Body unreadable — clear the pending flag so the submit gate unblocks (the
      // row will carry an empty body, the best available outcome at this point).
      setMailItem((current) => (current ? { ...current, bodyPending: false } : current));
      const msg = err instanceof Error ? err.message : "Unknown body read error";
      dlog(`readCurrentItem: body read skipped/failed in background: ${msg}`);
    });
}

// When the task pane is pinned, Outlook keeps this same pane alive while the user
// moves between messages. Re-read on ItemChanged so the pane does not show
// metadata/body from the previously selected email. Returns the effect cleanup
// (or void when the host lacks the API, e.g. the dev browser).
function registerPinnedPaneReread(readCurrentItem: () => void): (() => void) | void {
  const mailbox = Office.context?.mailbox;
  if (!mailbox?.addHandlerAsync || !Office.EventType?.ItemChanged) return;
  const onItemChanged = () => {
    dlog("ItemChanged: re-reading current item (pinned pane)");
    void readCurrentItem();
  };
  // Surface a failed registration: without a result callback a Failed status is
  // swallowed and the pinned pane silently stops re-reading on email switch.
  mailbox.addHandlerAsync(Office.EventType.ItemChanged, onItemChanged, (result) => {
    if (result?.status !== Office.AsyncResultStatus?.Succeeded) {
      dlog(`ItemChanged handler registration failed: ${result?.error?.message ?? "unknown"}`);
    }
  });
  return () => {
    mailbox.removeHandlerAsync?.(Office.EventType.ItemChanged);
  };
}

// Synchronously read the current Outlook item's metadata and publish it, then kick
// off the generation-guarded background body read. The metadata path has no await,
// so overlapping reads (rapid ItemChanged in a pinned pane) cannot interleave —
// the latest call's setMailItem always lands last.
function publishCurrentItem(
  generation: number,
  readGeneration: { current: number },
  setMailItem: Dispatch<SetStateAction<MailItemData | null>>,
  setLoading: Dispatch<SetStateAction<boolean>>,
  setError: Dispatch<SetStateAction<string | null>>,
): void {
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
    // Publish metadata immediately with bodyPending=true; the real body lands via
    // readBodyInBackground. The submit gate blocks Sync while bodyPending so a fast
    // tap inside the read window cannot persist an empty body to the Base row (the
    // row is the only home of the full email body, ADR-0022).
    setMailItem({ ...data, bodyPending: true });
    setLoading(false);
    readBodyInBackground(generation, readGeneration, setMailItem);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    dlog(`readCurrentItem: ERROR ${msg}`);
    setError(msg);
    setLoading(false);
  }
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
    publishCurrentItem(generation, readGeneration, setMailItem, setLoading, setError);
  }, []);

  useEffect(() => {
    if (!autoRead) return;
    if (!didAutoRead.current) {
      didAutoRead.current = true;
      void readCurrentItem();
    }
    return registerPinnedPaneReread(readCurrentItem);
  }, [autoRead, readCurrentItem]);

  return { mailItem, loading, error, readCurrentItem };
}
