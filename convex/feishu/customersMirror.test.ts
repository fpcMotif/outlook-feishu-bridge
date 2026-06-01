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
import { applyPage, buildSearchBlob, kick, search, searchAndCacheMiss } from "./customersMirror";

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
}>;

const kickHandler = (kick as unknown as { _handler: KickHandler })._handler;
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
const mockCallFeishu = vi.mocked(callFeishu);
const originalConvexDeployment = process.env.CONVEX_DEPLOYMENT;
const originalFixturesFlag = process.env.ENABLE_DEV_CUSTOMER_FIXTURES;
const originalAppToken = process.env.FEISHU_BITABLE_APP_TOKEN;

function feishuPage(index: number, hasMore: boolean) {
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
    // markRefreshStarted (Mirror Kick rate-limit, ADR-0016) stamps a start time;
    // it is not a watermark completion, so keep it out of `completions`.
    if (typeof args.startedAt === "number") return null;
    completions.push(args);
    return null;
  });
  // getMirrorRefreshStartedAt — no prior refresh, so the kick gate never skips.
  const runQuery = vi.fn(async () => null);
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
    const page = (id, hasMore, token) => ({
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
      if (typeof args.startedAt === "number") return null;
      completions.push(args);
      return null;
    });
    const ctx = {
      runMutation,
      // Current implementation reads the timestamp outside the mutation. Return
      // stale state for both racing actions to reproduce the production burst.
      runQuery: vi.fn(async () => null),
    };

    const results = await Promise.all([kickHandler(ctx, {}), kickHandler(ctx, {})]);

    expect(mockCallFeishu).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.pages).sort()).toEqual([0, 1]);
    expect(completions).toHaveLength(1);
  });
});
