import { internalMutation, internalQuery, type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import { feishuFetch, FEISHU_BASE } from "./client";

export interface TokenRow {
  token: string;
  expiresAt: number;
}

export function selectFreshToken(
  row: TokenRow | null | undefined,
  now: number,
): string | null {
  return row && row.expiresAt > now ? row.token : null;
}

/**
 * Margin (ms) by which an already-stored token must out-live `now` for a
 * concurrent writer to treat it as "good enough" and skip its own write.
 * This is what collapses the token-refresh herd: once one writer commits a
 * fresh token, every other herd member re-reads on its OCC retry, sees the
 * fresh row, and returns without touching the table — so the stampede resolves
 * after a single write instead of N writers fighting over the same row. Kept
 * small relative to the ~1.5h token lifetime so a genuinely near-expiry token
 * is still refreshed rather than skipped.
 */
export const TOKEN_WRITE_SKIP_MARGIN_MS = 60_000;

export interface ExistingTokenRow<TId> {
  _id: TId;
  expiresAt: number;
}

export type TokenWritePlan<TId> =
  | { kind: "skip" }
  | { kind: "patch"; patchId: TId; deleteIds: TId[] }
  | { kind: "insert"; deleteIds: TId[] };

/**
 * Decide how storeToken should reconcile the singleton token row, given the
 * rows currently present. Pure so the herd-collapse logic is unit-testable
 * without a Convex ctx (extract-then-test seam, ADR-0018/0019).
 *
 * `existing` is the index-ordered row list (oldest first) — the same row a
 * reader's `.first()` would return is `existing[0]`. When that row is fresh
 * beyond `marginMs`, we skip. Otherwise we reuse it as the singleton (patch)
 * or insert a new one, pruning any legacy duplicates in the same write.
 */
export function planTokenWrite<TId>(
  existing: ReadonlyArray<ExistingTokenRow<TId>>,
  now: number,
  marginMs: number,
): TokenWritePlan<TId> {
  const [head, ...extras] = existing;
  if (head && head.expiresAt > now + marginMs) {
    return { kind: "skip" };
  }
  const deleteIds = extras.map((row) => row._id);
  return head
    ? { kind: "patch", patchId: head._id, deleteIds }
    : { kind: "insert", deleteIds };
}

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
    const existing = await ctx.db
      .query("feishuTokens")
      .withIndex("by_tokenType", (q) => q.eq("tokenType", "tenant_access_token"))
      .take(10);

    const plan = planTokenWrite(existing, Date.now(), TOKEN_WRITE_SKIP_MARGIN_MS);
    if (plan.kind === "skip") return;

    await Promise.all(plan.deleteIds.map((id) => ctx.db.delete(id)));
    if (plan.kind === "patch") {
      await ctx.db.patch(plan.patchId, {
        token: args.token,
        expiresAt: args.expiresAt,
      });
    } else {
      await ctx.db.insert("feishuTokens", {
        tokenType: "tenant_access_token" as const,
        token: args.token,
        expiresAt: args.expiresAt,
      });
    }
  },
});

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
