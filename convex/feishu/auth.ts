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

// `feishuTokens` holds exactly ONE canonical row — the current tenant access
// token. `storeToken` enforces that invariant. `StoreTokenPlan` is the pure
// decision `storeToken` applies to whatever rows it finds; it is extracted so it
// can be unit-tested without the Convex runtime (the registered handler is
// v8-ignored, ADR-0019).
export type StoreTokenPlan<TId> =
  | { action: "skip"; deleteIds: TId[] }
  | { action: "patch"; target: TId; deleteIds: TId[] }
  | { action: "insert"; deleteIds: TId[] };

/**
 * Decide how a freshly-fetched tenant token should be written, given the rows
 * currently in `feishuTokens`.
 *
 * Why this exists (ADR-0031): the Feishu tenant token expires ~every 2h, and
 * `getTenantAccessToken` runs on every tenant-authed call (`call.ts`), so a cold
 * cache triggers a refresh *burst* — N concurrent actions each fetch a token and
 * each call `storeToken`. The original body deleted every row and inserted a new
 * one, so each store changed the table's contents and concurrent stores always
 * OCC-conflicted on `feishuTokens` ("storeToken vs Self" Insight, ~weekly).
 *
 * This planner collapses the burst to a single effective write:
 *   - If a still-fresh row already exists, a peer refresh already won
 *     (first-committer-wins): skip our write and drop any stragglers. A loser's
 *     OCC retry re-reads the now-fresh row and lands here as a read-only no-op,
 *     so it settles in ONE retry instead of cascading.
 *   - Otherwise replace ONE canonical row IN PLACE (stable `_id`) and prune the
 *     rest, so even two simultaneous cold-cache writers contend on a single
 *     document that Convex's automatic OCC retry resolves cleanly.
 *
 * It does not make a truly-simultaneous first collision vanish — it converts an
 * unbounded delete/insert churn into immediate single-row convergence.
 */
export function planTokenStore<TId>(
  rows: ReadonlyArray<{ _id: TId; expiresAt: number }>,
  now: number,
): StoreTokenPlan<TId> {
  // Keep the longest-lived still-fresh row, if any — deterministic regardless of
  // table scan order (the table is unindexed), and maximises validity headroom.
  let freshest: { _id: TId; expiresAt: number } | null = null;
  for (const row of rows) {
    if (row.expiresAt > now && (freshest === null || row.expiresAt > freshest.expiresAt)) {
      freshest = row;
    }
  }
  if (freshest) {
    return {
      action: "skip",
      deleteIds: rows.filter((row) => row._id !== freshest._id).map((row) => row._id),
    };
  }
  // Every cached row is stale (or none exist): replace one in place with the
  // freshly-fetched token and prune the rest back to a single canonical row.
  const [keep, ...extra] = rows;
  const deleteIds = extra.map((row) => row._id);
  return keep
    ? { action: "patch", target: keep._id, deleteIds }
    : { action: "insert", deleteIds };
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
    // `now` MUST be read here (not hoisted) so the writer's freshness clock
    // matches getCachedToken's reader clock above.
    const rows = await ctx.db.query("feishuTokens").take(10);
    const plan = planTokenStore(rows, Date.now());
    await Promise.all(plan.deleteIds.map((id) => ctx.db.delete(id)));
    if (plan.action === "patch") {
      await ctx.db.patch(plan.target, { token: args.token, expiresAt: args.expiresAt });
    } else if (plan.action === "insert") {
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

  // Caching is best-effort. We already hold a valid token to return, so a failed
  // store — e.g. an OCC write-conflict that survives Convex's auto-retries under
  // a refresh burst — must NOT fail the caller's Feishu call; the next caller
  // simply refreshes again. Secret-safe: logs the reason, never the token value.
  try {
    await ctx.runMutation(internal.feishu.auth.storeToken, {
      token: data.tenant_access_token,
      expiresAt,
    });
  } catch (err) {
    console.warn(
      `[auth] tenant token cache write failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return data.tenant_access_token;
}
