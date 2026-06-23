// Server-indexed Customer search (ADR-0016). Mirrors the Feishu Customer Table
// into a Convex table with a search index, so per-keystroke autocomplete in the
// SPA runs as a ranked Convex query — no client-side preload, no per-keystroke
// Bitable round-trip, scales past 50k rows.
//
// HARD RULE preserved (ADR-0010 / ADR-0012): we only READ the Bitable Customer
// Table. Writes land exclusively on Convex's own `customers` mirror table.
//
// Thin registration surface: args + returns validators (the shapes live in
// customerMirrorValidators.ts) wired to handler bodies in sibling modules —
// full-sync paging/prune in customerMirrorFullSync.ts (+ customerMirrorComple-
// tion.ts), search/domain-match adapters in customerMirrorSearchActions.ts,
// mutation/query bodies in customerMirrorWrites.ts, shared config in
// customerMirrorConfig.ts. Docs:
//   https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table-record/search
//   https://docs.convex.dev/database/text-search

import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";

import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from "../_generated/server";
import { internal } from "../_generated/api";
import type { CustomerRecord } from "./customers";
import {
  runCustomerSearch,
  type CustomerSearchOutcome,
} from "./customerSearchEngine";
import {
  deleteMirrorRowsById,
  listMirrorRowsForPrune,
  matchCustomerByEmailInMirror,
  MIN_CUSTOMER_SEARCH_LENGTH,
  searchCustomerMirror,
  startDomainMatchLease,
  startRefreshLease,
  upsertCustomerPage,
} from "./customerMirrorWrites";
import {
  makeCustomerSearchPort,
  matchEmailAndCacheMissLive,
} from "./customerMirrorSearchActions";
import {
  runFullSync,
  skippedKickResult,
  type FullSyncResult,
} from "./customerMirrorFullSync";
import {
  applyPageResultValidator,
  deleteResultValidator,
  fullSyncResultValidator,
  leaseResultValidator,
  matchByEmailResultValidator,
  matchEmailAndCacheMissResultValidator,
  mirrorRowValidator,
  pruneScanResultValidator,
  recordSyncCompletionArgs,
  searchCustomersResultValidator,
  searchResultValidator,
} from "./customerMirrorValidators";
import {
  DOMAIN_MATCH_COOLDOWN_MS,
  MAX_CACHE_MISS_PAGES,
  MIRROR_KICK_COOLDOWN_MS,
  MIRROR_REFRESH_LEASE_MS,
} from "./customerMirrorConfig";

export { buildSearchBlob } from "./customerMirrorRows";

// Upsert a page of Customers into the mirror, keyed by Bitable recordId. Bounded
// write fan-out per call (the cron paginates externally). Body in
// customerMirrorWrites.upsertCustomerPage.
export const applyPage = internalMutation({
  args: { rows: v.array(mirrorRowValidator), mirroredAt: v.number() },
  returns: applyPageResultValidator,
  handler: (ctx, args) => upsertCustomerPage(ctx, args.rows, args.mirroredAt),
});

// Mirror Prune scan (ADR-0016 / ADR-0021). Paginated read returning only
// {_id, recordId} so the orchestrating action decides orphans without shipping
// whole documents back. Read-only. Body in customerMirrorWrites.
export const listRowsForPrune = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  returns: pruneScanResultValidator,
  handler: (ctx, args) => listMirrorRowsForPrune(ctx, args.paginationOpts),
});

// Tombstone a bounded batch of mirror rows. Only ever called by the prune step
// after a completeness-verified sync; the action bounds the batch via
// PRUNE_PAGE_SIZE. Body in customerMirrorWrites.
export const deleteRowsById = internalMutation({
  args: { ids: v.array(v.id("customers")) },
  returns: deleteResultValidator,
  handler: (ctx, args) => deleteMirrorRowsById(ctx, args.ids),
});

// Mirror Refresh start lease (ADR-0016 amendment + ADR-0021 single-flight). The
// single shared gate BOTH the cron fullSync and the on-demand kick acquire so
// concurrent refreshes collapse to one. Body in customerMirrorWrites.
export const startRefreshIfAllowed = internalMutation({
  args: { startedAt: v.number(), cooldownMs: v.number() },
  returns: leaseResultValidator,
  handler: (ctx, args): Promise<{ started: true } | { started: false; remainingMs: number }> =>
    startRefreshLease(ctx, args.startedAt, args.cooldownMs),
});

// Per-domain cooldown gate for matchEmailAndCacheMiss (same check-and-set
// pattern as startRefreshIfAllowed). Body in customerMirrorWrites.
export const startDomainMatchIfAllowed = internalMutation({
  args: { domain: v.string(), startedAt: v.number(), cooldownMs: v.number() },
  returns: leaseResultValidator,
  handler: (
    ctx,
    args,
  ): Promise<{ started: true } | { started: false; remainingMs: number }> =>
    startDomainMatchLease(ctx, args.domain, args.startedAt, args.cooldownMs),
});

// Stamp the watermark row once per successful fullSync run.
export const recordSyncCompletion = internalMutation({
  args: recordSyncCompletionArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("customersMirrorState").first();
    if (existing) {
      await ctx.db.patch(existing._id, args);
    } else {
      await ctx.db.insert("customersMirrorState", args);
    }
  },
});

export const fullSync = internalAction({
  args: {},
  returns: fullSyncResultValidator,
  handler: async (ctx): Promise<FullSyncResult> => {
    const started = Date.now();
    // Single-flight (ADR-0021 hardening): the weekly cron and the on-demand kick
    // share ONE start lease, so a cron refresh that overlaps an in-flight kick
    // backs off instead of racing the prune's delete fan-out against its inserts.
    const lease = await ctx.runMutation(
      internal.feishu.customersMirror.startRefreshIfAllowed,
      { startedAt: started, cooldownMs: MIRROR_REFRESH_LEASE_MS },
    );
    if (!lease.started) {
      const remainingS = Math.round(lease.remainingMs / 1000);
      console.log(`[customers-mirror] fullSync skipped (refresh in flight, ${remainingS}s remaining)`);
      return skippedKickResult();
    }
    const out = await runFullSync(ctx, { startedAt: started });
    console.log(
      `[customers-mirror] fullSync ok pages=${out.pages} rows=${out.rows} ` +
        `inserted=${out.inserted} updated=${out.updated} unchanged=${out.unchanged} ` +
        `duplicateRows=${out.duplicateRows} sourceRows=${out.sourceRows} ` +
        `reportedTotal=${out.reportedTotal} pruneScanned=${out.pruneScanned} ` +
        `deletedStale=${out.deletedStale} ` +
        `stopReason=${out.stopReason} duration=${Date.now() - started}ms`,
    );
    return out;
  },
});

// Public on-demand Mirror Kick — the SPA forces a refresh when the picker opens.
// Globally rate-limited server-side (ADR-0016 amendment): if any full refresh
// started within the cooldown, skip the Feishu re-page entirely. The weekly cron
// (fullSync) is on its own path and never gated here.
export const kick = action({
  args: {},
  returns: fullSyncResultValidator,
  handler: async (ctx): Promise<FullSyncResult> => {
    const now = Date.now();
    const start = await ctx.runMutation(
      internal.feishu.customersMirror.startRefreshIfAllowed,
      { startedAt: now, cooldownMs: MIRROR_KICK_COOLDOWN_MS },
    );
    if (!start.started) {
      const remainingS = Math.round(start.remainingMs / 1000);
      console.log(`[customers-mirror] kick skipped (cooldown, ${remainingS}s remaining)`);
      return skippedKickResult();
    }
    return await runFullSync(ctx, { startedAt: now });
  },
});

// The ONE public Customer-search entry point (ADR-0016 amendment): the SPA no
// longer decides mirror-vs-live — the engine does, server-side. An action because
// the live fallback calls Feishu, which a query cannot; `source` is the provenance
// the taskpane badges and both sides' logs join on.
export const searchCustomers = action({
  args: {
    q: v.string(),
    mineFor: v.optional(v.string()),
    // When false the engine skips the live Feishu leg even on a mirror miss —
    // the SPA uses it during a negative-cache TTL so the (possibly backfilled)
    // mirror is still consulted without another cross-border live search.
    liveAllowed: v.optional(v.boolean()),
  },
  returns: searchCustomersResultValidator,
  handler: async (ctx, args): Promise<CustomerSearchOutcome<CustomerRecord>> => {
    return await runCustomerSearch(makeCustomerSearchPort(ctx), {
      q: args.q,
      mineFor: args.mineFor,
      minLength: MIN_CUSTOMER_SEARCH_LENGTH,
      liveAllowed: args.liveAllowed,
    });
  },
});

export const matchByEmail = query({
  args: { email: v.string() },
  returns: matchByEmailResultValidator,
  handler: (ctx, args): Promise<{ customer: CustomerRecord | null }> =>
    matchCustomerByEmailInMirror(ctx, args.email),
});

// Cache-aside lazy fill for the domain auto-match (ADR-0016). Called by the SPA
// only AFTER matchByEmail returned null: a live Feishu /records/search filtered
// to the canonical domain (≤ CACHE_MISS_PAGE_SIZE rows/page, up to
// MAX_CACHE_MISS_PAGES pages — see customerDomainMatchEngine), upserting results
// into the mirror and returning the strict canonical match. The server-side
// per-domain cooldown (startDomainMatchIfAllowed) is authoritative.
export const matchEmailAndCacheMiss = action({
  args: { email: v.string() },
  returns: matchEmailAndCacheMissResultValidator,
  handler: (
    ctx,
    args,
  ): Promise<{ customer: CustomerRecord | null; backfilled: number }> =>
    matchEmailAndCacheMissLive(ctx, args.email, DOMAIN_MATCH_COOLDOWN_MS, MAX_CACHE_MISS_PAGES),
});

// Ranked mirror search (ADR-0013). INTERNAL mirror leg of the Customer-search
// engine — the SPA enters through `searchCustomers`, never this query directly.
// Body in customerMirrorWrites.searchCustomerMirror.
export const search = internalQuery({
  args: {
    q: v.string(),
    mineFor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  returns: searchResultValidator,
  handler: (ctx, args): Promise<{ records: CustomerRecord[]; mirroredAt: number | null }> =>
    searchCustomerMirror(ctx, args),
});
