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
  // Terminal: retries exhausted (MAX attempts) or a permanent/poison error. A
  // distinct status — not `failed` + an undefined next-retry — so termination is
  // enforced by status, never by the fragile "undefined sorts lowest" index trick.
  v.literal("abandoned"),
);

// ADR-0022 (deferred attachment fill): a staged Convex blob handed to the server
// to mint a Feishu Drive token from, AFTER the row is created. storageId is an
// OPAQUE string, not v.id('_storage') — the staged blob is deleted once minted /
// GC'd, so a real FK on this long-lived row would dangle (dead-source = skipped).
export const attachmentSourceValidator = v.object({
  storageId: v.string(),
  fileName: v.string(),
});

export type AttachmentSource = Infer<typeof attachmentSourceValidator>;

// Lifecycle of the deferred attachment fill — INDEPENDENT of bitableSyncStatus.
// The row exists (synced) the moment it is created with an empty Sales Files
// cell; attachments are then filled in the background. pending → filling →
// filled, or failed (retryable until exhausted, then terminal via undefined
// attachmentNextRetryAt).
export const bitableAttachmentStatusValidator = v.union(
  v.literal("pending"),
  v.literal("filling"),
  v.literal("filled"),
  v.literal("failed"),
);

export type BitableAttachmentStatus = Infer<typeof bitableAttachmentStatusValidator>;

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
  feishuDocUrl: v.optional(v.string()),
  feishuDocToken: v.optional(v.string()),
  bitableClientToken: v.optional(v.string()),
  bitableSyncStatus: v.optional(bitableSyncStatusValidator),
  bitableLastError: v.optional(v.string()),
  bitableLastAttemptAt: v.optional(v.number()),
  bitableAttemptCount: v.optional(v.number()),
  bitableNextRetryAt: v.optional(v.number()),
  // When THIS flow minted the Bitable row (set on first create success). The
  // freshness clock for mayUpdateOwnedBitableRow — bounds the deferred
  // attachment patch so it can never touch an ancient/historical row.
  bitableRowMintedAt: v.optional(v.number()),
  // Deferred attachment fill (ADR-0022 amendment). Its own lifecycle, separate
  // from bitableSyncStatus, so a stuck fill on an already-created row is still
  // recoverable (the create-side rearm short-circuits once bitableRecordId is set).
  bitableAttachmentSources: v.optional(v.array(attachmentSourceValidator)),
  bitableAttachmentStatus: v.optional(bitableAttachmentStatusValidator),
  // Cumulative file_tokens minted so far — persisted BEFORE the PUT so a mid-fill
  // crash replays the same tokens (Drive upload_all is NOT idempotent) and the
  // "partial insert" PUT re-writes the same cumulative cell.
  bitableAttachmentFileTokens: v.optional(v.array(v.string())),
  // fileNames that could not be attached (dead/GC'd source, >20MB, exhausted).
  bitableAttachmentSkipped: v.optional(v.array(v.string())),
  attachmentAttemptCount: v.optional(v.number()),
  attachmentNextRetryAt: v.optional(v.number()),
  // Upload-latency instrumentation (click → fully-written). `syncTraceId` is
  // minted on the client at Submit-click and threaded through so every server
  // fill log line can be correlated back to one submit. `submitClickedAt` is the
  // CLIENT wall clock at click; `syncReceivedAt` is the SERVER wall clock when the
  // sync mutation first armed the row; `attachmentsFilledAt` is stamped when the
  // deferred fill fences `filled`. The [fillTotal] log (markAttachmentsFilled)
  // derives the click→filled duration from these. All optional — older rows lack
  // them and read as null spans.
  syncTraceId: v.optional(v.string()),
  submitClickedAt: v.optional(v.number()),
  syncReceivedAt: v.optional(v.number()),
  attachmentsFilledAt: v.optional(v.number()),
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
  // Staged Convex blobs for the deferred Attachment Fill (ADR-0027) — persisted
  // on the backup so the server can mint Drive tokens after the user leaves.
  attachmentSources?: AttachmentSource[];
  // Upload-latency instrumentation: trace id minted at Submit-click + the client
  // wall-clock click time, threaded through so the server [fillTotal] log can
  // report the true click→fully-written duration (the server-stamped legs are set
  // by beginBitableSync / markAttachmentsFilled, not carried from the client).
  syncTraceId?: string;
  submitClickedAt?: number;
}

// The Feishu handle produced during sync.
export interface EmailRecordResultIds {
  bitableRecordId?: string;
  sentToBitable?: boolean;
}

// The fields a freshly-synced Email Record never carries: the retired delivery
// metadata (bot/chat/contacts/groups + Feishu doc + per-category selections) and
// the lifecycle legs that the fill/sync mutations stamp later, not the client.
// A module-level constant so the mapping below stays under the per-function line
// cap; the values are exactly what the inline literal held.
const EMPTY_EMAIL_RECORD_LIFECYCLE = {
  sentToBot: false,
  sentToChat: false,
  sentToContacts: undefined,
  sentToGroups: undefined,
  // ADR-0022: new rows no longer populate the per-category selections; the
  // field stays in the schema only for historical rows.
  requestSelections: undefined,
  feishuMessageId: undefined,
  pdfFileKey: undefined,
  attachmentFileKeys: undefined,
  feishuDocUrl: undefined,
  feishuDocToken: undefined,
  bitableClientToken: undefined,
  bitableSyncStatus: undefined,
  bitableLastError: undefined,
  bitableLastAttemptAt: undefined,
  bitableAttemptCount: undefined,
  bitableNextRetryAt: undefined,
  bitableRowMintedAt: undefined,
  // Sources ride the backup; the rest of the attachment lifecycle is set by
  // the fill mutations (beginBitableSync arms the status when sources exist).
  bitableAttachmentStatus: undefined,
  bitableAttachmentFileTokens: undefined,
  bitableAttachmentSkipped: undefined,
  attachmentAttemptCount: undefined,
  attachmentNextRetryAt: undefined,
  // Client-minted trace + click time ride the backup; the server-stamped legs
  // (syncReceivedAt, attachmentsFilledAt) are set later by the sync/fill
  // mutations, never carried from the client.
  syncReceivedAt: undefined,
  attachmentsFilledAt: undefined,
} satisfies Partial<EmailRecord>;

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
    sentToBitable: ids.sentToBitable ?? true,
    requestNote: input.requestNote,
    selectedCoworkers: input.selectedCoworkers,
    selectedCustomer: input.selectedCustomer,
    initiator: input.initiator,
    bitableRecordId: ids.bitableRecordId,
    bitableAttachmentSources: input.attachmentSources,
    syncTraceId: input.syncTraceId,
    submitClickedAt: input.submitClickedAt,
    ...EMPTY_EMAIL_RECORD_LIFECYCLE,
  };
}
