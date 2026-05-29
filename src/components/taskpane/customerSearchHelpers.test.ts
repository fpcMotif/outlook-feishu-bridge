// Pure-fn coverage for customerSearchHelpers.ts — normalizedQuery,
// filterLocalCustomers (and its private customerMatchesText), ownerFilter, and
// logLocalFilter (which only wraps filterLocalCustomers + dtime). The debug
// module is mocked so we can assert logLocalFilter delegates to dtime without
// touching the real on-screen buffer.

import { describe, expect, it, vi } from "vitest";

import type { CustomerRecord } from "./customers";

const dtimeMock = vi.fn((_label: string, _start: number) => 0);
vi.mock("../../debug", () => ({ dtime: (...args: unknown[]) => dtimeMock(...(args as [string, number])) }));

import {
  filterLocalCustomers,
  logLocalFilter,
  normalizedQuery,
  ownerFilter,
} from "./customerSearchHelpers";

function customer(overrides: Partial<CustomerRecord> = {}): CustomerRecord {
  return {
    recordId: "rec_1",
    name: "Acme Corp",
    owner: { openId: "ou_me", name: "Jenny" },
    ...overrides,
  };
}

describe("normalizedQuery", () => {
  it("trims surrounding whitespace and lowercases", () => {
    expect(normalizedQuery("  HeLLo World  ")).toBe("hello world");
  });

  it("returns '' for a whitespace-only query", () => {
    expect(normalizedQuery("   ")).toBe("");
  });
});

describe("filterLocalCustomers", () => {
  it("returns [] when q is empty AND showMine is false (early return)", () => {
    expect(filterLocalCustomers([customer()], "", false, "ou_me")).toEqual([]);
  });

  it("matches on name", () => {
    const c = customer({ name: "Bayer Pharma" });
    expect(filterLocalCustomers([c], "bayer", false, undefined)).toEqual([c]);
  });

  it("matches on fullName (and its ?? false arm leaves non-matching records out)", () => {
    const hit = customer({ recordId: "h", name: "X", fullName: "Bayer Pharma AG" });
    const miss = customer({ recordId: "m", name: "Y" }); // fullName undefined -> ?? false
    expect(filterLocalCustomers([hit, miss], "pharma ag", false, undefined)).toEqual([hit]);
  });

  it("matches on accountNo", () => {
    const c = customer({ name: "X", accountNo: "ACC-007" });
    expect(filterLocalCustomers([c], "acc-007", false, undefined)).toEqual([c]);
  });

  it("matches on domain", () => {
    const c = customer({ name: "X", domain: "bayer.de" });
    expect(filterLocalCustomers([c], "bayer.de", false, undefined)).toEqual([c]);
  });

  it("matches on owner.name (and the owner?.name ?? false arm excludes owner=null)", () => {
    const hit = customer({ recordId: "h", name: "X", owner: { openId: "ou_a", name: "Jennifer" } });
    const miss = customer({ recordId: "m", name: "Y", owner: null });
    expect(filterLocalCustomers([hit, miss], "jennifer", false, undefined)).toEqual([hit]);
  });

  it("returns no records for a query that matches none of the fields", () => {
    const c = customer({ name: "Acme", fullName: "Acme Co", accountNo: "1", domain: "acme.com" });
    expect(filterLocalCustomers([c], "zzz-nomatch", false, undefined)).toEqual([]);
  });

  it("with showMine=true + a currentUserOpenId, keeps only records owned by that open_id", () => {
    const mine = customer({ recordId: "mine", owner: { openId: "ou_me", name: "Me" } });
    const theirs = customer({ recordId: "theirs", owner: { openId: "ou_other", name: "Other" } });
    expect(filterLocalCustomers([mine, theirs], "", true, "ou_me")).toEqual([mine]);
  });

  it("with showMine=true but currentUserOpenId undefined returns no records", () => {
    const mine = customer({ owner: { openId: "ou_me", name: "Me" } });
    expect(filterLocalCustomers([mine], "", true, undefined)).toEqual([]);
  });

  it("with empty q but showMine=true returns all owned records (!q arm of customerMatchesText)", () => {
    const a = customer({ recordId: "a", owner: { openId: "ou_me", name: "Me" } });
    const b = customer({ recordId: "b", name: "totally-different", owner: { openId: "ou_me", name: "Me" } });
    expect(filterLocalCustomers([a, b], "", true, "ou_me")).toEqual([a, b]);
  });

  it("excludes a record with owner=null when showMine=true (owner?.openId guard)", () => {
    const ownerless = customer({ owner: null });
    expect(filterLocalCustomers([ownerless], "", true, "ou_me")).toEqual([]);
  });
});

describe("ownerFilter", () => {
  it("returns {mineFor} when showMine && currentUserOpenId is set", () => {
    expect(ownerFilter(true, "ou_me")).toEqual({ mineFor: "ou_me" });
  });

  it("returns undefined when showMine is false", () => {
    expect(ownerFilter(false, "ou_me")).toBeUndefined();
  });

  it("returns undefined when currentUserOpenId is undefined even if showMine is true", () => {
    expect(ownerFilter(true, undefined)).toBeUndefined();
  });
});

describe("logLocalFilter", () => {
  it("returns the same result as filterLocalCustomers and calls dtime once", () => {
    dtimeMock.mockClear();
    const mine = customer({ recordId: "mine", owner: { openId: "ou_me", name: "Me" } });
    const records = [mine, customer({ recordId: "x", owner: { openId: "ou_x", name: "X" } })];

    const result = logLocalFilter(records, "", true, "ou_me");

    expect(result).toEqual(filterLocalCustomers(records, "", true, "ou_me"));
    expect(result).toEqual([mine]);
    expect(dtimeMock).toHaveBeenCalledTimes(1);
    // The label encodes the +mine suffix and the matched/total ratio.
    expect(dtimeMock.mock.calls[0][0]).toContain("+mine");
    expect(dtimeMock.mock.calls[0][0]).toContain("-> 1/2");
  });

  it("omits the +mine suffix in the dtime label when showMine is false", () => {
    dtimeMock.mockClear();
    logLocalFilter([customer({ name: "Acme" })], "acme", false, undefined);
    expect(dtimeMock.mock.calls[0][0]).not.toContain("+mine");
  });
});
