import { internalMutation, internalQuery, query } from "./_generated/server";
import { v } from "convex/values";

import { emailRecordFields } from "./emailRecord";

const RECONCILE_BATCH_LIMIT = 20;
const ERROR_PREVIEW_MAX = 500;

function nextRetryAt(attemptCount: number, attemptedAt: number): number {
  const minutes = attemptCount <= 1 ? 5 : attemptCount === 2 ? 15 : 60;
  return attemptedAt + minutes * 60_000;
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
    const existing = await ctx.db
      .query("emailRecords")
      .withIndex("by_internetMessageId", (q) =>
        q.eq("internetMessageId", args.internetMessageId),
      )
      .first();
    const bitableClientToken = existing?.bitableClientToken ?? args.bitableClientToken;
    const bitableRecordId = existing?.bitableRecordId ?? null;
    const recordFields = {
      ...args,
      bitableClientToken,
      bitableSyncStatus: bitableRecordId ? ("synced" as const) : ("pending" as const),
      bitableNextRetryAt: bitableRecordId ? undefined : now,
      bitableAttemptCount: existing?.bitableAttemptCount ?? 0,
      sentToBitable: bitableRecordId ? true : args.sentToBitable,
    };

    if (existing) {
      await ctx.db.patch(existing._id, recordFields);
      return { bitableClientToken, bitableRecordId };
    }

    await ctx.db.insert("emailRecords", {
      ...recordFields,
      createdAt: now,
    });
    return { bitableClientToken, bitableRecordId };
  },
});

export const markBitableSyncSucceeded = internalMutation({
  args: {
    internetMessageId: v.string(),
    bitableRecordId: v.string(),
    attemptedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("emailRecords")
      .withIndex("by_internetMessageId", (q) =>
        q.eq("internetMessageId", args.internetMessageId),
      )
      .first();
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
    });
  },
});

export const markBitableSyncFailed = internalMutation({
  args: {
    internetMessageId: v.string(),
    error: v.string(),
    attemptedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("emailRecords")
      .withIndex("by_internetMessageId", (q) =>
        q.eq("internetMessageId", args.internetMessageId),
      )
      .first();
    if (!existing) return;
    const attemptCount = (existing.bitableAttemptCount ?? 0) + 1;
    await ctx.db.patch(existing._id, {
      bitableSyncStatus: "failed",
      bitableLastAttemptAt: args.attemptedAt,
      bitableLastError: args.error.slice(0, ERROR_PREVIEW_MAX),
      bitableAttemptCount: attemptCount,
      bitableNextRetryAt: nextRetryAt(attemptCount, args.attemptedAt),
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

export const listRecent = query({
  handler: async (ctx) => {
    return await ctx.db.query("emailRecords").order("desc").take(20);
  },
});
