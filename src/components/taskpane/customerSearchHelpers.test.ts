import { describe, expect, it } from "vitest";

import {
  customerSearchEmptyMessage,
  filterLocalCustomers,
  getCustomerSearchEmptyKind,
} from "./customerSearchHelpers";
import type { CustomerRecord } from "./customers";

function customer(index: number): CustomerRecord {
  return { recordId: `rec_${index}`, name: `Acme ${index}`, owner: null };
}

describe("customerSearchHelpers", () => {
  it("returns every text match (the display cap is the caller's job, ADR-0020)", () => {
    const records = Array.from({ length: 100 }, (_, index) => customer(index));

    const matches = filterLocalCustomers(records, "acme", false, undefined);

    expect(matches).toHaveLength(100);
  });

  it("returns nothing for an empty query when not filtering to mine", () => {
    const records = [customer(1)];

    expect(filterLocalCustomers(records, "", false, undefined)).toHaveLength(0);
  });

  it("returns owned customers when Show mine is on with no query", () => {
    const owned = {
      recordId: "rec_owned",
      name: "Owned Co",
      owner: { openId: "ou_me", name: "Me" },
    };
    const other = {
      recordId: "rec_other",
      name: "Other Co",
      owner: { openId: "ou_other", name: "Other" },
    };

    expect(filterLocalCustomers([owned, other], "", true, "ou_me")).toEqual([owned]);
  });
});

describe("customerSearchEmptyKind", () => {
  it("returns show-mine-no-owned when the owner filter is active with no query and no matches", () => {
    expect(getCustomerSearchEmptyKind("", true, 0)).toBe("show-mine-no-owned");
  });

  it("returns show-mine-no-match when the owner filter is active with a query and no matches", () => {
    expect(getCustomerSearchEmptyKind("acme", true, 0)).toBe("show-mine-no-match");
  });

  it("returns null when there are matches or Show mine is off", () => {
    expect(getCustomerSearchEmptyKind("", true, 1)).toBeNull();
    expect(getCustomerSearchEmptyKind("acme", false, 0)).toBeNull();
  });
});

describe("customerSearchEmptyMessage", () => {
  it("explains the Show mine filter when there are no owned customers", () => {
    expect(customerSearchEmptyMessage("", true, "")).toMatch(/don't have any customers assigned/i);
  });

  it("explains query misses under Show mine", () => {
    expect(customerSearchEmptyMessage("beta", true, "beta")).toMatch(/you own match/i);
  });
});
