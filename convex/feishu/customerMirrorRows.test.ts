// Pure unit tests for the Customer mirror row projection helpers (ADR-0016 /
// ADR-0019 extract-then-test seam). These shape data on the way IN (Feishu →
// Convex upsert row) and decide whether a refresh actually changed a row — the
// contract the `customers` search index and the unchanged-skip path read. No
// Convex runtime, no ./call mock: everything here is a pure function.

import { describe, expect, it } from "vitest";

import {
  buildSearchBlob,
  customerRowChanged,
  projectionToRow,
  type CustomerUpsertRow,
} from "./customerMirrorRows";

const FLORIAN = {
  recordId: "rec_florian",
  name: "Acme Chemicals",
  fullName: "Acme Chemicals International AG",
  accountNo: "ACME-001",
  domain: "acme.example",
  countryRegion: "Germany 德国",
  owner: { openId: "ou_florian", name: "Florian Meurer" },
};

describe("buildSearchBlob", () => {
  // The search index ranks against ONE column — the blob is the contract.
  // Anything searchable about a customer must end up in this string or it
  // becomes invisible to the server-index path.
  it("concatenates every searchable field into a single space-separated blob", () => {
    expect(buildSearchBlob(FLORIAN)).toContain("Acme Chemicals");
    expect(buildSearchBlob(FLORIAN)).toContain("Acme Chemicals International AG");
    expect(buildSearchBlob(FLORIAN)).toContain("ACME-001");
    expect(buildSearchBlob(FLORIAN)).toContain("acme.example");
    expect(buildSearchBlob(FLORIAN)).toContain("Germany");
    expect(buildSearchBlob(FLORIAN)).toContain("Florian Meurer");
  });

  // Optional fields are common (the dirty probe in ADR-0013 showed many
  // Customer rows carry only Account Name). They must drop out of the blob
  // cleanly — no "undefined" tokens, no empty placeholders.
  it("skips missing optional fields without emitting empty tokens", () => {
    const blob = buildSearchBlob({
      recordId: "rec_min",
      name: "tricogen",
      owner: null,
    });
    expect(blob).toBe("tricogen");
    expect(blob).not.toContain("undefined");
    expect(blob).not.toMatch(/\s{2,}/);
  });
});

describe("projectionToRow domainKey", () => {
  it("stamps the canonicalized domain alongside the raw display value", () => {
    const row = projectionToRow({ recordId: "rec_x", name: "X", domain: " Acme.COM ", owner: null });

    expect(row.domain).toBe(" Acme.COM ");
    expect(row.domainKey).toBe("acme.com");
  });

  it("leaves domainKey absent when the row has no domain", () => {
    const row = projectionToRow({ recordId: "rec_x", name: "X", owner: null });

    expect(row.domainKey).toBeUndefined();
  });
});

describe("customerRowChanged", () => {
  const base: CustomerUpsertRow = {
    recordId: "rec_same",
    name: "Same Customer",
    domain: "same.example",
    domainKey: "same.example",
    fullName: "Same Customer GmbH",
    accountNo: "SAME-001",
    countryRegion: "Germany",
    ownerOpenId: "ou_owner",
    ownerName: "Owner One",
    searchBlob: "Same Customer Same Customer GmbH SAME-001 same.example Germany Owner One",
  };

  it("reports no change for a field-identical row so refreshes skip the rewrite", () => {
    expect(customerRowChanged(base, { ...base })).toBe(false);
  });

  it("detects a changed display field", () => {
    expect(customerRowChanged(base, { ...base, name: "Renamed Customer" })).toBe(true);
    expect(customerRowChanged(base, { ...base, searchBlob: "different blob" })).toBe(true);
  });

  it("detects a re-stamped domainKey (the first sync after the column shipped)", () => {
    const legacy: CustomerUpsertRow = { ...base, domainKey: undefined };
    expect(customerRowChanged(legacy, base)).toBe(true);
  });

  it("detects a cleared optional column (explicit undefined vs a prior value)", () => {
    expect(customerRowChanged(base, { ...base, ownerOpenId: undefined, ownerName: undefined })).toBe(true);
  });
});
