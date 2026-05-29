// Pure-fn coverage for customers.ts — emailDomain + findCustomerByEmail. The
// match rule is case-insensitive domain equality against the directory's
// `.domain` field.

import { describe, expect, it } from "vitest";

import { emailDomain, findCustomerByEmail } from "./customers";

const BAYER = { recordId: "rec_bayer", name: "Bayer Pharma", domain: "bayerpharma.de", owner: null };
const STOCKMEIER = { recordId: "rec_stock", name: "STOCKMEIER", domain: "stockmeier.com", owner: null };

describe("emailDomain", () => {
  it("normalizes the domain for UI labels and matching", () => {
    expect(emailDomain("m@Bayerpharma.DE")).toBe("bayerpharma.de");
  });

  it("returns null for malformed or empty domains", () => {
    expect(emailDomain("no-at-sign")).toBeNull();
    expect(emailDomain("user@")).toBeNull();
    expect(emailDomain("user@   ")).toBeNull();
  });
});

describe("findCustomerByEmail", () => {
  it("matches case-insensitively on the email domain", () => {
    const directory = [STOCKMEIER, BAYER];
    expect(findCustomerByEmail(directory, "m@Bayerpharma.DE")).toBe(BAYER);
  });

  it("returns null when no directory domain matches the email", () => {
    expect(findCustomerByEmail([BAYER, STOCKMEIER], "x@unknown.example")).toBeNull();
  });

  it("returns null when the email has no '@' (lastIndexOf < 0)", () => {
    expect(findCustomerByEmail([BAYER], "no-at-sign")).toBeNull();
  });

  it("returns null when '@' is the final character (at === length - 1)", () => {
    expect(findCustomerByEmail([BAYER], "user@")).toBeNull();
  });

  it("returns null when the domain is only whitespace after trim (domain || null)", () => {
    expect(findCustomerByEmail([BAYER], "user@   ")).toBeNull();
  });

  it("skips records whose domain is undefined or non-string (typeof guard)", () => {
    const directory = [
      { recordId: "r1", name: "No domain", domain: undefined, owner: null },
      { recordId: "r2", name: "Numeric domain", domain: 123 as unknown as string, owner: null },
      BAYER,
    ];
    expect(findCustomerByEmail(directory, "m@bayerpharma.de")).toBe(BAYER);
  });

  it("returns null when every domain is non-matching including non-string ones", () => {
    const directory = [{ recordId: "r2", name: "Numeric", domain: 123 as unknown as string, owner: null }];
    expect(findCustomerByEmail(directory, "m@bayerpharma.de")).toBeNull();
  });

  it("returns the FIRST matching record when multiple share a domain (Array.find first-hit)", () => {
    const first = { recordId: "rec_a", name: "First", domain: "shared.com", owner: null };
    const second = { recordId: "rec_b", name: "Second", domain: "shared.com", owner: null };
    expect(findCustomerByEmail([first, second], "x@SHARED.com")).toBe(first);
  });
});
