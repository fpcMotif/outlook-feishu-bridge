/* eslint-disable max-lines */
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query as convexQuery,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import { callFeishu, resolveFeishuToken } from "./call";

const COWORKER_SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const COWORKER_SEARCH_CACHE_MAX_ENTRIES_PER_SESSION = 24;
const MIN_COWORKER_SEARCH_LENGTH = 2;
const COWORKER_SEARCH_CACHE_CLEANUP_BATCH_SIZE = 200;
const COWORKER_DIRECTORY_TTL_MS = 25 * 60 * 60 * 1000;
const COWORKER_DIRECTORY_PAGE_SIZE = 50;
const COWORKER_DIRECTORY_MAX_USERS = 1000;
const COWORKER_DIRECTORY_RESULT_LIMIT = 50;
const COWORKER_DIRECTORY_STATE_KEY = "global" as const;

// Search Users response (open.feishu.cn GET /open-apis/search/v1/user): each
// user carries open_id, name, and usually an `avatar` object of sized URLs.
// Some tenants/API responses omit avatar_72 but include a larger avatar size,
// so the projection below falls back through the available Feishu avatar fields.
// `user_id` is only returned with contact:user.employee_id:readonly, which we
// don't request — Bitable Sync assigns Coworkers by open_id. See ADR-0003.
export interface FeishuUser {
  open_id: string;
  name: string;
  en_name?: string;
  email?: string;
  avatar?: {
    avatar_72?: string;
    avatar_240?: string;
    avatar_640?: string;
    avatar_origin?: string;
  };
  avatar_url?: string;
  department_ids?: string[];
}

interface FeishuDepartment {
  open_department_id?: string;
  department_id?: string;
  name?: string;
}

interface FeishuPagedItems<T> {
  items?: T[];
  has_more?: boolean;
  page_token?: string;
}

type CoworkerDirectoryStopReason =
  | "complete"
  | "disabled"
  | "missingPageToken"
  | "duplicatePageToken"
  | "tooManyUsers"
  | "failed";
type CoworkerDirectoryFailureReason = Exclude<CoworkerDirectoryStopReason, "complete">;

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

function normalizeDirectoryText(value: string): string {
  return value.trim().toLowerCase().replaceAll(/\s+/gu, " ");
}

function directoryNgrams(value: string): string[] {
  const compact = [...normalizeDirectoryText(value)].filter((ch) => ch !== " ");
  const grams = new Set<string>();
  for (const size of [2, 3]) {
    for (let i = 0; i + size <= compact.length; i++) {
      grams.add(compact.slice(i, i + size).join(""));
    }
  }
  return [...grams];
}

function uniqueTextTokens(values: Array<string | undefined>): string[] {
  const tokens = new Set<string>();
  for (const value of values) {
    const normalized = value ? normalizeDirectoryText(value) : "";
    if (!normalized) continue;
    tokens.add(normalized);
    for (const part of normalized.split(" ")) tokens.add(part);
    for (const gram of directoryNgrams(normalized)) tokens.add(gram);
  }
  return [...tokens];
}

export function coworkerSearchBlob(coworker: Coworker): string {
  return uniqueTextTokens([coworker.name, coworker.openId]).join(" ");
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

function isDirectoryFresh(
  state: { lastFullSyncAt: number; lastStopReason?: CoworkerDirectoryStopReason },
  now: number,
): boolean {
  return state.lastStopReason === "complete" && now - state.lastFullSyncAt <= COWORKER_DIRECTORY_TTL_MS;
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

async function searchFreshCoworkerDirectory(
  ctx: QueryCtx,
  searchText: string,
): Promise<Coworker[] | null> {
  const normalized = makeCacheLookupQuery(searchText);
  if (normalized.length < MIN_COWORKER_SEARCH_LENGTH) return [];

  const state = await ctx.db
    .query("coworkerDirectoryState")
    .withIndex("by_key", (q) => q.eq("key", COWORKER_DIRECTORY_STATE_KEY))
    .unique();
  if (!state || !isDirectoryFresh(state, Date.now())) return null;

  const rows = await ctx.db
    .query("coworkers")
    .withSearchIndex("by_text", (q) => q.search("searchBlob", normalized))
    .take(COWORKER_DIRECTORY_RESULT_LIMIT);

  return rows.map((row) => ({
    openId: row.openId,
    name: row.name,
    avatarUrl: row.avatarUrl,
  }));
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

export const searchCoworkerDirectory = internalQuery({
  args: {
    query: v.string(),
  },
  handler: async (ctx, args): Promise<{ results: Coworker[] } | null> => {
    const results = await searchFreshCoworkerDirectory(ctx, args.query);
    return results === null ? null : { results };
  },
});

export const searchCoworkersCached = convexQuery({
  args: {
    sessionId: v.string(),
    query: v.string(),
  },
  handler: async (ctx, args): Promise<{ results: Coworker[] } | null> => {
    const q = normalizeCoworkerQuery(args.query);
    if (q.length < MIN_COWORKER_SEARCH_LENGTH) return { results: [] };
    const session = await ctx.db
      .query("feishuUserTokens")
      .withIndex("by_sessionId", (idx) => idx.eq("sessionId", args.sessionId))
      .unique();
    if (!session || session.expiresAt <= Date.now()) return null;
    const directory = await searchFreshCoworkerDirectory(ctx, q);
    if (directory !== null) return { results: directory };
    const cached = await getFreshCoworkerCacheEntry(ctx, args.sessionId, q);
    if (!cached) return null;
    return { results: cached.results };
  },
});

export const listCoworkerDirectory = convexQuery({
  args: {
    sessionId: v.string(),
  },
  handler: async (ctx, args): Promise<{ records: Coworker[] } | null> => {
    const session = await ctx.db
      .query("feishuUserTokens")
      .withIndex("by_sessionId", (idx) => idx.eq("sessionId", args.sessionId))
      .unique();
    if (!session || session.expiresAt <= Date.now()) return null;

    const state = await ctx.db
      .query("coworkerDirectoryState")
      .withIndex("by_key", (q) => q.eq("key", COWORKER_DIRECTORY_STATE_KEY))
      .unique();
    if (!state || !isDirectoryFresh(state, Date.now())) return null;

    const rows = await ctx.db.query("coworkers").take(COWORKER_DIRECTORY_MAX_USERS);
    return {
      records: rows
        .map((row) => ({
          openId: row.openId,
          name: row.name,
          avatarUrl: row.avatarUrl,
        }))
        .toSorted((a, b) => a.name.localeCompare(b.name)),
    };
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

async function upsertCoworkerDirectoryRows(
  ctx: MutationCtx,
  coworkers: Coworker[],
  startedAt: number,
): Promise<Set<string>> {
  const seen = new Set(coworkers.map((coworker) => coworker.openId));
  for (const coworker of coworkers) {
    const existing = await ctx.db
      .query("coworkers")
      .withIndex("by_openId", (q) => q.eq("openId", coworker.openId))
      .unique();
    const row = {
      openId: coworker.openId,
      name: coworker.name,
      avatarUrl: coworker.avatarUrl,
      searchBlob: coworkerSearchBlob(coworker),
      mirroredAt: startedAt,
    };
    if (existing) await ctx.db.patch(existing._id, row);
    else await ctx.db.insert("coworkers", row);
  }
  return seen;
}

async function pruneMissingCoworkerDirectoryRows(
  ctx: MutationCtx,
  seen: Set<string>,
): Promise<number> {
  let deleted = 0;
  const existingRows = await ctx.db.query("coworkers").take(COWORKER_DIRECTORY_MAX_USERS + 1);
  for (const row of existingRows) {
    if (seen.has(row.openId)) continue;
    await ctx.db.delete(row._id);
    deleted++;
  }
  return deleted;
}

async function getCoworkerDirectoryState(ctx: MutationCtx) {
  return await ctx.db
    .query("coworkerDirectoryState")
    .withIndex("by_key", (q) => q.eq("key", COWORKER_DIRECTORY_STATE_KEY))
    .unique();
}

export const replaceCoworkerDirectory = internalMutation({
  args: {
    coworkers: v.array(
      v.object({
        openId: v.string(),
        name: v.string(),
        avatarUrl: v.optional(v.string()),
      }),
    ),
    startedAt: v.number(),
    departmentCount: v.number(),
    userPageCount: v.number(),
  },
  handler: async (ctx, args): Promise<{ rowCount: number; deleted: number }> => {
    if (args.coworkers.length > COWORKER_DIRECTORY_MAX_USERS) {
      throw new Error(`Coworker Directory exceeds ${COWORKER_DIRECTORY_MAX_USERS} users`);
    }

    const seen = await upsertCoworkerDirectoryRows(ctx, args.coworkers, args.startedAt);
    const deleted = await pruneMissingCoworkerDirectoryRows(ctx, seen);
    const state = await getCoworkerDirectoryState(ctx);
    const statePatch = {
      key: COWORKER_DIRECTORY_STATE_KEY,
      lastFullSyncAt: Date.now(),
      lastRefreshStartedAt: args.startedAt,
      lastRowCount: args.coworkers.length,
      lastDepartmentCount: args.departmentCount,
      lastUserPageCount: args.userPageCount,
      lastStopReason: "complete" as const,
      lastDurationMs: Date.now() - args.startedAt,
      lastFinishedAt: Date.now(),
    };
    if (state) {
      await ctx.db.patch(state._id, statePatch);
    } else {
      await ctx.db.insert("coworkerDirectoryState", statePatch);
    }

    console.log(
      `[coworkers] directory sync complete users=${args.coworkers.length} departments=${args.departmentCount} pages=${args.userPageCount} deleted=${deleted}`,
    );
    return { rowCount: args.coworkers.length, deleted };
  },
});

export const recordCoworkerDirectoryFailure = internalMutation({
  args: {
    startedAt: v.number(),
    stopReason: v.union(
      v.literal("disabled"),
      v.literal("missingPageToken"),
      v.literal("duplicatePageToken"),
      v.literal("tooManyUsers"),
      v.literal("failed"),
    ),
  },
  handler: async (ctx, args): Promise<void> => {
    const state = await getCoworkerDirectoryState(ctx);
    const patch = {
      key: COWORKER_DIRECTORY_STATE_KEY,
      lastFullSyncAt: state?.lastFullSyncAt ?? 0,
      lastRefreshStartedAt: args.startedAt,
      lastRowCount: state?.lastRowCount ?? 0,
      lastStopReason: args.stopReason,
      lastDurationMs: Date.now() - args.startedAt,
      lastFinishedAt: Date.now(),
    };
    if (state) await ctx.db.patch(state._id, patch);
    else await ctx.db.insert("coworkerDirectoryState", patch);
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

async function getWarmCoworkerDirectory(
  ctx: ActionCtx,
  searchText: string,
): Promise<Coworker[] | null> {
  const directory = await ctx.runQuery(internal.feishu.coworkers.searchCoworkerDirectory, {
    query: searchText,
  });
  if (!directory) return null;
  console.log(
    `[coworkers] directory hit q="${searchText.slice(0, 40)}" size=${directory.results.length}`,
  );
  return directory.results;
}

class CoworkerDirectorySyncError extends Error {
  readonly stopReason: CoworkerDirectoryFailureReason;

  constructor(stopReason: CoworkerDirectoryFailureReason, message: string) {
    super(message);
    this.stopReason = stopReason;
  }
}

function nextPageTokenOrThrow(
  label: string,
  seenTokens: Set<string>,
  data: { has_more?: boolean; page_token?: string },
): string | undefined {
  if (!data.has_more) return undefined;
  const token = data.page_token?.trim();
  if (!token) {
    throw new CoworkerDirectorySyncError(
      "missingPageToken",
      `${label} returned has_more=true without page_token`,
    );
  }
  if (seenTokens.has(token)) {
    throw new CoworkerDirectorySyncError(
      "duplicatePageToken",
      `${label} repeated page_token ${token}`,
    );
  }
  seenTokens.add(token);
  return token;
}

async function fetchDirectoryDepartments(ctx: ActionCtx): Promise<{
  departmentIds: string[];
  pageCount: number;
}> {
  const departmentIds = new Set<string>(["0"]);
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;
  let pageCount = 0;
  do {
    const data = await callFeishu<FeishuPagedItems<FeishuDepartment>>(ctx, {
      path: "/contact/v3/departments/0/children",
      method: "GET",
      auth: "tenant",
      query: {
        department_id_type: "open_department_id",
        fetch_child: "true",
        page_size: String(COWORKER_DIRECTORY_PAGE_SIZE),
        ...(pageToken ? { page_token: pageToken } : {}),
      },
      label: "Coworker Directory departments",
    });
    pageCount++;
    for (const department of data.items ?? []) {
      const id = department.open_department_id ?? department.department_id;
      if (id) departmentIds.add(id);
    }
    pageToken = nextPageTokenOrThrow("Coworker Directory departments", seenTokens, data);
  } while (pageToken);
  return { departmentIds: [...departmentIds], pageCount };
}

async function fetchDepartmentCoworkers(
  ctx: ActionCtx,
  departmentId: string,
): Promise<{ coworkers: Coworker[]; pageCount: number }> {
  const coworkers: Coworker[] = [];
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;
  let pageCount = 0;
  do {
    const data = await callFeishu<FeishuPagedItems<FeishuUser>>(ctx, {
      path: "/contact/v3/users/find_by_department",
      method: "GET",
      auth: "tenant",
      query: {
        department_id: departmentId,
        department_id_type: "open_department_id",
        user_id_type: "open_id",
        page_size: String(COWORKER_DIRECTORY_PAGE_SIZE),
        ...(pageToken ? { page_token: pageToken } : {}),
      },
      label: "Coworker Directory users",
    });
    pageCount++;
    for (const user of data.items ?? []) {
      if (!user.open_id || !user.name) continue;
      coworkers.push(mapFeishuUserToCoworker(user));
    }
    pageToken = nextPageTokenOrThrow(
      `Coworker Directory users department=${departmentId}`,
      seenTokens,
      data,
    );
  } while (pageToken);
  return { coworkers, pageCount };
}

type CoworkerDirectorySyncResult = {
  status: "complete" | "disabled";
  rowCount: number;
  departmentCount: number;
  userPageCount: number;
};

async function collectDirectoryCoworkers(
  ctx: ActionCtx,
  departmentIds: string[],
): Promise<{ coworkers: Coworker[]; userPageCount: number }> {
  const byOpenId = new Map<string, Coworker>();
  let userPageCount = 0;
  for (const departmentId of departmentIds) {
    const page = await fetchDepartmentCoworkers(ctx, departmentId);
    userPageCount += page.pageCount;
    for (const coworker of page.coworkers) {
      if (!byOpenId.has(coworker.openId)) byOpenId.set(coworker.openId, coworker);
    }
  }
  return {
    coworkers: [...byOpenId.values()].toSorted((a, b) => a.name.localeCompare(b.name)),
    userPageCount,
  };
}

async function recordDirectoryFailure(
  ctx: ActionCtx,
  startedAt: number,
  stopReason: CoworkerDirectoryFailureReason,
): Promise<void> {
  await ctx.runMutation(internal.feishu.coworkers.recordCoworkerDirectoryFailure, {
    startedAt,
    stopReason,
  });
}

async function runEnabledDirectorySync(
  ctx: ActionCtx,
  startedAt: number,
): Promise<CoworkerDirectorySyncResult> {
  const departments = await fetchDirectoryDepartments(ctx);
  const { coworkers, userPageCount } = await collectDirectoryCoworkers(
    ctx,
    departments.departmentIds,
  );
  if (coworkers.length > COWORKER_DIRECTORY_MAX_USERS) {
    throw new CoworkerDirectorySyncError(
      "tooManyUsers",
      `Coworker Directory returned ${coworkers.length} users; expected <= ${COWORKER_DIRECTORY_MAX_USERS}`,
    );
  }
  const totalPageCount = departments.pageCount + userPageCount;
  await ctx.runMutation(internal.feishu.coworkers.replaceCoworkerDirectory, {
    coworkers,
    startedAt,
    departmentCount: departments.departmentIds.length,
    userPageCount: totalPageCount,
  });
  return {
    status: "complete",
    rowCount: coworkers.length,
    departmentCount: departments.departmentIds.length,
    userPageCount: totalPageCount,
  };
}

export const fullDirectorySync = internalAction({
  args: {},
  handler: async (ctx): Promise<CoworkerDirectorySyncResult> => {
    const startedAt = Date.now();
    if (process.env.FEISHU_COWORKER_DIRECTORY_SYNC !== "1") {
      await recordDirectoryFailure(ctx, startedAt, "disabled");
      console.log("[coworkers] directory sync disabled; set FEISHU_COWORKER_DIRECTORY_SYNC=1 to enable");
      return { status: "disabled", rowCount: 0, departmentCount: 0, userPageCount: 0 };
    }

    try {
      return await runEnabledDirectorySync(ctx, startedAt);
    } catch (err) {
      const stopReason =
        err instanceof CoworkerDirectorySyncError ? err.stopReason : "failed";
      await recordDirectoryFailure(ctx, startedAt, stopReason);
      throw err;
    }
  },
});

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
      const directory = await getWarmCoworkerDirectory(ctx, searchQuery);
      if (directory) return directory;
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
