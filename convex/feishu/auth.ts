import { internalMutation, internalQuery, type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import { feishuFetch, FEISHU_BASE } from "./client";

/** Minimal shape of a cached-token row this module reasons about. */
export interface TokenRow {
  token: string;
  expiresAt: number;
}

/**
 * Pure selector for the cached-token freshness rule: return the row's token
 * only when it is still valid ({@code expiresAt > now}); otherwise null.
 * Extracted from {@link getCachedToken} so the rule is unit-testable.
 */
export function selectFreshToken(
  row: TokenRow | null | undefined,
  now: number,
): string | null {
  if (row && row.expiresAt > now) {
    return row.token;
  }
  return null;
}

/**
 * Pure helper for {@link storeToken}'s prune step: return the ids of ALL rows
 * to delete before inserting the fresh token (no `.take(n)` cap — every stale
 * row is dropped). Extracted so the "delete all" rule is unit-testable.
 */
export function pruneTokenRows<TId>(rows: ReadonlyArray<{ _id: TId }>): TId[] {
  return rows.map((row) => row._id);
}

// The two REGISTERED Convex functions below (getCachedToken / storeToken) need a
// live runtime; their pure rules — selectFreshToken, pruneTokenRows above — are
// unit-tested, and getTenantAccessToken below is tested with a fake ctx (ADR-0018).
/* v8 ignore start */
export const getCachedToken = internalQuery({
  args: {},
  handler: async (ctx) => {
    const cached = await ctx.db.query("feishuTokens").first();
    return selectFreshToken(cached, Date.now());
  },
});

export const storeToken = internalMutation({
  args: { token: v.string(), expiresAt: v.number() },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("feishuTokens").take(10);
    await Promise.all(
      pruneTokenRows(existing).map((id) => ctx.db.delete(id)),
    );
    await ctx.db.insert("feishuTokens", {
      tokenType: "tenant_access_token" as const,
      token: args.token,
      expiresAt: args.expiresAt,
    });
  },
});
/* v8 ignore stop */

/** Shared helper — call directly from any action, no ctx.runAction needed. */
export async function getTenantAccessToken(ctx: ActionCtx): Promise<string> {
  const cached: string | null = await ctx.runQuery(
    internal.feishu.auth.getCachedToken,
  );
  if (cached) return cached;

  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error("FEISHU_APP_ID and FEISHU_APP_SECRET must be set");
  }

  const data = await feishuFetch<{ tenant_access_token: string; expire: number }>({
    url: `${FEISHU_BASE}/auth/v3/tenant_access_token/internal`,
    label: "Feishu auth",
    json: { app_id: appId, app_secret: appSecret },
  });

  const expiresAt = Date.now() + (data.expire - 300) * 1000;

  await ctx.runMutation(internal.feishu.auth.storeToken, {
    token: data.tenant_access_token,
    expiresAt,
  });

  return data.tenant_access_token;
}
