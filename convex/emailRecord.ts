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

// The signed-in Feishu user who clicked Sync — the Initiator (ADR-0014).
// Distinct from selectedCoworkers (the assignee). Mirrored onto the Bitable
// Service row's `Sales` (User) column.
export const initiatorValidator = v.object({
  openId: v.string(),
  name: v.optional(v.string()),
});

export type Initiator = Infer<typeof initiatorValidator>;

export const bitableSyncStatusValidator = v.union(
  v.literal("pending"),
  v.literal("synced"),
  v.literal("failed"),
);

export type BitableSyncStatus = Infer<typeof bitableSyncStatusValidator>;

export function buildRequestSyncKey(
  userEmail: string | undefined,
  conversationId: string | undefined,
): string | null {
  const normalizedEmail = userEmail?.trim().toLowerCase() ?? "";
  const normalizedConversationId = conversationId?.trim() ?? "";
  if (!normalizedEmail || !normalizedConversationId) return null;
  return `${normalizedEmail}\n${normalizedConversationId}`;
}

// Persisted fields of an Email Record (everything except the server-stamped
// `createdAt`, which the table adds). Spread into defineTable and reused verbatim
// as the storeEmailRecord args, so the table and the mutation cannot drift.
export const emailRecordFields = {
  subject: v.string(),
  from: v.string(),
  clientEmail: v.optional(v.string()),
  to: v.array(v.string()),
  cc: v.array(v.string()),
  bodyPreview: v.string(),
  internetMessageId: v.string(),
  itemId: v.optional(v.string()),
  conversationId: v.optional(v.string()),
  userEmail: v.optional(v.string()),
  requestSyncKey: v.optional(v.string()),
  dateTimeCreated: v.optional(v.number()),
  sentToBot: v.boolean(),
  sentToChat: v.boolean(),
  sentToBitable: v.boolean(),
  sentToContacts: v.optional(v.array(v.string())),
  sentToGroups: v.optional(v.array(v.string())),
  // ADR-0022: the salesperson's single consolidated note. Replaces the per-
  // category requestSelections on new rows; requestSelections stays optional
  // below only so historical Email Records still validate.
  requestNote: v.optional(v.string()),
  requestSelections: v.optional(v.array(requestSelectionValidator)),
  selectedCoworkers: v.optional(v.array(selectedCoworkerValidator)),
  selectedCustomer: v.optional(selectedCustomerValidator),
  initiator: v.optional(initiatorValidator),
  feishuMessageId: v.optional(v.string()),
  bitableRecordId: v.optional(v.string()),
  pdfFileKey: v.optional(v.string()),
  attachmentFileKeys: v.optional(v.array(attachmentKeyValidator)),
  // ADR-0022 / #35: Feishu Drive file_tokens minted by uploadAttachmentsToDrive
  // before the Base write. Persisted so the reconcile retry re-attaches them
  // instead of re-creating the row file-less (the legacy attachmentFileKeys above
  // is a different {fileKey,fileName,type} shape and is unused on new rows).
  attachmentFileTokens: v.optional(v.array(v.object({ fileToken: v.string() }))),
  feishuDocUrl: v.optional(v.string()),
  feishuDocToken: v.optional(v.string()),
  bitableClientToken: v.optional(v.string()),
  bitableSyncStatus: v.optional(bitableSyncStatusValidator),
  bitableLastError: v.optional(v.string()),
  bitableLastAttemptAt: v.optional(v.number()),
  bitableAttemptCount: v.optional(v.number()),
  bitableNextRetryAt: v.optional(v.number()),
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
  clientEmail?: string;
  to: string[];
  cc: string[];
  body: string;
  internetMessageId: string;
  itemId?: string;
  conversationId?: string;
  userEmail?: string;
  dateTimeCreated?: number;
  // ADR-0022: single consolidated note (replaces requestSelections as the input).
  requestNote?: string;
  selectedCoworkers?: SelectedCoworker[];
  selectedCustomer?: SelectedCustomer;
  initiator?: Initiator;
  // ADR-0022: Drive file_tokens minted before the Base write, persisted so the
  // reconcile retry path can re-attach them.
  attachments?: { fileToken: string }[];
}

// The Feishu handle produced during sync.
export interface EmailRecordResultIds {
  bitableRecordId?: string;
  sentToBitable?: boolean;
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
    clientEmail: input.clientEmail,
    to: input.to,
    cc: input.cc,
    bodyPreview: input.body.slice(0, BODY_PREVIEW_MAX),
    internetMessageId: input.internetMessageId,
    itemId: input.itemId,
    conversationId: input.conversationId,
    userEmail: input.userEmail,
    requestSyncKey: buildRequestSyncKey(input.userEmail, input.conversationId) ?? undefined,
    dateTimeCreated: input.dateTimeCreated,
    sentToBot: false,
    sentToChat: false,
    sentToBitable: ids.sentToBitable ?? true,
    sentToContacts: undefined,
    sentToGroups: undefined,
    requestNote: input.requestNote,
    // ADR-0022: new rows no longer populate the per-category selections; the
    // field stays in the schema only for historical rows.
    requestSelections: undefined,
    selectedCoworkers: input.selectedCoworkers,
    selectedCustomer: input.selectedCustomer,
    initiator: input.initiator,
    feishuMessageId: undefined,
    bitableRecordId: ids.bitableRecordId,
    pdfFileKey: undefined,
    attachmentFileKeys: undefined,
    attachmentFileTokens: input.attachments,
    feishuDocUrl: undefined,
    feishuDocToken: undefined,
    bitableClientToken: undefined,
    bitableSyncStatus: undefined,
    bitableLastError: undefined,
    bitableLastAttemptAt: undefined,
    bitableAttemptCount: undefined,
    bitableNextRetryAt: undefined,
  };
}
