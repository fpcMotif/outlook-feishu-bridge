import {
  internalMutation,
  internalQuery,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { v } from "convex/values";

import { buildRequestSyncKey, emailRecordFields } from "./emailRecord";
import type { Doc } from "./_generated/dataModel";
import { resolveBitableNextRetryAt } from "./feishu/bitableSyncRetry";
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
  await ctx.db.patch(existing._id, {
    bitableSyncStatus: "failed",
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

    const recordFields = {
      ...args,
      bitableClientToken,
      bitableSyncStatus: "pending" as const,
      bitableNextRetryAt: now,
      bitableAttemptCount: existing?.bitableAttemptCount ?? 0,
      sentToBitable: args.sentToBitable,
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
    await ctx.db.patch(existing._id, {
      bitableRecordId: args.bitableRecordId,
      sentToBitable: true,
      bitableSyncStatus: "synced",
      bitableLastAttemptAt: args.attemptedAt,
      bitableLastError: undefined,
      bitableNextRetryAt: undefined,
      bitableAttachmentSources: undefined,
    });
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
    if (!existing) return;
    if (existing.bitableRecordId || existing.bitableSyncStatus === "synced") return;
    const attemptCount = (existing.bitableAttemptCount ?? 0) + 1;
    await ctx.db.patch(existing._id, {
      bitableSyncStatus: "failed",
      bitableLastAttemptAt: args.attemptedAt,
      bitableLastError: args.error.slice(0, ERROR_PREVIEW_MAX),
      bitableAttemptCount: attemptCount,
      bitableNextRetryAt: resolveBitableNextRetryAt(attemptCount, args.attemptedAt, args.error),
    });
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
    const takeForStatus = async (status: "pending" | "failed") =>
      await ctx.db
        .query("emailRecords")
        .withIndex("by_bitableSyncStatus_and_bitableNextRetryAt", (q) =>
          q.eq("bitableSyncStatus", status).lte("bitableNextRetryAt", args.now),
        )
        .take(limit);
    const pending = await takeForStatus("pending");
    if (pending.length >= limit) return pending.slice(0, limit);
    const failed = await takeForStatus("failed");
    return [...pending, ...failed].slice(0, limit);
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
      return {
        status: existing.bitableSyncStatus === "failed" ? ("failed" as const) : ("pending" as const),
        recordId: null,
        detailUrl: null,
        coworkerCount: existing.selectedCoworkers?.length ?? 0,
        syncedAt: existing.bitableLastAttemptAt ?? existing.createdAt,
        error: existing.bitableLastError ?? null,
      };
    }
    return {
      status: "synced" as const,
      recordId: existing.bitableRecordId,
      detailUrl: buildConfiguredBitableRecordDetailUrl(existing.bitableRecordId),
      coworkerCount: existing.selectedCoworkers?.length ?? 0,
      syncedAt: existing.bitableLastAttemptAt ?? existing.createdAt,
      error: null,
    };
  },
});

export const listRecent = query({
  handler: async (ctx) => {
    return await ctx.db.query("emailRecords").order("desc").take(20);
  },
});
