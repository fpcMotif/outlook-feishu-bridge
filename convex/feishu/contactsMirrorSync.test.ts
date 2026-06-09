// Unit tests for the PURE Feishu Contacts Mirror crawl state machine (ADR-0023).
// No ctx/db — pagination, the resigned filter, dedupe, the multi-walk
// completeness fold, the ≤800 assumption, throttle math, and prune accounting
// are exercised directly. The effectful loop in contactsMirror.ts is covered by
// the live run.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ASSUMED_MAX_CONTACTS,
  addDepartmentsToNameMap,
  addPrunePage,
  dedupeUsersByOpenId,
  departmentKey,
  emptyPruneTotals,
  exceedsAssumedMax,
  isActiveContact,
  nextPageTokenOrStop,
  pageSlotWaitMs,
  partitionActive,
  runContactsMirrorRefresh,
  shouldPruneStaleContacts,
  staleContactIds,
  stopReasonForPage,
  worstStopReason,
  type ContactCrawlResult,
  type ContactStopReason,
  type ContactsMirrorRefreshPort,
  type ContactsRefreshFinish,
  type PrunableContactRow,
} from "./contactsMirrorSync";
import type { ContactUpsertRow } from "./contactsMirrorRows";

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

// The whole Contacts Mirror Refresh driven through an in-memory fake port — no
// Convex. This is the test surface the engine interface buys: the all-or-nothing
// COMPLETENESS GATE (a partial crawl must NOT write or prune) and the prune gate
// run end to end without mocking the Convex action runtime. The adapter's
// parallel-walk crawl is supplied as `port.crawl`, so its pacing is out of scope.

function row(openId: string): ContactUpsertRow {
  return { openId, name: openId, searchBlob: openId };
}

function makeCrawl(over: Partial<ContactCrawlResult> = {}): ContactCrawlResult {
  const rows = over.rows ?? [row("a"), row("b")];
  return {
    rows,
    seenOpenIds: over.seenOpenIds ?? new Set(rows.map((r) => r.openId)),
    departmentCount: over.departmentCount ?? 3,
    skippedResigned: over.skippedResigned ?? 0,
    stopReason: over.stopReason ?? "complete",
  };
}

function makeFakePort(crawl: ContactCrawlResult, seedOrphans: string[] = []) {
  const store = new Map<string, number>();
  for (const id of seedOrphans) store.set(id, 0);
  let writeCalls = 0;
  let tombstoneCalls = 0;

  const port: ContactsMirrorRefreshPort<ContactsRefreshFinish> = {
    crawl: () => Promise.resolve(crawl),
    writeRows: (rows, mirroredAt) => {
      writeCalls += 1;
      let inserted = 0;
      let unchanged = 0;
      for (const r of rows) {
        if (store.has(r.openId)) unchanged += 1;
        else {
          store.set(r.openId, mirroredAt);
          inserted += 1;
        }
      }
      return Promise.resolve({ inserted, updated: 0, unchanged });
    },
    tombstone: (seen) => {
      tombstoneCalls += 1;
      const scanned = store.size;
      let deleted = 0;
      for (const id of [...store.keys()]) {
        if (!seen.has(id)) {
          store.delete(id);
          deleted += 1;
        }
      }
      return Promise.resolve({ scanned, deleted });
    },
    finish: (args) => Promise.resolve(args),
  };

  return {
    port,
    store,
    get writeCalls() {
      return writeCalls;
    },
    get tombstoneCalls() {
      return tombstoneCalls;
    },
  };
}

describe("runContactsMirrorRefresh (engine)", () => {
  it("writes the crawl at mirroredAt and tombstones orphans on a complete run", async () => {
    const fake = makeFakePort(makeCrawl({ rows: [row("a"), row("b")] }), ["orphan"]);
    const out = await runContactsMirrorRefresh(fake.port, { startedAt: 5000 });
    expect(out.complete).toBe(true);
    expect(out.mirroredAt).toBe(5000);
    expect(out.writes.inserted).toBe(2);
    expect(fake.writeCalls).toBe(1);
    expect(fake.tombstoneCalls).toBe(1);
    expect(out.prune.deleted).toBe(1);
    expect(fake.store.has("orphan")).toBe(false);
    expect([...fake.store.keys()].sort()).toEqual(["a", "b"]);
  });

  it("runs the prune on a complete crawl with no orphans (scans, deletes nothing)", async () => {
    const fake = makeFakePort(makeCrawl({ rows: [row("a")] }), ["a"]);
    const out = await runContactsMirrorRefresh(fake.port, { startedAt: 10 });
    expect(out.complete).toBe(true);
    expect(fake.tombstoneCalls).toBe(1);
    expect(out.prune.deleted).toBe(0);
    expect(fake.store.has("a")).toBe(true);
  });

  it.each<ContactStopReason>(["missingPageToken", "duplicatePageToken", "incomplete"])(
    "SAFETY GATE: a %s crawl neither writes nor prunes (live rows untouched)",
    async (stopReason) => {
      const fake = makeFakePort(makeCrawl({ rows: [row("a")], stopReason }), ["orphan"]);
      const out = await runContactsMirrorRefresh(fake.port, { startedAt: 1 });
      expect(out.complete).toBe(false);
      expect(out.writes).toEqual({ inserted: 0, updated: 0, unchanged: 0 });
      expect(out.prune).toEqual({ scanned: 0, deleted: 0 });
      expect(fake.writeCalls).toBe(0);
      expect(fake.tombstoneCalls).toBe(0);
      // The incomplete run touched nothing: the orphan survives, "a" was never written.
      expect(fake.store.has("orphan")).toBe(true);
      expect(fake.store.has("a")).toBe(false);
    },
  );
});
