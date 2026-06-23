/* eslint-disable max-lines, max-lines-per-function */
// ADVERSARIAL integration suite — family: PARTIAL fills, crash replay, and
// persist-before-delete (ADR-0027 deferred Attachment Fill).
//
// The owner's #1 invariant, attacked from the "the action crashed mid-fill"
// angle: when a fill is interrupted after a wave's PUT, the wave's tokens must be
// PERSISTED and their blobs deleted, the remaining-sources list must shrink to
// the UN-minted tail, the lifecycle must stay recoverable (pending/filling/
// failed — never silently "filled" or lost), and a replay (rearm-on-reopen or
// the action's own self-reschedule) must mint ONLY the remaining tail — every
// source ends up as exactly ONE token on the row, no duplicate file_name, no
// double-mint, no silent loss.
//
// We reach the REAL handlers only through the harness dispatcher (the same seam
// as drive.test.ts / the smoke test): vi.hoisted holder + vi.mock('./call') +
// vi.mock('../storage') delegating to the harness. We do NOT mock ./drive or any
// SUT module. Determinism: fake timers + a fixed system time; gated/faulted
// uploads via the FeishuBaseSim knobs; fixed fixtures.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 1. Hoisted holder the mocked modules delegate through (points at THIS test's
//    fresh harness, set in beforeEach via wireMocks).
const mocks = vi.hoisted(() => ({
  callFeishu: async (..._args: unknown[]): Promise<unknown> => {
    throw new Error("harness not wired: callFeishu");
  },
  resolveFeishuToken: async (..._args: unknown[]): Promise<string> => "tenant-token",
  getStorageBytes: async (..._args: unknown[]): Promise<ArrayBuffer> => {
    throw new Error("harness not wired: getStorageBytes");
  },
}));

// 2. Mock ONLY the I/O boundary (paths relative to this *.test.ts file). Preserve
//    the REAL ./call exports (notably withFeishuRateLimitRetry, used by
//    bitable.createServiceRecord) and override ONLY the two network functions —
//    a missing withFeishuRateLimitRetry makes the create path throw before any
//    row is minted (Vitest: "No export defined on the ./call mock").
vi.mock("./call", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./call")>();
  return {
    ...actual,
    callFeishu: (...args: unknown[]) => mocks.callFeishu(...args),
    resolveFeishuToken: (...args: unknown[]) => mocks.resolveFeishuToken(...args),
  };
});
vi.mock("../storage", () => ({
  getStorageBytes: (...args: unknown[]) => mocks.getStorageBytes(...args),
}));

// 3. Import the harness AFTER the mocks. We also import two REAL SUT constants
//    directly (NOT mocking those modules) so the fixtures match the SUT's own
//    thresholds exactly: the 20-MiB oversize cutoff and the rearm grace window.
import { createHarness, makeBytes, restoreEnv, type Harness } from "./attachmentFillSim";
import { MAX_MEDIA_UPLOAD_BYTES } from "./drive";
import { STALE_PENDING_REARM_GRACE_MS } from "./bitableSyncRetry";

const APP_TOKEN = "appTok";
const TABLE_ID = "tbl_service";
const NOW = 1_716_500_000_000;
const STALE_GRACE = STALE_PENDING_REARM_GRACE_MS;

const originalAppToken = process.env.FEISHU_BITABLE_APP_TOKEN;
const originalTableId = process.env.FEISHU_BITABLE_TABLE_ID;
const originalConcurrency = process.env.FEISHU_DRIVE_UPLOAD_CONCURRENCY;
const originalWindow = process.env.BITABLE_OWNED_ROW_UPDATE_WINDOW_MS;

let harness: Harness;

beforeEach(() => {
  process.env.FEISHU_BITABLE_APP_TOKEN = APP_TOKEN;
  process.env.FEISHU_BITABLE_TABLE_ID = TABLE_ID;
  // Force two waves at a deterministic, small width so "wave 1 vs wave 2" is
  // crisp (concurrency 2 ⇒ a 4-source intake splits exactly [0,1] then [2,3]).
  process.env.FEISHU_DRIVE_UPLOAD_CONCURRENCY = "2";
  delete process.env.BITABLE_OWNED_ROW_UPDATE_WINDOW_MS;
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  harness = createHarness();
  harness.wireMocks(mocks as never);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  restoreEnv("FEISHU_BITABLE_APP_TOKEN", originalAppToken);
  restoreEnv("FEISHU_BITABLE_TABLE_ID", originalTableId);
  restoreEnv("FEISHU_DRIVE_UPLOAD_CONCURRENCY", originalConcurrency);
  restoreEnv("BITABLE_OWNED_ROW_UPDATE_WINDOW_MS", originalWindow);
});


/** The Email Record for an intake, asserted present. */
function recordOf(intake: ReturnType<Harness["makeIntake"]>) {
  const rec = harness.getByMessageId(intake.internetMessageId);
  if (!rec) throw new Error("expected an Email Record for the intake");
  return rec;
}

function fileNamesOf(intake: ReturnType<Harness["makeIntake"]>): string[] {
  return (intake.attachmentSources ?? []).map((s) => s.fileName);
}

// ===========================================================================
// 1. CRASH AFTER WAVE 1 — the core persist-before-delete + replay guarantee.
// ===========================================================================

describe("crash after wave 1 (2nd wave defers) then rearm replays only the tail", () => {
  it("persists wave-1 tokens + deletes their blobs, shrinks remaining to the tail, stays recoverable", async () => {
    // 4 sources @ concurrency 2 ⇒ wave 1 = [f0,f1], wave 2 = [f2,f3].
    const intake = harness.makeIntake({ attachmentCount: 4 });
    const [f0, f1, f2, f3] = fileNamesOf(intake);

    // The "crash": EVERY upload in wave 2 throws a transient (non-Feishu) error,
    // so the fill DEFERS the whole second wave and BREAKS after wave 1 was fully
    // persisted + its blobs deleted + its coalesced PUT sent. (Deferring only one
    // of the two files would still mint+persist the sibling before the break — the
    // pipeline is correct about that; here we want a clean wave-1-only crash.)
    harness.feishu.deferUploadFor(f2, { times: 1 });
    harness.feishu.deferUploadFor(f3, { times: 1 });

    await harness.submit(intake);
    await harness.driveToCompletion();

    const recordId = harness.feishu.recordIds()[0];
    const rec = recordOf(intake);

    // --- WAVE 1 PERSISTED: exactly the two wave-1 tokens are on the record. ---
    expect(rec.bitableAttachmentFileTokens).toHaveLength(2);
    // ...and those two tokens are the ones minted for f0 + f1 (and only those).
    expect(harness.feishu.mintedTokensFor(f0)).toHaveLength(1);
    expect(harness.feishu.mintedTokensFor(f1)).toHaveLength(1);
    expect(harness.feishu.mintedCount()).toBe(2); // wave 2 never minted (it deferred)

    // --- WAVE 1 BLOBS DELETED (persist-before-delete completed for wave 1). ---
    expect(harness.storage.has(intake.attachmentSources![0].storageId)).toBe(false);
    expect(harness.storage.has(intake.attachmentSources![1].storageId)).toBe(false);
    // --- WAVE 2 BLOBS STILL STAGED (never minted ⇒ never deleted). ---
    expect(harness.storage.has(intake.attachmentSources![2].storageId)).toBe(true);
    expect(harness.storage.has(intake.attachmentSources![3].storageId)).toBe(true);

    // --- REMAINING shrunk to the UN-minted tail (f2, f3). ---
    const remaining = (rec.bitableAttachmentSources ?? []) as { fileName: string }[];
    expect(remaining.map((s) => s.fileName)).toEqual([f2, f3]);

    // --- STILL RECOVERABLE: not "filled", not lost. The deferred wave marks
    //     the fill `failed` with a real future next-retry (re-armable). ---
    expect(rec.bitableAttachmentStatus).toBe("failed");
    expect(typeof rec.attachmentNextRetryAt).toBe("number");
    expect(rec.attachmentNextRetryAt as number).toBeGreaterThan(NOW);

    // The coalesced PUT carried only the cumulative wave-1 tokens (Sales Files
    // column only), targeting the SAME row this flow minted.
    const salesPuts = harness.feishu.salesFilesPuts();
    expect(salesPuts.length).toBe(1);
    expect(salesPuts[0].recordId).toBe(recordId);
    expect(salesPuts[0].fieldKeys).toEqual(["Sales Files"]);
    expect(harness.feishu.salesFilesTokens(recordId)).toHaveLength(2);
  });

  it("rearm-on-reopen re-drives and mints ONLY the remaining tail: final cell = all 4, no dup file_name", async () => {
    const intake = harness.makeIntake({ attachmentCount: 4 });
    const [, , f2] = fileNamesOf(intake);

    // Crash wave 2 once; on the REPLAY the defer fault is already consumed, so
    // the tail mints cleanly.
    harness.feishu.deferUploadFor(f2, { times: 1 });

    await harness.sendAndSettle(intake);

    const recordId = harness.feishu.recordIds()[0];
    const rec = recordOf(intake);
    expect(rec.bitableAttachmentStatus).toBe("failed");

    // Drop the action's self-rescheduled retry so we exercise ONLY the public
    // rearm-on-reopen path (the cron-free self-heal the taskpane calls).
    harness.scheduler.clear();

    // Advance past the grace window + the persisted next-retry so the rearm
    // server-side staleness re-check passes; the freshness window (120m) still
    // holds (we are ~5m from mint).
    vi.setSystemTime((rec.attachmentNextRetryAt as number) + STALE_GRACE + 1);

    const { rearmed } = await harness.rearm(intake.userEmail!, intake.conversationId!);
    expect(rearmed).toBe(true);
    await harness.driveToCompletion();

    // --- ONLY the remaining tail was minted on replay: total mints = N (4),
    //     and EVERY file_name minted exactly once (no double-mint). ---
    expect(harness.feishu.mintedCount()).toBe(4);
    for (const name of fileNamesOf(intake)) {
      expect(harness.feishu.mintedTokensFor(name)).toHaveLength(1);
    }

    // --- FINAL CELL = all 4 tokens, no duplicates, on the SAME row. ---
    const cell = harness.feishu.salesFilesTokens(recordId);
    expect(cell).toHaveLength(4);
    expect(new Set(cell).size).toBe(4);
    expect(new Set(cell)).toEqual(new Set(harness.feishu.uploadLog.map((u) => u.fileToken)));

    // Lifecycle settled clean, remaining drained, all blobs gone, no retry left.
    const after = recordOf(intake);
    expect(after.bitableAttachmentStatus).toBe("filled");
    expect((after.bitableAttachmentSources ?? []) as unknown[]).toEqual([]);
    expect(harness.storage.size()).toBe(0);
    expect(harness.pendingJobs()).toEqual([]);

    // Every Sales-Files PUT (wave-1 coalesce + replay coalesce) hit the right
    // row + column-scope only — never a foreign id, never `Request Type`.
    for (const put of harness.feishu.salesFilesPuts()) {
      expect(put.recordId).toBe(recordId);
      expect(put.fieldKeys).toEqual(["Sales Files"]);
    }
  });

  it("the action's OWN self-reschedule (no human) also replays only the tail with no double-mint", async () => {
    // Same crash, but recovery via the in-action self-reschedule + time advance
    // (the no-human-in-the-loop path) rather than rearm. Both must converge.
    const intake = harness.makeIntake({ attachmentCount: 4 });
    const [, , f2] = fileNamesOf(intake);
    harness.feishu.deferUploadFor(f2, { times: 1 });

    await harness.sendAndSettle(intake);
    const recordId = harness.feishu.recordIds()[0];
    const rec = recordOf(intake);

    // A retry was self-scheduled by markAttachmentsFailed → fillRowAttachments.
    const pending = harness.pendingJobs();
    expect(pending.some((j) => j.refName.endsWith("fillRowAttachments"))).toBe(true);

    // Release the future-dated retry by advancing to its dueAt.
    vi.setSystemTime((rec.attachmentNextRetryAt as number) + 1);
    await harness.driveToCompletion();

    expect(harness.feishu.mintedCount()).toBe(4);
    for (const name of fileNamesOf(intake)) {
      expect(harness.feishu.mintedTokensFor(name)).toHaveLength(1);
    }
    const cell = harness.feishu.salesFilesTokens(recordId);
    expect(cell).toHaveLength(4);
    expect(new Set(cell).size).toBe(4);
    expect(recordOf(intake).bitableAttachmentStatus).toBe("filled");
  });
});

// ===========================================================================
// 2. CRASH BETWEEN PERSIST AND DELETE — the blob delete fails / is skipped.
// ===========================================================================

describe("crash between persist and delete (blob delete fails)", () => {
  it("token is not lost and a replay does NOT re-mint that source (already dropped from remaining)", async () => {
    const intake = harness.makeIntake({ attachmentCount: 2 });
    const [f0, f1] = fileNamesOf(intake);

    // Make ctx.storage.delete a no-op throw (the SUT wraps it in .catch(()=>{}),
    // so a delete failure is swallowed — the persist already committed the token
    // and dropped the source from `remainingSources`). This models a crash/skip
    // in the delete step that leaves a leaked blob but NEVER loses a token.
    const realDelete = harness.storage.delete.bind(harness.storage);
    harness.storage.delete = async (_id: string): Promise<void> => {
      throw new Error("simulated storage.delete failure (crash between persist and delete)");
    };

    await harness.sendAndSettle(intake);

    const recordId = harness.feishu.recordIds()[0];
    const rec = recordOf(intake);

    // Both tokens persisted, both minted exactly once, cell has both.
    expect(rec.bitableAttachmentFileTokens).toHaveLength(2);
    expect(harness.feishu.salesFilesTokens(recordId)).toHaveLength(2);
    expect(harness.feishu.mintedTokensFor(f0)).toHaveLength(1);
    expect(harness.feishu.mintedTokensFor(f1)).toHaveLength(1);

    // The persist DROPPED the sources from remaining even though the blobs were
    // not deleted (delete threw) — so no token is lost AND no source lingers to
    // be re-minted.
    expect((rec.bitableAttachmentSources ?? []) as unknown[]).toEqual([]);
    expect(rec.bitableAttachmentStatus).toBe("filled");

    // The blobs leaked (delete failed) — observable, but harmless.
    expect(harness.storage.size()).toBe(2);

    // Now restore a working delete and REPLAY (rearm-style direct kick). Because
    // remaining is empty, the replay re-mints NOTHING — no double-mint of either
    // source, even though their blobs are still staged.
    harness.storage.delete = realDelete;
    await harness.startFill(harness.lookupFor(intake));

    expect(harness.feishu.mintedTokensFor(f0)).toHaveLength(1);
    expect(harness.feishu.mintedTokensFor(f1)).toHaveLength(1);
    expect(harness.feishu.mintedCount()).toBe(2); // unchanged
    expect(harness.feishu.salesFilesTokens(recordId)).toHaveLength(2);
  });
});

// ===========================================================================
// 3. DEAD / GC'd SOURCE — getStorageBytes throws for one file ⇒ 'skipped'.
// ===========================================================================

describe("dead/GC'd source (getStorageBytes throws for one file)", () => {
  it("records the dead file as skipped (observable), still fills the others; filled+skipped === N", async () => {
    const intake = harness.makeIntake({ attachmentCount: 4 });
    const [f0, f1, f2, f3] = fileNamesOf(intake);

    // Evict ONE staged blob before the fill runs (a GC'd / already-consumed
    // restored-draft source). getStorageBytes throws for it ⇒ mintOneStagedSource
    // classifies it `skipped` (permanent, never uploaded, never deferred).
    await harness.storage.delete(intake.attachmentSources![1].storageId);

    await harness.sendAndSettle(intake);

    const recordId = harness.feishu.recordIds()[0];
    const rec = recordOf(intake);

    // The dead file is recorded in bitableAttachmentSkipped (observable) — not
    // silently vanished.
    expect(rec.bitableAttachmentSkipped).toEqual([f1]);

    // The OTHER three filled (minted exactly once each); the dead one never
    // minted.
    expect(harness.feishu.mintedTokensFor(f0)).toHaveLength(1);
    expect(harness.feishu.mintedTokensFor(f1)).toHaveLength(0);
    expect(harness.feishu.mintedTokensFor(f2)).toHaveLength(1);
    expect(harness.feishu.mintedTokensFor(f3)).toHaveLength(1);

    // (filled tokens) + (skipped) === N — nothing silently lost.
    const filledCount = (rec.bitableAttachmentFileTokens as unknown[]).length;
    const skippedCount = (rec.bitableAttachmentSkipped as unknown[]).length;
    expect(filledCount + skippedCount).toBe(4);

    // The cell holds the 3 healthy tokens; the lifecycle settled `filled`
    // (a skip is permanent, not a deferral — the fill completes).
    expect(harness.feishu.salesFilesTokens(recordId)).toHaveLength(3);
    expect(rec.bitableAttachmentStatus).toBe("filled");
    // Remaining drained, no retry pending.
    expect((rec.bitableAttachmentSources ?? []) as unknown[]).toEqual([]);
    expect(harness.pendingJobs()).toEqual([]);
  });

  it("a wave of ALL-dead sources skips every one, fills nothing, and still settles 'filled' (no silent loss)", async () => {
    const intake = harness.makeIntake({ attachmentCount: 2 });
    const names = fileNamesOf(intake);
    // Evict both staged blobs.
    for (const s of intake.attachmentSources ?? []) {
      // eslint-disable-next-line no-await-in-loop -- tiny fixed fixture
      await harness.storage.delete(s.storageId);
    }

    await harness.sendAndSettle(intake);
    const rec = recordOf(intake);

    expect(rec.bitableAttachmentSkipped).toEqual(names);
    expect(harness.feishu.mintedCount()).toBe(0);
    // No PUT for an all-skip wave (buildServiceAttachmentFields([]) ⇒ {} ⇒ no PUT).
    expect(harness.feishu.salesFilesPuts()).toEqual([]);
    // (filled 0) + (skipped 2) === 2; nothing lost.
    expect((rec.bitableAttachmentFileTokens ?? []) as unknown[]).toEqual([]);
    expect(rec.bitableAttachmentStatus).toBe("filled");
    expect((rec.bitableAttachmentSources ?? []) as unknown[]).toEqual([]);
  });
});

// ===========================================================================
// 4. OVERSIZE SOURCE (>20 MiB) ⇒ skipped + observable, never uploaded.
// ===========================================================================

describe("oversize source (>20 MiB ArrayBuffer)", () => {
  it("skips the oversize file (observable), never uploads it, fills the rest", async () => {
    // Build one intake whose first source is oversize and the second is normal.
    const intake = harness.makeIntake({ attachmentCount: 2 });
    const [oversizeName, normalName] = fileNamesOf(intake);
    // Re-stage the FIRST source's blob as >20 MiB at the SAME storageId so the
    // fill reads oversize bytes for it (makeIntake staged small bytes by default).
    const big = makeBytes(MAX_MEDIA_UPLOAD_BYTES + 1, 7);
    harness.storage.stage(big, intake.attachmentSources![0].storageId);

    await harness.sendAndSettle(intake);

    const recordId = harness.feishu.recordIds()[0];
    const rec = recordOf(intake);

    // Oversize ⇒ skipped + observable; never uploaded.
    expect(rec.bitableAttachmentSkipped).toEqual([oversizeName]);
    expect(harness.feishu.mintedTokensFor(oversizeName)).toHaveLength(0);
    // The normal file still minted + landed in the cell.
    expect(harness.feishu.mintedTokensFor(normalName)).toHaveLength(1);
    expect(harness.feishu.salesFilesTokens(recordId)).toHaveLength(1);

    // (filled 1) + (skipped 1) === 2; settled filled; remaining drained.
    expect((rec.bitableAttachmentFileTokens as unknown[]).length).toBe(1);
    expect(rec.bitableAttachmentStatus).toBe("filled");
    expect((rec.bitableAttachmentSources ?? []) as unknown[]).toEqual([]);

    // The oversize blob is NOT deleted (it was skipped, not minted) — observable.
    expect(harness.storage.has(intake.attachmentSources![0].storageId)).toBe(true);
  });
});

// ===========================================================================
// 5. MIXED WAVE — minted + skipped together persist ATOMICALLY before delete;
//    the PUT carries only the minted cumulative tokens.
// ===========================================================================

describe("mixed wave (minted + skipped in the same wave)", () => {
  it("persists both the minted token and the skipped name before delete; PUT carries only minted tokens", async () => {
    // concurrency 2, exactly 2 sources ⇒ ONE wave carrying [minted, skipped].
    const intake = harness.makeIntake({ attachmentCount: 2 });
    const [mintedName, skippedName] = fileNamesOf(intake);
    // Kill the SECOND source's blob so it skips inside the same wave as the first.
    await harness.storage.delete(intake.attachmentSources![1].storageId);

    await harness.sendAndSettle(intake);

    const recordId = harness.feishu.recordIds()[0];
    const rec = recordOf(intake);

    // Both outcomes persisted ATOMICALLY (one recordAttachmentProgress call):
    // the minted token in fileTokens AND the skipped name in skipped.
    expect(harness.feishu.mintedTokensFor(mintedName)).toHaveLength(1);
    expect((rec.bitableAttachmentFileTokens as unknown[]).length).toBe(1);
    expect(rec.bitableAttachmentSkipped).toEqual([skippedName]);

    // BOTH sources were dropped from remaining in that single persist (atomic).
    expect((rec.bitableAttachmentSources ?? []) as unknown[]).toEqual([]);

    // The minted blob was deleted (persist-before-delete); the skipped one was
    // already gone (it is what made the skip happen).
    expect(harness.storage.has(intake.attachmentSources![0].storageId)).toBe(false);

    // The coalesced PUT carried ONLY the minted token in the Sales Files column —
    // a skip contributes no token to the cell.
    const salesPuts = harness.feishu.salesFilesPuts();
    expect(salesPuts).toHaveLength(1);
    expect(salesPuts[0].recordId).toBe(recordId);
    expect(salesPuts[0].fieldKeys).toEqual(["Sales Files"]);
    expect(harness.feishu.salesFilesTokens(recordId)).toHaveLength(1);

    expect(rec.bitableAttachmentStatus).toBe("filled");
  });
});

// ===========================================================================
// 6. THE FENCE/WINDOW DEFECT — a LATE attachment retry PUTs after the freshness
//    window expires ⇒ patchRowAttachments fence REFUSES (throws). Minted +
//    persisted tokens then never reach the cell. SUSPECTED REAL DEFECT.
// ===========================================================================

describe("fence vs retry-span: a late retry mints + persists but the fence blocks the PUT", () => {
  // BUG: A deferred attachment fill is minted + persisted on the retry, but the
  // freshness fence (mayUpdateOwnedBitableRow) refuses the PUT because the retry
  // fired AFTER the window elapsed — the tokens are recorded on the Email Record
  // (bitableAttachmentFileTokens) but never land in the Base `Sales Files` cell,
  // and the lifecycle dies at `failed`/`abandoned`. Owner invariant (c) "fully
  // pend ALL file tokens onto the row" is violated: a persisted-but-unwritten
  // token is partial-and-silent loss on the row.
  // Repro below: shrink the window to 1ms so the SECOND wave's retry (after a
  // deferred first attempt) lands outside it; the retry mints + persists the tail
  // token but the PUT throws and the cell still misses it.
  // Fix sketch: derive the retry backoff schedule from (or clamp it under) the
  // freshness window — OR widen the fence to "the SAME flow's own retry chain"
  // (carry the bitableClientToken as the provenance proof and drop the time
  // window for self-minted rows, since provenance already proves ownership).
  it.fails(
    "minted+persisted token reaches the cell even when the retry fires past the freshness window",
    async () => {
      // One 2-source intake. Wave 1 (concurrency 2 → but make it 1 so f1 is its
      // own wave that we defer, then retry past the window).
      process.env.FEISHU_DRIVE_UPLOAD_CONCURRENCY = "1";
      const intake = harness.makeIntake({ attachmentCount: 2 });
      const [, f1] = fileNamesOf(intake);

      // Defer the SECOND source on the first attempt; on the retry it mints.
      harness.feishu.deferUploadFor(f1, { times: 1 });

      await harness.sendAndSettle(intake);

      const recordId = harness.feishu.recordIds()[0];
      const rec = recordOf(intake);
      // Wave 1 (f0) landed; f1 deferred → failed → retry scheduled.
      expect(harness.feishu.salesFilesTokens(recordId)).toHaveLength(1);
      expect(rec.bitableAttachmentStatus).toBe("failed");

      // Now SHRINK the freshness window so the upcoming retry PUT is fenced out.
      process.env.BITABLE_OWNED_ROW_UPDATE_WINDOW_MS = "1";

      // Release the self-scheduled retry (its dueAt is +5m, well past a 1ms
      // window since mint at NOW).
      vi.setSystemTime((rec.attachmentNextRetryAt as number) + 1);
      await harness.driveToCompletion();

      // The retry MINTED + PERSISTED f1's token (persist-before-delete ran)...
      const after = recordOf(intake);
      expect((after.bitableAttachmentFileTokens as unknown[]).length).toBe(2);

      // ...but does the SECOND token actually reach the Base cell? With the fence
      // refusing the PUT, it does NOT — this assertion FAILS today (the bug).
      expect(harness.feishu.salesFilesTokens(recordId)).toHaveLength(2);
    },
  );

  it("characterizes the fence refusal: persisted token count outruns the cell when the window is closed", async () => {
    // The SAFE-side characterization of the same defect: we OBSERVE the divergence
    // (persisted tokens > cell tokens) deterministically, so the suite documents
    // the current (buggy) behavior without going red.
    process.env.FEISHU_DRIVE_UPLOAD_CONCURRENCY = "1";
    const intake = harness.makeIntake({ attachmentCount: 2 });
    const [, f1] = fileNamesOf(intake);
    harness.feishu.deferUploadFor(f1, { times: 1 });

    await harness.sendAndSettle(intake);
    const recordId = harness.feishu.recordIds()[0];
    const rec = recordOf(intake);

    process.env.BITABLE_OWNED_ROW_UPDATE_WINDOW_MS = "1";
    vi.setSystemTime((rec.attachmentNextRetryAt as number) + 1);
    await harness.driveToCompletion();

    const after = recordOf(intake);
    const persisted = (after.bitableAttachmentFileTokens as unknown[]).length;
    const inCell = harness.feishu.salesFilesTokens(recordId).length;

    // The retry minted f1 and persisted its token (2 persisted)...
    expect(persisted).toBe(2);
    // ...but the fence refused the second PUT, so the cell is stuck at 1.
    expect(inCell).toBe(1);
    expect(persisted).toBeGreaterThan(inCell); // the silent on-row loss

    // The fence threw inside patchRowAttachments; fillRowAttachments' own
    // try/catch swallowed it into the failure path, so the proof that the PUT was
    // REFUSED (not merely skipped) is the recorded last-error on the row.
    expect(String(after.bitableLastError)).toMatch(/Refusing Sales Files PUT/);
    // The fill is left non-`filled` (the row is missing a token it minted) — the
    // observable, persisted symptom of the on-row loss.
    expect(after.bitableAttachmentStatus).not.toBe("filled");
  });
});
