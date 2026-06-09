// Unit tests for the pure Feishu→Customer projection mapper. The Customer Table
// (tbl4TE2GV472sKzp) returns Text fields as rich-text arrays [{text,type}] and
// User fields as arrays of {id,name,...}. The SPA wants a flat, slim projection
// (ADR-0013). The mapper has no Convex/IO dependencies so it is unit-tested in
// isolation.

import { describe, expect, it } from "vitest";

import {
  findCustomerByEmail,
  mapFeishuItemToCustomer,
  recordIdFromCustomerInfoRow,
  type CustomerRecord,
} from "./customers";

// One real shape sampled live from the Customer Table on 2026-05-28 (the dirty
// probe in the grilling session for ADR-0013) — captured here so the test
// guards against schema-drift surprises in the live table. The "Record Id"
// column is deliberately set to a value that DIVERGES from `record_id` so the
// test proves the projection keys on the immutable API id, not the human column.
const STOCKMEIER_ITEM = {
  record_id: "rec27inYHPqxyZ",
  fields: {
    "Account Name": [{ text: "STOCKMEIER Chemie GmbH & Co. KG", type: "text" }],
    "Record Id": [{ text: "recFromVisibleColumn", type: "text" }],
    "Country and Regio": "Germany 德国",
    Owner: [
      {
        email: "florianm@fenchem.com",
        en_name: "Florian Meurer",
        id: "ou_e961742edc33cc61fc1f3dba06d87b42",
        name: "Florian Meurer",
      },
    ],
    "Sales Service": { link_record_ids: ["rec27r5PGZZAXU"] },
  },
};

describe("mapFeishuItemToCustomer", () => {
  // ADR-0021: the dedup/identity key is the immutable API `record_id`, NOT the
  // user-facing "Record Id" column. Here they diverge, so this pins that the
  // human column never re-keys the mirror or the DuplexLink target.
  it("keys recordId on the immutable API record_id, ignoring the human `Record Id` column", () => {
    const customer = mapFeishuItemToCustomer(STOCKMEIER_ITEM);
    expect(customer.recordId).toBe("rec27inYHPqxyZ");
    expect(customer.recordId).not.toBe("recFromVisibleColumn");
    expect(customer.name).toBe("STOCKMEIER Chemie GmbH & Co. KG");
  });

  it("uses the API record_id even when the row carries no `Record Id` column", () => {
    const customer = mapFeishuItemToCustomer({
      record_id: "rec27inYHPqxOw",
      fields: { "Account Name": [{ text: "tricogen", type: "text" }] },
    });
    expect(customer.recordId).toBe("rec27inYHPqxOw");
  });

  // Many Customer rows in the live table carry only Account Name (the dirty
  // probe showed `tricogen` had no domain/fullName/accountNo/Owner/Country).
  // The mapper must leave those optional projection fields as `undefined`
  // rather than empty strings so the SPA can distinguish "absent" from
  // "blank" when rendering the picker.
  it("returns undefined (not '') for optional fields when the Feishu row omits them", () => {
    const customer = mapFeishuItemToCustomer({
      record_id: "rec27inYHPqxOw",
      fields: { "Account Name": [{ text: "tricogen", type: "text" }] },
    });
    expect(customer.domain).toBeUndefined();
    expect(customer.fullName).toBeUndefined();
    expect(customer.accountNo).toBeUndefined();
    expect(customer.countryRegion).toBeUndefined();
    expect(customer.owner).toBeNull();
  });

  // Verified shapes for User and SingleSelect fields from the same live probe.
  it("projects Owner first user to {openId,name} and passes SingleSelect Country through", () => {
    const customer = mapFeishuItemToCustomer(STOCKMEIER_ITEM);
    expect(customer.owner).toEqual({
      openId: "ou_e961742edc33cc61fc1f3dba06d87b42",
      name: "Florian Meurer",
    });
    expect(customer.countryRegion).toBe("Germany 德国");
  });
});

// The human "Record Id" column is demoted to a DISPLAY-ONLY projection
// (ADR-0021). The helper still reads it (with API fallback) so a surface can
// show the human value, but it must never be the identity key — these tests pin
// both that contract and the fact that it CAN diverge from the API id.
describe("recordIdFromCustomerInfoRow (display-only)", () => {
  it("reads the user-facing `Record Id` column when present", () => {
    expect(recordIdFromCustomerInfoRow(STOCKMEIER_ITEM)).toBe("recFromVisibleColumn");
  });

  it("falls back to the API record_id when the `Record Id` column is absent", () => {
    expect(
      recordIdFromCustomerInfoRow({
        record_id: "rec27inYHPqxOw",
        fields: { "Account Name": [{ text: "tricogen", type: "text" }] },
      }),
    ).toBe("rec27inYHPqxOw");
  });

  it("is decoupled from the identity key the mapper assigns", () => {
    // Same row: the display helper yields the human column while the mapper keys
    // identity on the API id — proving the two are intentionally independent.
    expect(recordIdFromCustomerInfoRow(STOCKMEIER_ITEM)).not.toBe(
      mapFeishuItemToCustomer(STOCKMEIER_ITEM).recordId,
    );
  });
});

// ADR-0013 fixes the auto-match rule as exact equality, case-insensitive,
// between the email's domain and the Customer's `域名` projection.
// `findCustomerByEmail` is the pure helper that both the UI and any
// server-side fallback can call.
describe("findCustomerByEmail", () => {
  const bayer: CustomerRecord = {
    recordId: "rec_bayer",
    name: "Bayer Pharma",
    domain: "bayerpharma.de",
    owner: null,
  };
  const stockmeier: CustomerRecord = {
    recordId: "rec_stock",
    name: "STOCKMEIER Chemie GmbH & Co. KG",
    domain: "stockmeier.com",
    owner: null,
  };
  const customerless: CustomerRecord = {
    recordId: "rec_x",
    name: "no-domain",
    owner: null,
  };
  const directory: CustomerRecord[] = [bayer, stockmeier, customerless];

  it("finds a Customer whose domain equals the email's domain", () => {
    expect(findCustomerByEmail(directory, "m.hoffmann@bayerpharma.de")).toBe(bayer);
  });

  it("matches case-insensitively on both sides", () => {
    expect(findCustomerByEmail(directory, "M.HOFFMANN@BayerPharma.DE")).toBe(bayer);
  });

  it("returns null when no domain matches", () => {
    expect(findCustomerByEmail(directory, "anyone@unknown-domain.io")).toBeNull();
  });

  it("returns null for malformed emails instead of guessing", () => {
    expect(findCustomerByEmail(directory, "not-an-email")).toBeNull();
    expect(findCustomerByEmail(directory, "")).toBeNull();
  });

  it("skips Customers without a `域名` value rather than crashing", () => {
    expect(findCustomerByEmail(directory, "anyone@no-domain.tld")).toBeNull();
  });
});

describe("findCustomerByEmail domain aliases", () => {
  it("maps known Microsoft sender domains to the Microsoft Customer domain", () => {
    const microsoft: CustomerRecord = {
      recordId: "rec_microsoft",
      name: "Microsoft",
      domain: "microsoft.com",
      owner: null,
    };
    expect(findCustomerByEmail([microsoft], "alerts@microsoftonline.com")).toBe(microsoft);
  });
});
