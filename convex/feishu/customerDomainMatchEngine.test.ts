// Unit tests for the domain-match cache-miss engine — the strict-canonical
// paging strategy driven through an in-memory fake port, no Convex. This is the
// seam the extraction buys: what used to live inline in the matchEmailAndCacheMiss
// action (a `contains`-filter page walk that must reject superstring domains) is
// pinned here directly.

import { describe, expect, it } from "vitest";

import {
  runDomainMatchCacheMiss,
  type DomainMatchPage,
  type DomainMatchPort,
} from "./customerDomainMatchEngine";

interface FakeRecord {
  recordId: string;
  domain?: string;
}

function rec(recordId: string, domain?: string): FakeRecord {
  return { recordId, domain };
}

// A fake port that hands back the supplied pages in order, recording how many
// times it was asked and with which page token.
function makeFakePort(pages: DomainMatchPage<FakeRecord>[]) {
  const tokens: (string | undefined)[] = [];
  let index = 0;
  const port: DomainMatchPort<FakeRecord> = {
    fetchPage: (pageToken) => {
      tokens.push(pageToken);
      const page = pages[index] ?? { records: [], hasMore: false };
      index += 1;
      return Promise.resolve(page);
    },
  };
  return { port, tokens, fetched: () => index };
}

describe("runDomainMatchCacheMiss", () => {
  it("returns the strict canonical match from a single page", async () => {
    const fake = makeFakePort([
      { records: [rec("rec_acme", "acme.com")], hasMore: false },
    ]);
    const out = await runDomainMatchCacheMiss(fake.port, {
      email: "buyer@acme.com",
      maxPages: 3,
    });
    expect(out.customer).toEqual(rec("rec_acme", "acme.com"));
    expect(out.allRecords).toEqual([rec("rec_acme", "acme.com")]);
    expect(fake.fetched()).toBe(1);
  });

  it("never auto-matches a superstring domain (contains pulls in notacme.com for acme.com)", async () => {
    const fake = makeFakePort([
      { records: [rec("rec_not", "notacme.com")], hasMore: false },
    ]);
    const out = await runDomainMatchCacheMiss(fake.port, {
      email: "buyer@acme.com",
      maxPages: 3,
    });
    expect(out.customer).toBeNull();
    // The superstring row is still returned so the adapter can backfill it.
    expect(out.allRecords).toEqual([rec("rec_not", "notacme.com")]);
  });

  it("pages past superstring rows on page 1 and matches on page 2", async () => {
    const fake = makeFakePort([
      { records: [rec("rec_not", "notacme.com")], hasMore: true, pageToken: "p2" },
      { records: [rec("rec_acme", "acme.com")], hasMore: false },
    ]);
    const out = await runDomainMatchCacheMiss(fake.port, {
      email: "buyer@acme.com",
      maxPages: 3,
    });
    expect(out.customer).toEqual(rec("rec_acme", "acme.com"));
    // Accumulates every row across both pages for the backfill.
    expect(out.allRecords).toEqual([
      rec("rec_not", "notacme.com"),
      rec("rec_acme", "acme.com"),
    ]);
    expect(fake.tokens).toEqual([undefined, "p2"]);
    expect(fake.fetched()).toBe(2);
  });

  it("stops once a match is found without fetching further pages", async () => {
    const fake = makeFakePort([
      { records: [rec("rec_acme", "acme.com")], hasMore: true, pageToken: "p2" },
      { records: [rec("rec_extra", "acme.com")], hasMore: false },
    ]);
    const out = await runDomainMatchCacheMiss(fake.port, {
      email: "buyer@acme.com",
      maxPages: 3,
    });
    expect(out.customer).toEqual(rec("rec_acme", "acme.com"));
    // Page 2 is never fetched — the match short-circuits the walk.
    expect(fake.fetched()).toBe(1);
  });

  it("caps the walk at maxPages even while Feishu keeps reporting has_more", async () => {
    const fake = makeFakePort([
      { records: [rec("r1", "notacme.com")], hasMore: true, pageToken: "p2" },
      { records: [rec("r2", "notacme.com")], hasMore: true, pageToken: "p3" },
      { records: [rec("r3", "notacme.com")], hasMore: true, pageToken: "p4" },
      { records: [rec("r4", "acme.com")], hasMore: false },
    ]);
    const out = await runDomainMatchCacheMiss(fake.port, {
      email: "buyer@acme.com",
      maxPages: 3,
    });
    // The exact match sits on page 4, past the cap — so it is never reached.
    expect(out.customer).toBeNull();
    expect(out.allRecords).toHaveLength(3);
    expect(fake.fetched()).toBe(3);
  });

  it("stops when Feishu reports no more pages even though no match was found", async () => {
    const fake = makeFakePort([
      { records: [rec("r1", "notacme.com")], hasMore: true, pageToken: "p2" },
      { records: [rec("r2", "alsoacme.org")], hasMore: false },
    ]);
    const out = await runDomainMatchCacheMiss(fake.port, {
      email: "buyer@acme.com",
      maxPages: 3,
    });
    expect(out.customer).toBeNull();
    expect(fake.fetched()).toBe(2);
  });

  it("stops when has_more is true but the next page token is missing", async () => {
    const fake = makeFakePort([
      { records: [rec("r1", "notacme.com")], hasMore: true, pageToken: undefined },
      { records: [rec("r2", "acme.com")], hasMore: false },
    ]);
    const out = await runDomainMatchCacheMiss(fake.port, {
      email: "buyer@acme.com",
      maxPages: 3,
    });
    // A truncated has_more with no token cannot advance — stop rather than re-fetch page 1.
    expect(out.customer).toBeNull();
    expect(fake.fetched()).toBe(1);
  });
});
