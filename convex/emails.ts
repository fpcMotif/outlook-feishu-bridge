import {
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";
import { v } from "convex/values";

import { buildRequestSyncKey, emailRecordFields } from "./emailRecord";
import { shouldRearmStaleSync } from "./feishu/bitableSyncRetry";
import { shouldRearmAttachmentFill } from "./feishu/attachmentFill";
import { buildConfiguredBitableRecordDetailUrl } from "./feishu/bitableUrl";
import {
  findExistingEmailRecord,
  patchAbandonedBitableSync,
  runBeginBitableSync,
  runMarkBitableSyncFailed,
  runMarkBitableSyncSucceeded,
} from "./emailRecordLookup";
import {
  runListDueAttachmentFills,
  runListDueBitableSyncRecords,
  runMarkAttachmentsFailed,
  runMarkAttachmentsFilled,
  runRecordAttachmentProgress,
} from "./emailRecordFill";

export const storeEmailRecord = internalMutation({
  args: emailRecordFields,
  handler: async (ctx, args) => {
    await ctx.db.insert("emailRecords", {
      ...args,
      createdAt: Date.now(),
    });
  },
});

export const beginBitableSync = internalMutation({
  args: {
    ...emailRecordFields,
    bitableClientToken: v.string(),
  },
  handler: (ctx, args) => runBeginBitableSync(ctx, args),
});

export const abandonBitableSync = internalMutation({
  args: {
    internetMessageId: v.string(),
    requestSyncKey: v.optional(v.string()),
    error: v.string(),
    attemptedAt: v.number(),
  },
  handler: (ctx, args) => patchAbandonedBitableSync(ctx, args, args.error, args.attemptedAt),
});

export const markBitableSyncSucceeded = internalMutation({
  args: {
    internetMessageId: v.string(),
    requestSyncKey: v.optional(v.string()),
    bitableRecordId: v.string(),
    attemptedAt: v.number(),
  },
  handler: (ctx, args) => runMarkBitableSyncSucceeded(ctx, args),
});

export const markBitableSyncFailed = internalMutation({
  args: {
    internetMessageId: v.string(),
    requestSyncKey: v.optional(v.string()),
    error: v.string(),
    attemptedAt: v.number(),
  },
  handler: (ctx, args) => runMarkBitableSyncFailed(ctx, args),
});

// ===== Deferred Attachment Fill (ADR-0027) =====
// State the fill action reads each pass — including the freshness inputs the
// runtime fence asserts against and the REMAINING (un-minted) sources.
export const getAttachmentFillState = internalQuery({
  args: { internetMessageId: v.string(), requestSyncKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const existing = await findExistingEmailRecord(ctx, args);
    if (!existing) return null;
    return {
      bitableRecordId: existing.bitableRecordId ?? null,
      bitableClientToken: existing.bitableClientToken ?? null,
      bitableRowMintedAt: existing.bitableRowMintedAt ?? null,
      bitableAttachmentStatus: existing.bitableAttachmentStatus ?? null,
      remainingSources: existing.bitableAttachmentSources ?? [],
      fileTokens: existing.bitableAttachmentFileTokens ?? [],
    };
  },
});

// Persist one wave's outcome BEFORE the action deletes the staged blobs
// (persist-before-delete: Drive upload_all is not idempotent). Appends the
// minted tokens + skipped names, drops the completed sources from the remaining
// list (so a replay re-mints only the un-minted tail), and marks `filling`.
export const recordAttachmentProgress = internalMutation({
  args: {
    internetMessageId: v.string(),
    requestSyncKey: v.optional(v.string()),
    mintedTokens: v.array(v.string()),
    skippedNames: v.array(v.string()),
    completedStorageIds: v.array(v.string()),
  },
  handler: (ctx, args) => runRecordAttachmentProgress(ctx, args),
});

// Index-backed sweep of attachment fills that are stranded due (pending/filling/
// failed with a real next-retry in the past). Backs the manual reconcile (ADR-
// 0027) — the per-conversation rearm-on-reopen only fires when a user reopens, so
// this is the no-human-in-the-loop backstop. Returns ids the action re-drives.
export const listDueAttachmentFills = internalQuery({
  args: { now: v.number(), limit: v.optional(v.number()) },
  handler: (ctx, args) => runListDueAttachmentFills(ctx, args),
});

export const markAttachmentsFilled = internalMutation({
  args: { internetMessageId: v.string(), requestSyncKey: v.optional(v.string()) },
  handler: (ctx, args) => runMarkAttachmentsFilled(ctx, args),
});

// Terminal-or-retryable attachment failure. Reuses the bitable backoff shape;
// an undefined next-retry is the terminal sentinel (shouldRearmAttachmentFill /
// the sweep exclude it). Returns the delay so the action can self-reschedule.
export const markAttachmentsFailed = internalMutation({
  args: {
    internetMessageId: v.string(),
    requestSyncKey: v.optional(v.string()),
    error: v.string(),
    attemptedAt: v.number(),
  },
  handler: (ctx, args) => runMarkAttachmentsFailed(ctx, args),
});

export const listDueBitableSyncRecords = internalQuery({
  args: {
    now: v.number(),
    limit: v.optional(v.number()),
  },
  handler: (ctx, args) => runListDueBitableSyncRecords(ctx, args),
});

// Server-side re-check for the rearm-on-reopen self-heal: returns the stored
// backup ONLY when it is genuinely stranded (shouldRearmStaleSync), so the
// public rearm action can never be coaxed into re-driving a live/terminal row.
export const getRearmableOutboxRecord = internalQuery({
  args: {
    userEmail: v.string(),
    conversationId: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const requestSyncKey = buildRequestSyncKey(args.userEmail, args.conversationId);
    const existing = await findExistingEmailRecord(ctx, {
      requestSyncKey: requestSyncKey ?? undefined,
      userEmail: args.userEmail,
      conversationId: args.conversationId,
    });
    if (!existing) return null;
    // Two independent rearm modes: a stranded ROW create (no bitableRecordId yet)
    // vs a stranded ATTACHMENT fill on an already-created row. The create-side
    // predicate short-circuits once the row exists, so the attachment fill needs
    // its own (ADR-0027 gap-1).
    if (shouldRearmStaleSync(existing, args.now)) {
      return { mode: "sync" as const, record: existing };
    }
    if (shouldRearmAttachmentFill(existing, args.now)) {
      return {
        mode: "attachment" as const,
        internetMessageId: existing.internetMessageId,
        requestSyncKey: existing.requestSyncKey ?? null,
      };
    }
    return null;
  },
});

export const getByInternetMessageId = query({
  args: { internetMessageId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("emailRecords")
      .withIndex("by_internetMessageId", (q) =>
        q.eq("internetMessageId", args.internetMessageId),
      )
      .first();
  },
});

export const getBitableSyncByConversation = query({
  args: {
    userEmail: v.string(),
    conversationId: v.string(),
  },
  handler: async (ctx, args) => {
    const requestSyncKey = buildRequestSyncKey(args.userEmail, args.conversationId);
    if (!requestSyncKey) return null;
    const existing = await findExistingEmailRecord(ctx, {
      requestSyncKey,
      userEmail: args.userEmail,
      conversationId: args.conversationId,
    });
    if (!existing) return null;
    if (!existing.bitableRecordId) {
      // `abandoned` (terminal) collapses to the `failed` UI shape — both show a
      // terminal error, not a perpetual spinner. `rearmable` is the cron-free
      // self-heal cue: reopening a stranded task (action died / mark threw) lets
      // the taskpane re-arm its retry without any scheduled sweep.
      const terminalOrFailed =
        existing.bitableSyncStatus === "failed" || existing.bitableSyncStatus === "abandoned";
      return {
        status: terminalOrFailed ? ("failed" as const) : ("pending" as const),
        recordId: null,
        detailUrl: null,
        coworkerCount: existing.selectedCoworkers?.length ?? 0,
        syncedAt: existing.bitableLastAttemptAt ?? existing.createdAt,
        error: existing.bitableLastError ?? null,
        rearmable: shouldRearmStaleSync(existing, Date.now()),
        attachmentStatus: existing.bitableAttachmentStatus ?? null,
      };
    }
    // Row exists. It is `synced` even while attachments are still filling — the
    // attachment lifecycle is independent (ADR-0027); a stuck fill is rearmable.
    return {
      status: "synced" as const,
      recordId: existing.bitableRecordId,
      detailUrl: buildConfiguredBitableRecordDetailUrl(existing.bitableRecordId),
      coworkerCount: existing.selectedCoworkers?.length ?? 0,
      syncedAt: existing.bitableLastAttemptAt ?? existing.createdAt,
      error: null,
      rearmable: shouldRearmAttachmentFill(existing, Date.now()),
      attachmentStatus: existing.bitableAttachmentStatus ?? null,
    };
  },
});

// Internal-only debug helper (run via `bunx convex run`): the 20 most recent
// Email Record backups carry message PII, so this must never be public. No
// frontend caller.
export const listRecent = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("emailRecords").order("desc").take(20);
  },
});
