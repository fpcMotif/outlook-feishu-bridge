// Unit tests for the Attachment Fill engine — one fill pass driven through an
// in-memory fake port, no Convex. This is the seam the extraction buys: the
// wave sequencing, the PERSIST-BEFORE-DELETE ordering, the deferred-break, and
// the failure→bounded-retry arming are exercised directly, with an op log
// asserting the exact order of effects. The real adapter
// (requestSync.fillRowAttachments) stays covered end to end by the
// attachmentFillSim harness suite.

import { describe, expect, it } from "vitest";

import {
  runAttachmentFill,
  type AttachmentFillPort,
  type AttachmentFillState,
  type MintOutcome,
  type StagedSource,
} from "./attachmentFillEngine";

function src(n: number): StagedSource {
  return { storageId: `st_${n}`, fileName: `f${n}.pdf` };
}

function sources(count: number): StagedSource[] {
  return Array.from({ length: count }, (_, n) => src(n));
}

interface FakePortOptions {
  state?: AttachmentFillState | null;
  concurrency?: number;
  /** Per-storageId mint behavior; default is "minted". */
  mintPlan?: Record<string, "minted" | "skipped" | "deferred" | "throw">;
  /** Throw from recordProgress (simulates a persist crash). */
  recordProgressThrows?: boolean;
  /** Reject blob deletion (must never fail the fill). */
  deleteThrows?: boolean;
  /** Throw from prepare (config error — must propagate, not mark failed). */
  prepareThrows?: boolean;
  /** What markFailed's planner answers; default arms a 5s retry. */
  retryDelayMs?: number | null;
}

function makeFakePort(opts: FakePortOptions = {}) {
  const ops: string[] = [];
  const failures: string[] = [];
  const retries: number[] = [];
  const port: AttachmentFillPort = {
    getState: () => {
      ops.push("getState");
      return Promise.resolve(opts.state === undefined ? null : opts.state);
    },
    prepare: () => {
      ops.push("prepare");
      if (opts.prepareThrows) return Promise.reject(new Error("FEISHU_BITABLE_APP_TOKEN must be set"));
      return Promise.resolve({ concurrency: opts.concurrency ?? 2 });
    },
    mint: (source) => {
      ops.push(`mint:${source.storageId}`);
      const plan = opts.mintPlan?.[source.storageId] ?? "minted";
      if (plan === "throw") return Promise.reject(new Error(`mint blew up on ${source.fileName}`));
      const outcome: MintOutcome =
        plan === "minted"
          ? { kind: "minted", fileToken: `tok_${source.storageId}`, ...source }
          : { kind: plan, ...source };
      return Promise.resolve(outcome);
    },
    recordProgress: (progress) => {
      ops.push(
        `persist:[${progress.mintedTokens.join(",")}]+skip[${progress.skippedNames.join(",")}]`,
      );
      if (opts.recordProgressThrows) return Promise.reject(new Error("persist failed"));
      return Promise.resolve();
    },
    deleteStagedBlob: (storageId) => {
      ops.push(`delete:${storageId}`);
      if (opts.deleteThrows) return Promise.reject(new Error("blob already gone"));
      return Promise.resolve();
    },
    patchRow: () => {
      ops.push("patchRow");
      return Promise.resolve();
    },
    markFilled: () => {
      ops.push("markFilled");
      return Promise.resolve();
    },
    markFailed: (reason) => {
      ops.push("markFailed");
      failures.push(reason);
      return Promise.resolve({ retryDelayMs: opts.retryDelayMs === undefined ? 5_000 : opts.retryDelayMs });
    },
    scheduleRetry: (delayMs) => {
      ops.push(`scheduleRetry:${delayMs}`);
      retries.push(delayMs);
      return Promise.resolve();
    },
  };
  return { port, ops, failures, retries };
}

function fillState(remaining: StagedSource[], over: Partial<AttachmentFillState> = {}): AttachmentFillState {
  return {
    bitableRecordId: "rec_1",
    bitableAttachmentStatus: "pending",
    remainingSources: remaining,
    ...over,
  };
}

describe("runAttachmentFill — early exits", () => {
  it("no-ops when the Email Record is gone", async () => {
    const fake = makeFakePort({ state: null });
    expect(await runAttachmentFill(fake.port)).toEqual({ filled: 0, skipped: 0, deferred: 0 });
    expect(fake.ops).toEqual(["getState"]);
  });

  it("no-ops when the Base row was never created (create lifecycle's job)", async () => {
    const fake = makeFakePort({ state: fillState(sources(2), { bitableRecordId: null }) });
    expect(await runAttachmentFill(fake.port)).toEqual({ filled: 0, skipped: 0, deferred: 0 });
    expect(fake.ops).toEqual(["getState"]);
  });

  it("no-ops when the fill already fenced filled", async () => {
    const fake = makeFakePort({ state: fillState(sources(2), { bitableAttachmentStatus: "filled" }) });
    expect(await runAttachmentFill(fake.port)).toEqual({ filled: 0, skipped: 0, deferred: 0 });
    expect(fake.ops).toEqual(["getState"]);
  });

  it("fences filled immediately when nothing remains (no prepare, no mint)", async () => {
    const fake = makeFakePort({ state: fillState([]) });
    expect(await runAttachmentFill(fake.port)).toEqual({ filled: 0, skipped: 0, deferred: 0 });
    expect(fake.ops).toEqual(["getState", "markFilled"]);
  });

  it("a prepare (config) failure propagates instead of consuming a retry attempt", async () => {
    const fake = makeFakePort({ state: fillState(sources(1)), prepareThrows: true });
    await expect(runAttachmentFill(fake.port)).rejects.toThrow(/FEISHU_BITABLE_APP_TOKEN/);
    expect(fake.ops).toEqual(["getState", "prepare"]);
    expect(fake.failures).toEqual([]);
  });
});

describe("runAttachmentFill — waves and ordering", () => {
  it("processes sources in waves of `concurrency`, persisting BEFORE deleting BEFORE the PUT", async () => {
    const fake = makeFakePort({ state: fillState(sources(4)), concurrency: 2 });
    const totals = await runAttachmentFill(fake.port);
    expect(totals).toEqual({ filled: 4, skipped: 0, deferred: 0 });
    expect(fake.ops).toEqual([
      "getState",
      "prepare",
      "mint:st_0",
      "mint:st_1",
      "persist:[tok_st_0,tok_st_1]+skip[]",
      "delete:st_0",
      "delete:st_1",
      "patchRow",
      "mint:st_2",
      "mint:st_3",
      "persist:[tok_st_2,tok_st_3]+skip[]",
      "delete:st_2",
      "delete:st_3",
      "patchRow",
      "markFilled",
    ]);
  });

  it("a mixed wave persists minted + skipped together but deletes only the minted blobs", async () => {
    const fake = makeFakePort({
      state: fillState(sources(2)),
      concurrency: 2,
      mintPlan: { st_1: "skipped" },
    });
    const totals = await runAttachmentFill(fake.port);
    expect(totals).toEqual({ filled: 1, skipped: 1, deferred: 0 });
    expect(fake.ops).toContain("persist:[tok_st_0]+skip[f1.pdf]");
    expect(fake.ops).toContain("delete:st_0");
    expect(fake.ops).not.toContain("delete:st_1");
    expect(fake.ops.at(-1)).toBe("markFilled");
  });

  it("an all-skipped wave still persists and PUTs (the adapter's PUT no-ops on zero tokens)", async () => {
    const fake = makeFakePort({
      state: fillState(sources(1)),
      mintPlan: { st_0: "skipped" },
    });
    const totals = await runAttachmentFill(fake.port);
    expect(totals).toEqual({ filled: 0, skipped: 1, deferred: 0 });
    expect(fake.ops).toContain("persist:[]+skip[f0.pdf]");
    expect(fake.ops).toContain("patchRow");
    expect(fake.ops.at(-1)).toBe("markFilled");
  });

  it("a failed blob delete never fails the fill (token already persisted)", async () => {
    const fake = makeFakePort({ state: fillState(sources(2)), concurrency: 2, deleteThrows: true });
    const totals = await runAttachmentFill(fake.port);
    expect(totals).toEqual({ filled: 2, skipped: 0, deferred: 0 });
    expect(fake.ops).toContain("patchRow");
    expect(fake.ops.at(-1)).toBe("markFilled");
    expect(fake.failures).toEqual([]);
  });
});

describe("runAttachmentFill — deferred break and retry arming", () => {
  it("a deferred mint stops the loop: the tail is never minted, the wave's siblings still land", async () => {
    const fake = makeFakePort({
      state: fillState(sources(4)),
      concurrency: 2,
      mintPlan: { st_1: "deferred" },
    });
    const totals = await runAttachmentFill(fake.port);
    expect(totals).toEqual({ filled: 1, skipped: 0, deferred: 1 });
    // Wave 1's minted sibling persists + PUTs; wave 2 (st_2, st_3) never starts.
    expect(fake.ops).toContain("persist:[tok_st_0]+skip[]");
    expect(fake.ops).not.toContain("mint:st_2");
    expect(fake.ops).not.toContain("mint:st_3");
    expect(fake.failures).toEqual(["1 attachment(s) deferred (transient Drive failure)"]);
    expect(fake.retries).toEqual([5_000]);
    expect(fake.ops).not.toContain("markFilled");
  });

  it("an all-deferred wave neither persists nor PUTs, then arms the retry", async () => {
    const fake = makeFakePort({
      state: fillState(sources(2)),
      concurrency: 2,
      mintPlan: { st_0: "deferred", st_1: "deferred" },
    });
    const totals = await runAttachmentFill(fake.port);
    expect(totals).toEqual({ filled: 0, skipped: 0, deferred: 2 });
    expect(fake.ops.some((op) => op.startsWith("persist:"))).toBe(false);
    expect(fake.ops).not.toContain("patchRow");
    expect(fake.failures).toEqual(["2 attachment(s) deferred (transient Drive failure)"]);
  });

  it("a terminal planner answer (null delay) records the failure without arming a retry", async () => {
    const fake = makeFakePort({
      state: fillState(sources(1)),
      mintPlan: { st_0: "deferred" },
      retryDelayMs: null,
    });
    await runAttachmentFill(fake.port);
    expect(fake.failures).toHaveLength(1);
    expect(fake.retries).toEqual([]);
  });

  it("a thrown wave error becomes the failure reason and keeps the counts already accumulated", async () => {
    const fake = makeFakePort({
      state: fillState(sources(3)),
      concurrency: 1,
      mintPlan: { st_1: "throw" },
    });
    const totals = await runAttachmentFill(fake.port);
    // st_0 minted+landed before the crash; st_2 never reached.
    expect(totals).toEqual({ filled: 1, skipped: 0, deferred: 0 });
    expect(fake.ops).not.toContain("mint:st_2");
    expect(fake.failures).toEqual(["mint blew up on f1.pdf"]);
    expect(fake.retries).toEqual([5_000]);
  });

  it("a persist crash routes to markFailed with the error message (tokens not yet deleted)", async () => {
    const fake = makeFakePort({
      state: fillState(sources(1)),
      recordProgressThrows: true,
    });
    const totals = await runAttachmentFill(fake.port);
    expect(totals.filled).toBe(1);
    // PERSIST-BEFORE-DELETE: the crash happened in persist, so no blob was deleted.
    expect(fake.ops.some((op) => op.startsWith("delete:"))).toBe(false);
    expect(fake.ops).not.toContain("patchRow");
    expect(fake.failures).toEqual(["persist failed"]);
  });

  it("a thrown error beats the deferred default as the failure reason", async () => {
    const fake = makeFakePort({
      state: fillState(sources(2)),
      concurrency: 2,
      // st_0 defers (sets deferred>0), st_1 throws… but Promise.all rejects with
      // the throw, so the wave never partitions — the reason is the error.
      mintPlan: { st_0: "deferred", st_1: "throw" },
    });
    await runAttachmentFill(fake.port);
    expect(fake.failures).toEqual(["mint blew up on f1.pdf"]);
  });
});
