import type { CustomerRecord } from "./customers";

export interface CustomerUpsertRow {
  recordId: string;
  name: string;
  domain?: string;
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
export function buildSearchBlob(customer: CustomerRecord): string {
  return [
    customer.name,
    customer.fullName ?? "",
    customer.accountNo ?? "",
    customer.domain ?? "",
    customer.countryRegion ?? "",
    customer.owner?.name ?? "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function projectionToRow(customer: CustomerRecord): CustomerUpsertRow {
  return {
    recordId: customer.recordId,
    name: customer.name,
    domain: customer.domain,
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
