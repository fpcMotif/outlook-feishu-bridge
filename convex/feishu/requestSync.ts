import { action, internalAction, type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { v } from "convex/values";
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

interface RequestSyncArgs {
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
  selectedCoworkers?: SelectedCoworker[];
}

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

type BitableSyncFailureOutcome = { status: "failed" | "abandoned"; retryDelayMs: number | null };

async function markFailure(
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

export const processPendingBitableSync = internalAction({
  args: { ...intakeArgs, clientToken: v.string() },
  handler: async (ctx, args): Promise<Extract<SyncRequestResult, { status: "synced" }>> => {
    const selectedCoworkers = requireExactlyOneCoworker(args.selectedCoworkers);
    try {
      return await syncBitableRequest(ctx, args, selectedCoworkers, args.clientToken);
    } catch (e: unknown) {
      const backup = buildEmailRecordBackup({ ...args, selectedCoworkers }, false);
      const outcome = await markFailure(ctx, backup, e);
      // Per-task bounded retry (replaces the 15-min reconcile sweep): re-enqueue
      // ourselves at the planner's backoff under the SAME idempotency token, so
      // the Feishu create dedups on replay. A null delay means terminal — the
      // chain stops here, capped at MAX_BITABLE_SYNC_ATTEMPTS.
      if (typeof outcome?.retryDelayMs === "number") {
        await ctx.scheduler.runAfter(
          outcome.retryDelayMs,
          internal.feishu.requestSync.processPendingBitableSync,
          args,
        );
      }
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
async function replayStoredOutboxRecord(
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

// Manual backstop only — NO LONGER on a cron. Run via `bunx convex run
// feishu/requestSync:reconcilePendingBitableSync` to sweep any rows the per-task
// chain + rearm-on-reopen somehow missed. Day-to-day recovery is per-task.
export const reconcilePendingBitableSync = internalAction({
  args: {},
  handler: async (ctx): Promise<{ checked: number; synced: number; failed: number }> => {
    const due = await ctx.runQuery(internal.emails.listDueBitableSyncRecords, { now: Date.now(), limit: RECONCILE_LIMIT });
    const outcomes = await Promise.all(due.map((record) => replayStoredOutboxRecord(ctx, record)));
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

// Per-task self-heal (cron-free backstop). The taskpane calls this when it
// reopens a conversation whose outbox row is stranded (`rearmable`, see
// emails.getBitableSyncByConversation). The query re-checks staleness server-
// side, so this can only re-drive a genuinely stuck row, idempotently.
export const rearmConversationSync = action({
  args: { userEmail: v.string(), conversationId: v.string() },
  handler: async (ctx, args): Promise<{ rearmed: boolean }> => {
    const record = await ctx.runQuery(internal.emails.getRearmableOutboxRecord, {
      userEmail: args.userEmail,
      conversationId: args.conversationId,
      now: Date.now(),
    });
    if (!record) return { rearmed: false };
    await replayStoredOutboxRecord(ctx, record);
    return { rearmed: true };
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
      selectedSales: resolveSyncSales(args),
      initiator: resolveSyncSales(args),
      emailConversationId: args.conversationId,
    });
    return { recordId, detailUrl: buildConfiguredBitableRecordDetailUrl(recordId) };
  },
});
