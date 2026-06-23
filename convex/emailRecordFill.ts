import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import {
  BITABLE_NEXT_RETRY_MIN,
  isBitableSyncDue,
  resolveBitableNextRetryAt,
} from "./feishu/bitableSyncRetry";
import { buildFillTotal } from "./feishu/attachmentFill";
import {
  ERROR_PREVIEW_MAX,
  RECONCILE_BATCH_LIMIT,
  findExistingEmailRecord,
} from "./emailRecordLookup";

interface AttachmentProgressArgs {
  internetMessageId: string;
  requestSyncKey?: string;
  mintedTokens: string[];
  skippedNames: string[];
  completedStorageIds: string[];
}

export async function runRecordAttachmentProgress(
  ctx: MutationCtx,
  args: AttachmentProgressArgs,
): Promise<void> {
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
    // Mark `filling` and refresh the heartbeat — an actively-progressing fill
    // keeps pushing its rearm clock forward (so it is never double-driven); a
    // crashed one goes stale past the grace window and becomes rearmable.
    bitableAttachmentStatus: "filling",
    attachmentNextRetryAt: Date.now(),
  });
}

interface DueLookup {
  now: number;
  limit?: number;
}

export async function runListDueAttachmentFills(
  ctx: QueryCtx,
  args: DueLookup,
): Promise<{ internetMessageId: string; requestSyncKey?: string }[]> {
  const limit = Math.min(Math.max(args.limit ?? RECONCILE_BATCH_LIMIT, 1), RECONCILE_BATCH_LIMIT);
  // The three non-terminal statuses index independently — query them in
  // parallel (one indexed read each) rather than a sequential scan.
  const perStatus = await Promise.all(
    (["pending", "filling", "failed"] as const).map((status) =>
      ctx.db
        .query("emailRecords")
        .withIndex("by_attachmentStatus_and_attachmentNextRetryAt", (q) =>
          q
            .eq("bitableAttachmentStatus", status)
            .gte("attachmentNextRetryAt", BITABLE_NEXT_RETRY_MIN)
            .lte("attachmentNextRetryAt", args.now),
        )
        .take(limit),
    ),
  );
  const due: { internetMessageId: string; requestSyncKey?: string }[] = [];
  for (const row of perStatus.flat()) {
    // Only rows that actually have a created Base row + remaining work.
    if (row.bitableRecordId && (row.bitableAttachmentSources?.length ?? 0) > 0) {
      due.push({ internetMessageId: row.internetMessageId, requestSyncKey: row.requestSyncKey });
    }
  }
  return due.slice(0, limit);
}

interface MarkAttachmentsFilledArgs {
  internetMessageId: string;
  requestSyncKey?: string;
}

export async function runMarkAttachmentsFilled(
  ctx: MutationCtx,
  args: MarkAttachmentsFilledArgs,
): Promise<void> {
  const existing = await findExistingEmailRecord(ctx, args);
  if (!existing) return;
  const filledAt = Date.now();
  await ctx.db.patch(existing._id, {
    bitableAttachmentStatus: "filled",
    attachmentNextRetryAt: undefined,
    attachmentsFilledAt: existing.attachmentsFilledAt ?? filledAt,
  });
  // One structured, grep-able line measuring the TRUE click→fully-written
  // latency — the per-Feishu-call logs cannot, because the client pane is long
  // gone by the time the deferred fill fences. Surfaces in `bunx convex logs`
  // as `[fillTotal] … totalMs=…` (buildFillTotal reads the tokens/skips that
  // recordAttachmentProgress already persisted before this fence).
  console.log(buildFillTotal(existing, filledAt).line);
}

interface MarkAttachmentsFailedArgs {
  internetMessageId: string;
  requestSyncKey?: string;
  error: string;
  attemptedAt: number;
}

export async function runMarkAttachmentsFailed(
  ctx: MutationCtx,
  args: MarkAttachmentsFailedArgs,
): Promise<{ retryDelayMs: number | null }> {
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
}

export async function runListDueBitableSyncRecords(
  ctx: QueryCtx,
  args: DueLookup,
): Promise<Doc<"emailRecords">[]> {
  const limit = Math.min(Math.max(args.limit ?? RECONCILE_BATCH_LIMIT, 1), RECONCILE_BATCH_LIMIT);
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
    return candidates.filter((record) => isBitableSyncDue(record.bitableNextRetryAt, args.now));
  };
  const pending = await takeForStatus("pending");
  if (pending.length >= limit) return pending.slice(0, limit);
  const failed = await takeForStatus("failed");
  return [...pending, ...failed].slice(0, limit);
}
