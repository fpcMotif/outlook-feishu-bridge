// One source of truth for the shape of a persisted Email Record — the row the
// Forward pipeline writes after sending. The schema table, the storeEmailRecord
// mutation, and the action→record mapping all derive from here, so a new field
// is added in one place instead of three. Pure values + types only (no
// _generated/server import), so convex/schema.ts can import it without a cycle.

import { v, type Infer } from "convex/values";

// The attachment as handed to Feishu: one fileKey + display name + whether it is
// an image or a generic file. Shared by the messaging path, the forward action,
// and the persisted record.
export const attachmentKeyValidator = v.object({
  fileKey: v.string(),
  fileName: v.string(),
  type: v.union(v.literal("file"), v.literal("image")),
});

export type AttachmentKey = Infer<typeof attachmentKeyValidator>;

// A single request the sender filled in (Quotation / Sample / R&D Support) plus
// its free-text note, and the Feishu coworker chosen as the Bitable assignee.
export const requestSelectionValidator = v.object({
  requestType: v.string(),
  note: v.string(),
});

export type RequestSelection = Infer<typeof requestSelectionValidator>;

export const selectedCoworkerValidator = v.object({
  openId: v.string(),
  name: v.string(),
  avatarUrl: v.optional(v.string()),
});

export type SelectedCoworker = Infer<typeof selectedCoworkerValidator>;

// Persisted fields of an Email Record (everything except the server-stamped
// `createdAt`, which the table adds). Spread into defineTable and reused verbatim
// as the storeEmailRecord args, so the table and the mutation cannot drift.
export const emailRecordFields = {
  subject: v.string(),
  from: v.string(),
  to: v.array(v.string()),
  cc: v.array(v.string()),
  bodyPreview: v.string(),
  internetMessageId: v.string(),
  itemId: v.optional(v.string()),
  conversationId: v.optional(v.string()),
  userEmail: v.optional(v.string()),
  dateTimeCreated: v.optional(v.number()),
  sentToBot: v.boolean(),
  sentToChat: v.boolean(),
  sentToBitable: v.boolean(),
  sentToContacts: v.optional(v.array(v.string())),
  sentToGroups: v.optional(v.array(v.string())),
  requestSelections: v.optional(v.array(requestSelectionValidator)),
  selectedCoworkers: v.optional(v.array(selectedCoworkerValidator)),
  feishuMessageId: v.optional(v.string()),
  bitableRecordId: v.optional(v.string()),
  pdfFileKey: v.optional(v.string()),
  attachmentFileKeys: v.optional(v.array(attachmentKeyValidator)),
  feishuDocUrl: v.optional(v.string()),
  feishuDocToken: v.optional(v.string()),
};

export const emailRecordValidator = v.object(emailRecordFields);
export type EmailRecord = Infer<typeof emailRecordValidator>;

// First 500 chars of the body are stored as the preview; the full body is never
// persisted (it rode to the action only to render the card + this preview).
const BODY_PREVIEW_MAX = 500;

// What the forward action already holds when it goes to persist. A structural
// subset of the action args — extra transport fields (sessionId, pdfBytes, …) are
// simply ignored.
export interface ForwardRecordInput {
  subject: string;
  from: string;
  to: string[];
  cc: string[];
  body: string;
  internetMessageId: string;
  itemId?: string;
  conversationId?: string;
  userEmail?: string;
  dateTimeCreated?: number;
  targets: { bot: boolean; chat: boolean; bitable: boolean };
  contacts?: string[];
  groups?: string[];
  requestSelections?: RequestSelection[];
  selectedCoworkers?: SelectedCoworker[];
  attachmentFileKeys?: AttachmentKey[];
  feishuDocUrl?: string;
  feishuDocToken?: string;
}

// The Feishu handles produced during dispatch.
export interface ForwardResultIds {
  feishuMessageId?: string;
  bitableRecordId?: string;
}

// Map a completed forward (input + dispatch results + the uploaded PDF key) onto
// the Email Record to persist. The only logic here is the body→bodyPreview
// truncation and the targets→sentTo* / contacts→sentToContacts flattening — pure,
// no DB, no I/O, so it is unit-tested directly.
export function toEmailRecord(
  input: ForwardRecordInput,
  ids: ForwardResultIds,
  pdfFileKey?: string,
): EmailRecord {
  return {
    subject: input.subject,
    from: input.from,
    to: input.to,
    cc: input.cc,
    bodyPreview: input.body.slice(0, BODY_PREVIEW_MAX),
    internetMessageId: input.internetMessageId,
    itemId: input.itemId,
    conversationId: input.conversationId,
    userEmail: input.userEmail,
    dateTimeCreated: input.dateTimeCreated,
    sentToBot: input.targets.bot,
    sentToChat: input.targets.chat,
    sentToBitable: input.targets.bitable,
    sentToContacts: input.contacts,
    sentToGroups: input.groups,
    requestSelections: input.requestSelections,
    selectedCoworkers: input.selectedCoworkers,
    feishuMessageId: ids.feishuMessageId,
    bitableRecordId: ids.bitableRecordId,
    pdfFileKey,
    attachmentFileKeys: input.attachmentFileKeys,
    feishuDocUrl: input.feishuDocUrl,
    feishuDocToken: input.feishuDocToken,
  };
}
