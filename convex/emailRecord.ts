// One source of truth for the shape of a persisted Email Record — the row the
// Bitable Sync writes after creating the Feishu row. The schema table, the storeEmailRecord
// mutation, and the sync action→record mapping all derive from here, so a new field
// is added in one place instead of three. Pure values + types only (no
// _generated/server import), so convex/schema.ts can import it without a cycle.

import { v, type Infer } from "convex/values";

// Legacy delivery metadata retained in the schema for existing Email Records.
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

// The Customer the salesperson confirmed (auto-matched or overridden via the
// Customer Picker — ADR-0013). Stored on the Email Record so the audit trail
// records the link without re-fetching Bitable. Optional — when null we
// either could not auto-match or the user chose to sync unlinked.
export const selectedCustomerValidator = v.object({
  recordId: v.string(),
  name: v.string(),
});

export type SelectedCustomer = Infer<typeof selectedCustomerValidator>;

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
  selectedCustomer: v.optional(selectedCustomerValidator),
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

// What Bitable Sync holds when it goes to persist.
export interface EmailRecordInput {
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
  requestSelections?: RequestSelection[];
  selectedCoworkers?: SelectedCoworker[];
  selectedCustomer?: SelectedCustomer;
}

// The Feishu handle produced during sync.
export interface EmailRecordResultIds {
  bitableRecordId?: string;
}

// Map a completed Bitable Sync onto the Email Record to persist. The only logic
// here is body→bodyPreview truncation plus the retired delivery flags staying
// false for schema compatibility — pure, no DB, no I/O, so it is unit-tested.
export function toEmailRecord(
  input: EmailRecordInput,
  ids: EmailRecordResultIds,
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
    sentToBot: false,
    sentToChat: false,
    sentToBitable: true,
    sentToContacts: undefined,
    sentToGroups: undefined,
    requestSelections: input.requestSelections,
    selectedCoworkers: input.selectedCoworkers,
    selectedCustomer: input.selectedCustomer,
    feishuMessageId: undefined,
    bitableRecordId: ids.bitableRecordId,
    pdfFileKey: undefined,
    attachmentFileKeys: undefined,
    feishuDocUrl: undefined,
    feishuDocToken: undefined,
  };
}
