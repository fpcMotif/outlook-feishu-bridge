import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { v } from "convex/values";
import {
  attachmentSourceValidator,
  initiatorValidator,
  selectedCoworkerValidator,
  selectedCustomerValidator,
  toEmailRecord,
  type AttachmentSource,
  type SelectedCoworker,
} from "../emailRecord";
import { assertRealCoworkerOpenIds, poisonedOutboxReason } from "./previewFixtures";
import { buildConfiguredBitableRecordDetailUrl } from "./bitableUrl";

// Shared intake submitted by the taskpane.
export const intakeArgs = {
  subject: v.string(),
  from: v.string(),
  to: v.array(v.string()),
  cc: v.array(v.string()),
  body: v.string(),
  internetMessageId: v.string(),
  itemId: v.optional(v.string()),
  conversationId: v.optional(v.string()),
  userEmail: v.optional(v.string()),
  dateTimeCreated: v.optional(v.number()),
  clientEmail: v.optional(v.string()),
  selectedCustomer: v.optional(selectedCustomerValidator),
  selectedSales: v.optional(initiatorValidator),
  initiator: v.optional(initiatorValidator),
  requestNote: v.optional(v.string()),
  // Legacy: pre-minted Drive tokens written on the create (the SPA flow before
  // ADR-0027). Kept for backward compat until the client sends attachmentSources.
  attachments: v.optional(v.array(v.object({ fileToken: v.string() }))),
  // ADR-0027: staged Convex blobs. The row is created with an empty Sales Files
  // cell and these are minted + filled by the deferred Attachment Fill.
  attachmentSources: v.optional(v.array(attachmentSourceValidator)),
  selectedCoworkers: v.optional(v.array(selectedCoworkerValidator)),
  // Upload-latency instrumentation: minted on the client at Submit-click and
  // threaded through so the server [fillTotal] log reports the true click→filled
  // duration (ADR-0027). Optional — an older client simply omits them.
  syncTraceId: v.optional(v.string()),
  submitClickedAt: v.optional(v.number()),
};

export const RECONCILE_LIMIT = 20;

export type SyncRequestResult =
  | { status: "pending"; recordId: null; detailUrl: null }
  | { status: "synced"; recordId: string; detailUrl: string | null };

export function newBitableClientToken(): string {
  return globalThis.crypto.randomUUID();
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function requireExactlyOneCoworker(coworkers: SelectedCoworker[] | undefined): SelectedCoworker[] {
  if (!coworkers || coworkers.length !== 1) {
    throw new Error("Bitable Sync requires exactly one Feishu coworker");
  }
  assertRealCoworkerOpenIds(coworkers);
  return coworkers;
}

export interface RequestSyncArgs {
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
  clientEmail?: string;
  selectedCustomer?: { recordId: string; name: string };
  selectedSales?: { openId: string; name?: string };
  initiator?: { openId: string; name?: string };
  requestNote?: string;
  attachments?: { fileToken: string }[];
  attachmentSources?: AttachmentSource[];
  selectedCoworkers?: SelectedCoworker[];
  syncTraceId?: string;
  submitClickedAt?: number;
}

export function buildEmailRecordBackup(args: RequestSyncArgs, sentToBitable: boolean) {
  return toEmailRecord(
    {
      subject: args.subject,
      from: args.from,
      clientEmail: args.clientEmail,
      to: args.to,
      cc: args.cc,
      body: args.body,
      internetMessageId: args.internetMessageId,
      itemId: args.itemId,
      conversationId: args.conversationId,
      userEmail: args.userEmail,
      dateTimeCreated: args.dateTimeCreated,
      requestNote: args.requestNote,
      selectedCoworkers: args.selectedCoworkers,
      selectedCustomer: args.selectedCustomer,
      initiator: args.selectedSales ?? args.initiator,
      attachmentSources: args.attachmentSources,
      syncTraceId: args.syncTraceId,
      submitClickedAt: args.submitClickedAt,
    },
    { sentToBitable },
  );
}

export function resolveSyncSales(args: RequestSyncArgs): RequestSyncArgs["selectedSales"] {
  return args.selectedSales ?? args.initiator;
}

export type BitableSyncFailureOutcome = { status: "failed" | "abandoned"; retryDelayMs: number | null };

export async function markFailure(
  ctx: ActionCtx,
  lookup: { internetMessageId: string; requestSyncKey?: string },
  e: unknown,
): Promise<BitableSyncFailureOutcome | null> {
  return await ctx.runMutation(internal.emails.markBitableSyncFailed, {
    internetMessageId: lookup.internetMessageId,
    requestSyncKey: lookup.requestSyncKey,
    error: errorMessage(e),
    attemptedAt: Date.now(),
  });
}

async function createServiceRow(
  ctx: ActionCtx,
  args: RequestSyncArgs,
  selectedCoworkers: SelectedCoworker[],
  clientToken: string,
): Promise<string> {
  const selectedSales = resolveSyncSales(args);
  const { recordId } = await ctx.runAction(internal.feishu.bitable.createServiceRecord, {
    subject: args.subject,
    clientEmail: args.clientEmail ?? args.from,
    clientRecordId: args.selectedCustomer?.recordId,
    dateOfOffer: args.dateTimeCreated,
    requestNote: args.requestNote,
    body: args.body,
    attachments: args.attachments,
    selectedCoworkers,
    selectedSales,
    initiator: selectedSales,
    emailConversationId: args.conversationId,
    clientToken,
  });
  return recordId;
}

export async function syncBitableRequest(
  ctx: ActionCtx,
  args: RequestSyncArgs,
  selectedCoworkers: SelectedCoworker[],
  clientToken: string,
): Promise<Extract<SyncRequestResult, { status: "synced" }>> {
  const backup = buildEmailRecordBackup({ ...args, selectedCoworkers }, false);
  const createdRecordId = await createServiceRow(ctx, args, selectedCoworkers, clientToken);
  const detailUrl = await markSuccess(ctx, backup, createdRecordId, clientToken);
  return { status: "synced", recordId: createdRecordId, detailUrl };
}

async function markSuccess(
  ctx: ActionCtx,
  backup: ReturnType<typeof buildEmailRecordBackup>,
  bitableRecordId: string,
  clientToken: string,
): Promise<string | null> {
  let detailUrl = buildConfiguredBitableRecordDetailUrl(bitableRecordId);
  try {
    const result: { detailUrl: string | null } = await ctx.runMutation(internal.emails.markBitableSyncSucceeded, {
      internetMessageId: backup.internetMessageId,
      requestSyncKey: backup.requestSyncKey,
      bitableRecordId,
      attemptedAt: Date.now(),
    });
    detailUrl = result.detailUrl;
  } catch (e: unknown) {
    // Case 2: the Base row exists but marking it synced failed, so the backup
    // stays `pending`. It self-heals on reopen (rearmable) — the replay re-runs
    // create under this same client_token, which dedups, then re-marks.
    console.error(
      `[requestSync] markBitableSyncSucceeded failed; Bitable row ${bitableRecordId} ` +
        `stays pending and re-arms on reopen with client_token ${clientToken}: ${errorMessage(e)}`,
    );
  }
  return detailUrl;
}

// Rebuild the sync action args from a stored backup. The full body is never
// persisted, so the ≤500-char preview rides as the body (ADR-0022); the stored
// initiator drives both Sales and initiator on the replayed Base row.
function storedRecordToSyncArgs(
  record: Doc<"emailRecords">,
  selectedCoworkers: SelectedCoworker[],
): RequestSyncArgs {
  return {
    subject: record.subject,
    from: record.from,
    to: record.to,
    cc: record.cc,
    body: record.bodyPreview,
    internetMessageId: record.internetMessageId,
    itemId: record.itemId,
    conversationId: record.conversationId,
    userEmail: record.userEmail,
    dateTimeCreated: record.dateTimeCreated,
    clientEmail: record.clientEmail,
    selectedCustomer: record.selectedCustomer,
    selectedSales: record.initiator,
    initiator: record.initiator,
    requestNote: record.requestNote,
    selectedCoworkers,
  };
}

// Replay one stored outbox backup against Feishu Base under its persisted
// idempotency token (create dedups on client_token). Poisoned rows are abandoned
// without a Base call. Shared by the manual reconcile backstop and the per-task
// rearm-on-reopen self-heal, so both recover a stranded row identically.
export async function replayStoredOutboxRecord(
  ctx: ActionCtx,
  record: Doc<"emailRecords">,
): Promise<"synced" | "failed"> {
  const poisonReason = poisonedOutboxReasonForRecord(record);
  if (poisonReason) {
    await ctx.runMutation(internal.emails.abandonBitableSync, {
      internetMessageId: record.internetMessageId,
      requestSyncKey: record.requestSyncKey,
      error: poisonReason,
      attemptedAt: Date.now(),
    });
    return "failed";
  }
  try {
    const selectedCoworkers = requireExactlyOneCoworker(record.selectedCoworkers);
    if (!record.bitableClientToken) {
      throw new Error(`Missing bitableClientToken for ${record.internetMessageId}`);
    }
    const result = await syncBitableRequest(
      ctx,
      storedRecordToSyncArgs(record, selectedCoworkers),
      selectedCoworkers,
      record.bitableClientToken,
    );
    return result.status;
  } catch (e: unknown) {
    await markFailure(ctx, record, e);
    return "failed";
  }
}

function poisonedOutboxReasonForRecord(record: Doc<"emailRecords">): string | null {
  return poisonedOutboxReason({
    internetMessageId: record.internetMessageId,
    conversationId: record.conversationId,
    selectedCoworkers: record.selectedCoworkers,
  });
}
