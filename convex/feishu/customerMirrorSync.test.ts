// Unit tests for the PURE Customer Mirror pagination state machine
// (ADR-0016, audit be-customers-2). These functions carry no ctx/db, so the
// page-to-page advance and completeness/watermark accounting can be exercised
// directly — the effectful loop in customersMirror.ts is covered separately via
// the `kick` integration test.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  addPageTotals,
  addPrunePage,
  completenessStopReason,
  emptyPruneTotals,
  emptyTotals,
  maxReportedTotal,
  nextPageTokenOrStop,
  pageSlotWaitMs,
  runMirrorRefresh,
  shouldPruneStaleRows,
  stalePageIds,
  stopReasonForPage,
  type AppliedPage,
  type FeishuRecord,
  type MirrorRefreshPort,
  type MirrorStopReason,
  type PrunableRow,
  type PruneTotals,
  type SearchResponse,
  type SyncTotals,
} from "./customerMirrorSync";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function appliedPage(rowCount: number, stats?: Partial<AppliedPage>): AppliedPage {
  return {
    inserted: rowCount,
    updated: 0,
    unchanged: 0,
    duplicateRows: 0,
    rowCount,
    firstRecordId: "rec_first",
    lastRecordId: "rec_last",
    ...stats,
  };
}

describe("stopReasonForPage", () => {
  it("returns complete when Feishu reports no more pages", () => {
    expect(stopReasonForPage({ has_more: false }, new Set())).toBe("complete");
  });

  it("flags a missing page_token when more pages are promised", () => {
    expect(stopReasonForPage({ has_more: true }, new Set())).toBe("missingPageToken");
  });

  it("flags a repeated page_token as a pagination loop", () => {
    const seen = new Set(["p2"]);
    expect(stopReasonForPage({ has_more: true, page_token: "p2" }, seen)).toBe(
      "duplicatePageToken",
    );
  });

  it("returns null (keep paging) for a fresh page_token", () => {
    expect(stopReasonForPage({ has_more: true, page_token: "p2" }, new Set())).toBeNull();
  });
});

describe("nextPageTokenOrStop", () => {
  it("advances to the next page and records the token for loop detection", () => {
    const seen = new Set<string>();
    const data: SearchResponse = { has_more: true, page_token: "p2" };
    expect(nextPageTokenOrStop(data, seen, 1)).toEqual({ pageToken: "p2" });
    expect(seen.has("p2")).toBe(true);
  });

  it("stops cleanly when there are no more pages", () => {
    expect(nextPageTokenOrStop({ has_more: false }, new Set(), 3)).toEqual({
      stopReason: "complete",
    });
  });

  it("stops with missingPageToken when more is promised but no token given", () => {
    expect(nextPageTokenOrStop({ has_more: true }, new Set(), 3)).toEqual({
      stopReason: "missingPageToken",
    });
  });
});

describe("completenessStopReason", () => {
  it("passes a clean stop through when paged rows cover Feishu's total", () => {
    const totals = { ...emptyTotals(), sourceRows: 5, reportedTotal: 5 };
    expect(completenessStopReason("complete", totals)).toBe("complete");
  });

  it("promotes a row shortfall to incompleteTotal", () => {
    const totals = { ...emptyTotals(), sourceRows: 3, reportedTotal: 5 };
    expect(completenessStopReason("complete", totals)).toBe("incompleteTotal");
  });

  it("leaves a non-clean stop reason untouched", () => {
    const totals = { ...emptyTotals(), sourceRows: 3, reportedTotal: 5 };
    expect(completenessStopReason("missingPageToken", totals)).toBe("missingPageToken");
  });
});

describe("addPageTotals", () => {
  it("accumulates row and write counts across pages", () => {
    const totals = emptyTotals();
    addPageTotals(totals, appliedPage(2, { inserted: 1, updated: 1 }));
    addPageTotals(totals, appliedPage(3, { inserted: 2, unchanged: 1 }));
    expect(totals).toMatchObject({
      pages: 2,
      rows: 5,
      sourceRows: 5,
      inserted: 3,
      updated: 1,
      unchanged: 1,
      duplicateRows: 0,
    });
  });
});

describe("maxReportedTotal", () => {
  it("keeps the largest total Feishu reports across pages", () => {
    expect(maxReportedTotal(0, { total: 22 })).toBe(22);
    expect(maxReportedTotal(22, { total: 10 })).toBe(22);
    expect(maxReportedTotal(5, {})).toBe(5);
  });
});

describe("pageSlotWaitMs", () => {
  it("waits zero on the first request", () => {
    expect(pageSlotWaitMs(0, 60, 1_000)).toBe(0);
  });

  it("throttles toward the minimum inter-request interval", () => {
    // 40ms elapsed of a 60ms window -> 20ms left to wait.
    expect(pageSlotWaitMs(1_000, 60, 1_040)).toBe(20);
  });

  it("returns a non-positive value once the interval has passed", () => {
    expect(pageSlotWaitMs(1_000, 60, 1_100)).toBeLessThanOrEqual(0);
  });
});

describe("stalePageIds", () => {
  const rows: PrunableRow<string>[] = [
    { _id: "doc_live1", recordId: "rec_live1" },
    { _id: "doc_orphan", recordId: "rec_gone" },
    { _id: "doc_live2", recordId: "rec_live2" },
  ];

  it("returns the ids of rows whose recordId was not seen this sync", () => {
    const seen = new Set(["rec_live1", "rec_live2"]);
    expect(stalePageIds(rows, seen)).toEqual(["doc_orphan"]);
  });

  it("keeps every row when all recordIds were seen (steady state, prune deletes nothing)", () => {
    const seen = new Set(["rec_live1", "rec_gone", "rec_live2"]);
    expect(stalePageIds(rows, seen)).toEqual([]);
  });

  it("protects dev-fixture rows that were written this run even though they are not Feishu rows", () => {
    const withFixture: PrunableRow<string>[] = [
      ...rows,
      { _id: "doc_fixture", recordId: "dev_fixture_fanpc_customer" },
    ];
    // The sync adds fixture ids to the seen-set, so they survive the prune;
    // only the genuine orphan (rec_gone) is returned.
    const seen = new Set(["rec_live1", "rec_live2", "dev_fixture_fanpc_customer"]);
    expect(stalePageIds(withFixture, seen)).toEqual(["doc_orphan"]);
  });

  it("treats an empty seen-set as everything-stale (guarded elsewhere by shouldPruneStaleRows)", () => {
    expect(stalePageIds(rows, new Set())).toEqual(["doc_live1", "doc_orphan", "doc_live2"]);
  });
});

describe("shouldPruneStaleRows", () => {
  it("prunes only after a clean, completeness-verified sync", () => {
    expect(shouldPruneStaleRows("complete")).toBe(true);
  });

  it.each(["missingPageToken", "duplicatePageToken", "incompleteTotal"] as const)(
    "never prunes on a non-complete stop reason (%s) so a partial fetch cannot wipe the mirror",
    (reason) => {
      expect(shouldPruneStaleRows(reason)).toBe(false);
    },
  );
});

describe("addPrunePage", () => {
  it("accumulates scanned and deleted counts across prune pages", () => {
    const totals = emptyPruneTotals();
    addPrunePage(
      totals,
      [
        { _id: "a", recordId: "rec_a" },
        { _id: "b", recordId: "rec_b" },
      ],
      ["b"],
    );
    addPrunePage(totals, [{ _id: "c", recordId: "rec_c" }], []);
    expect(totals).toEqual({ scanned: 3, deleted: 1 });
  });
});

// The whole Mirror Refresh driven through an in-memory fake port — no Convex.
// This is the test surface the deepened engine interface buys: the page-walk,
// completeness promotion, and the all-or-nothing prune gate are exercised end to
// end without mocking the Convex action runtime.

type FinishArgs = {
  totals: SyncTotals;
  mirroredAt: number;
  hadMore: boolean;
  stopReason: MirrorStopReason;
  prune: PruneTotals;
};

function rec(id: string): FeishuRecord {
  return { record_id: id, fields: {} };
}

function makeFakePort(pages: SearchResponse[], seedOrphans: string[] = []) {
  const sleeps: number[] = [];
  const store = new Map<string, number>();
  for (const id of seedOrphans) store.set(id, 0);
  let clock = 1000;
  let pageIdx = 0;
  let tombstoneCalls = 0;
  let devFixtureCalls = 0;

  const port: MirrorRefreshPort<FinishArgs> = {
    clock: {
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        if (ms > 0) clock += ms;
      },
    },
    fetchPage: async () => pages[pageIdx++] ?? { has_more: false },
    applyPage: async (items, mirroredAt) => {
      const recordIds = items.map((i) => i.record_id);
      let inserted = 0;
      let unchanged = 0;
      for (const id of recordIds) {
        if (store.has(id)) unchanged += 1;
        else {
          store.set(id, mirroredAt);
          inserted += 1;
        }
      }
      return {
        inserted,
        updated: 0,
        unchanged,
        duplicateRows: 0,
        rowCount: items.length,
        firstRecordId: recordIds[0] ?? "(none)",
        lastRecordId: recordIds.at(-1) ?? "(none)",
        recordIds,
      };
    },
    applyDevFixtures: async () => {
      devFixtureCalls += 1;
    },
    tombstone: async (seen) => {
      tombstoneCalls += 1;
      const scanned = store.size;
      let deleted = 0;
      for (const id of store.keys()) {
        if (!seen.has(id)) {
          store.delete(id);
          deleted += 1;
        }
      }
      return { scanned, deleted };
    },
    finish: async (args) => args,
  };

  return {
    port,
    store,
    sleeps,
    get tombstoneCalls() {
      return tombstoneCalls;
    },
    get devFixtureCalls() {
      return devFixtureCalls;
    },
  };
}

describe("runMirrorRefresh (engine)", () => {
  it("pages to completion, tombstones orphans, returns a complete result", async () => {
    const fake = makeFakePort(
      [
        { items: [rec("a"), rec("b")], has_more: true, page_token: "t1", total: 3 },
        { items: [rec("c")], has_more: false, total: 3 },
      ],
      ["orphan"],
    );
    const result = await runMirrorRefresh(fake.port, { startedAt: 5000 });
    expect(result.stopReason).toBe("complete");
    expect(result.mirroredAt).toBe(5000);
    expect(result.totals.pages).toBe(2);
    expect(result.totals.sourceRows).toBe(3);
    expect(fake.devFixtureCalls).toBe(1);
    expect(fake.tombstoneCalls).toBe(1);
    expect(result.prune.deleted).toBe(1);
    expect(fake.store.has("orphan")).toBe(false);
    expect([...fake.store.keys()].sort()).toEqual(["a", "b", "c"]);
  });

  it("promotes a row shortfall to incompleteTotal and SKIPS the prune (safety gate)", async () => {
    const fake = makeFakePort([{ items: [rec("a")], has_more: false, total: 5 }], ["orphan"]);
    const result = await runMirrorRefresh(fake.port);
    expect(result.stopReason).toBe("incompleteTotal");
    expect(fake.tombstoneCalls).toBe(0);
    expect(result.prune).toEqual({ scanned: 0, deleted: 0 });
    expect(fake.store.has("orphan")).toBe(true);
  });

  it("stops on a missing page token without pruning", async () => {
    const fake = makeFakePort(
      [{ items: [rec("a")], has_more: true, page_token: undefined }],
      ["orphan"],
    );
    const result = await runMirrorRefresh(fake.port);
    expect(result.stopReason).toBe("missingPageToken");
    expect(fake.tombstoneCalls).toBe(0);
    expect(fake.store.has("orphan")).toBe(true);
  });

  it("stops on a duplicate page token (loop guard) without pruning", async () => {
    const fake = makeFakePort(
      [
        { items: [rec("a")], has_more: true, page_token: "dup", total: 99 },
        { items: [rec("b")], has_more: true, page_token: "dup", total: 99 },
      ],
      ["orphan"],
    );
    const result = await runMirrorRefresh(fake.port);
    expect(result.stopReason).toBe("duplicatePageToken");
    expect(fake.tombstoneCalls).toBe(0);
    expect(fake.store.has("orphan")).toBe(true);
  });

  it("paces pages ~60ms apart, with no wait before the first page", async () => {
    const fake = makeFakePort([
      { items: [rec("a")], has_more: true, page_token: "t1", total: 2 },
      { items: [rec("b")], has_more: false, total: 2 },
    ]);
    await runMirrorRefresh(fake.port, { startedAt: 1000 });
    expect(fake.sleeps[0]).toBe(0);
    expect(fake.sleeps[1]).toBe(60);
  });
});
