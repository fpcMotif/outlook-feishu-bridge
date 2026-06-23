import { action, internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import { poisonedOutboxReason } from "./previewFixtures";
import { buildConfiguredBitableRecordDetailUrl } from "./bitableUrl";
import { assertWithinAttachmentCap } from "./attachmentLimits";
import { driveUploadConcurrency } from "./drive";
import { resolveFeishuToken } from "./call";
import {
  buildEmailRecordBackup,
  intakeArgs,
  markFailure,
  newBitableClientToken,
  RECONCILE_LIMIT,
  replayStoredOutboxRecord,
  requireExactlyOneCoworker,
  resolveSyncSales,
  syncBitableRequest,
  type SyncRequestResult,
} from "./requestSyncCore";
import { runAttachmentFillWaves } from "./requestSyncFill";

// Re-exported here so consumers (tests, harness) can keep importing it from the
// registered-function module while the implementation lives in requestSyncCore.
export { requireExactlyOneCoworker };

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
    // Server backstop for the attachment-count cap (the validator only checks
    // element shape, not array length). Rejects an over-cap batch BEFORE any Base
    // row is created — mirrors the client MAX_ATTACHMENT_COUNT via ATTACHMENT_CAP.
    assertWithinAttachmentCap(args);
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

// Manual backstop only — NO LONGER on a cron. Run via `bunx convex run
// feishu/requestSync:reconcilePendingBitableSync` to sweep any rows the per-task
// chain + rearm-on-reopen somehow missed. Day-to-day recovery is per-task.
export const reconcilePendingBitableSync = internalAction({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ checked: number; synced: number; failed: number; attachmentFills: number }> => {
    const now = Date.now();
    const due = await ctx.runQuery(internal.emails.listDueBitableSyncRecords, { now, limit: RECONCILE_LIMIT });
    // Serialize: never fire multiple Bitable creates in parallel — Feishu QPS
    // budget is small and a burst of N rows triggers 1254290 TooManyRequest.
    const outcomes: ("synced" | "failed")[] = [];
    for (const record of due) {
      // eslint-disable-next-line react-doctor/async-await-in-loop -- deliberate serialisation to respect Feishu QPS
      outcomes.push(await replayStoredOutboxRecord(ctx, record));
    }
    const synced = outcomes.filter((o) => o === "synced").length;
    const failed = outcomes.filter((o) => o === "failed").length;
    // Backstop the deferred Attachment Fill too (ADR-0027): re-drive any fill that
    // is stranded-due, for the no-human-in-the-loop case the per-conversation
    // rearm-on-reopen can't reach. fillRowAttachments is idempotent + fenced.
    const dueFills = await ctx.runQuery(internal.emails.listDueAttachmentFills, { now, limit: RECONCILE_LIMIT });
    await Promise.all(
      dueFills.map((f) =>
        ctx.scheduler.runAfter(0, internal.feishu.requestSync.fillRowAttachments, {
          internetMessageId: f.internetMessageId,
          requestSyncKey: f.requestSyncKey ?? undefined,
        }),
      ),
    );
    if (due.length > 0 || dueFills.length > 0) {
      console.log(
        `[requestSync] reconcile checked=${due.length} synced=${synced} failed=${failed} attachmentFills=${dueFills.length}`,
      );
    }
    return { checked: due.length, synced, failed, attachmentFills: dueFills.length };
  },
});

// Deferred Attachment Fill (ADR-0027). Kicked from markBitableSyncSucceeded once
// the row exists, and re-driven by rearm-on-reopen. Processes the REMAINING
// staged sources in waves of `driveUploadConcurrency` (bounded ≤5 under the
// 5 QPS budget): each wave mints concurrently, persists tokens BEFORE deleting
// blobs (upload_all is not idempotent), then coalesces into ONE cumulative
// Sales Files PUT (fenced). Transient Drive failures defer to a bounded retry;
// dead/oversize sources are permanently skipped. The row already exists, so a
// stuck fill never affects the synced status — it just leaves a fillable cell.
export const fillRowAttachments = internalAction({
  args: { internetMessageId: v.string(), requestSyncKey: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ filled: number; skipped: number; deferred: number }> => {
    const lookup = { internetMessageId: args.internetMessageId, requestSyncKey: args.requestSyncKey };
    const state = await ctx.runQuery(internal.emails.getAttachmentFillState, lookup);
    if (!state || !state.bitableRecordId || state.bitableAttachmentStatus === "filled") {
      return { filled: 0, skipped: 0, deferred: 0 };
    }
    if (state.remainingSources.length === 0) {
      await ctx.runMutation(internal.emails.markAttachmentsFilled, lookup);
      return { filled: 0, skipped: 0, deferred: 0 };
    }
    const appToken = process.env.FEISHU_BITABLE_APP_TOKEN;
    if (!appToken) throw new Error("FEISHU_BITABLE_APP_TOKEN must be set");
    const tenantToken = await resolveFeishuToken(ctx, "tenant");
    const concurrency = driveUploadConcurrency();

    const { filled, skipped, deferred, lastError } = await runAttachmentFillWaves(
      ctx,
      state,
      lookup,
      { appToken, tenantToken },
      concurrency,
    );

    if (deferred > 0 || lastError) {
      const reason = lastError ?? `${deferred} attachment(s) deferred (transient Drive failure)`;
      const outcome = await ctx.runMutation(internal.emails.markAttachmentsFailed, {
        ...lookup,
        error: reason,
        attemptedAt: Date.now(),
      });
      if (typeof outcome?.retryDelayMs === "number") {
        await ctx.scheduler.runAfter(outcome.retryDelayMs, internal.feishu.requestSync.fillRowAttachments, lookup);
      }
    } else {
      await ctx.runMutation(internal.emails.markAttachmentsFilled, lookup);
    }
    return { filled, skipped, deferred };
  },
});

// Per-task self-heal (cron-free backstop). The taskpane calls this when it
// reopens a conversation whose outbox row is stranded (`rearmable`, see
// emails.getBitableSyncByConversation). The query re-checks staleness server-
// side, so this can only re-drive a genuinely stuck row, idempotently. Two
// modes: a stranded ROW create replays the outbox; a stranded ATTACHMENT fill
// re-drives fillRowAttachments (ADR-0027).
export const rearmConversationSync = action({
  args: { userEmail: v.string(), conversationId: v.string() },
  handler: async (ctx, args): Promise<{ rearmed: boolean }> => {
    const result = await ctx.runQuery(internal.emails.getRearmableOutboxRecord, {
      userEmail: args.userEmail,
      conversationId: args.conversationId,
      now: Date.now(),
    });
    if (!result) return { rearmed: false };
    if (result.mode === "sync") {
      await replayStoredOutboxRecord(ctx, result.record);
      return { rearmed: true };
    }
    await ctx.scheduler.runAfter(0, internal.feishu.requestSync.fillRowAttachments, {
      internetMessageId: result.internetMessageId,
      requestSyncKey: result.requestSyncKey ?? undefined,
    });
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
