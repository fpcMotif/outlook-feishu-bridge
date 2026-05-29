// Pure unit tests for the mirror-row contract (ADR-0016). These four helpers
// shape data on the way IN (CustomerRecord → upsert row) and OUT (mirror doc →
// CustomerRecord) of the Convex search-index mirror, and dedupe a page before
// upsert. They have zero I/O, so they are unit-tested in isolation and pinned
// hard — the search index reads exactly what `projectionToRow`/`buildSearchBlob`
// emit, and the SPA reads exactly what `mirrorDocToCustomer` reconstructs.

import { describe, expect, it } from "vitest";

import type { CustomerRecord } from "./customers";
import {
  buildSearchBlob,
  dedupeRowsByRecordId,
  mirrorDocToCustomer,
  projectionToRow,
  type CustomerMirrorDoc,
  type CustomerUpsertRow,
} from "./customerMirrorRows";

// A fully-populated customer — every optional field present + a real owner —
// so the round-trip and projection tests exercise the populated branch of each
// optional/owner path.
const FULL: CustomerRecord = {
  recordId: "rec_full",
  name: "Acme Chemicals",
  domain: "acme.example",
  fullName: "Acme Chemicals International AG",
  accountNo: "ACME-001",
  countryRegion: "Germany 德国",
  owner: { openId: "ou_florian", name: "Florian Meurer" },
};

describe("buildSearchBlob", () => {
  // The blob is a single space-joined column; only present fields contribute,
  // in a fixed order (name, fullName, accountNo, domain, countryRegion, owner).
  it("orders the present fields and joins them with single spaces", () => {
    expect(buildSearchBlob(FULL)).toBe(
      "Acme Chemicals Acme Chemicals International AG ACME-001 acme.example Germany 德国 Florian Meurer",
    );
  });

  // Partial optionals: only `domain` present (fullName/accountNo absent). The
  // filter(Boolean) must drop the empty placeholders so no double-spaces leak
  // and the surviving tokens keep the field order (name then domain).
  it("emits only the present optionals with no double spaces when some are absent", () => {
    const blob = buildSearchBlob({
      recordId: "rec_partial",
      name: "tricogen",
      domain: "tricogen.io",
      owner: null,
    });
    expect(blob).toBe("tricogen tricogen.io");
    expect(blob).not.toMatch(/\s{2,}/);
    expect(blob).not.toContain("undefined");
  });
});

describe("projectionToRow", () => {
  it("maps every CustomerRecord field 1:1 and derives searchBlob from buildSearchBlob", () => {
    const row = projectionToRow(FULL);
    expect(row).toEqual({
      recordId: "rec_full",
      name: "Acme Chemicals",
      domain: "acme.example",
      fullName: "Acme Chemicals International AG",
      accountNo: "ACME-001",
      countryRegion: "Germany 德国",
      ownerOpenId: "ou_florian",
      ownerName: "Florian Meurer",
      searchBlob: buildSearchBlob(FULL),
    });
  });

  // owner=null is the common case (many rows have no Owner) — the optional
  // chaining on owner?.openId / owner?.name must surface as undefined columns,
  // not "" or a crash (customerMirrorRows.ts:50-51).
  it("yields undefined ownerOpenId/ownerName when owner is null", () => {
    const row = projectionToRow({ recordId: "rec_x", name: "no-owner", owner: null });
    expect(row.ownerOpenId).toBeUndefined();
    expect(row.ownerName).toBeUndefined();
  });

  // Absent optional source fields stay absent on the row (undefined, not "").
  it("passes absent optional fields through as undefined", () => {
    const row = projectionToRow({ recordId: "rec_min", name: "minimal", owner: null });
    expect(row.domain).toBeUndefined();
    expect(row.fullName).toBeUndefined();
    expect(row.accountNo).toBeUndefined();
    expect(row.countryRegion).toBeUndefined();
  });
});

describe("dedupeRowsByRecordId", () => {
  const mk = (recordId: string, name: string): CustomerUpsertRow => ({
    recordId,
    name,
    searchBlob: name,
  });

  // A single fullSync page can carry the same recordId twice (overlapping
  // pagination windows). The Map-by-recordId keeps the LAST occurrence so the
  // freshest projection wins (customerMirrorRows.ts:59).
  it("collapses duplicate recordIds keeping the last occurrence", () => {
    const out = dedupeRowsByRecordId([mk("rec1", "old"), mk("rec1", "new")]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("new");
  });

  it("preserves distinct recordIds in first-seen order", () => {
    const out = dedupeRowsByRecordId([mk("a", "A"), mk("b", "B"), mk("c", "C")]);
    expect(out.map((r) => r.recordId)).toEqual(["a", "b", "c"]);
  });

  it("returns [] for empty input", () => {
    expect(dedupeRowsByRecordId([])).toEqual([]);
  });
});

describe("mirrorDocToCustomer", () => {
  const baseDoc: CustomerMirrorDoc = {
    recordId: "rec_doc",
    name: "Acme Chemicals",
    domain: "acme.example",
    fullName: "Acme Chemicals International AG",
    accountNo: "ACME-001",
    countryRegion: "Germany 德国",
    ownerOpenId: "ou_florian",
    ownerName: "Florian Meurer",
  };

  it("reconstructs owner={openId,name} when ownerOpenId is set", () => {
    expect(mirrorDocToCustomer(baseDoc).owner).toEqual({
      openId: "ou_florian",
      name: "Florian Meurer",
    });
  });

  // The ternary at customerMirrorRows.ts:70-71: an undefined ownerOpenId means
  // the source row had no Owner, so the reconstructed customer's owner is null.
  it("yields owner=null when ownerOpenId is undefined", () => {
    const { ownerOpenId: _drop, ownerName: _drop2, ...noOwner } = baseDoc;
    expect(mirrorDocToCustomer(noOwner).owner).toBeNull();
  });

  // ownerOpenId present but ownerName missing → the `?? ""` fallback gives a
  // blank name rather than undefined, so owner stays a complete {openId,name}.
  it("falls back to name='' when ownerOpenId is set but ownerName is undefined", () => {
    const { ownerName: _drop, ...row } = baseDoc;
    expect(mirrorDocToCustomer(row).owner).toEqual({ openId: "ou_florian", name: "" });
  });
});

// The mirror is a lossy projection (Owner email/en_name are dropped), but the
// fields the SPA renders must survive a full in→out round-trip — this pins the
// contract that drives the server-index search path end to end.
describe("projectionToRow → mirrorDocToCustomer round-trip", () => {
  it("preserves recordId/name/domain/owner for a representative customer", () => {
    const back = mirrorDocToCustomer(projectionToRow(FULL));
    expect(back.recordId).toBe(FULL.recordId);
    expect(back.name).toBe(FULL.name);
    expect(back.domain).toBe(FULL.domain);
    expect(back.owner).toEqual(FULL.owner);
  });

  it("round-trips owner=null back to null", () => {
    const c: CustomerRecord = { recordId: "rec_n", name: "n", owner: null };
    expect(mirrorDocToCustomer(projectionToRow(c)).owner).toBeNull();
  });
});
