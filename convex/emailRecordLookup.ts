import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import type { EmailRecord } from "./emailRecord";
import {
  type BitableSyncFailureStatus,
  planBitableSyncFailure,
} from "./feishu/bitableSyncRetry";
import { buildConfiguredBitableRecordDetailUrl } from "./feishu/bitableUrl";
import { poisonedOutboxReason } from "./feishu/previewFixtures";

export const RECONCILE_BATCH_LIMIT = 20;
export const ERROR_PREVIEW_MAX = 500;

export interface EmailRecordLookup {
  requestSyncKey?: string;
  internetMessageId?: string;
  userEmail?: string;
  conversationId?: string;
}

export async function findExistingEmailRecord(
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

export async function patchAbandonedBitableSync(
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

type BeginBitableSyncArgs = EmailRecord & { bitableClientToken: string };

interface BeginBitableSyncResult {
  bitableClientToken: string;
  bitableRecordId: string | null;
  detailUrl: string | null;
  shouldSchedule: boolean;
}

export async function runBeginBitableSync(
  ctx: MutationCtx,
  args: BeginBitableSyncArgs,
): Promise<BeginBitableSyncResult> {
  const now = Date.now();
  const abandonReason = poisonedOutboxReason({
    internetMessageId: args.internetMessageId,
    conversationId: args.conversationId,
    selectedCoworkers: args.selectedCoworkers,
  });
  if (abandonReason) {
    return await abandonBeginBitableSync(ctx, args, abandonReason, now);
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

  await armBitableSync(ctx, args, existing, bitableClientToken, now);
  return { bitableClientToken, bitableRecordId: null, detailUrl: null, shouldSchedule };
}

// Arm a fresh or retried sync: build the `pending` record fields (stamping the
// click→filled span clock once and the attachment lifecycle when sources exist)
// then patch the existing backup or insert a new one.
async function armBitableSync(
  ctx: MutationCtx,
  args: BeginBitableSyncArgs,
  existing: Doc<"emailRecords"> | null,
  bitableClientToken: string,
  now: number,
): Promise<void> {
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
    // Server-stamped start of the click→filled span; set once on first arm so a
    // retry/reopen never resets the clock (the client-minted submitClickedAt +
    // syncTraceId ride in via ...args).
    syncReceivedAt: existing?.syncReceivedAt ?? now,
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
    return;
  }

  await ctx.db.insert("emailRecords", {
    ...recordFields,
    createdAt: now,
  });
}

async function abandonBeginBitableSync(
  ctx: MutationCtx,
  args: BeginBitableSyncArgs,
  abandonReason: string,
  now: number,
): Promise<BeginBitableSyncResult> {
  await patchAbandonedBitableSync(ctx, args, abandonReason, now);
  const existing = await findExistingEmailRecord(ctx, args);
  return {
    bitableClientToken: existing?.bitableClientToken ?? args.bitableClientToken,
    bitableRecordId: null,
    detailUrl: null,
    shouldSchedule: false,
  };
}

interface MarkSucceededArgs {
  internetMessageId: string;
  requestSyncKey?: string;
  bitableRecordId: string;
  attemptedAt: number;
}

export async function runMarkBitableSyncSucceeded(
  ctx: MutationCtx,
  args: MarkSucceededArgs,
): Promise<{ detailUrl: string | null }> {
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
  // [syncTotal]: click → row synced — the SyncScreen's server-side span,
  // mirroring [fillTotal] for the deferred-fill tail. clickToSynced uses the
  // client-minted submitClickedAt; armToSynced is the server-internal create.
  const syncedAt = args.attemptedAt;
  const clickToSyncedMs = existing.submitClickedAt ? syncedAt - existing.submitClickedAt : null;
  const armToSyncedMs = existing.syncReceivedAt ? syncedAt - existing.syncReceivedAt : null;
  console.log(
    `[syncTotal] trace=${existing.syncTraceId ?? "—"} recordId=${args.bitableRecordId} ` +
      `clickToSynced=${clickToSyncedMs ?? "?"}ms armToSynced=${armToSyncedMs ?? "?"}ms`,
  );
  return { detailUrl: buildConfiguredBitableRecordDetailUrl(args.bitableRecordId) };
}

interface MarkFailedArgs {
  internetMessageId: string;
  requestSyncKey?: string;
  error: string;
  attemptedAt: number;
}

export async function runMarkBitableSyncFailed(
  ctx: MutationCtx,
  args: MarkFailedArgs,
): Promise<{ status: BitableSyncFailureStatus; retryDelayMs: number | null } | null> {
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
}
