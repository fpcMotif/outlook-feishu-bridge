import { describe, expect, it } from "vitest";

import {
  customerSearchEmptyMessage,
  filterLocalCustomers,
  getCustomerSearchEmptyKind,
  ownerFilter,
  ownerFilterApplies,
} from "./customerSearchHelpers";
import type { CustomerRecord } from "./customers";

function customer(index: number): CustomerRecord {
  return { recordId: `rec_${index}`, name: `Acme ${index}`, owner: null };
}

describe("customerSearchHelpers", () => {
  it("returns every text match (the display cap is the caller's job, ADR-0020)", () => {
    const records = Array.from({ length: 100 }, (_, index) => customer(index));

    const matches = filterLocalCustomers(records, "acme", false);

    expect(matches).toHaveLength(100);
  });

  it("returns nothing for an empty query when not filtering to mine", () => {
    const records = [customer(1)];

    expect(filterLocalCustomers(records, "", false)).toHaveLength(0);
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

  it("searches the full directory when Show mine is on but the query is non-empty", () => {
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

    expect(filterLocalCustomers([owned, other], "other", true, "ou_me")).toEqual([other]);
  });
});

describe("ownerFilterApplies", () => {
  it("is true only for Show mine with an empty query", () => {
    expect(ownerFilterApplies(true, "")).toBe(true);
    expect(ownerFilterApplies(true, "acme")).toBe(false);
    expect(ownerFilterApplies(false, "")).toBe(false);
  });
});

describe("ownerFilter", () => {
  it("returns mineFor only when owner browse mode is active", () => {
    expect(ownerFilter(true, "ou_me", "")).toEqual({ mineFor: "ou_me" });
    expect(ownerFilter(true, "ou_me", "acme")).toBeUndefined();
    expect(ownerFilter(false, "ou_me", "")).toBeUndefined();
  });
});

describe("customerSearchEmptyKind", () => {
  it("returns show-mine-no-owned when the owner filter is active with no query and no matches", () => {
    expect(getCustomerSearchEmptyKind("", true, 0)).toBe("show-mine-no-owned");
  });

  it("returns null when a query is active (search is directory-wide)", () => {
    expect(getCustomerSearchEmptyKind("acme", true, 0)).toBeNull();
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

  it("uses directory-wide no-match copy when searching with Show mine on", () => {
    expect(customerSearchEmptyMessage("beta", true, "beta")).toMatch(/no customers match/i);
    expect(customerSearchEmptyMessage("beta", true, "beta")).not.toMatch(/you own/i);
  });
});
