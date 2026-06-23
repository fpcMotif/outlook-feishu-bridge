// The Customer domain-match cache-miss engine (ADR-0016 amendment) — the PURE
// paging strategy for the on-demand "match this email's domain to a Customer"
// probe, behind a port (the ADR-0019 seam, same shape as customerSearchEngine.ts).
//
// matchByEmail answers from the mirror's by_domainKey index. On a miss the SPA
// asks for a live probe (matchEmailAndCacheMiss): page the Customer Table by
// `域名 contains <domain>` until a STRICT canonical match is found, or the pages
// run out. Strictness is the whole point — a `contains` filter pulls in
// superstring domains (notacme.com for acme.com) that belong in the mirror (so
// the caller backfills every row it sees) but must NEVER auto-match the email.
//
// No ctx, no db, no I/O: the Convex adapter (customersMirror.matchEmailAndCacheMiss)
// owns the per-domain cooldown gate, the effectful page fetch, and the mirror
// backfill; tests drive an in-memory fake port (customerDomainMatchEngine.test.ts).

import { findCustomerByEmail } from "./customers";

export interface DomainMatchPage<R> {
  records: R[];
  /** Feishu has_more for this page — false/absent means no further pages. */
  hasMore: boolean;
  /** The page_token to fetch the NEXT page, when has_more is true. */
  pageToken?: string;
}

export interface DomainMatchPort<R> {
  /**
   * One filtered `域名 contains <domain>` page. `pageToken` is undefined for the
   * first page and otherwise the token returned by the previous page.
   */
  fetchPage: (pageToken?: string) => Promise<DomainMatchPage<R>>;
}

export interface DomainMatchOutcome<R> {
  /** The strict canonical match for the email, or null if none across the pages. */
  customer: R | null;
  /** Every row seen across the probe, so the adapter can backfill the mirror with them. */
  allRecords: R[];
}

// Page the domain filter until a strict canonical match is found or the pages
// run out (≤ args.maxPages). The caller is responsible for the email's domain
// being matchable (the adapter gates on canonicalCustomerDomain before probing).
export async function runDomainMatchCacheMiss<R extends { domain?: string }>(
  port: DomainMatchPort<R>,
  args: { email: string; maxPages: number },
): Promise<DomainMatchOutcome<R>> {
  const allRecords: R[] = [];
  let pageToken: string | undefined;
  let customer: R | null = null;
  for (let page = 0; page < args.maxPages; page++) {
    const result = await port.fetchPage(pageToken);
    allRecords.push(...result.records);
    // Strict canonical equality (findCustomerByEmail), NOT "first row returned":
    // `contains` can pull in superstring domains (e.g. notacme.com for acme.com)
    // that belong in the mirror but must not auto-match this email.
    customer = findCustomerByEmail(allRecords, args.email);
    if (customer !== null || !result.hasMore || !result.pageToken) break;
    pageToken = result.pageToken;
  }
  return { customer, allRecords };
}
