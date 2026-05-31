// Customer Directory + per-keystroke search over the Feishu Customer Table
// (tbl4TE2GV472sKzp). Tenant-token reads only — the HARD RULE (ADR-0010,
// ADR-0012) forbids modifying any pre-existing Bitable row and this file does
// not write at all. The on-login preload + the per-keystroke fallback are both
// described in ADR-0013.
//
// Official Feishu docs (the ONLY source of truth):
//   search  POST /bitable/v1/apps/{app}/tables/{table}/records/search
//     https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table-record/search
//   field-value formats (rich-text array, User array, etc.):
//     https://open.feishu.cn/document/docs/bitable-v1/app-table-record/bitable-record-data-structure-overview
//     SDK: github.com/larksuite/oapi-sdk-go

import { v } from "convex/values";

import { action, type ActionCtx } from "../_generated/server";
import { callFeishu } from "./call";
import {
  mergePreferredCustomers,
  searchDevCustomerFixtures,
  withDevCustomerFixtures,
} from "./devCustomerFixtures";

// Same Base as the Service table (FEISHU_BITABLE_APP_TOKEN). The customer
// table id is fixed — see ADR-0012's "Client linkage (domain match)" section.
const CUSTOMER_TABLE_ID = "tbl4TE2GV472sKzp";
const PAGE_SIZE = 500;
// Safety cap on the on-login preload. Today the live table is ~250 rows; the
// goal accommodates growth to ~5000 (ADR-0013). 6000 leaves headroom without
// risking a runaway preload.
const MAX_RECORDS = 6000;

/**
 * The slim projection of one Customer-Table row that the SPA caches in the
 * Customer Directory and renders in the Customer Picker (ADR-0013). Optional
 * fields are `undefined` (not "") when the source row omits them so the UI can
 * distinguish "absent" from "blank".
 */
export interface CustomerRecord {
  recordId: string;
  name: string;
  domain?: string;
  fullName?: string;
  accountNo?: string;
  countryRegion?: string;
  owner: { openId: string; name: string } | null;
}

export const SEARCH_FALLBACK_PAGE_SIZE = 50;
const CUSTOMER_SEARCH_FIELDS = [
  "Account Name",
  "域名",
  "全名",
  "Account No.",
  "Country and Regio",
] as const;

interface SearchFilter {
  conjunction: "or";
  conditions: {
    field_name: (typeof CUSTOMER_SEARCH_FIELDS)[number];
    operator: "contains";
    value: string[];
  }[];
}

/**
 * Map one /records/search item to the slim {@link CustomerRecord}. Pure — no
 * I/O — so it is the foundation for both the on-login `listCustomers` preload
 * and the per-keystroke `searchCustomers` fallback.
 *
 * Field shapes (verified against live data on 2026-05-28):
 *  - Text fields (`Account Name`, `域名`, `全名`, `Account No.`) → rich-text
 *    array `[{text,type:"text"}, ...]`; flattened to a plain string.
 *  - SingleSelect (`Country and Regio`) → plain string.
 *  - User (`Owner`) → array of `{id, name, en_name, email}`; first entry only.
 */
export function mapFeishuItemToCustomer(item: {
  record_id: string;
  fields: Record<string, unknown>;
}): CustomerRecord {
  const f = item.fields;
  return {
    recordId: recordIdFromCustomerInfoRow(item),
    name: flattenText(f["Account Name"]) ?? "",
    domain: flattenText(f["域名"]),
    fullName: flattenText(f["全名"]),
    accountNo: flattenText(f["Account No."]),
    countryRegion: typeof f["Country and Regio"] === "string" ? f["Country and Regio"] : undefined,
    owner: firstOwner(f["Owner"]),
  };
}

export function recordIdFromCustomerInfoRow(item: {
  record_id: string;
  fields?: Record<string, unknown>;
}): string {
  return flattenText(item.fields?.["Record Id"]) ?? item.record_id;
}

// Feishu Text fields are returned as [{text, type:"text"}, ...]. Concatenate.
// Returns `undefined` when the field is absent so optional projection fields
// surface as "absent" instead of "blank".
function flattenText(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  }
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const joined = value
    .map((seg) =>
      typeof seg === "object" && seg !== null && "text" in seg
        ? String((seg as { text: unknown }).text ?? "")
        : "",
    )
    .join("");
  return joined === "" ? undefined : joined;
}

export function normalizeCustomerQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ");
}

export function buildCustomerSearchFilter(query: string): SearchFilter {
  const q = normalizeCustomerQuery(query);
  return {
    conjunction: "or",
    conditions: CUSTOMER_SEARCH_FIELDS.map((fieldName) => ({
      field_name: fieldName,
      operator: "contains",
      value: [q],
    })),
  };
}

function firstOwner(value: unknown): { openId: string; name: string } | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const first = value[0];
  if (typeof first !== "object" || first === null) return null;
  const o = first as { id?: unknown; name?: unknown };
  if (typeof o.id !== "string") return null;
  return { openId: o.id, name: typeof o.name === "string" ? o.name : "" };
}

/**
 * Pure auto-match: locate the Customer whose `域名` equals the email's domain,
 * case-insensitively. Returns null on no-match or malformed input. The match
 * is intentionally strict (no suffix or fuzzy heuristics) — silently picking
 * the wrong Customer is worse than no match (ADR-0013).
 */
const CUSTOMER_DOMAIN_ALIASES: Record<string, string> = {
  "microsoftonline.com": "microsoft.com",
};

export function findCustomerByEmail<R extends { domain?: string }>(
  directory: readonly R[],
  email: string,
): R | null {
  const target = canonicalCustomerDomain(emailDomain(email));
  if (!target) return null;
  return directory.find((c) => canonicalCustomerDomain(c.domain) === target) ?? null;
}

export function canonicalCustomerDomain(domain: string | undefined | null): string | null {
  const normalized = domain?.trim().toLowerCase();
  if (!normalized) return null;
  return CUSTOMER_DOMAIN_ALIASES[normalized] ?? normalized;
}

export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0 || at === email.length - 1) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return domain || null;
}

interface FeishuRecord {
  record_id: string;
  fields: Record<string, unknown>;
}

interface SearchResponse {
  items?: FeishuRecord[];
  has_more?: boolean;
  page_token?: string;
}

function requireAppToken(): string {
  const appToken = process.env.FEISHU_BITABLE_APP_TOKEN;
  if (!appToken) throw new Error("FEISHU_BITABLE_APP_TOKEN must be set");
  return appToken;
}

async function fetchCustomerPage(
  ctx: ActionCtx,
  appToken: string,
  pageToken: string | undefined,
  records: CustomerRecord[],
  pageCount: number,
): Promise<CustomerRecord[]> {
  if (records.length >= MAX_RECORDS || pageCount >= 20) return records;
  const query: Record<string, string> = { page_size: String(PAGE_SIZE) };
  if (pageToken) query.page_token = pageToken;
  const data: SearchResponse = await callFeishu<SearchResponse>(ctx, {
    path: `/bitable/v1/apps/${appToken}/tables/${CUSTOMER_TABLE_ID}/records/search`,
    method: "POST",
    auth: "tenant",
    json: {},
    query,
    label: "Bitable list customers",
  });
  const nextRecords = records
    .concat((data.items ?? []).map((item) => mapFeishuItemToCustomer(item)))
    .slice(0, MAX_RECORDS);
  if (!data.has_more || !data.page_token || nextRecords.length >= MAX_RECORDS) {
    return nextRecords;
  }
  return fetchCustomerPage(ctx, appToken, data.page_token, nextRecords, pageCount + 1);
}

/**
 * On-login preload: page through every Customer row and return the slim
 * {@link CustomerRecord} projection. Tenant-token; read-only — the HARD RULE
 * is structural (this file does not import or call any write/update API).
 *
 * ADR-0013 caps the preload at {@link MAX_RECORDS} rows so a runaway table
 * cannot DoS the SPA; today the live table is ~250 rows.
 */
export const listCustomers = action({
  args: {},
  handler: async (ctx): Promise<{ records: CustomerRecord[]; generatedAt: number }> => {
    const appToken = requireAppToken();
    const records = await fetchCustomerPage(ctx, appToken, undefined, [], 0);
    const withFixtures = withDevCustomerFixtures(records);
    if (withFixtures[0]?.recordId === "dev_fixture_fanpc_customer") {
      console.log(
        `[dev-customer-fixture] TEST ONLY injected fanpc customer domain=fenchem.com rows=${withFixtures.length}`,
      );
    }
    return { records: withFixtures, generatedAt: Date.now() };
  },
});

/**
 * Per-keystroke server-side search — the fallback path used before the
 * directory finishes preloading, or for A/B comparison against the local Fuse
 * index (ADR-0013). A normalized `or` contains filter over searchable
 * Customer fields; takes the first page only.
 */
export const searchCustomers = action({
  args: { query: v.string() },
  handler: async (ctx, args): Promise<{ records: CustomerRecord[] }> => {
    const q = normalizeCustomerQuery(args.query);
    if (!q) return { records: [] };
    const appToken = requireAppToken();
    const data: SearchResponse = await callFeishu<SearchResponse>(ctx, {
      path: `/bitable/v1/apps/${appToken}/tables/${CUSTOMER_TABLE_ID}/records/search`,
      method: "POST",
      auth: "tenant",
      json: { filter: buildCustomerSearchFilter(q) },
      query: { page_size: String(SEARCH_FALLBACK_PAGE_SIZE) },
      label: "Bitable search customers",
    });
    const liveRecords = (data.items ?? []).map((item) => mapFeishuItemToCustomer(item));
    return { records: mergePreferredCustomers(searchDevCustomerFixtures(q), liveRecords) };
  },
});
