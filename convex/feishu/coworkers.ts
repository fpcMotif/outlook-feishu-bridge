/* eslint-disable max-lines */
import {
  action,
  internalMutation,
  internalQuery,
  query as convexQuery,
  type ActionCtx,
  type QueryCtx,
} from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import { callFeishu, resolveFeishuToken } from "./call";

const COWORKER_SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const COWORKER_SEARCH_CACHE_MAX_ENTRIES_PER_SESSION = 24;
const MIN_COWORKER_SEARCH_LENGTH = 2;
const COWORKER_SEARCH_CACHE_CLEANUP_BATCH_SIZE = 200;

// Search Users response (open.feishu.cn GET /open-apis/search/v1/user): each
// user carries open_id, name, and usually an `avatar` object of sized URLs.
// Some tenants/API responses omit avatar_72 but include a larger avatar size,
// so the projection below falls back through the available Feishu avatar fields.
// `user_id` is only returned with contact:user.employee_id:readonly, which we
// don't request — Bitable Sync assigns Coworkers by open_id. See ADR-0003.
export interface FeishuUser {
  open_id: string;
  name: string;
  avatar?: {
    avatar_72?: string;
    avatar_240?: string;
    avatar_640?: string;
    avatar_origin?: string;
  };
  avatar_url?: string;
  department_ids?: string[];
}

export interface Coworker {
  openId: string;
  name: string;
  avatarUrl?: string;
}

export function coworkerAvatarUrl(u: FeishuUser): string | undefined {
  return (
    u.avatar?.avatar_72 ??
    u.avatar?.avatar_240 ??
    u.avatar?.avatar_640 ??
    u.avatar?.avatar_origin ??
    u.avatar_url
  );
}

export function mapFeishuUserToCoworker(u: FeishuUser): Coworker {
  return {
    openId: u.open_id,
    name: u.name,
    avatarUrl: coworkerAvatarUrl(u),
  };
}

export function mapCoworkers(data: { users?: FeishuUser[] }): Coworker[] {
  return (data.users ?? []).map((u) => mapFeishuUserToCoworker(u));
}

function normalizeCoworkerQuery(query: string): string {
  return query.trim();
}

function makeCacheLookupQuery(query: string): string {
  return normalizeCoworkerQuery(query).toLowerCase();
}

function isCacheFresh(cachedAt: number, now: number, ttlMs: number): boolean {
  return now - cachedAt <= ttlMs;
}

async function getFreshCoworkerCacheEntry(
  ctx: QueryCtx,
  sessionId: string,
  searchText: string,
): Promise<{ cachedAt: number; results: Coworker[] } | null> {
  const normalized = makeCacheLookupQuery(searchText);
  const [hit] = await ctx.db
    .query("coworkerSearchCache")
    .withIndex("by_session_query", (q) =>
      q.eq("sessionId", sessionId).eq("query", normalized),
    )
    .order("desc")
    .take(1);
  if (hit === undefined) return null;
  if (!isCacheFresh(hit.cachedAt, Date.now(), hit.ttlMs)) return null;
  return { cachedAt: hit.cachedAt, results: hit.results };
}

function logCoworkerAvatarDiagnostics(users: FeishuUser[], coworkers: Coworker[]) {
  const avatarKeys = new Set<string>();
  for (const user of users) {
    for (const key of Object.keys(user.avatar ?? {})) avatarKeys.add(key);
    if (user.avatar_url) avatarKeys.add("avatar_url");
  }
  const withAvatar = coworkers.filter((coworker) => Boolean(coworker.avatarUrl)).length;
  console.log(
    `[coworkers] Search Users returned users=${users.length} avatars=${withAvatar} avatarKeys=${[
      ...avatarKeys,
    ].join(",") || "none"}`,
  );
}

export const getCachedCoworkerSearch = internalQuery({
  args: {
    sessionId: v.string(),
    query: v.string(),
  },
  handler: async (ctx, args): Promise<{ cachedAt: number; results: Coworker[] } | null> => {
    const normalized = makeCacheLookupQuery(args.query);
    const cached = await getFreshCoworkerCacheEntry(ctx, args.sessionId, normalized);
    if (!cached) {
      console.log(`[coworkers] cache miss/stale session=${args.sessionId} q="${normalized.slice(0, 40)}"`);
      return null;
    }
    return cached;
  },
});

export const searchCoworkersCached = convexQuery({
  args: {
    sessionId: v.string(),
    query: v.string(),
  },
  handler: async (ctx, args): Promise<{ results: Coworker[] } | null> => {
    const q = normalizeCoworkerQuery(args.query);
    if (!q) return { results: [] };
    const session = await ctx.db
      .query("feishuUserTokens")
      .withIndex("by_sessionId", (idx) => idx.eq("sessionId", args.sessionId))
      .unique();
    if (!session || session.expiresAt <= Date.now()) return null;
    const cached = await getFreshCoworkerCacheEntry(ctx, args.sessionId, q);
    if (!cached) return null;
    return { results: cached.results };
  },
});

export const setCoworkerSearchCache = internalMutation({
  args: {
    sessionId: v.string(),
    query: v.string(),
    results: v.array(
      v.object({
        openId: v.string(),
        name: v.string(),
        avatarUrl: v.optional(v.string()),
      }),
    ),
    ttlMs: v.number(),
  },
  // eslint-disable-next-line max-lines-per-function
  handler: async (ctx, args): Promise<void> => {
    const normalized = makeCacheLookupQuery(args.query);
    const existing = await ctx.db
      .query("coworkerSearchCache")
      .withIndex("by_session_query", (q) =>
        q.eq("sessionId", args.sessionId).eq("query", normalized),
      )
      .order("desc")
      .take(COWORKER_SEARCH_CACHE_MAX_ENTRIES_PER_SESSION + 1);

    const payload = {
      sessionId: args.sessionId,
      query: normalized,
      results: args.results,
      cachedAt: Date.now(),
      ttlMs: args.ttlMs,
    };

    const [current, ...duplicates] = existing;
    if (current) {
      await ctx.db.patch(current._id, payload);
      for (const duplicate of duplicates) {
        await ctx.db.delete(duplicate._id);
      }
      console.log(
        `[coworkers] cache update session=${args.sessionId} q="${normalized.slice(0, 40)}" size=${args.results.length}`,
      );
      if (duplicates.length > 0) {
        console.log(
          `[coworkers] cache duplicate cleanup session=${args.sessionId} q="${normalized.slice(0, 40)}" removed=${duplicates.length}`,
        );
      }
      return;
    }

    await ctx.db.insert("coworkerSearchCache", payload);
    console.log(`[coworkers] cache insert session=${args.sessionId} q="${normalized.slice(0, 40)}" size=${args.results.length}`);

    const entries = await ctx.db
      .query("coworkerSearchCache")
      .withIndex("by_session_cachedAt", (q) => q.eq("sessionId", args.sessionId))
      .order("desc")
      .take(COWORKER_SEARCH_CACHE_MAX_ENTRIES_PER_SESSION + 1);

    if (entries.length <= COWORKER_SEARCH_CACHE_MAX_ENTRIES_PER_SESSION) return;

    const toDrop = entries.slice(COWORKER_SEARCH_CACHE_MAX_ENTRIES_PER_SESSION);
    for (const row of toDrop) {
      await ctx.db.delete(row._id);
    }
    console.log(
      `[coworkers] cache eviction session=${args.sessionId} removed=${toDrop.length} keeping=${Math.min(entries.length, COWORKER_SEARCH_CACHE_MAX_ENTRIES_PER_SESSION)}`,
    );
  },
});

export const cleanupExpiredCoworkerSearchCache = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ deleted: number }> => {
    const cutoff = Date.now() - COWORKER_SEARCH_CACHE_TTL_MS;
    const expired = await ctx.db
      .query("coworkerSearchCache")
      .withIndex("by_cachedAt", (q) => q.lt("cachedAt", cutoff))
      .take(COWORKER_SEARCH_CACHE_CLEANUP_BATCH_SIZE);
    for (const row of expired) {
      await ctx.db.delete(row._id);
    }
    if (expired.length > 0) {
      console.log(`[coworkers] cache ttl cleanup removed=${expired.length}`);
    }
    return { deleted: expired.length };
  },
});

async function getWarmServerCache(
  ctx: ActionCtx,
  sessionId: string,
  cacheKey: string,
): Promise<Coworker[] | null> {
  const cached = await ctx.runQuery(internal.feishu.coworkers.getCachedCoworkerSearch, {
    sessionId,
    query: cacheKey,
  });
  if (!cached) return null;
  console.log(
    `[coworkers] cache hit session=${sessionId} q="${cacheKey.slice(0, 40)}"` +
      ` size=${cached.results.length}`,
  );
  return cached.results;
}

async function saveServerCache(
  ctx: ActionCtx,
  sessionId: string,
  cacheKey: string,
  coworkers: Coworker[],
): Promise<void> {
  await ctx.runMutation(internal.feishu.coworkers.setCoworkerSearchCache, {
    sessionId,
    query: cacheKey,
    results: coworkers,
    ttlMs: COWORKER_SEARCH_CACHE_TTL_MS,
  });
}

export const searchCoworkers = action({
  args: {
    sessionId: v.string(),
    query: v.string(),
    userAccessToken: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Coworker[]> => {
    const cacheKey = makeCacheLookupQuery(args.query);
    const searchQuery = normalizeCoworkerQuery(args.query);
    if (searchQuery.length < MIN_COWORKER_SEARCH_LENGTH) return [];

    // Primary login stores the token in Convex. Resolve it before checking the
    // cache so deleted/expired sessions cannot keep reading cached directory
    // data. Fallback-login calls pass a browser-held token; those deliberately
    // bypass the shared server cache and rely on the frontend token-scoped cache.
    const token =
      args.userAccessToken ?? (await resolveFeishuToken(ctx, "user", args.sessionId));
    const canUseServerCache = args.userAccessToken === undefined;

    if (canUseServerCache) {
      const cached = await getWarmServerCache(ctx, args.sessionId, cacheKey);
      if (cached) return cached;
    }

    const data = await callFeishu<{ users?: FeishuUser[] }>(ctx, {
      path: "/search/v1/user",
      method: "GET",
      query: { query: searchQuery, page_size: "20" },
      auth: "user",
      sessionId: args.sessionId,
      token,
      label: "Coworker search",
    });

    const users = data.users ?? [];
    const coworkers = mapCoworkers(data);

    if (canUseServerCache) {
      await saveServerCache(ctx, args.sessionId, cacheKey, coworkers);
    }

    logCoworkerAvatarDiagnostics(users, coworkers);
    console.log(
      `[coworkers] cache miss -> query="${searchQuery.slice(0, 40)}" -> ${coworkers.length}`,
    );
    return coworkers;
  },
});
