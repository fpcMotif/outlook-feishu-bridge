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

export interface CustomerSearchOptions {
  mineFor?: string;
}

const CUSTOMER_DOMAIN_ALIASES: Record<string, string> = {
  "microsoftonline.com": "microsoft.com",
};

export function findCustomerByEmail<R extends { domain?: string }>(
  directory: readonly R[],
  email: string,
): R | null {
  return findCustomerByDomain(directory, emailDomain(email));
}

export function findCustomerByDomain<R extends { domain?: string }>(
  directory: readonly R[],
  domain: string | undefined | null,
): R | null {
  const target = canonicalCustomerDomain(domain);
  if (!target) return null;
  return (
    directory.find((customer) => canonicalCustomerDomain(customer.domain) === target) ?? null
  );
}

function canonicalCustomerDomain(domain: string | undefined | null): string | null {
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
