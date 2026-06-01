// Shared email/Customer domain normalization. The pure auto-match (ADR-0013)
// compares an email's domain against the Customer's `域名` projection, both
// canonicalized through these helpers so the on-login preload (customers.ts),
// the server-indexed mirror (customersMirror.ts), and any future caller agree
// byte-for-byte. The match is intentionally strict (no suffix or fuzzy
// heuristics) — silently picking the wrong Customer is worse than no match.

const CUSTOMER_DOMAIN_ALIASES: Record<string, string> = {
  "microsoftonline.com": "microsoft.com",
};

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
