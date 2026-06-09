import type { MailItemData } from "../../office/useMailItem";

/**
 * Stable React identity for "which intake context is on screen" while a PINNED
 * task pane stays mounted across email switches (SupportsPinning). The mailbox
 * is part of the key because Outlook conversation ids are mailbox-local. Used as
 * the `key` on RequestIntakeScreenCore so that:
 *
 *  - moving to a DIFFERENT conversation thread changes the key → React remounts
 *    the intake tree → a clean slate (notes, customer, sales, attachments, sync
 *    screen, and every hook-local race-guard ref reset for free); and
 *  - navigating between sibling messages in the SAME thread keeps the key → the
 *    in-progress request survives (the unit of work is the conversation: the
 *    backend dedups one Base record per conversation thread — see
 *    convex/emailRecord.ts buildRequestSyncKey / getBitableSyncByConversation).
 *
 * Conversation-first is the deliberate choice (confirmed with product): `from`
 * is per-sender (two senders in one thread must NOT reset) and itemId /
 * internetMessageId are per-message (siblings must NOT reset), so neither can be
 * the primary key. The per-message ids are only a fallback for a degraded host
 * that omits conversationId; a final constant covers the (effectively
 * impossible) all-empty case. Pure and deterministic — no Date/random.
 */
export function deriveMailKey(
  mailItem: Pick<
    MailItemData,
    "conversationId" | "internetMessageId" | "itemId" | "userEmail"
  >,
): string {
  const user = mailItem.userEmail?.trim().toLowerCase() || "unknown-user";
  const conversation = mailItem.conversationId?.trim();
  if (conversation) return `conv:${user}\n${conversation}`;
  const message =
    mailItem.internetMessageId?.trim() || mailItem.itemId?.trim();
  if (message) return `msg:${user}\n${message}`;
  return `mail:${user}\nunknown`;
}
