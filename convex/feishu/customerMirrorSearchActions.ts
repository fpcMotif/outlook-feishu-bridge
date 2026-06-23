// ActionCtx I/O adapters for the Customer-search and domain-match engines
// (ADR-0016). The engines own the strategy (min-length gate, mirror-first, live
// on miss, strict-canonical stop) — these adapters only supply the Feishu /
// Convex I/O. Split out of customersMirror.ts so the registration file stays
// under the architecture line limit; the registered searchCustomers /
// matchEmailAndCacheMiss actions build a port here and hand it to the engine.
//
// HARD RULE preserved (ADR-0010 / ADR-0012): only READs the Bitable Customer
// Table; new rows are backfilled into Convex's own `customers` mirror via applyPage.

import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { callFeishu } from "./call";
import {
  canonicalCustomerDomain,
  emailDomain,
  mapFeishuItemToCustomer,
  type CustomerRecord,
} from "./customers";
import { projectionToRow } from "./customerMirrorRows";
import {
  mergePreferredCustomers,
  searchDevCustomerFixtures,
} from "./devCustomerFixtures";
import type { SearchResponse } from "./customerMirrorSync";
import type { CustomerSearchPort } from "./customerSearchEngine";
import {
  runDomainMatchCacheMiss,
  type DomainMatchPort,
} from "./customerDomainMatchEngine";
import {
  CACHE_MISS_PAGE_SIZE,
  CUSTOMER_FIELD_NAMES,
  CUSTOMER_TABLE_ID,
  requireAppToken,
} from "./customerMirrorConfig";

// Live leg of the Customer search (ADR-0016 § "Per-request cache miss"): falls
// through to the LIVE Feishu /records/search with the same `or` `contains`
// filter the legacy per-keystroke path used, then INCREMENTALLY upserts any new
// rows into the mirror so the next identical query hits the fast path. Slower
// than the mirror query (200-500 ms cross-border), but the latency hit lands
// exactly when the mirror missed — and it self-heals for next time. Only ever
// invoked by the Customer-search engine after a mirror miss.
async function liveSearchAndBackfill(
  ctx: ActionCtx,
  q: string,
  mineFor?: string,
): Promise<{ records: CustomerRecord[]; backfilled: number }> {
  const appToken = requireAppToken();
  const started = Date.now();
  const data: SearchResponse = await callFeishu<SearchResponse>(ctx, {
    path: `/bitable/v1/apps/${appToken}/tables/${CUSTOMER_TABLE_ID}/records/search`,
    method: "POST",
    auth: "tenant",
    json: {
      field_names: CUSTOMER_FIELD_NAMES,
      filter: {
        conjunction: "or",
        conditions: [
          { field_name: "Account Name", operator: "contains", value: [q] },
          { field_name: "域名", operator: "contains", value: [q] },
        ],
      },
    },
    query: { page_size: String(CACHE_MISS_PAGE_SIZE) },
    label: "Customers mirror — live search on cache miss",
  });
  const backfilledRecords: CustomerRecord[] = (data.items ?? []).map((item) =>
    mapFeishuItemToCustomer(item),
  );
  if (backfilledRecords.length > 0) {
    await ctx.runMutation(internal.feishu.customersMirror.applyPage, {
      rows: backfilledRecords.map((customer) => projectionToRow(customer)),
      mirroredAt: Date.now(),
    });
  }
  const records = mergePreferredCustomers(
    searchDevCustomerFixtures(q, mineFor),
    mineFor === undefined
      ? backfilledRecords
      : backfilledRecords.filter((record) => record.owner?.openId === mineFor),
  );
  console.log(
    `[customers-mirror] live search q="${q.slice(0, 40)}" -> ${records.length}/${backfilledRecords.length} backfilled (${Date.now() - started}ms)`,
  );
  return { records, backfilled: backfilledRecords.length };
}

// The real Customer-search port: the mirror leg via the internal ranked query,
// the live leg via Feishu + backfill. The engine (customerSearchEngine.
// runCustomerSearch) owns the strategy — min-length gate, mirror-first, live on
// miss — this adapter only supplies the I/O.
export function makeCustomerSearchPort(ctx: ActionCtx): CustomerSearchPort<CustomerRecord> {
  return {
    mirrorSearch: async (q, mineFor) => {
      const hit: { records: CustomerRecord[]; mirroredAt: number | null } = await ctx.runQuery(
        internal.feishu.customersMirror.search,
        mineFor === undefined ? { q } : { q, mineFor },
      );
      return hit;
    },
    liveSearch: (q, mineFor) => liveSearchAndBackfill(ctx, q, mineFor),
  };
}

// The effectful port for the domain-match cache-miss engine: one filtered
// `域名 contains <domain>` page per call (≤ CACHE_MISS_PAGE_SIZE rows). The engine
// (customerDomainMatchEngine.runDomainMatchCacheMiss) owns the strict-canonical
// stop logic and the ≤ MAX_CACHE_MISS_PAGES cap — this adapter only supplies I/O.
function makeDomainMatchPort(
  ctx: ActionCtx,
  appToken: string,
  domain: string,
): DomainMatchPort<CustomerRecord> {
  return {
    fetchPage: async (pageToken) => {
      const data: SearchResponse = await callFeishu<SearchResponse>(ctx, {
        path: `/bitable/v1/apps/${appToken}/tables/${CUSTOMER_TABLE_ID}/records/search`,
        method: "POST",
        auth: "tenant",
        json: {
          field_names: CUSTOMER_FIELD_NAMES,
          filter: {
            conjunction: "and",
            conditions: [{ field_name: "域名", operator: "contains", value: [domain] }],
          },
        },
        query: pageToken
          ? { page_size: String(CACHE_MISS_PAGE_SIZE), page_token: pageToken }
          : { page_size: String(CACHE_MISS_PAGE_SIZE) },
        label: "Customers mirror — live domain match on cache miss",
      });
      return {
        records: (data.items ?? []).map((item) => mapFeishuItemToCustomer(item)),
        hasMore: data.has_more === true,
        pageToken: data.page_token,
      };
    },
  };
}

// matchEmailAndCacheMiss body. Gate on the per-domain cooldown
// (startDomainMatchIfAllowed), run the domain-match cache-miss engine with the
// live Feishu port, then backfill any results into the mirror via applyPage.
// cooldownMs / maxPages are passed in from the registration so the constants
// stay with the public surface.
export async function matchEmailAndCacheMissLive(
  ctx: ActionCtx,
  email: string,
  cooldownMs: number,
  maxPages: number,
): Promise<{ customer: CustomerRecord | null; backfilled: number }> {
  const domain = canonicalCustomerDomain(emailDomain(email));
  if (!domain) return { customer: null, backfilled: 0 };
  const gate: { started: true } | { started: false; remainingMs: number } =
    await ctx.runMutation(internal.feishu.customersMirror.startDomainMatchIfAllowed, {
      domain,
      startedAt: Date.now(),
      cooldownMs,
    });
  if (!gate.started) {
    const remainingS = Math.round((gate as { started: false; remainingMs: number }).remainingMs / 1000);
    console.log(
      `[customers-mirror] matchEmailAndCacheMiss domain="${domain}" -> skipped (cooldown, ${remainingS}s remaining)`,
    );
    return { customer: null, backfilled: 0 };
  }
  const appToken = requireAppToken();
  const started = Date.now();
  const { customer, allRecords } = await runDomainMatchCacheMiss(
    makeDomainMatchPort(ctx, appToken, domain),
    { email, maxPages },
  );
  if (allRecords.length > 0) {
    await ctx.runMutation(internal.feishu.customersMirror.applyPage, {
      rows: allRecords.map((c) => projectionToRow(c)),
      mirroredAt: Date.now(),
    });
  }
  console.log(
    `[customers-mirror] matchEmailAndCacheMiss domain="${domain}" -> ` +
      `${customer ? "hit" : "miss"}/${allRecords.length} backfilled (${Date.now() - started}ms)`,
  );
  return { customer, backfilled: allRecords.length };
}
