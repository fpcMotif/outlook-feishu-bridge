// Unit tests for the Customer-search engine — the mirror-first / live-fallback
// strategy driven through an in-memory fake port, no Convex. This is the seam
// the extraction buys: what used to be untestable client-side decision logic
// (mirror miss ⇒ live + backfill) is pinned here directly.

import { describe, expect, it } from "vitest";

import { runCustomerSearch, type CustomerSearchPort } from "./customerSearchEngine";

interface FakeRecord {
  recordId: string;
}

function rec(id: string): FakeRecord {
  return { recordId: id };
}

function makeFakePort(opts: {
  mirrorRecords?: FakeRecord[];
  mirroredAt?: number | null;
  liveRecords?: FakeRecord[];
  backfilled?: number;
}) {
  const calls: string[] = [];
  const port: CustomerSearchPort<FakeRecord> = {
    mirrorSearch: (q, mineFor) => {
      calls.push(`mirror:${q}:${mineFor ?? "<all>"}`);
      return Promise.resolve({
        records: opts.mirrorRecords ?? [],
        mirroredAt: opts.mirroredAt ?? null,
      });
    },
    liveSearch: (q, mineFor) => {
      calls.push(`live:${q}:${mineFor ?? "<all>"}`);
      return Promise.resolve({
        records: opts.liveRecords ?? [],
        backfilled: opts.backfilled ?? 0,
      });
    },
  };
  return { port, calls };
}

describe("runCustomerSearch", () => {
  it("answers a too-short query empty without touching either leg", async () => {
    const fake = makeFakePort({ mirrorRecords: [rec("never")] });
    const out = await runCustomerSearch(fake.port, { q: " a ", minLength: 2 });
    expect(out).toEqual({ records: [], source: "mirror", backfilled: 0, mirroredAt: null });
    expect(fake.calls).toEqual([]);
  });

  it("a mirror hit never pays the live leg", async () => {
    const fake = makeFakePort({ mirrorRecords: [rec("rec_acme")], mirroredAt: 1_234 });
    const out = await runCustomerSearch(fake.port, { q: "Acme", minLength: 2 });
    expect(out.source).toBe("mirror");
    expect(out.records).toEqual([rec("rec_acme")]);
    expect(out.mirroredAt).toBe(1_234);
    expect(out.backfilled).toBe(0);
    expect(fake.calls).toEqual(["mirror:Acme:<all>"]);
  });

  it("a mirror miss falls through to the live leg and reports its backfill", async () => {
    const fake = makeFakePort({
      mirrorRecords: [],
      mirroredAt: 9_000,
      liveRecords: [rec("rec_new")],
      backfilled: 1,
    });
    const out = await runCustomerSearch(fake.port, { q: "Newco", minLength: 2 });
    expect(out.source).toBe("live");
    expect(out.records).toEqual([rec("rec_new")]);
    expect(out.backfilled).toBe(1);
    // The watermark still describes the mirror that missed.
    expect(out.mirroredAt).toBe(9_000);
    expect(fake.calls).toEqual(["mirror:Newco:<all>", "live:Newco:<all>"]);
  });

  it("an empty live answer is still a live-sourced outcome (the caller's negative cache keys on this)", async () => {
    const fake = makeFakePort({ liveRecords: [], backfilled: 0 });
    const out = await runCustomerSearch(fake.port, { q: "ghost", minLength: 2 });
    expect(out.source).toBe("live");
    expect(out.records).toEqual([]);
  });

  it("trims the query before both legs and passes mineFor through", async () => {
    const fake = makeFakePort({ mirrorRecords: [], liveRecords: [] });
    await runCustomerSearch(fake.port, { q: "  Acme GmbH  ", mineFor: "ou_me", minLength: 2 });
    expect(fake.calls).toEqual(["mirror:Acme GmbH:ou_me", "live:Acme GmbH:ou_me"]);
  });
});
