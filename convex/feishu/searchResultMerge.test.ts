// Unit tests for the single-home Customer search merge (ADR-0016). Pure — both
// the per-keystroke fallback (customers.ts) and the mirror search
// (customersMirror.ts) share this ordering + dedup contract.

import { describe, expect, it } from "vitest";

import type { CustomerRecord } from "./customers";
import { mergePreferredCustomers } from "./searchResultMerge";

function cust(recordId: string, domain?: string): CustomerRecord {
  return { recordId, name: recordId, domain, owner: null };
}

describe("mergePreferredCustomers", () => {
  it("places preferred records ahead of live results", () => {
    const merged = mergePreferredCustomers([cust("p1", "a.com")], [cust("r1", "b.com")]);
    expect(merged.map((c) => c.recordId)).toEqual(["p1", "r1"]);
  });

  it("drops a live record that collides on recordId", () => {
    const merged = mergePreferredCustomers([cust("dup", "a.com")], [cust("dup", "other.com")]);
    expect(merged.map((c) => c.recordId)).toEqual(["dup"]);
  });

  it("drops a live record colliding on canonical domain (trim + lowercase)", () => {
    const merged = mergePreferredCustomers(
      [cust("p1", " Fenchem.com ")],
      [cust("r1", "fenchem.com"), cust("r2", "keep.com")],
    );
    expect(merged.map((c) => c.recordId)).toEqual(["p1", "r2"]);
  });

  it("keeps live records that have no domain", () => {
    const merged = mergePreferredCustomers([cust("p1", "a.com")], [cust("r1", undefined)]);
    expect(merged.map((c) => c.recordId)).toEqual(["p1", "r1"]);
  });

  it("returns live records unchanged when there is no preferred set", () => {
    const live = [cust("r1", "a.com"), cust("r2", "b.com")];
    expect(mergePreferredCustomers([], live).map((c) => c.recordId)).toEqual(["r1", "r2"]);
  });
});
