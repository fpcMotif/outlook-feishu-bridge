// Identity that decides which in-progress intake draft is current (pinned-pane
// support, commit "Make the Outlook read pane pinnable"). Base sync dedup is
// scoped by mailbox + conversation (ADR-0012, getBitableSyncByConversation), so
// one mailbox/conversation pair is one "page": reading sibling messages in the
// same thread should PRESERVE the draft, moving to a different conversation must
// start a clean slate, and switching back should restore that page's latest draft.
//
// Fallback order (only hit on degraded/dev hosts where conversationId is empty):
// per-message id, then a shared constant. See docs/adr — the shared "mail:unknown"
// bucket means several id-less messages would not remount between each other; this
// is acceptable for non-Outlook hosts where pinning is not exercised. Telemetry on
// the fallback path is deferred (docs/pinned-pane-review-and-deferred-work.md).

import type { MailItemData } from "../../office/mailItem";

function normalizeUserEmail(userEmail: string | undefined): string {
  return userEmail?.trim().toLowerCase() || "unknown-user";
}

export function deriveMailKey(
  mailItem: Pick<
    MailItemData,
    "conversationId" | "internetMessageId" | "itemId" | "userEmail"
  >,
): string {
  const user = normalizeUserEmail(mailItem.userEmail);
  const conversation = mailItem.conversationId?.trim();
  if (conversation) return `conv:${user}\n${conversation}`;
  const message = mailItem.internetMessageId?.trim() || mailItem.itemId?.trim();
  if (message) return `msg:${user}\n${message}`;
  return `mail:${user}\nunknown`;
}
