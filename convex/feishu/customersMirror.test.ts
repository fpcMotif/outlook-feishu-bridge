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
import { buildSearchBlob, kick } from "./customersMirror";

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
    ) => Promise<{ inserted: number; updated: number; duplicateRows: number } | null>;
  },
  args: Record<string, never>,
) => Promise<{
  pages: number;
  rows: number;
  inserted: number;
  updated: number;
  duplicateRows: number;
  stopReason: string;
}>;

const kickHandler = (kick as unknown as { _handler: KickHandler })._handler;
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
    if (Array.isArray(args.rows)) {
      return { inserted: args.rows.length, updated: 0, duplicateRows: 0 };
    }
    completions.push(args);
    return null;
  });
  return { ctx: { runMutation }, completions };
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
      duplicateRows: 0,
      stopReason: "complete",
    });
    expect(completions[0]).toMatchObject({
      lastRowCount: 22,
      lastPageCount: 22,
      lastPageSize: 500,
      lastInsertedCount: 22,
      lastUpdatedCount: 0,
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
});
