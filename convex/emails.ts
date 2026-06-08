import {
  internalMutation,
  internalQuery,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { v } from "convex/values";

import { internal } from "./_generated/api";
import { buildRequestSyncKey, emailRecordFields } from "./emailRecord";
import type { Doc } from "./_generated/dataModel";
import {
  BITABLE_NEXT_RETRY_MIN,
  isBitableSyncDue,
  planBitableSyncFailure,
  resolveBitableNextRetryAt,
  shouldRearmStaleSync,
} from "./feishu/bitableSyncRetry";
import { shouldRearmAttachmentFill } from "./feishu/attachmentFill";
import { buildConfiguredBitableRecordDetailUrl } from "./feishu/bitableUrl";
import { poisonedOutboxReason } from "./feishu/previewFixtures";

const RECONCILE_BATCH_LIMIT = 20;
const ERROR_PREVIEW_MAX = 500;

interface EmailRecordLookup {
  requestSyncKey?: string;
  internetMessageId?: string;
  userEmail?: string;
  conversationId?: string;
}

async function findExistingEmailRecord(
  ctx: QueryCtx | MutationCtx,
  lookup: EmailRecordLookup,
): Promise<Doc<"emailRecords"> | null> {
  if (lookup.requestSyncKey) {
    const bySyncKey = await ctx.db
      .query("emailRecords")
      .withIndex("by_requestSyncKey", (q) => q.eq("requestSyncKey", lookup.requestSyncKey))
      .first();
    if (bySyncKey) return bySyncKey;
  }

  const internetMessageId = lookup.internetMessageId;
  if (internetMessageId) {
    const byMessage = await ctx.db
      .query("emailRecords")
      .withIndex("by_internetMessageId", (q) => q.eq("internetMessageId", internetMessageId))
      .first();
    if (byMessage) return byMessage;
  }

  const normalizedEmail = lookup.userEmail?.trim().toLowerCase();
  const conversationId = lookup.conversationId?.trim();
  if (!normalizedEmail || !conversationId) return null;

  const candidates = await ctx.db
    .query("emailRecords")
    .withIndex("by_conversationId", (q) => q.eq("conversationId", conversationId))
    .order("desc")
    .take(20);
  return (
    candidates.find((record) => record.userEmail?.trim().toLowerCase() === normalizedEmail) ??
    null
  );
}

async function patchAbandonedBitableSync(
  ctx: MutationCtx,
  lookup: EmailRecordLookup,
  error: string,
  attemptedAt: number,
): Promise<void> {
  const existing = await findExistingEmailRecord(ctx, lookup);
  if (!existing) return;
  if (existing.bitableRecordId || existing.bitableSyncStatus === "synced") return;
  const attemptCount = (existing.bitableAttemptCount ?? 0) + 1;
  // Poison/abandon is terminal: a distinct `abandoned` status (not `failed` + an
  // undefined next-retry) so the row can never be re-selected as "due".
  await ctx.db.patch(existing._id, {
    bitableSyncStatus: "abandoned",
    bitableLastAttemptAt: attemptedAt,
    bitableLastError: error.slice(0, ERROR_PREVIEW_MAX),
    bitableAttemptCount: attemptCount,
    bitableNextRetryAt: undefined,
  });
}

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
  handler: async (ctx, args) => {
    const now = Date.now();
    const abandonReason = poisonedOutboxReason({
      internetMessageId: args.internetMessageId,
      conversationId: args.conversationId,
      selectedCoworkers: args.selectedCoworkers,
    });
    if (abandonReason) {
      await patchAbandonedBitableSync(ctx, args, abandonReason, now);
      const existing = await findExistingEmailRecord(ctx, args);
      return {
        bitableClientToken: existing?.bitableClientToken ?? args.bitableClientToken,
        bitableRecordId: null,
        detailUrl: null,
        shouldSchedule: false,
      };
    }

    const existing = await findExistingEmailRecord(ctx, args);
    const bitableClientToken = existing?.bitableClientToken ?? args.bitableClientToken;
    const shouldSchedule = !existing || existing.bitableSyncStatus === "failed";
    if (existing?.bitableRecordId) {
      return {
        bitableClientToken,
        bitableRecordId: existing.bitableRecordId,
        detailUrl: buildConfiguredBitableRecordDetailUrl(existing.bitableRecordId),
        shouldSchedule: false,
      };
    }

    // Deferred Attachment Fill (ADR-0027): if the intake carried staged sources,
    // arm the attachment lifecycle as `pending` so markBitableSyncSucceeded can
    // kick the fill once the row exists. No sources → no attachment lifecycle.
    const hasAttachmentSources = (args.bitableAttachmentSources?.length ?? 0) > 0;
    const recordFields = {
      ...args,
      bitableClientToken,
      bitableSyncStatus: "pending" as const,
      bitableNextRetryAt: now,
      bitableAttemptCount: existing?.bitableAttemptCount ?? 0,
      sentToBitable: args.sentToBitable,
      bitableAttachmentStatus: hasAttachmentSources ? ("pending" as const) : undefined,
      bitableAttachmentFileTokens: undefined,
      bitableAttachmentSkipped: undefined,
      attachmentAttemptCount: undefined,
      // Heartbeat clock: a `pending` fill is only rearmed once its next-retry
      // goes stale past the grace window, so arm it at `now`; the fill refreshes
      // it each wave, and a crashed fill stops refreshing → becomes rearmable.
      attachmentNextRetryAt: hasAttachmentSources ? now : undefined,
    };

    if (existing) {
      await ctx.db.patch(existing._id, recordFields);
      return { bitableClientToken, bitableRecordId: null, detailUrl: null, shouldSchedule };
    }

    await ctx.db.insert("emailRecords", {
      ...recordFields,
      createdAt: now,
    });
    return { bitableClientToken, bitableRecordId: null, detailUrl: null, shouldSchedule };
  },
});

export const abandonBitableSync = internalMutation({
  args: {
    internetMessageId: v.string(),
    requestSyncKey: v.optional(v.string()),
    error: v.string(),
    attemptedAt: v.number(),
  },
  handler: async (ctx, args) => {
    await patchAbandonedBitableSync(ctx, args, args.error, args.attemptedAt);
  },
});

export const markBitableSyncSucceeded = internalMutation({
  args: {
    internetMessageId: v.string(),
    requestSyncKey: v.optional(v.string()),
    bitableRecordId: v.string(),
    attemptedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await findExistingEmailRecord(ctx, args);
    if (!existing) {
      throw new Error(`No Email Record backup found for ${args.internetMessageId}`);
    }
    // Stamp the mint time once (the freshness clock for mayUpdateOwnedBitableRow).
    const bitableRowMintedAt = existing.bitableRowMintedAt ?? args.attemptedAt;
    await ctx.db.patch(existing._id, {
      bitableRecordId: args.bitableRecordId,
      sentToBitable: true,
      bitableSyncStatus: "synced",
      bitableLastAttemptAt: args.attemptedAt,
      bitableLastError: undefined,
      bitableNextRetryAt: undefined,
      bitableRowMintedAt,
    });
    // Kick the deferred Attachment Fill from INSIDE this mutation (ADR-0027), so
    // the scheduled fill is guaranteed to see the committed bitableRecordId +
    // bitableRowMintedAt that the runtime fence asserts against.
    const hasSources = (existing.bitableAttachmentSources?.length ?? 0) > 0;
    if (hasSources && existing.bitableAttachmentStatus !== "filled") {
      await ctx.scheduler.runAfter(0, internal.feishu.requestSync.fillRowAttachments, {
        internetMessageId: args.internetMessageId,
        requestSyncKey: args.requestSyncKey,
      });
    }
    return { detailUrl: buildConfiguredBitableRecordDetailUrl(args.bitableRecordId) };
  },
});

export const markBitableSyncFailed = internalMutation({
  args: {
    internetMessageId: v.string(),
    requestSyncKey: v.optional(v.string()),
    error: v.string(),
    attemptedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await findExistingEmailRecord(ctx, args);
    if (!existing) return null;
    if (existing.bitableRecordId || existing.bitableSyncStatus === "synced") return null;
    const attemptCount = (existing.bitableAttemptCount ?? 0) + 1;
    // The planner decides retry-vs-retire: `failed` + a future next-retry while
    // attempts remain, or terminal `abandoned` at MAX / on a permanent error.
    const plan = planBitableSyncFailure(attemptCount, args.attemptedAt, args.error);
    await ctx.db.patch(existing._id, {
      bitableSyncStatus: plan.status,
      bitableLastAttemptAt: args.attemptedAt,
      bitableLastError: args.error.slice(0, ERROR_PREVIEW_MAX),
      bitableAttemptCount: attemptCount,
      bitableNextRetryAt: plan.nextRetryAt,
    });
    // Convex values can't hold `undefined`; null tells the action the chain is
    // terminal. A numeric delay is the action's cue to self-schedule the next try.
    return { status: plan.status, retryDelayMs: plan.retryDelayMs ?? null };
  },
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
  handler: async (ctx, args) => {
    const existing = await findExistingEmailRecord(ctx, args);
    if (!existing) return;
    const completed = new Set(args.completedStorageIds);
    await ctx.db.patch(existing._id, {
      bitableAttachmentFileTokens: [
        ...(existing.bitableAttachmentFileTokens ?? []),
        ...args.mintedTokens,
      ],
      bitableAttachmentSkipped: [
        ...(existing.bitableAttachmentSkipped ?? []),
        ...args.skippedNames,
      ],
      bitableAttachmentSources: (existing.bitableAttachmentSources ?? []).filter(
        (s) => !completed.has(s.storageId),
      ),
      // Stay `pending` and refresh the heartbeat — an actively-progressing fill
      // keeps pushing its rearm clock forward; a crashed one goes stale.
      bitableAttachmentStatus: "pending",
      attachmentNextRetryAt: Date.now(),
    });
  },
});

export const markAttachmentsFilled = internalMutation({
  args: { internetMessageId: v.string(), requestSyncKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const existing = await findExistingEmailRecord(ctx, args);
    if (!existing) return;
    await ctx.db.patch(existing._id, {
      bitableAttachmentStatus: "filled",
      attachmentNextRetryAt: undefined,
    });
  },
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
  handler: async (ctx, args) => {
    const existing = await findExistingEmailRecord(ctx, args);
    if (!existing) return { retryDelayMs: null };
    const attemptCount = (existing.attachmentAttemptCount ?? 0) + 1;
    const nextRetryAt = resolveBitableNextRetryAt(attemptCount, args.attemptedAt, args.error);
    await ctx.db.patch(existing._id, {
      bitableAttachmentStatus: "failed",
      attachmentAttemptCount: attemptCount,
      attachmentNextRetryAt: nextRetryAt,
      bitableLastError: args.error.slice(0, ERROR_PREVIEW_MAX),
    });
    return { retryDelayMs: nextRetryAt === undefined ? null : nextRetryAt - args.attemptedAt };
  },
});

export const listDueBitableSyncRecords = internalQuery({
  args: {
    now: v.number(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = Math.min(
      Math.max(args.limit ?? RECONCILE_BATCH_LIMIT, 1),
      RECONCILE_BATCH_LIMIT,
    );
    // Lower-bound the range by BITABLE_NEXT_RETRY_MIN so the undefined "never
    // retry again" sentinel (which sorts below all numbers in a Convex index) is
    // excluded — otherwise exhausted / permanent-error rows stay forever "due"
    // and the reconcile cron retries them past MAX_BITABLE_SYNC_ATTEMPTS. The
    // index narrows; isBitableSyncDue is the authoritative (unit-tested) check.
    const takeForStatus = async (status: "pending" | "failed") => {
      const candidates = await ctx.db
        .query("emailRecords")
        .withIndex("by_bitableSyncStatus_and_bitableNextRetryAt", (q) =>
          q
            .eq("bitableSyncStatus", status)
            .gte("bitableNextRetryAt", BITABLE_NEXT_RETRY_MIN)
            .lte("bitableNextRetryAt", args.now),
        )
        .take(limit);
      return candidates.filter((record) =>
        isBitableSyncDue(record.bitableNextRetryAt, args.now),
      );
    };
    const pending = await takeForStatus("pending");
    if (pending.length >= limit) return pending.slice(0, limit);
    const failed = await takeForStatus("failed");
    return [...pending, ...failed].slice(0, limit);
  },
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

export const listRecent = query({
  handler: async (ctx) => {
    return await ctx.db.query("emailRecords").order("desc").take(20);
  },
});
