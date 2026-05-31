import { v } from "convex/values";

import {
  action,
  internalMutation,
  internalQuery,
} from "../_generated/server";
import { internal } from "../_generated/api";
import { callFeishu } from "./call";

const COWORKER_SEARCH_CACHE_TTL_MS = 60_000;
const COWORKER_SEARCH_PAGE_SIZE = 20;

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

interface CachedCoworkerSearch {
  results: Coworker[];
}

function normalizeCoworkerQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

function cacheKey(sessionId: string, query: string): string {
  return `${sessionId}::${normalizeCoworkerQuery(query)}`;
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

export const getCachedCoworkerSearch = internalQuery({
  args: { normalizedQuery: v.string() },
  handler: async (ctx, args): Promise<CachedCoworkerSearch | null> => {
    const hit = await ctx.db
      .query("coworkerSearchCache")
      .withIndex("by_normalizedQuery", (q) => q.eq("normalizedQuery", args.normalizedQuery))
      .first();
    if (!hit || hit.expiresAt <= Date.now()) {
      return null;
    }
    return { results: hit.results };
  },
});

export const upsertCoworkerSearchCache = internalMutation({
  args: {
    normalizedQuery: v.string(),
    results: v.array(
      v.object({
        openId: v.string(),
        name: v.string(),
        avatarUrl: v.optional(v.string()),
      }),
    ),
    fetchedAt: v.number(),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("coworkerSearchCache")
      .withIndex("by_normalizedQuery", (q) => q.eq("normalizedQuery", args.normalizedQuery))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, args);
      return;
    }
    await ctx.db.insert("coworkerSearchCache", args);
  },
});

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

export const searchCoworkers = action({
  args: {
    sessionId: v.string(),
    query: v.string(),
    userAccessToken: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Coworker[]> => {
    const queryText = normalizeCoworkerQuery(args.query);
    if (!queryText) return [];
    const normalizedQuery = cacheKey(args.sessionId, queryText);
    const cached = await ctx.runQuery(internal.feishu.coworkers.getCachedCoworkerSearch, {
      normalizedQuery,
    });
    if (cached !== null) {
      return cached.results;
    }
    // Search Users is a GET with the keyword in the `query` URL param (scope
    // contact:user:search) — NOT a POST with a JSON body. See ADR-0003.
    const data = await callFeishu<{ users?: FeishuUser[] }>(ctx, {
      path: "/search/v1/user",
      method: "GET",
      query: { query: queryText, page_size: String(COWORKER_SEARCH_PAGE_SIZE) },
      auth: "user",
      sessionId: args.sessionId,
      token: args.userAccessToken,
      label: "Coworker search",
    });

    const users = data.users ?? [];
    const coworkers = mapCoworkers(data);
    const now = Date.now();
    await ctx.runMutation(internal.feishu.coworkers.upsertCoworkerSearchCache, {
      normalizedQuery,
      results: coworkers,
      fetchedAt: now,
      expiresAt: now + COWORKER_SEARCH_CACHE_TTL_MS,
    });
    logCoworkerAvatarDiagnostics(users, coworkers);
    return coworkers;
  },
});
