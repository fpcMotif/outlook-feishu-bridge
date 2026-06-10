// Pure unit tests for the parts of the server-side Customer mirror (ADR-0016)
// that can be exercised without a Convex runtime. The actions
// (`fullSync` / `kick` / `searchAndCacheMiss`) + mutations (`applyPage` /
// `recordSyncCompletion`) call ctx — those are covered in the existing
// integration tests via SPA mocks. What lives here is the pure helpers that
// shape data on the way IN (Feishu → Convex row) and the way OUT
// (Convex row → CustomerRecord), because those are the contract Convex's
// search index reads.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { callFeishu } from "./call";
import {
  applyPage,
  buildSearchBlob,
  fullSync,
  kick,
  matchByEmail,
  matchEmailAndCacheMiss,
  search,
  searchAndCacheMiss,
} from "./customersMirror";
import { projectionToRow } from "./customerMirrorRows";

vi.mock("./call", () => ({
  callFeishu: vi.fn(),
}));

const FLORIAN = {
  recordId: "rec_florian",
  name: "Acme Chemicals",
  fullName: "Acme Chemicals International AG",
  accountNo: "ACME-001",
  domain: "acme.example",
  countryRegion: "Germany 德国",
  owner: { openId: "ou_florian", name: "Florian Meurer" },
};

type KickHandler = (
  ctx: {
    runMutation: (
      fn: unknown,
      args: Record<string, unknown>,
    ) => Promise<unknown>;
    runQuery?: (fn: unknown, args: Record<string, unknown>) => Promise<unknown>;
  },
  args: Record<string, never>,
) => Promise<{
  pages: number;
  rows: number;
  inserted: number;
  updated: number;
  unchanged: number;
  duplicateRows: number;
  stopReason: string;
  pruneScanned: number;
  deletedStale: number;
}>;

const kickHandler = (kick as unknown as { _handler: KickHandler })._handler;
// fullSync shares the single-flight lease with kick (ADR-0021); the handler is
// exercised directly to prove two concurrent cron/kick runs cannot both page.
const fullSyncHandler = (fullSync as unknown as {
  _handler: (
    ctx: {
      runMutation: (fn: unknown, args: Record<string, unknown>) => Promise<unknown>;
      runQuery: (fn: unknown, args?: Record<string, unknown>) => Promise<unknown>;
    },
    args: Record<string, never>,
  ) => Promise<{ pages: number; pruneScanned: number; deletedStale: number }>;
})._handler;
const searchAndCacheMissHandler = (searchAndCacheMiss as unknown as {
  _handler: (
    ctx: {
      runMutation: (
        fn: unknown,
        args: Record<string, unknown>,
      ) => Promise<{ inserted: number; updated: number; unchanged: number; duplicateRows: number }>;
    },
    args: { q: string; mineFor?: string },
  ) => Promise<{ records: unknown[]; backfilled: number }>;
})._handler;
const searchHandler = (search as unknown as {
  _handler: (
    ctx: {
      db: {
        query: (table: "customersMirrorState" | "customers") => unknown;
      };
    },
    args: { q: string; mineFor?: string; limit?: number },
  ) => Promise<{ records: unknown[]; mirroredAt: number | null }>;
})._handler;
const applyPageHandler = (applyPage as unknown as {
  _handler: (
    ctx: {
      db: {
        query: (table: "customers") => {
          withIndex: (
            name: "by_recordId",
            callback: (q: { eq: (field: "recordId", value: string) => unknown }) => unknown,
          ) => { unique: () => Promise<Record<string, unknown> | null> };
        };
        patch: (id: string, fields: Record<string, unknown>) => Promise<void>;
        insert: (table: "customers", fields: Record<string, unknown>) => Promise<void>;
      };
    },
    args: {
      rows: Array<{
        recordId: string;
        name: string;
        domain?: string;
        fullName?: string;
        accountNo?: string;
        countryRegion?: string;
        ownerOpenId?: string;
        ownerName?: string;
        searchBlob: string;
      }>;
      mirroredAt: number;
    },
  ) => Promise<{ inserted: number; updated: number; unchanged: number; duplicateRows: number }>;
})._handler;
const matchByEmailHandler = (matchByEmail as unknown as {
  _handler: (
    ctx: { db: { query: (table: "customers") => unknown } },
    args: { email: string },
  ) => Promise<{ customer: { recordId: string } | null }>;
})._handler;
const matchEmailAndCacheMissHandler = (matchEmailAndCacheMiss as unknown as {
  _handler: (
    ctx: {
      runMutation: (
        fn: unknown,
        args: Record<string, unknown>,
      ) => Promise<{ inserted: number; updated: number; unchanged: number; duplicateRows: number }>;
    },
    args: { email: string },
  ) => Promise<{ customer: { recordId: string } | null; backfilled: number }>;
})._handler;
const mockCallFeishu = vi.mocked(callFeishu);
const originalConvexDeployment = process.env.CONVEX_DEPLOYMENT;
const originalFixturesFlag = process.env.ENABLE_DEV_CUSTOMER_FIXTURES;
const originalAppToken = process.env.FEISHU_BITABLE_APP_TOKEN;

function feishuPage(index: number, hasMore: boolean): {
  items: Array<{ record_id: string; fields: Record<string, Array<{ text: string; type: string }>> }>;
  has_more: boolean;
  page_token: string | undefined;
  total?: number;
} {
  return {
    items: [
      {
        record_id: `rec_${index}`,
        fields: { "Account Name": [{ text: `Customer ${index}`, type: "text" }] },
      },
    ],
    has_more: hasMore,
    page_token: hasMore ? `page_${index + 1}` : undefined,
  };
}

function makeCtx() {
  const completions: Record<string, unknown>[] = [];
  const runMutation = vi.fn(async (_fn: unknown, args: Record<string, unknown>) => {
    if (typeof args.cooldownMs === "number") return { started: true };
    if (Array.isArray(args.rows)) {
      return { inserted: args.rows.length, updated: 0, unchanged: 0, duplicateRows: 0 };
    }
    // deleteRowsById (Mirror Prune) — never called for an empty mirror, but keep
    // it out of `completions` so a populated-table test does not see a phantom.
    if (Array.isArray(args.ids)) return { deleted: args.ids.length };
    // Defensive guard for a bare {startedAt} mutation; the refresh start lease
    // now stamps the start via the cooldownMs branch above (ADR-0021). Not a
    // watermark completion, so keep it out of `completions`.
    if (typeof args.startedAt === "number") return null;
    completions.push(args);
    return null;
  });
  // listRowsForPrune — empty mirror in the unit ctx, so the prune scans and
  // deletes nothing. (The legacy getMirrorRefreshStartedAt path returns null.)
  const runQuery = vi.fn(async (_fn: unknown, args?: Record<string, unknown>) => {
    if (args && "paginationOpts" in args) {
      return { page: [], isDone: true, continueCursor: "" };
    }
    return null;
  });
  return { ctx: { runMutation, runQuery }, completions };
}

beforeEach(() => {
  delete process.env.CONVEX_DEPLOYMENT;
  delete process.env.ENABLE_DEV_CUSTOMER_FIXTURES;
  process.env.FEISHU_BITABLE_APP_TOKEN = "apptest";
  mockCallFeishu.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  if (originalConvexDeployment === undefined) {
    delete process.env.CONVEX_DEPLOYMENT;
  } else {
    process.env.CONVEX_DEPLOYMENT = originalConvexDeployment;
  }
  if (originalFixturesFlag === undefined) {
    delete process.env.ENABLE_DEV_CUSTOMER_FIXTURES;
  } else {
    process.env.ENABLE_DEV_CUSTOMER_FIXTURES = originalFixturesFlag;
  }
  if (originalAppToken === undefined) {
    delete process.env.FEISHU_BITABLE_APP_TOKEN;
  } else {
    process.env.FEISHU_BITABLE_APP_TOKEN = originalAppToken;
  }
  vi.restoreAllMocks();
});

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
    const patch = vi.fn(async () => undefined);
    const insert = vi.fn(async () => undefined);
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

describe("customer mirror cache-miss search", () => {
  it("skips live Feishu search for one-character queries", async () => {
    const runMutation = vi.fn();

    const result = await searchAndCacheMissHandler({ runMutation }, { q: " a " });

    expect(result).toEqual({ records: [], backfilled: 0 });
    expect(mockCallFeishu).not.toHaveBeenCalled();
    expect(runMutation).not.toHaveBeenCalled();
  });

  it("uses a smaller Feishu page than full sync for interactive cache misses", async () => {
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

    const result = await searchAndCacheMissHandler({ runMutation }, { q: "Acme" });

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

// db mock for matchByEmail: each named index resolves to a fixed row (or null),
// and every probe records which index was hit with what key so the tests can
// lock the domainKey-first / raw-domain-fallback order.
function customersIndexDb(rowsByIndex: Record<string, Record<string, unknown> | null>) {
  const probes: Array<{ index: string; value: unknown }> = [];
  const query = vi.fn(() => ({
    withIndex: (
      name: string,
      callback: (q: { eq: (field: string, value: unknown) => unknown }) => unknown,
    ) => {
      let captured: unknown;
      callback({
        eq: (_field, value) => {
          captured = value;
          return {};
        },
      });
      probes.push({ index: name, value: captured });
      return { first: async () => rowsByIndex[name] ?? null };
    },
  }));
  return { query, probes };
}

describe("customer mirror domain match (matchByEmail)", () => {
  it("matches via the canonical domainKey index even when the raw 域名 cell has casing", async () => {
    const row = { recordId: "rec_acme", name: "Acme", domain: "Acme.COM", domainKey: "acme.com" };
    const { query, probes } = customersIndexDb({ by_domainKey: row });

    const result = await matchByEmailHandler({ db: { query } }, { email: "buyer@ACME.com" });

    expect(result.customer?.recordId).toBe("rec_acme");
    expect(probes).toEqual([{ index: "by_domainKey", value: "acme.com" }]);
  });

  it("falls back to the raw-domain index for rows synced before domainKey existed", async () => {
    const row = { recordId: "rec_legacy", name: "Legacy", domain: "legacy.example" };
    const { query, probes } = customersIndexDb({ by_domainKey: null, by_domain: row });

    const result = await matchByEmailHandler({ db: { query } }, { email: "buyer@legacy.example" });

    expect(result.customer?.recordId).toBe("rec_legacy");
    expect(probes.map((probe) => probe.index)).toEqual(["by_domainKey", "by_domain"]);
  });
});

describe("customer mirror domain cache-miss (matchEmailAndCacheMiss)", () => {
  it("skips live Feishu entirely for text without an email domain", async () => {
    const runMutation = vi.fn();

    const result = await matchEmailAndCacheMissHandler({ runMutation }, { email: "not-an-email" });

    expect(result).toEqual({ customer: null, backfilled: 0 });
    expect(mockCallFeishu).not.toHaveBeenCalled();
    expect(runMutation).not.toHaveBeenCalled();
  });

  it("backfills one bounded filtered page and returns only the exact canonical match", async () => {
    mockCallFeishu.mockResolvedValueOnce({
      items: [
        {
          record_id: "rec_super",
          fields: {
            "Account Name": [{ text: "Not Acme", type: "text" }],
            域名: [{ text: "notacme.com", type: "text" }],
          },
        },
        {
          record_id: "rec_acme",
          fields: {
            "Account Name": [{ text: "Acme", type: "text" }],
            域名: [{ text: "Acme.COM", type: "text" }],
          },
        },
      ],
      has_more: false,
    });
    const runMutation = vi.fn(async () => ({
      inserted: 2,
      updated: 0,
      unchanged: 0,
      duplicateRows: 0,
    }));

    const result = await matchEmailAndCacheMissHandler({ runMutation }, { email: "buyer@acme.com" });

    // `contains` pulls in the superstring domain too — it belongs in the
    // mirror, but only the strict canonical match may auto-select.
    expect(result.backfilled).toBe(2);
    expect(result.customer?.recordId).toBe("rec_acme");
    expect(mockCallFeishu).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        label: "Customers mirror — live domain match on cache miss",
        query: { page_size: "50" },
        json: expect.objectContaining({
          filter: {
            conjunction: "and",
            conditions: [{ field_name: "域名", operator: "contains", value: ["acme.com"] }],
          },
        }),
      }),
    );
    expect(runMutation).toHaveBeenCalledTimes(1);
    const upsert = runMutation.mock.calls[0]?.[1] as {
      rows: Array<{ recordId: string; domainKey?: string }>;
    };
    expect(upsert.rows.find((row) => row.recordId === "rec_acme")?.domainKey).toBe("acme.com");
  });

  it("queries Feishu with the alias-canonicalized domain and skips the upsert on empty results", async () => {
    mockCallFeishu.mockResolvedValueOnce({ items: [], has_more: false });
    const runMutation = vi.fn();

    const result = await matchEmailAndCacheMissHandler(
      { runMutation },
      { email: "buyer@microsoftonline.com" },
    );

    expect(result).toEqual({ customer: null, backfilled: 0 });
    expect(runMutation).not.toHaveBeenCalled();
    expect(mockCallFeishu).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        json: expect.objectContaining({
          filter: expect.objectContaining({
            conditions: [{ field_name: "域名", operator: "contains", value: ["microsoft.com"] }],
          }),
        }),
      }),
    );
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

describe("customer mirror full sync pagination", () => {
  it("keeps paging past the old 20-page ceiling until Feishu has_more is false", async () => {
    const pages = Array.from({ length: 22 }, (_, index) => feishuPage(index + 1, index < 21));
    pages.forEach((page) => {
      page.total = 22;
    });
    mockCallFeishu.mockImplementation(async () => pages.shift());
    const { ctx, completions } = makeCtx();

    const result = await kickHandler(ctx, {});

    expect(mockCallFeishu).toHaveBeenCalledTimes(22);
    expect(mockCallFeishu).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({
        path: "/bitable/v1/apps/apptest/tables/tbl4TE2GV472sKzp/records/search",
        method: "POST",
        query: { page_size: "500" },
        json: {
          field_names: [
            "Account Name",
            "Record Id",
            "域名",
            "全名",
            "Account No.",
            "Country and Regio",
            "Owner",
          ],
        },
      }),
    );
    expect(result).toMatchObject({
      pages: 22,
      rows: 22,
      inserted: 22,
      updated: 0,
      unchanged: 0,
      duplicateRows: 0,
      stopReason: "complete",
    });
    expect(completions[0]).toMatchObject({
      lastRowCount: 22,
      lastPageCount: 22,
      lastPageSize: 500,
      lastInsertedCount: 22,
      lastUpdatedCount: 0,
      lastUnchangedCount: 0,
      lastDuplicateCount: 0,
      lastHadMore: false,
      lastStopReason: "complete",
      lastReportedTotal: 22,
      lastSourceRowCount: 22,
      lastSourceTableId: "tbl4TE2GV472sKzp",
    });
  });

  it("records an audit stop reason before failing on broken Feishu pagination", async () => {
    mockCallFeishu.mockResolvedValueOnce({
      items: [
        {
          record_id: "rec_first",
          fields: { "Account Name": [{ text: "First", type: "text" }] },
        },
      ],
      has_more: true,
    });
    const { ctx, completions } = makeCtx();

    await expect(kickHandler(ctx, {})).rejects.toThrow(
      "Customers mirror stopped before completion",
    );

    expect(completions[0]).toMatchObject({
      lastRowCount: 1,
      lastPageCount: 1,
      lastHadMore: true,
      lastStopReason: "missingPageToken",
    });
  });

  it("flags an incompleteTotal shortfall when paged rows fall short of Feishu total", async () => {
    // Feishu reports a table total of 5, but pagination cleanly ends after 3 rows.
    const page = (id: string, hasMore: boolean, token: string | undefined) => ({
      items: [{ record_id: id, fields: { "Account Name": [{ text: id, type: "text" }] } }],
      has_more: hasMore,
      page_token: token,
      total: 5,
    });
    mockCallFeishu
      .mockResolvedValueOnce(page("rec_1", true, "p2"))
      .mockResolvedValueOnce(page("rec_2", true, "p3"))
      .mockResolvedValueOnce(page("rec_3", false, undefined));
    const { ctx, completions } = makeCtx();

    await expect(kickHandler(ctx, {})).rejects.toThrow(
      "Customers mirror stopped before completion",
    );

    expect(completions[0]).toMatchObject({
      lastReportedTotal: 5,
      lastSourceRowCount: 3,
      lastStopReason: "incompleteTotal",
    });
  });

  it("tombstones mirror rows whose recordId was not seen during a complete sync", async () => {
    // Feishu returns one live row; the mirror also holds two orphans left behind
    // by earlier Feishu deletes/re-imports that the upsert-only mirror never removed.
    mockCallFeishu.mockResolvedValueOnce({
      items: [{ record_id: "rec_live", fields: { "Account Name": [{ text: "Live", type: "text" }] } }],
      has_more: false,
      total: 1,
    });
    const mirrorRows = [
      { _id: "d_live", recordId: "rec_live" },
      { _id: "d_orphan1", recordId: "rec_old1" },
      { _id: "d_orphan2", recordId: "rec_old2" },
    ];
    const deleted: string[][] = [];
    const completions: Record<string, unknown>[] = [];
    const runMutation = vi.fn(async (_fn: unknown, args: Record<string, unknown>) => {
      if (typeof args.cooldownMs === "number") return { started: true };
      if (Array.isArray(args.rows)) {
        return { inserted: args.rows.length, updated: 0, unchanged: 0, duplicateRows: 0 };
      }
      if (Array.isArray(args.ids)) {
        deleted.push(args.ids as string[]);
        return { deleted: args.ids.length };
      }
      if (typeof args.startedAt === "number") return null;
      completions.push(args);
      return null;
    });
    const runQuery = vi.fn(async (_fn: unknown, args?: Record<string, unknown>) =>
      args && "paginationOpts" in args
        ? { page: mirrorRows, isDone: true, continueCursor: "" }
        : null,
    );

    const result = await kickHandler({ runMutation, runQuery }, {});

    expect(result.stopReason).toBe("complete");
    expect(deleted).toEqual([["d_orphan1", "d_orphan2"]]);
    expect(result.pruneScanned).toBe(3);
    expect(result.deletedStale).toBe(2);
    expect(completions[0]).toMatchObject({
      lastPruneScannedCount: 3,
      lastDeletedStaleCount: 2,
      lastStopReason: "complete",
    });
  });

  it("never prunes when the sync stops incomplete, so a partial fetch cannot wipe the mirror", async () => {
    // has_more=true with no page_token -> missingPageToken (incomplete). An orphan
    // is present in the mirror, but the prune MUST be skipped entirely.
    mockCallFeishu.mockResolvedValueOnce({
      items: [{ record_id: "rec_1", fields: { "Account Name": [{ text: "One", type: "text" }] } }],
      has_more: true,
    });
    const deleted: string[][] = [];
    const runMutation = vi.fn(async (_fn: unknown, args: Record<string, unknown>) => {
      if (typeof args.cooldownMs === "number") return { started: true };
      if (Array.isArray(args.rows)) {
        return { inserted: args.rows.length, updated: 0, unchanged: 0, duplicateRows: 0 };
      }
      if (Array.isArray(args.ids)) {
        deleted.push(args.ids as string[]);
        return { deleted: args.ids.length };
      }
      if (typeof args.startedAt === "number") return null;
      return null;
    });
    const runQuery = vi.fn(async (_fn: unknown, args?: Record<string, unknown>) =>
      args && "paginationOpts" in args
        ? { page: [{ _id: "d_orphan", recordId: "rec_old" }], isDone: true, continueCursor: "" }
        : null,
    );

    await expect(kickHandler({ runMutation, runQuery }, {})).rejects.toThrow(
      "Customers mirror stopped before completion",
    );

    // The prune scan never ran and nothing was deleted (safety gate held).
    expect(runQuery).not.toHaveBeenCalled();
    expect(deleted).toEqual([]);
  });

  it("allows only one full re-page when two mirror kicks race before the cooldown stamp is visible", async () => {
    mockCallFeishu.mockResolvedValue({
      items: [
        {
          record_id: "rec_race",
          fields: { "Account Name": [{ text: "Race", type: "text" }] },
        },
      ],
      has_more: false,
      total: 1,
    });
    const completions: Record<string, unknown>[] = [];
    let refreshAlreadyStarted = false;
    const runMutation = vi.fn(async (_fn: unknown, args: Record<string, unknown>) => {
      if (typeof args.cooldownMs === "number") {
        if (refreshAlreadyStarted) return { started: false, remainingMs: args.cooldownMs };
        refreshAlreadyStarted = true;
        return { started: true };
      }
      if (Array.isArray(args.rows)) {
        return { inserted: args.rows.length, updated: 0, unchanged: 0, duplicateRows: 0 };
      }
      if (Array.isArray(args.ids)) return { deleted: args.ids.length };
      if (typeof args.startedAt === "number") return null;
      completions.push(args);
      return null;
    });
    const ctx = {
      runMutation,
      // Current implementation reads the timestamp outside the mutation. Return
      // stale state for both racing actions to reproduce the production burst;
      // the prune scan (listRowsForPrune) sees an empty mirror.
      runQuery: vi.fn(async (_fn: unknown, qArgs?: Record<string, unknown>) =>
        qArgs && "paginationOpts" in qArgs
          ? { page: [], isDone: true, continueCursor: "" }
          : null,
      ),
    };

    const results = await Promise.all([kickHandler(ctx, {}), kickHandler(ctx, {})]);

    expect(mockCallFeishu).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.pages).sort()).toEqual([0, 1]);
    expect(completions).toHaveLength(1);
  });
});

describe("customer mirror identity key", () => {
  // ADR-0021: the mirror must upsert on the immutable API `record_id`, never the
  // user-facing "Record Id" column. This captures the rows handed to `applyPage`
  // from a Feishu page whose "Record Id" column DIVERGES from the API id and
  // pins that the persisted dedup key is the API id.
  it("upserts on the API record_id even when the human `Record Id` column diverges", async () => {
    mockCallFeishu.mockResolvedValueOnce({
      items: [
        {
          record_id: "recAPIimmutable",
          fields: {
            "Account Name": [{ text: "Divergent Co", type: "text" }],
            "Record Id": [{ text: "recHumanColumn", type: "text" }],
          },
        },
      ],
      has_more: false,
      total: 1,
    });

    const appliedRows: Array<{ recordId: string }> = [];
    const runMutation = vi.fn(async (_fn: unknown, args: Record<string, unknown>) => {
      if (typeof args.cooldownMs === "number") return { started: true };
      if (Array.isArray(args.rows)) {
        appliedRows.push(...(args.rows as Array<{ recordId: string }>));
        return { inserted: args.rows.length, updated: 0, unchanged: 0, duplicateRows: 0 };
      }
      if (Array.isArray(args.ids)) return { deleted: args.ids.length };
      if (typeof args.startedAt === "number") return null;
      return null;
    });
    // Empty mirror scan so the now-active prune deletes nothing — this test only
    // asserts the persisted identity key.
    const runQuery = vi.fn(async (_fn: unknown, args?: Record<string, unknown>) =>
      args && "paginationOpts" in args
        ? { page: [], isDone: true, continueCursor: "" }
        : null,
    );

    await kickHandler({ runMutation, runQuery }, {});

    expect(appliedRows).toHaveLength(1);
    expect(appliedRows[0].recordId).toBe("recAPIimmutable");
    expect(appliedRows[0].recordId).not.toBe("recHumanColumn");
  });
});

describe("customer mirror full sync single-flight (ADR-0021)", () => {
  it("backs off a second concurrent full sync so only one pages — no prune race", async () => {
    mockCallFeishu.mockResolvedValue({
      items: [{ record_id: "rec_sf", fields: { "Account Name": [{ text: "SF", type: "text" }] } }],
      has_more: false,
      total: 1,
    });
    // The shared start lease grants exactly one holder; the second concurrent
    // fullSync sees the lease held and skips its entire page walk.
    let leaseHeld = false;
    const runMutation = vi.fn(async (_fn: unknown, args: Record<string, unknown>) => {
      if (typeof args.cooldownMs === "number") {
        if (leaseHeld) return { started: false, remainingMs: args.cooldownMs };
        leaseHeld = true;
        return { started: true };
      }
      if (Array.isArray(args.rows)) {
        return { inserted: args.rows.length, updated: 0, unchanged: 0, duplicateRows: 0 };
      }
      if (Array.isArray(args.ids)) return { deleted: args.ids.length };
      if (typeof args.startedAt === "number") return null;
      return null;
    });
    const runQuery = vi.fn(async (_fn: unknown, args?: Record<string, unknown>) =>
      args && "paginationOpts" in args
        ? { page: [], isDone: true, continueCursor: "" }
        : null,
    );

    const results = await Promise.all([
      fullSyncHandler({ runMutation, runQuery }, {}),
      fullSyncHandler({ runMutation, runQuery }, {}),
    ]);

    // Only the lease holder pages Feishu; the other returns the skipped result.
    expect(mockCallFeishu).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.pages).sort()).toEqual([0, 1]);
  });
});

describe("customer mirror drift alarm (ADR-0021)", () => {
  it("logs a DRIFT ALARM when the retained mirror count still exceeds the source total after prune", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockCallFeishu.mockResolvedValueOnce({
      items: [{ record_id: "rec_live", fields: { "Account Name": [{ text: "Live", type: "text" }] } }],
      has_more: false,
      total: 1,
    });
    // The mirror still holds many DUPLICATE docs for the one live recordId (the
    // exact overcount that an upsert-only re-key drift produced). None are stale
    // (all seen), so the prune deletes nothing and the retained count stays far
    // above the source total — the alarm must fire.
    const dupDocs = Array.from({ length: 40 }, (_, i) => ({ _id: `d_${i}`, recordId: "rec_live" }));
    const runMutation = vi.fn(async (_fn: unknown, args: Record<string, unknown>) => {
      if (typeof args.cooldownMs === "number") return { started: true };
      if (Array.isArray(args.rows)) {
        return { inserted: args.rows.length, updated: 0, unchanged: 0, duplicateRows: 0 };
      }
      if (Array.isArray(args.ids)) return { deleted: args.ids.length };
      if (typeof args.startedAt === "number") return null;
      return null;
    });
    const runQuery = vi.fn(async (_fn: unknown, args?: Record<string, unknown>) =>
      args && "paginationOpts" in args
        ? { page: dupDocs, isDone: true, continueCursor: "" }
        : null,
    );

    const result = await kickHandler({ runMutation, runQuery }, {});

    expect(result.stopReason).toBe("complete");
    expect(result.pruneScanned).toBe(40);
    expect(result.deletedStale).toBe(0);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("DRIFT ALARM"));
  });
});
