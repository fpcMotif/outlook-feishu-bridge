import type { CustomerRecord, CustomerSearchOptions } from "./customers";
import { dtime } from "../../debug";

export function normalizedQuery(query: string): string {
  return query.trim().toLowerCase();
}

function customerMatchesText(customer: CustomerRecord, q: string): boolean {
  return (
    !q ||
    customer.name.toLowerCase().includes(q) ||
    (customer.fullName?.toLowerCase().includes(q) ?? false) ||
    (customer.accountNo?.toLowerCase().includes(q) ?? false) ||
    (customer.domain?.toLowerCase().includes(q) ?? false) ||
    (customer.owner?.name.toLowerCase().includes(q) ?? false)
  );
}

export function filterLocalCustomers(
  records: readonly CustomerRecord[],
  q: string,
  showMine: boolean,
  currentUserOpenId: string | undefined,
): CustomerRecord[] {
  if (!q && !showMine) return [];
  return records.filter((customer) => {
    const ownedByMe =
      !showMine ||
      (currentUserOpenId !== undefined && customer.owner?.openId === currentUserOpenId);
    return ownedByMe && customerMatchesText(customer, q);
  });
}

export function logLocalFilter(
  records: readonly CustomerRecord[],
  q: string,
  showMine: boolean,
  currentUserOpenId: string | undefined,
): CustomerRecord[] {
  const started = performance.now();
  const matches = filterLocalCustomers(records, q, showMine, currentUserOpenId);
  dtime(
    `customer picker: local filter "${q.slice(0, 40)}"${showMine ? " +mine" : ""} -> ${matches.length}/${records.length}`,
    started,
  );
  return matches;
}

export function ownerFilter(
  showMine: boolean,
  currentUserOpenId: string | undefined,
): CustomerSearchOptions | undefined {
  return showMine && currentUserOpenId !== undefined ? { mineFor: currentUserOpenId } : undefined;
}

export type CustomerSearchEmptyKind = "show-mine-no-owned" | "show-mine-no-match";

export function getCustomerSearchEmptyKind(
  q: string,
  showMine: boolean,
  matchCount: number,
): CustomerSearchEmptyKind | null {
  if (matchCount > 0 || !showMine) return null;
  return q ? "show-mine-no-match" : "show-mine-no-owned";
}

export function customerSearchEmptyMessage(
  q: string,
  showMine: boolean,
  rawQuery: string,
): string {
  if (showMine && !q) return "You don't have any customers assigned to you.";
  if (showMine && q) return `No customers you own match "${rawQuery.trim()}".`;
  if (q) return `No customers match "${rawQuery.trim()}"`;
  return "No customers found.";
}
