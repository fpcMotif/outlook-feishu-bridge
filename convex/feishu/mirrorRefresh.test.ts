// Unit tests for the Mirror Refresh engine — the whole lifecycle driven through
// an in-memory fake port, no Convex. This is the test surface the engine
// interface buys: the all-or-nothing COMPLETENESS GATE (a partial crawl must
// NOT write or prune), the EMPTY-SOURCE GUARD (a "complete" crawl with an empty
// seen-set must never tombstone the mirror), and the streamed-vs-assembled
// write policies, end to end. The adapters' real walks (customersMirror.ts,
// contactsMirror.ts) are out of scope here — they are supplied as `port.crawl`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  EMPTY_SOURCE,
  runMirrorRefresh,
  type MirrorCrawl,
  type MirrorRefreshOutcome,
  type MirrorRefreshPort,
} from "./mirrorRefresh";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

type Reason = "complete" | "missingPageToken" | "duplicatePageToken" | "incomplete";

interface FakeRow {
  key: string;
}

interface FakeCrawl extends MirrorCrawl<FakeRow, Reason> {
  // Adapter-specific crawl context must survive the round trip into finish.
  extra: string;
}

type FakeOutcome = MirrorRefreshOutcome<FakeCrawl, Reason>;

function crawlOf(over: Partial<FakeCrawl> & Pick<FakeCrawl, "stopReason">): FakeCrawl {
  return { seenKeys: new Set(), extra: "ctx", ...over };
}

// An in-memory mirror: write upserts by key, tombstone deletes everything not
// in the seen-set — the same semantics as the real adapters' Convex tables.
function makeFakePort(crawl: FakeCrawl, seedOrphans: string[] = []) {
  const store = new Map<string, number>();
  for (const key of seedOrphans) store.set(key, 0);
  let writeCalls = 0;
  let tombstoneCalls = 0;

  const port: MirrorRefreshPort<FakeRow, Reason, FakeCrawl, FakeOutcome> = {
    crawl: () => Promise.resolve(crawl),
    write: (rows, mirroredAt) => {
      writeCalls += 1;
      let inserted = 0;
      let unchanged = 0;
      for (const row of rows) {
        if (store.has(row.key)) unchanged += 1;
        else {
          store.set(row.key, mirroredAt);
          inserted += 1;
        }
      }
      return Promise.resolve({ inserted, updated: 0, unchanged });
    },
    tombstone: (seen) => {
      tombstoneCalls += 1;
      const scanned = store.size;
      let deleted = 0;
      for (const key of store.keys()) {
        if (!seen.has(key)) {
          store.delete(key);
          deleted += 1;
        }
      }
      return Promise.resolve({ scanned, deleted });
    },
    finish: (outcome) => Promise.resolve(outcome),
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

function assembled(keys: string[], stopReason: Reason = "complete"): FakeCrawl {
  return crawlOf({
    stopReason,
    assembledRows: keys.map((key) => ({ key })),
    seenKeys: new Set(keys),
  });
}

describe("runMirrorRefresh — assembled crawl (gated write)", () => {
  it("writes the crawl at mirroredAt and tombstones orphans on a complete run", async () => {
    const fake = makeFakePort(assembled(["a", "b"]), ["orphan"]);
    const out = await runMirrorRefresh(fake.port, { startedAt: 5000, label: "test-mirror" });
    expect(out.complete).toBe(true);
    expect(out.stopReason).toBe("complete");
    expect(out.mirroredAt).toBe(5000);
    expect(out.writes.inserted).toBe(2);
    expect(fake.writeCalls).toBe(1);
    expect(fake.tombstoneCalls).toBe(1);
    expect(out.prune.deleted).toBe(1);
    expect(fake.store.has("orphan")).toBe(false);
    expect([...fake.store.keys()].sort()).toEqual(["a", "b"]);
  });

  it("runs the prune on a complete crawl with no orphans (scans, deletes nothing)", async () => {
    const fake = makeFakePort(assembled(["a"]), ["a"]);
    const out = await runMirrorRefresh(fake.port, { startedAt: 10, label: "test-mirror" });
    expect(out.complete).toBe(true);
    expect(fake.tombstoneCalls).toBe(1);
    expect(out.prune.deleted).toBe(0);
    expect(fake.store.has("a")).toBe(true);
  });

  it.each<Reason>(["missingPageToken", "duplicatePageToken", "incomplete"])(
    "SAFETY GATE: a %s crawl neither writes nor prunes (live rows untouched)",
    async (stopReason) => {
      const fake = makeFakePort(assembled(["a"], stopReason), ["orphan"]);
      const out = await runMirrorRefresh(fake.port, { startedAt: 1, label: "test-mirror" });
      expect(out.complete).toBe(false);
      expect(out.stopReason).toBe(stopReason);
      expect(out.writes).toEqual({ inserted: 0, updated: 0, unchanged: 0 });
      expect(out.prune).toEqual({ scanned: 0, deleted: 0 });
      expect(fake.writeCalls).toBe(0);
      expect(fake.tombstoneCalls).toBe(0);
      // The incomplete run touched nothing: the orphan survives, "a" was never written.
      expect(fake.store.has("orphan")).toBe(true);
      expect(fake.store.has("a")).toBe(false);
    },
  );

  it("EMPTY-SOURCE GUARD: a complete crawl with an empty seen-set fails instead of wiping the mirror", async () => {
    const fake = makeFakePort(assembled([]), ["live-1", "live-2"]);
    const out = await runMirrorRefresh(fake.port, { startedAt: 7, label: "test-mirror" });
    expect(out.complete).toBe(false);
    expect(out.stopReason).toBe(EMPTY_SOURCE);
    expect(fake.writeCalls).toBe(0);
    expect(fake.tombstoneCalls).toBe(0);
    // Every pre-existing row survives — the whole point of the guard.
    expect([...fake.store.keys()].sort()).toEqual(["live-1", "live-2"]);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("EMPTY SOURCE"));
  });

  it("finish carries the adapter's crawl context through unchanged", async () => {
    const crawl = assembled(["a"]);
    const fake = makeFakePort(crawl);
    const out = await runMirrorRefresh(fake.port, { startedAt: 1, label: "test-mirror" });
    expect(out.crawl).toBe(crawl);
    expect(out.crawl.extra).toBe("ctx");
  });

  it("throws loudly when an assembled crawl meets a port without write()", async () => {
    const { port } = makeFakePort(assembled(["a"]));
    const noWrite = { ...port, write: undefined };
    await expect(
      runMirrorRefresh(noWrite, { startedAt: 1, label: "test-mirror" }),
    ).rejects.toThrow(/no write\(\)/);
  });
});

describe("runMirrorRefresh — streamed crawl (writes happened during the walk)", () => {
  it("skips the write phase entirely and prunes against the streamed seen-set", async () => {
    const fake = makeFakePort(
      crawlOf({ stopReason: "complete", seenKeys: new Set(["a"]) }),
      ["a", "orphan"],
    );
    const out = await runMirrorRefresh(fake.port, { startedAt: 2, label: "test-mirror" });
    expect(out.complete).toBe(true);
    expect(fake.writeCalls).toBe(0);
    expect(out.writes).toEqual({ inserted: 0, updated: 0, unchanged: 0 });
    expect(fake.tombstoneCalls).toBe(1);
    expect(fake.store.has("orphan")).toBe(false);
    expect(fake.store.has("a")).toBe(true);
  });

  it("never prunes a partial streamed walk", async () => {
    const fake = makeFakePort(
      crawlOf({ stopReason: "incomplete", seenKeys: new Set(["a"]) }),
      ["orphan"],
    );
    const out = await runMirrorRefresh(fake.port, { startedAt: 2, label: "test-mirror" });
    expect(out.complete).toBe(false);
    expect(fake.tombstoneCalls).toBe(0);
    expect(fake.store.has("orphan")).toBe(true);
  });

  it("applies the empty-source guard to streamed crawls too", async () => {
    const fake = makeFakePort(
      crawlOf({ stopReason: "complete", seenKeys: new Set() }),
      ["live"],
    );
    const out = await runMirrorRefresh(fake.port, { startedAt: 2, label: "test-mirror" });
    expect(out.stopReason).toBe(EMPTY_SOURCE);
    expect(out.complete).toBe(false);
    expect(fake.tombstoneCalls).toBe(0);
    expect(fake.store.has("live")).toBe(true);
  });
});
