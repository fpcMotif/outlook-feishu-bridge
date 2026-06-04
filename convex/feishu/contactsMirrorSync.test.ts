// Unit tests for the PURE Feishu Contacts Mirror crawl state machine (ADR-0023).
// No ctx/db — pagination, the resigned filter, dedupe, the multi-walk
// completeness fold, the ≤800 assumption, throttle math, and prune accounting
// are exercised directly. The effectful loop in contactsMirror.ts is covered by
// the live run.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ASSUMED_MAX_CONTACTS,
  PRUNE_MIN_RETAIN_RATIO,
  addDepartmentsToNameMap,
  addPrunePage,
  contactsCrawlStopReason,
  dedupeUsersByOpenId,
  departmentKey,
  emptyPruneTotals,
  exceedsAssumedMax,
  isActiveContact,
  nextPageTokenOrStop,
  pageSlotWaitMs,
  partitionActive,
  shouldPruneStaleContacts,
  staleContactIds,
  stopReasonForPage,
  worstStopReason,
  type ContactStopReason,
  type PrunableContactRow,
} from "./contactsMirrorSync";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("stopReasonForPage", () => {
  it("returns complete when Feishu reports no more pages", () => {
    expect(stopReasonForPage({ has_more: false }, new Set())).toBe("complete");
  });

  it("flags a missing page_token when more pages are promised", () => {
    expect(stopReasonForPage({ has_more: true }, new Set())).toBe("missingPageToken");
  });

  it("flags a repeated page_token as a pagination loop", () => {
    expect(stopReasonForPage({ has_more: true, page_token: "p2" }, new Set(["p2"]))).toBe(
      "duplicatePageToken",
    );
  });

  it("returns null (keep paging) for a fresh page_token", () => {
    expect(stopReasonForPage({ has_more: true, page_token: "p2" }, new Set())).toBeNull();
  });
});

describe("nextPageTokenOrStop", () => {
  it("advances and records the token for loop detection", () => {
    const seen = new Set<string>();
    expect(nextPageTokenOrStop({ has_more: true, page_token: "p2" }, seen, 1, "members")).toEqual({
      pageToken: "p2",
    });
    expect(seen.has("p2")).toBe(true);
  });

  it("stops cleanly when there are no more pages", () => {
    expect(nextPageTokenOrStop({ has_more: false }, new Set(), 3, "departments")).toEqual({
      stopReason: "complete",
    });
  });

  it("stops with missingPageToken when more is promised but no token given", () => {
    expect(nextPageTokenOrStop({ has_more: true }, new Set(), 3, "members")).toEqual({
      stopReason: "missingPageToken",
    });
  });
});

describe("departmentKey", () => {
  it("prefers open_department_id over department_id", () => {
    expect(departmentKey({ open_department_id: "od-1", department_id: "1" })).toBe("od-1");
  });

  it("falls back to department_id, then null", () => {
    expect(departmentKey({ department_id: "1" })).toBe("1");
    expect(departmentKey({ name: "Orphan" })).toBeNull();
  });
});

describe("addDepartmentsToNameMap", () => {
  it("indexes departments by key, skipping blank names and keyless rows", () => {
    const map = new Map<string, string>();
    addDepartmentsToNameMap(map, [
      { open_department_id: "od-1", name: "Sales" },
      { open_department_id: "od-2", name: "" },
      { name: "NoKey" },
    ]);
    expect(map.get("od-1")).toBe("Sales");
    expect(map.has("od-2")).toBe(false);
    expect(map.size).toBe(1);
  });
});

describe("isActiveContact / partitionActive", () => {
  it("treats a user with no status as active", () => {
    expect(isActiveContact({})).toBe(true);
  });

  it("skips resigned and exited but keeps frozen", () => {
    expect(isActiveContact({ status: { is_resigned: true } })).toBe(false);
    expect(isActiveContact({ status: { is_exited: true } })).toBe(false);
    expect(isActiveContact({ status: { is_frozen: true } })).toBe(true);
  });

  it("partitions a page into active users and a skipped count", () => {
    const result = partitionActive([
      { open_id: "a", name: "A", status: { is_activated: true } },
      { open_id: "b", name: "B", status: { is_resigned: true } },
      { open_id: "c", name: "C", status: { is_exited: true } },
      { open_id: "d", name: "D" },
    ]);
    expect(result.active.map((u) => u.open_id)).toEqual(["a", "d"]);
    expect(result.skippedResigned).toBe(2);
  });
});

describe("dedupeUsersByOpenId", () => {
  it("keeps one entry per open_id (a user in multiple departments)", () => {
    const unique = dedupeUsersByOpenId([
      { open_id: "a", name: "A" },
      { open_id: "b", name: "B" },
      { open_id: "a", name: "A again" },
    ]);
    expect(unique).toHaveLength(2);
    expect(unique.find((u) => u.open_id === "a")?.name).toBe("A again");
  });
});

describe("worstStopReason", () => {
  it("returns complete only when every walk completed", () => {
    expect(worstStopReason(["complete", "complete", "complete"])).toBe("complete");
  });

  it("returns the first non-complete reason (any broken walk fails the run)", () => {
    expect(worstStopReason(["complete", "missingPageToken", "complete"])).toBe("missingPageToken");
    expect(worstStopReason(["duplicatePageToken", "complete"])).toBe("duplicatePageToken");
  });
});

describe("exceedsAssumedMax", () => {
  it("flags counts above the assumed 800-entry ceiling", () => {
    expect(ASSUMED_MAX_CONTACTS).toBe(800);
    expect(exceedsAssumedMax(800)).toBe(false);
    expect(exceedsAssumedMax(801)).toBe(true);
  });
});

describe("pageSlotWaitMs", () => {
  it("waits zero on the first request", () => {
    expect(pageSlotWaitMs(0, 60, 1_000)).toBe(0);
  });

  it("throttles toward the minimum inter-request interval", () => {
    expect(pageSlotWaitMs(1_000, 60, 1_040)).toBe(20);
  });

  it("returns a non-positive value once the interval has passed", () => {
    expect(pageSlotWaitMs(1_000, 60, 1_100)).toBeLessThanOrEqual(0);
  });
});

describe("staleContactIds", () => {
  const rows: PrunableContactRow<string>[] = [
    { _id: "doc_live", openId: "ou_live" },
    { _id: "doc_left", openId: "ou_left" },
  ];

  it("returns ids whose openId was not seen this run (employees who left)", () => {
    expect(staleContactIds(rows, new Set(["ou_live"]))).toEqual(["doc_left"]);
  });

  it("keeps every row when all openIds were seen (steady state)", () => {
    expect(staleContactIds(rows, new Set(["ou_live", "ou_left"]))).toEqual([]);
  });

  it("treats an empty seen-set as everything-stale (guarded by shouldPruneStaleContacts)", () => {
    expect(staleContactIds(rows, new Set())).toEqual(["doc_live", "doc_left"]);
  });
});

describe("shouldPruneStaleContacts", () => {
  it("prunes only after a clean, complete crawl", () => {
    expect(shouldPruneStaleContacts("complete")).toBe(true);
  });

  it.each(["missingPageToken", "duplicatePageToken", "incomplete"] as ContactStopReason[])(
    "never prunes on a non-complete stop reason (%s)",
    (reason) => {
      expect(shouldPruneStaleContacts(reason)).toBe(false);
    },
  );
});

describe("contactsCrawlStopReason (prune completeness floor)", () => {
  it("keeps complete when the crawl is plausibly full vs the last run", () => {
    expect(contactsCrawlStopReason("complete", 480, 500)).toBe("complete");
    expect(contactsCrawlStopReason("complete", 250, 500)).toBe("complete");
  });

  it("downgrades a clean crawl that collapsed below the retain ratio to incomplete", () => {
    expect(PRUNE_MIN_RETAIN_RATIO).toBe(0.5);
    expect(contactsCrawlStopReason("complete", 249, 500)).toBe("incomplete");
    // The worst case: a clean-but-empty crawl that would otherwise wipe the table.
    expect(contactsCrawlStopReason("complete", 0, 500)).toBe("incomplete");
  });

  it("allows the first-ever sync (no baseline) and an empty baseline to proceed", () => {
    expect(contactsCrawlStopReason("complete", 0, 0)).toBe("complete");
    expect(contactsCrawlStopReason("complete", 10, 0)).toBe("complete");
  });

  it("passes a non-complete stop reason through unchanged (already blocks prune)", () => {
    expect(contactsCrawlStopReason("missingPageToken", 0, 500)).toBe("missingPageToken");
    expect(contactsCrawlStopReason("duplicatePageToken", 0, 500)).toBe("duplicatePageToken");
  });
});

describe("addPrunePage", () => {
  it("accumulates scanned and deleted counts across prune pages", () => {
    const totals = emptyPruneTotals();
    addPrunePage(
      totals,
      [
        { _id: "a", openId: "ou_a" },
        { _id: "b", openId: "ou_b" },
      ],
      ["b"],
    );
    addPrunePage(totals, [{ _id: "c", openId: "ou_c" }], []);
    expect(totals).toEqual({ scanned: 3, deleted: 1 });
  });
});
