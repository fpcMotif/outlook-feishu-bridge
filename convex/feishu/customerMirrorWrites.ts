// Extracted ctx-typed bodies for the Customer mirror registrations (ADR-0019
// "extract-then-test" seam). Each registration in customersMirror.ts is a thin
// wrapper over one of these helpers, so the registration file stays under the
// architecture line limit while the validators + function references stay there.
//
// HARD RULE preserved (ADR-0010 / ADR-0012): only Convex's own `customers`
// mirror is written here; the Bitable Customer Table is never mutated.

import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { toSearchQueryString } from "./cjkSearch";
import { canonicalCustomerDomain, emailDomain, type CustomerRecord } from "./customers";
import {
  customerRowChanged,
  dedupeRowsByRecordId,
  mirrorDocToCustomer,
  type CustomerUpsertRow,
} from "./customerMirrorRows";
import { searchDevCustomerFixtures, mergePreferredCustomers } from "./devCustomerFixtures";

// Minimum query length the search index is consulted for. Lives here because
// both the `search` query body and (via customersMirror) the searchCustomers
// engine gate on it; keeping one definition keeps the two paths identical.
export const MIN_CUSTOMER_SEARCH_LENGTH = 2;

// Upsert a page of Customers into the mirror table, keyed by Bitable recordId.
// Bounded write fan-out per call so a single mutation stays well under Convex's
// per-transaction document budget (the cron paginates externally).
export async function upsertCustomerPage(
  ctx: MutationCtx,
  rawRows: readonly CustomerUpsertRow[],
  mirroredAt: number,
): Promise<{ inserted: number; updated: number; unchanged: number; duplicateRows: number }> {
  const rows = dedupeRowsByRecordId(rawRows);
  const duplicateRows = rawRows.length - rows.length;
  const existingRows = await Promise.all(
    rows.map(async (row) => ({
      row,
      existing: await ctx.db
        .query("customers")
        .withIndex("by_recordId", (q) => q.eq("recordId", row.recordId))
        .unique(),
    })),
  );
  const writes = await Promise.all(
    existingRows.map(async ({ row, existing }) => {
      // Explicit undefined for every optional column before spreading `row`
      // so ctx.db.patch removes a field whose Bitable cell was cleared.
      // Convex strips undefined from action→mutation args, but inside a
      // mutation handler explicit undefined IS propagated by db.patch (it
      // removes the key). Without this, cleared cells can never be reflected.
      const fields = {
        domain: undefined,
        domainKey: undefined,
        fullName: undefined,
        accountNo: undefined,
        countryRegion: undefined,
        ownerOpenId: undefined,
        ownerName: undefined,
        ...row,
        mirroredAt,
      };
      if (existing) {
        if (!customerRowChanged(existing, row)) {
          return "unchanged" as const;
        }
        await ctx.db.patch(existing._id, fields);
        return "updated" as const;
      }
      await ctx.db.insert("customers", fields);
      return "inserted" as const;
    }),
  );
  const inserted = writes.filter((result) => result === "inserted").length;
  const updated = writes.filter((result) => result === "updated").length;
  const unchanged = writes.length - inserted - updated;
  return { inserted, updated, unchanged, duplicateRows };
}

// Mirror Prune scan body (ADR-0016 / ADR-0021). Returns only {_id, recordId} so
// the orchestrating action can decide which rows are orphans without shipping
// whole documents back. Read-only.
export async function listMirrorRowsForPrune(
  ctx: QueryCtx,
  paginationOpts: { numItems: number; cursor: string | null },
): Promise<{
  page: { _id: Id<"customers">; recordId: string }[];
  isDone: boolean;
  continueCursor: string;
}> {
  const result = await ctx.db.query("customers").paginate(paginationOpts);
  return {
    ...result,
    page: result.page.map((row) => ({ _id: row._id, recordId: row.recordId })),
  };
}

// Tombstone a bounded batch of mirror rows. Only ever called by the prune step
// after a complete, completeness-verified sync; the action bounds the batch so
// this stays within the per-transaction write budget.
export async function deleteMirrorRowsById(
  ctx: MutationCtx,
  ids: readonly Id<"customers">[],
): Promise<{ deleted: number }> {
  await Promise.all(ids.map((id) => ctx.db.delete(id)));
  return { deleted: ids.length };
}

// Mirror Refresh start lease (ADR-0016 amendment + ADR-0021 single-flight). The
// single shared gate that BOTH the cron fullSync and the on-demand kick acquire:
// it atomically check-and-sets lastRefreshStartedAt, returning started=false
// (with the remaining cooldown) when a refresh already started within the
// window — so concurrent refreshes collapse to one and can never race the
// prune's delete fan-out. The state row may not exist yet on a fresh deployment,
// so insert a minimal never-completed row in that case.
export async function startRefreshLease(
  ctx: MutationCtx,
  startedAt: number,
  cooldownMs: number,
): Promise<{ started: true } | { started: false; remainingMs: number }> {
  const existing = await ctx.db.query("customersMirrorState").first();
  const lastStartedAt = existing?.lastRefreshStartedAt ?? null;
  if (lastStartedAt !== null) {
    const elapsedMs = Math.max(0, startedAt - lastStartedAt);
    if (elapsedMs < cooldownMs) {
      return { started: false, remainingMs: cooldownMs - elapsedMs };
    }
  }
  if (existing) {
    await ctx.db.patch(existing._id, { lastRefreshStartedAt: startedAt });
  } else {
    await ctx.db.insert("customersMirrorState", {
      lastFullSyncAt: 0,
      lastRowCount: 0,
      lastRefreshStartedAt: startedAt,
    });
  }
  return { started: true };
}

// Per-domain cooldown gate for matchEmailAndCacheMiss. Follows the same
// check-and-set pattern as startRefreshLease: one mutation that atomically
// reads the last attempt timestamp and writes a new one, so concurrent SPA
// sessions for the same domain collapse to a single live Feishu probe.
export async function startDomainMatchLease(
  ctx: MutationCtx,
  domain: string,
  startedAt: number,
  cooldownMs: number,
): Promise<{ started: true } | { started: false; remainingMs: number }> {
  const existing = await ctx.db
    .query("customerDomainMatchCooldowns")
    .withIndex("by_domain", (q) => q.eq("domain", domain))
    .unique();
  if (existing) {
    const elapsedMs = Math.max(0, startedAt - existing.lastAttemptAt);
    if (elapsedMs < cooldownMs) {
      return { started: false, remainingMs: cooldownMs - elapsedMs };
    }
    await ctx.db.patch(existing._id, { lastAttemptAt: startedAt });
  } else {
    await ctx.db.insert("customerDomainMatchCooldowns", {
      domain,
      lastAttemptAt: startedAt,
    });
  }
  return { started: true };
}

// matchByEmail body. Probe the canonical-key index first. The old by_domain
// probe compared a lowercased canonical domain against the RAW 域名 cell, so any
// cell with casing/padding could never match — a permanent miss no re-sync
// fixed. The by_domain fallback only covers rows synced before domainKey
// existed; the next full sync re-stamps every row and the fallback goes dead.
export async function matchCustomerByEmailInMirror(
  ctx: QueryCtx,
  email: string,
): Promise<{ customer: CustomerRecord | null }> {
  const domain = canonicalCustomerDomain(emailDomain(email));
  if (!domain) return { customer: null };
  const hit =
    (await ctx.db
      .query("customers")
      .withIndex("by_domainKey", (q) => q.eq("domainKey", domain))
      .first()) ??
    (await ctx.db
      .query("customers")
      .withIndex("by_domain", (q) => q.eq("domain", domain))
      .first());
  if (hit) {
    if (hit.recordId === "dev_fixture_fanpc_customer") {
      console.log(
        `[dev-customer-fixture] TEST ONLY matched fanpc customer for ${domain}`,
      );
    }
    return { customer: mirrorDocToCustomer(hit) };
  }
  const fixture = searchDevCustomerFixtures(domain)[0] ?? null;
  if (fixture) {
    console.log(`[dev-customer-fixture] TEST ONLY matched in-memory fixture for ${domain}`);
  }
  return { customer: fixture };
}

// Ranked mirror search body. Uses Convex's `withSearchIndex` for prefix + score
// ranking on the `searchBlob` column. Optional `mineFor` filters to customers
// whose Owner == that open_id (the "Show mine" toggle from CustomerPicker,
// ADR-0013).
export async function searchCustomerMirror(
  ctx: QueryCtx,
  args: { q: string; mineFor?: string; limit?: number },
): Promise<{ records: CustomerRecord[]; mirroredAt: number | null }> {
  const q = args.q.trim();
  const limit = Math.min(Math.max(args.limit ?? 20, 1), 50);
  const state = await ctx.db.query("customersMirrorState").first();
  // CJK queries are bigram-expanded so they match the bigram-augmented blob
  // (cjkSearch.ts); a query with no searchable content (e.g. all punctuation)
  // collapses to "" and is treated as a miss.
  const searchTokens = toSearchQueryString(q);
  if (q.length < MIN_CUSTOMER_SEARCH_LENGTH || searchTokens === "") {
    return { records: [], mirroredAt: state?.lastFullSyncAt ?? null };
  }
  const hits = await ctx.db
    .query("customers")
    .withSearchIndex("by_text", (b) => {
      let s = b.search("searchBlob", searchTokens);
      if (args.mineFor) s = s.eq("ownerOpenId", args.mineFor);
      return s;
    })
    .take(limit);
  const records: CustomerRecord[] = mergePreferredCustomers(
    searchDevCustomerFixtures(q, args.mineFor),
    hits.map((hit) => mirrorDocToCustomer(hit)),
  ).slice(0, limit);
  return { records, mirroredAt: state?.lastFullSyncAt ?? null };
}
