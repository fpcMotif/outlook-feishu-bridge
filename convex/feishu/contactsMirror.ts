/* eslint-disable max-lines */
// Server-indexed Feishu Contacts (org directory) mirror (ADR-0023). Sibling of
// the Customer mirror (customersMirror.ts): a biweekly cron crawls the Feishu
// Contact v3 directory into a Convex table with a search index, so colleagues
// can be ranked-searched by name / @fenchem.com email / department the same way
// customers are.
//
// What is stored: name, department (joined names), enterprise_email (the
// @fenchem.com mailbox — NEVER the personal `email`), avatarUrl. Phone numbers
// are NEVER read or stored. Resigned / exited employees are skipped and pruned.
//
// The directory has no "list all users" endpoint, so the org is enumerated by
// crawling departments then listing each department's DIRECT members:
//   departments children (recursive):
//     https://open.feishu.cn/document/server-docs/contact-v3/department/children
//   users by department:
//     https://open.feishu.cn/document/server-docs/contact-v3/user/find_by_department
// Convex search index:
//   https://docs.convex.dev/search/text-search
//
// Auth: TENANT token (the cron has no user session). Requires a tenant
// contact-read scope (e.g. contact:contact:readonly_as_app) + the app's data
// range covering the org — see ADR-0023. We do NOT request contact:user.phone.

import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";

import {
  internalAction,
  internalMutation,
  internalQuery,
  query,
  type ActionCtx,
} from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { callFeishu } from "./call";
import { toSearchQueryString } from "./cjkSearch";
import {
  dedupeRowsByOpenId,
  mapUserToRow,
  mirrorDocToContact,
  type ContactRecord,
  type ContactUpsertRow,
  type FeishuContactUser,
} from "./contactsMirrorRows";
import {
  addDepartmentsToNameMap,
  addPrunePage,
  dedupeUsersByOpenId,
  emptyPruneTotals,
  exceedsAssumedMax,
  nextPageTokenOrStop,
  partitionActive,
  shouldPruneStaleContacts,
  staleContactIds,
  worstStopReason,
  type ContactStopReason,
  type FeishuDepartment,
  type PruneTotals,
} from "./contactsMirrorSync";

// Feishu's documented contact page_size ceiling is 50 (find_by_department &
// department children). The mirror walks until has_more=false — no MAX_PAGES cap
// of our own (loop detection guards against a stuck page_token instead).
const CONTACT_PAGE_SIZE = 50;
// Bounded write fan-out per applyPage call so one mutation stays well under
// Convex's per-transaction document budget (the action batches externally).
const APPLY_BATCH_SIZE = 100;
// Prune scans the whole mirror in bounded pages.
const PRUNE_PAGE_SIZE = 500;
const MIN_PAGE_REQUEST_INTERVAL_MS = 60;
const MIN_CONTACT_SEARCH_LENGTH = 2;
// Single-flight lease so a manual run can never overlap the cron and race the
// prune's delete fan-out (same hazard as ADR-0021). 15 min >> one full sync.
const MIRROR_REFRESH_LEASE_MS = 15 * 60 * 1000;
const ROOT_DEPARTMENT_ID = "0";

// --- Registered mutations / queries ----------------------------------------

const upsertRowValidator = v.object({
  openId: v.string(),
  name: v.string(),
  email: v.optional(v.string()),
  department: v.optional(v.string()),
  departmentIds: v.optional(v.array(v.string())),
  avatarUrl: v.optional(v.string()),
  searchBlob: v.string(),
});

function sameStringArray(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

function contactRowChanged(existing: ContactUpsertRow, next: ContactUpsertRow): boolean {
  return (
    existing.name !== next.name ||
    existing.email !== next.email ||
    existing.department !== next.department ||
    existing.avatarUrl !== next.avatarUrl ||
    existing.searchBlob !== next.searchBlob ||
    !sameStringArray(existing.departmentIds, next.departmentIds)
  );
}

// Upsert a batch of contacts keyed by the immutable openId. Bounded fan-out.
export const applyPage = internalMutation({
  args: { rows: v.array(upsertRowValidator), mirroredAt: v.number() },
  handler: async (ctx, args) => {
    const rows = dedupeRowsByOpenId(args.rows);
    const existingRows = await Promise.all(
      rows.map(async (row) => ({
        row,
        existing: await ctx.db
          .query("feishuContacts")
          .withIndex("by_openId", (q) => q.eq("openId", row.openId))
          .unique(),
      })),
    );
    const writes = await Promise.all(
      existingRows.map(async ({ row, existing }) => {
        const fields = { ...row, mirroredAt: args.mirroredAt };
        if (existing) {
          if (!contactRowChanged(existing, row)) return "unchanged" as const;
          await ctx.db.patch(existing._id, fields);
          return "updated" as const;
        }
        await ctx.db.insert("feishuContacts", fields);
        return "inserted" as const;
      }),
    );
    const inserted = writes.filter((result) => result === "inserted").length;
    const updated = writes.filter((result) => result === "updated").length;
    return { inserted, updated, unchanged: writes.length - inserted - updated };
  },
});

// Paginated read of the mirror returning only {_id, openId} so the prune can
// decide orphans without shipping whole documents back.
export const listRowsForPrune = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const result = await ctx.db.query("feishuContacts").paginate(args.paginationOpts);
    return {
      ...result,
      page: result.page.map((row) => ({ _id: row._id, openId: row.openId })),
    };
  },
});

export const deleteRowsById = internalMutation({
  args: { ids: v.array(v.id("feishuContacts")) },
  handler: async (ctx, args) => {
    await Promise.all(args.ids.map((id) => ctx.db.delete(id)));
    return { deleted: args.ids.length };
  },
});

// Single-flight start lease: atomically check-and-set lastRefreshStartedAt,
// returning started=false (with remaining cooldown) when a refresh already
// started within the window — so two runs can never race the prune.
export const startRefreshIfAllowed = internalMutation({
  args: { startedAt: v.number(), cooldownMs: v.number() },
  handler: async (
    ctx,
    args,
  ): Promise<{ started: true } | { started: false; remainingMs: number }> => {
    const existing = await ctx.db.query("feishuContactsMirrorState").first();
    const lastStartedAt = existing?.lastRefreshStartedAt ?? null;
    if (lastStartedAt !== null) {
      const elapsedMs = Math.max(0, args.startedAt - lastStartedAt);
      if (elapsedMs < args.cooldownMs) {
        return { started: false, remainingMs: args.cooldownMs - elapsedMs };
      }
    }
    if (existing) {
      await ctx.db.patch(existing._id, { lastRefreshStartedAt: args.startedAt });
    } else {
      await ctx.db.insert("feishuContactsMirrorState", {
        lastFullSyncAt: 0,
        lastUserCount: 0,
        lastRefreshStartedAt: args.startedAt,
      });
    }
    return { started: true };
  },
});

export const recordSyncCompletion = internalMutation({
  args: {
    lastFullSyncAt: v.number(),
    lastUserCount: v.number(),
    lastDepartmentCount: v.number(),
    lastInsertedCount: v.number(),
    lastUpdatedCount: v.number(),
    lastUnchangedCount: v.number(),
    lastSkippedResignedCount: v.number(),
    lastStopReason: v.union(
      v.literal("complete"),
      v.literal("missingPageToken"),
      v.literal("duplicatePageToken"),
      v.literal("incomplete"),
    ),
    lastDurationMs: v.number(),
    lastFinishedAt: v.number(),
    lastPruneScannedCount: v.number(),
    lastDeletedStaleCount: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("feishuContactsMirrorState").first();
    if (existing) {
      await ctx.db.patch(existing._id, args);
    } else {
      await ctx.db.insert("feishuContactsMirrorState", args);
    }
  },
});

// Public ranked search over the mirror's searchBlob (CJK-expanded query). Slim
// projection, bounded take. Exposed for a future colleague picker.
export const search = query({
  args: { q: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{ records: ContactRecord[]; mirroredAt: number | null }> => {
    const q = args.q.trim();
    const limit = Math.min(Math.max(args.limit ?? 20, 1), 50);
    const state = await ctx.db.query("feishuContactsMirrorState").first();
    const searchTokens = toSearchQueryString(q);
    if (q.length < MIN_CONTACT_SEARCH_LENGTH || searchTokens === "") {
      return { records: [], mirroredAt: state?.lastFullSyncAt ?? null };
    }
    const hits = await ctx.db
      .query("feishuContacts")
      .withSearchIndex("by_text", (b) => b.search("searchBlob", searchTokens))
      .take(limit);
    return { records: hits.map((hit) => mirrorDocToContact(hit)), mirroredAt: state?.lastFullSyncAt ?? null };
  },
});

// --- Action-runtime crawl (pure helpers in contactsMirrorSync.ts) -----------

interface DepartmentChildrenResponse {
  items?: FeishuDepartment[];
  has_more?: boolean;
  page_token?: string;
}
interface FindByDepartmentResponse {
  items?: FeishuContactUser[];
  has_more?: boolean;
  page_token?: string;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForPageSlot(previousRequestStartedAt: number): Promise<number> {
  const waitMs =
    previousRequestStartedAt === 0
      ? 0
      : MIN_PAGE_REQUEST_INTERVAL_MS - (Date.now() - previousRequestStartedAt);
  await sleep(waitMs);
  return Date.now();
}

// Crawl ALL departments from root with fetch_child=true (one recursive paginated
// walk) → id→name map + the list of department ids to scan for members.
async function walkDepartments(
  ctx: ActionCtx,
): Promise<{ nameById: Map<string, string>; departmentIds: string[]; stopReason: ContactStopReason }> {
  const nameById = new Map<string, string>();
  const seenPageTokens = new Set<string>();
  let stopReason: ContactStopReason = "complete";
  let pageToken: string | undefined;
  let previousRequestStartedAt = 0;
  let pageNumber = 0;
  for (;;) {
    previousRequestStartedAt = await waitForPageSlot(previousRequestStartedAt);
    const queryParams: Record<string, string> = {
      fetch_child: "true",
      department_id_type: "open_department_id",
      page_size: String(CONTACT_PAGE_SIZE),
    };
    if (pageToken) queryParams.page_token = pageToken;
    const data = await callFeishu<DepartmentChildrenResponse>(ctx, {
      path: `/contact/v3/departments/${ROOT_DEPARTMENT_ID}/children`,
      method: "GET",
      auth: "tenant",
      query: queryParams,
      label: "Contacts mirror — departments",
    });
    addDepartmentsToNameMap(nameById, data.items ?? []);
    pageNumber += 1;
    const next = nextPageTokenOrStop(data, seenPageTokens, pageNumber, "departments");
    if (next.stopReason) {
      stopReason = next.stopReason;
      break;
    }
    pageToken = next.pageToken;
  }
  return { nameById, departmentIds: [...nameById.keys()], stopReason };
}

// List one department's DIRECT members (paginated). Returns the active users
// (resigned/exited filtered out), the skipped count, and the walk's stop reason.
async function walkDepartmentMembers(
  ctx: ActionCtx,
  departmentId: string,
): Promise<{ active: FeishuContactUser[]; skippedResigned: number; stopReason: ContactStopReason }> {
  const active: FeishuContactUser[] = [];
  const seenPageTokens = new Set<string>();
  let skippedResigned = 0;
  let stopReason: ContactStopReason = "complete";
  let pageToken: string | undefined;
  let previousRequestStartedAt = 0;
  let pageNumber = 0;
  for (;;) {
    previousRequestStartedAt = await waitForPageSlot(previousRequestStartedAt);
    const queryParams: Record<string, string> = {
      department_id: departmentId,
      department_id_type: "open_department_id",
      user_id_type: "open_id",
      page_size: String(CONTACT_PAGE_SIZE),
    };
    if (pageToken) queryParams.page_token = pageToken;
    const data = await callFeishu<FindByDepartmentResponse>(ctx, {
      path: "/contact/v3/users/find_by_department",
      method: "GET",
      auth: "tenant",
      query: queryParams,
      label: "Contacts mirror — members",
    });
    const partitioned = partitionActive(data.items ?? []);
    active.push(...partitioned.active);
    skippedResigned += partitioned.skippedResigned;
    pageNumber += 1;
    const next = nextPageTokenOrStop(data, seenPageTokens, pageNumber, `members[${departmentId}]`);
    if (next.stopReason) {
      stopReason = next.stopReason;
      break;
    }
    pageToken = next.pageToken;
  }
  return { active, skippedResigned, stopReason };
}

interface CrawlResult {
  rows: ContactUpsertRow[];
  seenOpenIds: Set<string>;
  departmentCount: number;
  skippedResigned: number;
  stopReason: ContactStopReason;
}

async function crawlDirectory(ctx: ActionCtx): Promise<CrawlResult> {
  const departments = await walkDepartments(ctx);
  // Scan root (direct members at the top) plus every descendant department.
  const departmentIds = [ROOT_DEPARTMENT_ID, ...departments.departmentIds];
  const stopReasons: ContactStopReason[] = [departments.stopReason];
  const rawUsers: FeishuContactUser[] = [];
  let skippedResigned = 0;
  for (const departmentId of departmentIds) {
    const walk = await walkDepartmentMembers(ctx, departmentId);
    rawUsers.push(...walk.active);
    skippedResigned += walk.skippedResigned;
    stopReasons.push(walk.stopReason);
  }
  const uniqueUsers = dedupeUsersByOpenId(rawUsers);
  const rows = uniqueUsers.map((user) => mapUserToRow(user, departments.nameById));
  return {
    rows,
    seenOpenIds: new Set(rows.map((row) => row.openId)),
    departmentCount: departments.departmentIds.length,
    skippedResigned,
    stopReason: worstStopReason(stopReasons),
  };
}

interface WriteTotals {
  inserted: number;
  updated: number;
  unchanged: number;
}

async function writeRows(
  ctx: ActionCtx,
  rows: readonly ContactUpsertRow[],
  mirroredAt: number,
): Promise<WriteTotals> {
  const totals: WriteTotals = { inserted: 0, updated: 0, unchanged: 0 };
  for (let i = 0; i < rows.length; i += APPLY_BATCH_SIZE) {
    const batch = rows.slice(i, i + APPLY_BATCH_SIZE);
    const stats: WriteTotals = await ctx.runMutation(internal.feishu.contactsMirror.applyPage, {
      rows: batch,
      mirroredAt,
    });
    totals.inserted += stats.inserted;
    totals.updated += stats.updated;
    totals.unchanged += stats.unchanged;
  }
  return totals;
}

// Tombstone any mirror row whose openId was not seen this run. Callers MUST gate
// on shouldPruneStaleContacts(stopReason) — never prune after a partial crawl.
async function pruneStaleContacts(
  ctx: ActionCtx,
  seenOpenIds: ReadonlySet<string>,
): Promise<PruneTotals> {
  const totals = emptyPruneTotals();
  let cursor: string | null = null;
  for (;;) {
    const result: {
      page: { _id: Id<"feishuContacts">; openId: string }[];
      isDone: boolean;
      continueCursor: string;
    } = await ctx.runQuery(internal.feishu.contactsMirror.listRowsForPrune, {
      paginationOpts: { numItems: PRUNE_PAGE_SIZE, cursor },
    });
    const staleIds = staleContactIds(result.page, seenOpenIds);
    if (staleIds.length > 0) {
      await ctx.runMutation(internal.feishu.contactsMirror.deleteRowsById, { ids: staleIds });
    }
    addPrunePage(totals, result.page, staleIds);
    if (result.isDone) break;
    cursor = result.continueCursor;
  }
  return totals;
}

interface FullSyncResult extends WriteTotals {
  userCount: number;
  departmentCount: number;
  skippedResigned: number;
  stopReason: ContactStopReason;
  pruneScanned: number;
  deletedStale: number;
  durationMs: number;
}

async function runFullSync(ctx: ActionCtx, startedAt: number): Promise<FullSyncResult> {
  const crawl = await crawlDirectory(ctx);
  if (exceedsAssumedMax(crawl.rows.length)) {
    console.error(
      `[contacts-mirror] ASSUMPTION BREACH users=${crawl.rows.length} exceeds assumed max 800 — revisit paging/cost`,
    );
  }
  const writes = await writeRows(ctx, crawl.rows, startedAt);
  const prune = shouldPruneStaleContacts(crawl.stopReason)
    ? await pruneStaleContacts(ctx, crawl.seenOpenIds)
    : emptyPruneTotals();
  const finishedAt = Date.now();
  await ctx.runMutation(internal.feishu.contactsMirror.recordSyncCompletion, {
    lastFullSyncAt: startedAt,
    lastUserCount: crawl.rows.length,
    lastDepartmentCount: crawl.departmentCount,
    lastInsertedCount: writes.inserted,
    lastUpdatedCount: writes.updated,
    lastUnchangedCount: writes.unchanged,
    lastSkippedResignedCount: crawl.skippedResigned,
    lastStopReason: crawl.stopReason,
    lastDurationMs: finishedAt - startedAt,
    lastFinishedAt: finishedAt,
    lastPruneScannedCount: prune.scanned,
    lastDeletedStaleCount: prune.deleted,
  });
  if (crawl.stopReason !== "complete") {
    throw new Error(
      `Contacts mirror stopped before completion: reason=${crawl.stopReason} ` +
        `departments=${crawl.departmentCount} users=${crawl.rows.length}`,
    );
  }
  return {
    ...writes,
    userCount: crawl.rows.length,
    departmentCount: crawl.departmentCount,
    skippedResigned: crawl.skippedResigned,
    stopReason: crawl.stopReason,
    pruneScanned: prune.scanned,
    deletedStale: prune.deleted,
    durationMs: finishedAt - startedAt,
  };
}

function skippedResult(): FullSyncResult {
  return {
    inserted: 0,
    updated: 0,
    unchanged: 0,
    userCount: 0,
    departmentCount: 0,
    skippedResigned: 0,
    stopReason: "complete",
    pruneScanned: 0,
    deletedStale: 0,
    durationMs: 0,
  };
}

// Biweekly cron entry. Single-flight: a manual run overlapping the cron (or
// vice-versa) backs off instead of racing the prune's delete fan-out.
export const fullSync = internalAction({
  args: {},
  handler: async (ctx): Promise<FullSyncResult> => {
    const started = Date.now();
    const lease = await ctx.runMutation(internal.feishu.contactsMirror.startRefreshIfAllowed, {
      startedAt: started,
      cooldownMs: MIRROR_REFRESH_LEASE_MS,
    });
    if (!lease.started) {
      const remainingS = Math.round(lease.remainingMs / 1000);
      console.log(`[contacts-mirror] fullSync skipped (refresh in flight, ${remainingS}s remaining)`);
      return skippedResult();
    }
    const out = await runFullSync(ctx, started);
    console.log(
      `[contacts-mirror] fullSync ok departments=${out.departmentCount} users=${out.userCount} ` +
        `inserted=${out.inserted} updated=${out.updated} unchanged=${out.unchanged} ` +
        `skippedResigned=${out.skippedResigned} pruneScanned=${out.pruneScanned} ` +
        `deletedStale=${out.deletedStale} stopReason=${out.stopReason} duration=${out.durationMs}ms`,
    );
    return out;
  },
});
