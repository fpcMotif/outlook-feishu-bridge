// Pure unit tests for the parts of the server-side Customer mirror (ADR-0016)
// that can be exercised without a Convex runtime. The actions
// (`fullSync` / `kick` / `searchAndCacheMiss`) + mutations (`applyPage` /
// `recordSyncCompletion`) call ctx — those are covered in the existing
// integration tests via SPA mocks. What lives here is the pure helpers that
// shape data on the way IN (Feishu → Convex row) and the way OUT
// (Convex row → CustomerRecord), because those are the contract Convex's
// search index reads.

import { describe, expect, it } from "vitest";

import { buildSearchBlob } from "./customersMirror";

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
