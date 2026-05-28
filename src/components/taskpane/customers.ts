// Frontend-side Customer types. The Convex `listCustomers` action returns rows
// of this exact shape (its server-side `CustomerRecord` interface mirrors this)
// — keeping a parallel SPA-side type avoids importing across the Convex/SPA
// boundary just for a value type. The Coworker type uses the same pattern in
// coworkers.ts.

export interface CustomerRecord {
  recordId: string;
  name: string;
  domain?: string;
  fullName?: string;
  accountNo?: string;
  countryRegion?: string;
  owner: { openId: string; name: string } | null;
}

export type CustomerDirectoryStatus = "idle" | "loading" | "ready" | "error";

export interface CustomerDirectoryState {
  status: CustomerDirectoryStatus;
  records: CustomerRecord[];
}

export function findCustomerByEmail<R extends { domain?: string }>(
  directory: readonly R[],
  email: string,
): R | null {
  const target = emailDomain(email);
  if (!target) return null;
  return (
    directory.find((customer) =>
      typeof customer.domain === "string" && customer.domain.toLowerCase() === target,
    ) ?? null
  );
}

function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0 || at === email.length - 1) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return domain || null;
}
