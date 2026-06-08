/* eslint-disable max-lines */
// Orchestration hub for the Base Sync pending process (outbox enqueue → deferred
// create → reconcile). It legitimately runs past the 300-line cap, like its
// sibling bitable.ts — the per-function limit still applies.
import { action, internalAction, type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { v, type Infer } from "convex/values";
import { initiatorValidator, selectedCoworkerValidator, selectedCustomerValidator, toEmailRecord, type SelectedCoworker } from "../emailRecord";
import { assertRealCoworkerOpenIds, poisonedOutboxReason } from "./previewFixtures";
import { buildConfiguredBitableRecordDetailUrl } from "./bitableUrl";

// Shared intake submitted by the taskpane.
const intakeArgs = {
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
  attachments: v.optional(v.array(v.object({ fileToken: v.string() }))),
  selectedCoworkers: v.optional(v.array(selectedCoworkerValidator)),
};

const RECONCILE_LIMIT = 20;

type SyncRequestResult =
  | { status: "pending"; recordId: null; detailUrl: null }
  | { status: "synced"; recordId: string; detailUrl: string | null };

function newBitableClientToken(): string {
  return globalThis.crypto.randomUUID();
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function requireExactlyOneCoworker(coworkers: SelectedCoworker[] | undefined): SelectedCoworker[] {
  if (!coworkers || coworkers.length !== 1) {
    throw new Error("Bitable Sync requires exactly one Feishu coworker");
  }
  assertRealCoworkerOpenIds(coworkers);
  return coworkers;
}

// Internal mirror of the public `intakeArgs` — derived so the two cannot drift.
// Threaded through the helpers below; the Email Record keeps the `initiator`
// audit while the Base row receives the single resolved `sales` (CONTEXT).
type RequestSyncArgs = Infer<ReturnType<typeof v.object<typeof intakeArgs>>>;

function buildEmailRecordBackup(args: RequestSyncArgs, sentToBitable: boolean) {
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
    },
    { sentToBitable },
  );
}

function resolveSyncSales(args: RequestSyncArgs): RequestSyncArgs["selectedSales"] {
  return args.selectedSales ?? args.initiator;
}

async function markFailure(
  ctx: ActionCtx,
  lookup: { internetMessageId: string; requestSyncKey?: string },
  e: unknown,
) {
  await ctx.runMutation(internal.emails.markBitableSyncFailed, {
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
  const { recordId } = await ctx.runAction(internal.feishu.bitable.createServiceRecord, {
    subject: args.subject,
    clientEmail: args.clientEmail ?? args.from,
    clientRecordId: args.selectedCustomer?.recordId,
    dateOfOffer: args.dateTimeCreated,
    requestNote: args.requestNote,
    body: args.body,
    attachments: args.attachments,
    selectedCoworkers,
    sales: resolveSyncSales(args),
    emailConversationId: args.conversationId,
    clientToken,
  });
  return recordId;
}

async function syncBitableRequest(
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
    console.error(
      `[requestSync] markBitableSyncSucceeded failed; Bitable row ${bitableRecordId} ` +
        `will be reconciled with client_token ${clientToken}: ${errorMessage(e)}`,
    );
  }
  return detailUrl;
}

export const processPendingBitableSync = internalAction({
  args: { ...intakeArgs, clientToken: v.string() },
  handler: async (ctx, args): Promise<Extract<SyncRequestResult, { status: "synced" }>> => {
    const selectedCoworkers = requireExactlyOneCoworker(args.selectedCoworkers);
    try {
      return await syncBitableRequest(ctx, args, selectedCoworkers, args.clientToken);
    } catch (e: unknown) {
      const backup = buildEmailRecordBackup({ ...args, selectedCoworkers }, false);
      await markFailure(ctx, backup, e);
      throw e;
    }
  },
});

export const syncRequest = action({
  args: intakeArgs,
  handler: async (ctx, args): Promise<SyncRequestResult> => {
    const selectedCoworkers = requireExactlyOneCoworker(args.selectedCoworkers);
    const backup = buildEmailRecordBackup({ ...args, selectedCoworkers }, false);
    const poisonReason = poisonedOutboxReason({
      internetMessageId: args.internetMessageId,
      conversationId: args.conversationId,
      selectedCoworkers,
    });
    if (poisonReason) {
      await ctx.runMutation(internal.emails.abandonBitableSync, {
        internetMessageId: backup.internetMessageId,
        requestSyncKey: backup.requestSyncKey,
        error: poisonReason,
        attemptedAt: Date.now(),
      });
      throw new Error(poisonReason);
    }
    const beginResult: { bitableClientToken: string; bitableRecordId: string | null; detailUrl: string | null; shouldSchedule: boolean } =
      await ctx.runMutation(internal.emails.beginBitableSync, {
        ...backup,
        bitableClientToken: newBitableClientToken(),
      });
    if (beginResult.bitableRecordId) {
      return {
        status: "synced",
        recordId: beginResult.bitableRecordId,
        detailUrl: beginResult.detailUrl,
      };
    }

    if (beginResult.shouldSchedule) {
      try {
        await ctx.scheduler.runAfter(0, internal.feishu.requestSync.processPendingBitableSync, {
          ...args,
          selectedCoworkers,
          clientToken: beginResult.bitableClientToken,
        });
      } catch (e: unknown) {
        await markFailure(ctx, backup, e);
        throw e;
      }
    }
    return { status: "pending", recordId: null, detailUrl: null };
  },
});

// Rebuild the sync intake from a stored outbox row. The reconcile path can only
// replay what the Email Record kept: the ≤500-char body preview (not the full
// body) and the `initiator` audit as the Sales identity; attachments were never
// persisted on the backup, so a reconciled row carries none (ADR-0022).
function reconcileRecordToSyncArgs(
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
    requestNote: record.requestNote,
    selectedCoworkers,
  };
}

// Replay one due outbox row: abandon it if poisoned, else (re)create its Base row
// with the stored client_token. Never throws — a failure is marked and counted so
// one bad row can't abort the whole reconcile batch.
async function reconcileOneRecord(
  ctx: ActionCtx,
  record: Doc<"emailRecords">,
): Promise<"synced" | "failed"> {
  const poisonReason = poisonedOutboxReason({
    internetMessageId: record.internetMessageId,
    conversationId: record.conversationId,
    selectedCoworkers: record.selectedCoworkers,
  });
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
      reconcileRecordToSyncArgs(record, selectedCoworkers),
      selectedCoworkers,
      record.bitableClientToken,
    );
    return result.status;
  } catch (e: unknown) {
    await markFailure(ctx, record, e);
    return "failed";
  }
}

export const reconcilePendingBitableSync = internalAction({
  args: {},
  handler: async (ctx): Promise<{ checked: number; synced: number; failed: number }> => {
    const due = await ctx.runQuery(internal.emails.listDueBitableSyncRecords, { now: Date.now(), limit: RECONCILE_LIMIT });
    const outcomes = await Promise.all(due.map((record) => reconcileOneRecord(ctx, record)));
    const synced = outcomes.filter((o) => o === "synced").length;
    const failed = outcomes.filter((o) => o === "failed").length;
    if (due.length > 0) {
      console.log(
        `[requestSync] reconcilePendingBitableSync checked=${due.length} synced=${synced} failed=${failed}`,
      );
    }
    return { checked: due.length, synced, failed };
  },
});

export const correctRequest = action({
  args: { recordId: v.string(), ...intakeArgs },
  handler: async (ctx, args): Promise<{ recordId: string; detailUrl: string | null }> => {
    const selectedCoworkers = requireExactlyOneCoworker(args.selectedCoworkers);
    const { recordId } = await ctx.runAction(internal.feishu.bitable.correctServiceRecord, {
      recordId: args.recordId,
      subject: args.subject,
      clientEmail: args.clientEmail ?? args.from,
      clientRecordId: args.selectedCustomer?.recordId,
      dateOfOffer: args.dateTimeCreated,
      requestNote: args.requestNote,
      body: args.body,
      attachments: args.attachments,
      selectedCoworkers,
      sales: resolveSyncSales(args),
      emailConversationId: args.conversationId,
    });
    return { recordId, detailUrl: buildConfiguredBitableRecordDetailUrl(recordId) };
  },
});
