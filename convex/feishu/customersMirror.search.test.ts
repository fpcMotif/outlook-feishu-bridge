// Handler tests for the Customer mirror SEARCH surface: the bounded upsert
// (applyPage), the ranked internal mirror query (search), and the public
// engine-driven entry point (searchCustomers). Shared fake-ctx harness lives in
// customersMirror.testkit.ts. See customerSearchEngine.test.ts for the pure
// mirror-first/live-fallback strategy these handlers delegate to.

import { describe, expect, it, vi } from "vitest";

import {
  applyPageHandler,
  installMirrorTestEnv,
  mockCallFeishu,
  searchCustomersHandler,
  searchHandler,
} from "./customersMirror.testkit";

vi.mock("./call", () => ({
  callFeishu: vi.fn(),
}));

installMirrorTestEnv();

describe("customer mirror applyPage", () => {
  it("skips unchanged rows so full refreshes do not rewrite the search index", async () => {
    const existing = {
      _id: "customer_1",
      recordId: "rec_same",
      name: "Same Customer",
      domain: "same.example",
      fullName: "Same Customer GmbH",
      accountNo: "SAME-001",
      countryRegion: "Germany",
      ownerOpenId: "ou_owner",
      ownerName: "Owner One",
      searchBlob: "Same Customer Same Customer GmbH SAME-001 same.example Germany Owner One",
      mirroredAt: 1,
    };
    const patch = vi.fn(async () => {});
    const insert = vi.fn(async () => {});
    const db = {
      query: () => ({
        withIndex: (_name: "by_recordId", callback: (q: { eq: (field: "recordId", value: string) => unknown }) => unknown) => {
          const constraints: Record<string, string> = {};
          callback({
            eq: (field, value) => {
              constraints[field] = value;
              return null;
            },
          });
          return {
            unique: async () => (constraints.recordId === existing.recordId ? existing : null),
          };
        },
      }),
      patch,
      insert,
    };

    const result = await applyPageHandler(
      { db },
      {
        rows: [
          {
            recordId: existing.recordId,
            name: existing.name,
            domain: existing.domain,
            fullName: existing.fullName,
            accountNo: existing.accountNo,
            countryRegion: existing.countryRegion,
            ownerOpenId: existing.ownerOpenId,
            ownerName: existing.ownerName,
            searchBlob: existing.searchBlob,
          },
        ],
        mirroredAt: 2,
      },
    );

    expect(result).toEqual({ inserted: 0, updated: 0, unchanged: 1, duplicateRows: 0 });
    expect(patch).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("clears optional columns when the serialized row omits them (simulates Convex arg strip)", async () => {
    // In production an action calls ctx.runMutation(applyPage, { rows, mirroredAt }).
    // Convex serializes args to JSON before the mutation sees them, so any field
    // with value `undefined` is silently dropped. If the row coming from Bitable
    // has no domain cell the incoming arg object will simply lack `domain` / `domainKey`.
    // The explicit-undefined spread in applyPage is what turns that absence into
    // a db.patch() that clears the stale optional column.
    const existing = {
      _id: "customer_had_domain",
      recordId: "rec_had_domain",
      name: "Was Domain Co",
      domain: "old.example",
      domainKey: "old.example",
      searchBlob: "Was Domain Co old.example",
      mirroredAt: 1,
    };
    const patched: Record<string, unknown>[] = [];
    const db = {
      query: () => ({
        withIndex: (
          _name: "by_recordId",
          callback: (q: { eq: (field: "recordId", value: string) => unknown }) => unknown,
        ) => {
          const constraints: Record<string, string> = {};
          callback({ eq: (field, value) => { constraints[field] = value; return null; } });
          return { unique: async () => (constraints.recordId === existing.recordId ? existing : null) };
        },
      }),
      patch: vi.fn(async (_id: string, fields: Record<string, unknown>) => { patched.push(fields); }),
      insert: vi.fn(async () => {}),
    };

    // JSON round-trip simulates what Convex does to action→mutation args:
    // fields with value `undefined` are stripped. The row now has no domain/domainKey.
    const serializedRow = JSON.parse(
      JSON.stringify({ recordId: "rec_had_domain", name: "Was Domain Co", searchBlob: "Was Domain Co" }),
    );
    await applyPageHandler({ db }, { rows: [serializedRow], mirroredAt: 2 });

    // The explicit-undefined spread must produce a patch that includes domain:undefined
    // so Convex removes the stale column from the stored document.
    expect(patched).toHaveLength(1);
    expect(Object.prototype.hasOwnProperty.call(patched[0], "domain")).toBe(true);
    expect(patched[0].domain).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(patched[0], "domainKey")).toBe(true);
    expect(patched[0].domainKey).toBeUndefined();
  });
});

describe("customer mirror public search", () => {
  it("skips the search index for one-character queries", async () => {
    const customersQuery = vi.fn(() => {
      throw new Error("customers search index should not be queried");
    });
    const query = vi.fn((table: "customersMirrorState" | "customers") => {
      if (table === "customersMirrorState") {
        return { first: vi.fn(async () => ({ lastFullSyncAt: 123 })) };
      }
      return customersQuery();
    });

    const result = await searchHandler({ db: { query } }, { q: " a " });

    expect(result).toEqual({ records: [], mirroredAt: 123 });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith("customersMirrorState");
    expect(customersQuery).not.toHaveBeenCalled();
  });

  it("skips the search index when a query collapses to no searchable tokens", async () => {
    const customersQuery = vi.fn(() => {
      throw new Error("customers search index should not be queried");
    });
    const query = vi.fn((table: "customersMirrorState" | "customers") => {
      if (table === "customersMirrorState") {
        return { first: vi.fn(async () => ({ lastFullSyncAt: 123 })) };
      }
      return customersQuery();
    });

    // Two punctuation chars clear the length guard but bigram-expand to "".
    const result = await searchHandler({ db: { query } }, { q: "()" });

    expect(result).toEqual({ records: [], mirroredAt: 123 });
    expect(customersQuery).not.toHaveBeenCalled();
  });

  it("bigram-expands a CJK query before handing it to the search index", async () => {
    let searchedTerm = "";
    const take = vi.fn(async () => []);
    const query = vi.fn((table: "customersMirrorState" | "customers") => {
      if (table === "customersMirrorState") {
        return { first: vi.fn(async () => ({ lastFullSyncAt: 123 })) };
      }
      return {
        withSearchIndex: (
          _name: "by_text",
          callback: (b: { search: (field: string, value: string) => unknown }) => unknown,
        ) => {
          callback({
            search: (_field, value) => {
              searchedTerm = value;
              return { eq: () => ({}) };
            },
          });
          return { take };
        },
      };
    });

    await searchHandler({ db: { query } }, { q: "上海化妆品" });

    // The raw query would prefix-match nothing; the expanded bigrams do.
    expect(searchedTerm).toBe("上海 海化 化妆 妆品");
    expect(take).toHaveBeenCalledTimes(1);
  });
});

describe("customer mirror searchCustomers (engine-driven)", () => {
  it("skips both legs for one-character queries", async () => {
    const runQuery = vi.fn();
    const runMutation = vi.fn();

    const result = await searchCustomersHandler({ runQuery, runMutation }, { q: " a " });

    expect(result).toEqual({ records: [], source: "mirror", backfilled: 0, mirroredAt: null });
    expect(runQuery).not.toHaveBeenCalled();
    expect(mockCallFeishu).not.toHaveBeenCalled();
    expect(runMutation).not.toHaveBeenCalled();
  });

  it("answers from the mirror without any live Feishu call on a hit", async () => {
    const runQuery = vi.fn(async () => ({
      records: [{ recordId: "rec_acme", name: "Acme", owner: null }],
      mirroredAt: 1_234,
    }));
    const runMutation = vi.fn();

    const result = await searchCustomersHandler({ runQuery, runMutation }, { q: "Acme" });

    expect(result.source).toBe("mirror");
    expect(result.records).toHaveLength(1);
    expect(result.mirroredAt).toBe(1_234);
    expect(runQuery).toHaveBeenCalledTimes(1);
    expect(mockCallFeishu).not.toHaveBeenCalled();
    expect(runMutation).not.toHaveBeenCalled();
  });

  it("falls through to a smaller Feishu page than full sync on a mirror miss", async () => {
    const runQuery = vi.fn(async () => ({ records: [], mirroredAt: null }));
    mockCallFeishu.mockResolvedValueOnce({
      items: [
        {
          record_id: "rec_acme",
          fields: { "Account Name": [{ text: "Acme", type: "text" }] },
        },
      ],
      has_more: false,
    });
    const runMutation = vi.fn(async () => ({
      inserted: 1,
      updated: 0,
      unchanged: 0,
      duplicateRows: 0,
    }));

    const result = await searchCustomersHandler({ runQuery, runMutation }, { q: "Acme" });

    expect(result.source).toBe("live");
    expect(result.backfilled).toBe(1);
    expect(mockCallFeishu).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        label: "Customers mirror — live search on cache miss",
        query: { page_size: "50" },
        json: expect.objectContaining({
          field_names: [
            "Account Name",
            "Record Id",
            "域名",
            "全名",
            "Account No.",
            "Country and Regio",
            "Owner",
          ],
        }),
      }),
    );
    expect(runMutation).toHaveBeenCalledTimes(1);
  });
});
