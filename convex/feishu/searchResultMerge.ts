import type { CustomerRecord } from "./customers";

// Merge a preferred set of Customers (today: dev fixtures) ahead of live search
// results, deduping by Bitable recordId and by canonicalized domain so a
// preferred row hides any live row that would collide on either. Pure — no I/O
// — so both the per-keystroke fallback (customers.ts) and the mirror search
// (customersMirror.ts) share one ordering+dedup contract.
export function mergePreferredCustomers(
  preferred: readonly CustomerRecord[],
  records: readonly CustomerRecord[],
): CustomerRecord[] {
  const preferredIds = new Set(preferred.map((customer) => customer.recordId));
  const preferredDomains = new Set(
    preferred.flatMap((customer) => {
      const domain = customer.domain?.trim().toLowerCase();
      return domain ? [domain] : [];
    }),
  );
  return [
    ...preferred,
    ...records.filter((customer) => {
      if (preferredIds.has(customer.recordId)) return false;
      const domain = customer.domain?.trim().toLowerCase();
      return domain === undefined || !preferredDomains.has(domain);
    }),
  ];
}
