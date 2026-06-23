import { cjkBigramBlob } from "./cjkSearch";
import { canonicalCustomerDomain, type CustomerRecord } from "./customers";

export interface CustomerUpsertRow {
  recordId: string;
  name: string;
  domain?: string;
  // Canonicalized `domain` (canonicalCustomerDomain) — the by_domainKey index
  // key matchByEmail probes. Stamped at projection time so EVERY write path
  // (full sync, cache-miss backfills) keeps it consistent with `domain`.
  domainKey?: string;
  fullName?: string;
  accountNo?: string;
  countryRegion?: string;
  ownerOpenId?: string;
  ownerName?: string;
  searchBlob: string;
}

export interface CustomerMirrorDoc {
  recordId: string;
  name: string;
  domain?: string;
  fullName?: string;
  accountNo?: string;
  countryRegion?: string;
  ownerOpenId?: string;
  ownerName?: string;
}

// Build the single searchable text column. Convex's search index ranks tokens
// across one column; concatenating the searchable fields gives salespeople
// "type anything that identifies the Customer" behavior.
//
// We append per-field CJK character bigrams after the plain concatenation so
// substring / cross-punctuation queries over Chinese names also match — Convex's
// SimpleTokenizer otherwise indexes each CJK run as a single prefix-only token
// (see cjkSearch.ts). Latin tokens are untouched and keep prefix matching.
export function buildSearchBlob(customer: CustomerRecord): string {
  const fields = [
    customer.name,
    customer.fullName ?? "",
    customer.accountNo ?? "",
    customer.domain ?? "",
    customer.countryRegion ?? "",
    customer.owner?.name ?? "",
  ].filter(Boolean);
  const base = fields.join(" ");
  const bigrams = fields
    .flatMap((field) => {
      const blob = cjkBigramBlob(field);
      return blob ? [blob] : [];
    })
    .join(" ");
  return bigrams ? `${base} ${bigrams}` : base;
}

export function projectionToRow(customer: CustomerRecord): CustomerUpsertRow {
  return {
    recordId: customer.recordId,
    name: customer.name,
    domain: customer.domain,
    domainKey: canonicalCustomerDomain(customer.domain) ?? undefined,
    fullName: customer.fullName,
    accountNo: customer.accountNo,
    countryRegion: customer.countryRegion,
    ownerOpenId: customer.owner?.openId,
    ownerName: customer.owner?.name,
    searchBlob: buildSearchBlob(customer),
  };
}

export function dedupeRowsByRecordId(
  rows: readonly CustomerUpsertRow[],
): CustomerUpsertRow[] {
  return [...new Map(rows.map((row) => [row.recordId, row])).values()];
}

// Field-by-field equality of a mirror upsert against the row already stored, so
// a full refresh only rewrites the search index when something actually moved.
export function customerRowChanged(
  existing: CustomerUpsertRow,
  next: CustomerUpsertRow,
): boolean {
  return (
    existing.recordId !== next.recordId ||
    existing.name !== next.name ||
    existing.domain !== next.domain ||
    // domainKey participates so the first full sync after the column shipped
    // re-stamps every row (undefined !== canonical value). The applyPage
    // explicit-undefined spread also triggers this check when a cell is cleared.
    existing.domainKey !== next.domainKey ||
    existing.fullName !== next.fullName ||
    existing.accountNo !== next.accountNo ||
    existing.countryRegion !== next.countryRegion ||
    existing.ownerOpenId !== next.ownerOpenId ||
    existing.ownerName !== next.ownerName ||
    existing.searchBlob !== next.searchBlob
  );
}

export function mirrorDocToCustomer(hit: CustomerMirrorDoc): CustomerRecord {
  return {
    recordId: hit.recordId,
    name: hit.name,
    domain: hit.domain,
    fullName: hit.fullName,
    accountNo: hit.accountNo,
    countryRegion: hit.countryRegion,
    owner:
      hit.ownerOpenId === undefined ? null : { openId: hit.ownerOpenId, name: hit.ownerName ?? "" },
  };
}
