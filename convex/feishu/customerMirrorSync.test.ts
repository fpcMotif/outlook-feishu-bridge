// Unit tests for the PURE Customer Mirror pagination state machine
// (ADR-0016, audit be-customers-2). These functions carry no ctx/db, so the
// page-to-page advance and completeness/watermark accounting can be exercised
// directly — the effectful loop in customersMirror.ts is covered separately via
// the `kick` integration test.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  addPageTotals,
  completenessStopReason,
  emptyTotals,
  maxReportedTotal,
  nextPageTokenOrStop,
  pageSlotWaitMs,
  stopReasonForPage,
  type AppliedPage,
  type SearchResponse,
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
    addPageTotals(totals, appliedPage(3, { inserted: 3 }));
    expect(totals).toMatchObject({
      pages: 2,
      rows: 5,
      sourceRows: 5,
      inserted: 4,
      updated: 1,
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
