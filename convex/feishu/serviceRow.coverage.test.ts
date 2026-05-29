// Extra coverage for the Service-row field builder beyond serviceRow.test.ts
// (which pins Email Subject / Sales / Email Conversation ID). This file pins
// the Request Type MultiSelect mapping, the per-request Note columns, the
// exactly-one Co Worker validation + User-array shape, Date of Offer / Client,
// and the entire DIAG_SKIP_FIELDS binary-search path (readSkipSet + every
// skip.has guard + the one-time console.log). Field shapes come from the
// official Feishu record-data-structure docs cited in serviceRow.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildServiceFields, type ServiceRowInput } from "./serviceRow";

// Minimal valid input: the builder REQUIRES exactly one coworker, so every
// non-validation case carries one to reach the field-mapping lines.
const ONE_COWORKER = [{ openId: "ou_jenny", name: "Jenny Xu" }];
const BASE: ServiceRowInput = { selectedCoworkers: ONE_COWORKER };

// DIAG_SKIP_FIELDS is read from process.env at call time; snapshot + restore it
// so cases that set it can't leak into each other (or the rest of the suite).
const ORIGINAL_DIAG = process.env.DIAG_SKIP_FIELDS;
beforeEach(() => {
  delete process.env.DIAG_SKIP_FIELDS;
});
afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_DIAG === undefined) delete process.env.DIAG_SKIP_FIELDS;
  else process.env.DIAG_SKIP_FIELDS = ORIGINAL_DIAG;
});

describe("buildServiceFields — Request Type MultiSelect", () => {
  // The Bitable option is literally the misspelled "Qutation" — it must match
  // exactly or Feishu rejects the MultiSelect write.
  it("maps requestType 'Quotation' to the misspelled 'Qutation' option", () => {
    const fields = buildServiceFields(
      { ...BASE, requestSelections: [{ requestType: "Quotation", note: "" }] },
      null,
    );
    expect(fields["Request Type"]).toEqual(["Qutation"]);
  });

  it("maps multiple requestTypes into a string[] preserving order", () => {
    const fields = buildServiceFields(
      {
        ...BASE,
        requestSelections: [
          { requestType: "Quotation", note: "" },
          { requestType: "Sample", note: "" },
          { requestType: "R&D Support", note: "" },
        ],
      },
      null,
    );
    expect(fields["Request Type"]).toEqual(["Qutation", "Sample", "R&D Support"]);
  });

  // Unknown titles have no REQUEST_TYPE_OPTION entry and are filtered out so the
  // MultiSelect only ever carries options Feishu knows.
  it("drops a requestType that is not a known option", () => {
    const fields = buildServiceFields(
      {
        ...BASE,
        requestSelections: [
          { requestType: "Quotation", note: "" },
          { requestType: "Unknown Kind", note: "" },
        ],
      },
      null,
    );
    expect(fields["Request Type"]).toEqual(["Qutation"]);
  });

  it("omits the Request Type field when requestSelections is empty", () => {
    const empty = buildServiceFields({ ...BASE, requestSelections: [] }, null);
    expect("Request Type" in empty).toBe(false);
  });

  it("omits the Request Type field when requestSelections is undefined", () => {
    const fields = buildServiceFields(BASE, null);
    expect("Request Type" in fields).toBe(false);
  });

  // All selections map to unknown options -> the filtered array is empty ->
  // the `types.length > 0` guard suppresses the field.
  it("omits Request Type when every selection maps to an unknown option", () => {
    const fields = buildServiceFields(
      { ...BASE, requestSelections: [{ requestType: "Nope", note: "" }] },
      null,
    );
    expect("Request Type" in fields).toBe(false);
  });
});

describe("buildServiceFields — Note columns", () => {
  it("writes each request's note to its mapped Note column", () => {
    const fields = buildServiceFields(
      {
        ...BASE,
        requestSelections: [
          { requestType: "Quotation", note: "need FOB price" },
          { requestType: "Sample", note: "50g sample" },
          { requestType: "R&D Support", note: "spec sheet?" },
        ],
      },
      null,
    );
    expect(fields["Quotation Note"]).toBe("need FOB price");
    expect(fields["Sample Note"]).toBe("50g sample");
    expect(fields["R&D Support Note"]).toBe("spec sheet?");
  });

  it("omits a Note column when the note is empty or whitespace-only", () => {
    const fields = buildServiceFields(
      {
        ...BASE,
        requestSelections: [
          { requestType: "Quotation", note: "" },
          { requestType: "Sample", note: "   " },
        ],
      },
      null,
    );
    expect("Quotation Note" in fields).toBe(false);
    expect("Sample Note" in fields).toBe(false);
  });

  // An unknown requestType has no NOTE_FIELD mapping; its note is silently
  // dropped rather than written under a bogus column name.
  it("omits the Note when the requestType has no NOTE_FIELD mapping", () => {
    const fields = buildServiceFields(
      { ...BASE, requestSelections: [{ requestType: "Unknown Kind", note: "lost note" }] },
      null,
    );
    expect(Object.keys(fields)).not.toContain("Unknown Kind Note");
    // Co Worker is still written, proving the loop didn't blow up.
    expect(fields["Co Worker"]).toEqual([{ id: "ou_jenny" }]);
  });
});

describe("buildServiceFields — Co Worker validation + shape", () => {
  it("writes Co Worker as [{id: openId}] for the single selected coworker", () => {
    const fields = buildServiceFields(BASE, null);
    expect(fields["Co Worker"]).toEqual([{ id: "ou_jenny" }]);
  });

  it("throws when selectedCoworkers is undefined", () => {
    expect(() => buildServiceFields({}, null)).toThrow(
      "Bitable Service row requires exactly one Feishu coworker",
    );
  });

  it("throws when selectedCoworkers has zero entries", () => {
    expect(() => buildServiceFields({ selectedCoworkers: [] }, null)).toThrow(
      "Bitable Service row requires exactly one Feishu coworker",
    );
  });

  it("throws when selectedCoworkers has more than one entry", () => {
    expect(() =>
      buildServiceFields(
        {
          selectedCoworkers: [
            { openId: "ou_a", name: "A" },
            { openId: "ou_b", name: "B" },
          ],
        },
        null,
      ),
    ).toThrow("Bitable Service row requires exactly one Feishu coworker");
  });
});

describe("buildServiceFields — Date of Offer + Client", () => {
  it("writes Date of Offer as the raw epoch-ms number when provided", () => {
    const fields = buildServiceFields({ ...BASE, dateOfOffer: 1_716_900_000_000 }, null);
    expect(fields["Date of Offer"]).toBe(1_716_900_000_000);
  });

  // The guard is `!== undefined`, so the epoch 0 IS a legitimate write.
  it("writes Date of Offer when dateOfOffer is 0 (epoch start), not treated as absent", () => {
    const fields = buildServiceFields({ ...BASE, dateOfOffer: 0 }, null);
    expect(fields["Date of Offer"]).toBe(0);
  });

  it("omits Date of Offer when dateOfOffer is undefined", () => {
    const fields = buildServiceFields(BASE, null);
    expect("Date of Offer" in fields).toBe(false);
  });

  it("writes Client as [clientRecordId] when a non-null clientRecordId is passed", () => {
    const fields = buildServiceFields(BASE, "rec_client_123");
    expect(fields["Client"]).toEqual(["rec_client_123"]);
  });

  it("omits Client when clientRecordId is null", () => {
    const fields = buildServiceFields(BASE, null);
    expect("Client" in fields).toBe(false);
  });
});

describe("buildServiceFields — Email Subject + Sales guards", () => {
  it("omits Email Subject when subject is empty or whitespace-only", () => {
    const blank = buildServiceFields({ ...BASE, subject: "" }, null);
    const spaces = buildServiceFields({ ...BASE, subject: "   " }, null);
    expect("Email Subject" in blank).toBe(false);
    expect("Email Subject" in spaces).toBe(false);
  });

  // Sales requires a truthy initiator.openId — an initiator object with an empty
  // open_id is treated as "no initiator" rather than writing [{ id: "" }].
  it("omits Sales when initiator is present but initiator.openId is empty", () => {
    const fields = buildServiceFields(
      { ...BASE, initiator: { openId: "", name: "Ghost" } },
      null,
    );
    expect("Sales" in fields).toBe(false);
  });
});

describe("buildServiceFields — DIAG_SKIP_FIELDS binary-search path", () => {
  it("omits Request Type when the env lists 'Request Type' but still writes the rest", () => {
    process.env.DIAG_SKIP_FIELDS = "Request Type";
    const fields = buildServiceFields(
      { ...BASE, requestSelections: [{ requestType: "Quotation", note: "p" }] },
      "rec_c",
    );
    expect("Request Type" in fields).toBe(false);
    // Other fields are unaffected by skipping just Request Type.
    expect(fields["Quotation Note"]).toBe("p");
    expect(fields["Co Worker"]).toEqual([{ id: "ou_jenny" }]);
    expect(fields["Client"]).toEqual(["rec_c"]);
  });

  // The exactly-one validation runs BEFORE the skip guard, so skipping
  // "Co Worker" omits the field yet still enforces the one-coworker rule.
  it("skipping 'Co Worker' omits the field but validation still runs first", () => {
    process.env.DIAG_SKIP_FIELDS = "Co Worker";
    const fields = buildServiceFields(BASE, null);
    expect("Co Worker" in fields).toBe(false);

    // Validation precedes the skip guard: the wrong count still throws even
    // though Co Worker would have been skipped.
    expect(() =>
      buildServiceFields({ selectedCoworkers: [] }, null),
    ).toThrow("Bitable Service row requires exactly one Feishu coworker");
  });

  // readSkipSet trims each comma-split token and drops empties (flatMap-empty).
  it("parses '  Client , Sales ' into a skip set suppressing both Client and Sales", () => {
    process.env.DIAG_SKIP_FIELDS = "  Client , Sales ";
    const fields = buildServiceFields(
      { ...BASE, initiator: { openId: "ou_init", name: "Init" } },
      "rec_c",
    );
    expect("Client" in fields).toBe(false);
    expect("Sales" in fields).toBe(false);
  });

  // An empty env var -> "".split(",") -> [""] -> trimmed/dropped -> empty set,
  // so nothing is skipped and no DIAG log fires.
  it("an empty env var yields an empty skip set and writes all applicable fields", () => {
    process.env.DIAG_SKIP_FIELDS = "";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const fields = buildServiceFields(
      {
        ...BASE,
        subject: "Subj",
        initiator: { openId: "ou_init", name: "Init" },
        requestSelections: [{ requestType: "Quotation", note: "p" }],
      },
      "rec_c",
    );
    expect(fields["Request Type"]).toEqual(["Qutation"]);
    expect(fields["Email Subject"]).toBe("Subj");
    expect(fields["Sales"]).toEqual([{ id: "ou_init" }]);
    expect(fields["Client"]).toEqual(["rec_c"]);
    // skip.size === 0 -> no "DIAG_SKIP_FIELDS active" line.
    expect(
      logSpy.mock.calls.some((c) => String(c[0]).includes("DIAG_SKIP_FIELDS active")),
    ).toBe(false);
  });

  it("logs '[bitable] DIAG_SKIP_FIELDS active: ...' exactly once when the skip set is populated", () => {
    process.env.DIAG_SKIP_FIELDS = "Client,Sales";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    buildServiceFields(BASE, "rec_c");
    const diagLines = logSpy.mock.calls.filter((c) =>
      String(c[0]).includes("DIAG_SKIP_FIELDS active"),
    );
    expect(diagLines).toHaveLength(1);
    expect(String(diagLines[0][0])).toBe("[bitable] DIAG_SKIP_FIELDS active: Client|Sales");
  });
});
