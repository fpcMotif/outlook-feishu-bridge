/* eslint-disable max-lines-per-function */
// ADVERSARIAL integration suite — FAMILY: "Concurrent-fill double-mint (no lock)".
//
// Weak point #1 (from the spec pack): the deferred Attachment Fill
// (`fillRowAttachments`) has NO per-row lease/lock. Each pass does:
//
//   state   = getAttachmentFillState(...)            // reads remainingSources
//   minted  = Promise.all(batch.map(mintOneStagedSource))  // upload_all — NOT idempotent
//   recordAttachmentProgress(... mintedTokens ...)   // append tokens, drop sources
//   patchRowAttachments(...)                          // PUT cumulative fileTokens
//
// If two fills overlap (e.g. the create-side kick races a rearm-on-reopen, or the
// reconcile backstop fires alongside the kick), BOTH can read the SAME
// `remainingSources` BEFORE either persists. Each then mints every source — and
// because `medias/upload_all` is not idempotent, a single logical file gets TWO
// distinct Drive `file_token`s, both appended to `bitableAttachmentFileTokens`,
// both PUT into the `Sales Files` cell.
//
// OWNER INVARIANT under attack (#1c): every source ends as a token on the row OR
// is observably skipped — "never duplicated". A double-mint violates (c): the
// final cell carries the same logical file twice (2 tokens, 2 Drive objects) and
// `tokenCount > sourceCount`.
//
// The seam mirrors convex/feishu/drive.test.ts exactly: a vi.hoisted holder +
// vi.mock('./call') + vi.mock('../storage') delegating into a per-test harness.
// We do NOT mock ./drive or any SUT module — the real mintOneStagedSource /
// recordAttachmentProgress / patchRowAttachments / fence run. The FeishuBaseSim
// upload gate (`gateUploads()`) holds BOTH fills mid-upload so they provably read
// the same state before either persists — a faithful interleave, not a contrivance.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 1. Hoisted holder the mocked I/O-boundary modules delegate through.
const mocks = vi.hoisted(() => ({
  callFeishu: async (..._args: unknown[]): Promise<unknown> => {
    throw new Error("harness not wired: callFeishu");
  },
  resolveFeishuToken: async (..._args: unknown[]): Promise<string> => "tenant-token",
  getStorageBytes: async (..._args: unknown[]): Promise<ArrayBuffer> => {
    throw new Error("harness not wired: getStorageBytes");
  },
}));

// 2. Mock ONLY the I/O boundary (paths relative to THIS test file). Preserve the
//    REAL ./call exports (notably withFeishuRateLimitRetry, used by
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

// 3. Import the harness AFTER the mocks. Also import `internal` so we can reach
//    the real fillRowAttachments handler through the harness dispatcher (we never
//    re-implement pipeline logic in the test — runAction resolves the ref to its
//    registered ._handler via the harness Registry, with the unified harness ctx).
import { createHarness, restoreEnv, type Harness, type FillLookup } from "./attachmentFillSim";
import { internal } from "../_generated/api";

const APP_TOKEN = "appTok";
const TABLE_ID = "tbl_service";
const NOW = 1_716_500_000_000;

const originalAppToken = process.env.FEISHU_BITABLE_APP_TOKEN;
const originalTableId = process.env.FEISHU_BITABLE_TABLE_ID;
const originalConcurrency = process.env.FEISHU_DRIVE_UPLOAD_CONCURRENCY;

let harness: Harness;

beforeEach(() => {
  process.env.FEISHU_BITABLE_APP_TOKEN = APP_TOKEN;
  process.env.FEISHU_BITABLE_TABLE_ID = TABLE_ID;
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
});

// Reach the REAL fillRowAttachments handler through the harness dispatcher (its
// registered ref -> ._handler via the Registry, with the unified harness ctx).
// Returns the action's own result promise so the test can hold two un-awaited
// invocations overlapping. No pipeline logic is duplicated here.
function startOverlappingFill(
  h: Harness,
  lookup: FillLookup,
): Promise<{ filled: number; skipped: number; deferred: number }> {
  return (h.ctx as {
    runAction: (
      ref: unknown,
      args: unknown,
    ) => Promise<{ filled: number; skipped: number; deferred: number }>;
  }).runAction(internal.feishu.requestSync.fillRowAttachments, {
    internetMessageId: lookup.internetMessageId,
    requestSyncKey: lookup.requestSyncKey,
  });
}

/**
 * Drive the CREATE only — run JUST the queued processPendingBitableSync (which
 * creates the Base row, marks synced, and kicks ONE fill via runAfter(0)). We pop
 * and run exactly that one job through the harness dispatcher, then DISCARD the
 * fill it kicked, so the test owns the interleave entirely. (We must NOT use
 * driveToCompletion / runDue here: those drain to quiescence and the runAfter(0)
 * fill is immediately due, so they would run the fill too and leave the row
 * already-filled.) Afterwards the row exists — bitableRecordId + bitableRowMintedAt
 * + bitableClientToken set, attachment status 'pending', remainingSources still
 * the full source list — exactly the state both racing fills will read.
 */
async function createRowOnly(
  h: Harness,
  intake: ReturnType<Harness["makeIntake"]>,
): Promise<string> {
  await h.submit(intake);
  // Pop and run ONLY processPendingBitableSync (the single due job after submit).
  const createJob = h.scheduler.popDue();
  expect(createJob?.refName).toContain("processPendingBitableSync");
  const handler = h.registry.resolve(createJob!.ref);
  await handler(h.ctx, createJob!.args ?? {});
  // The create's markBitableSyncSucceeded kicked a fillRowAttachments(0). Clear it
  // so the only fills that run are the explicit, gated ones the test starts.
  h.scheduler.clear();

  const recordIds = h.feishu.recordIds();
  expect(recordIds).toHaveLength(1);
  // Precondition: the row is created but the fill has NOT yet run.
  const rec = h.getByMessageId(intake.internetMessageId)!;
  expect(rec.bitableRecordId).toBe(recordIds[0]);
  expect((rec.bitableAttachmentSources as unknown[]).length).toBe(
    intake.attachmentSources!.length,
  );
  expect(rec.bitableAttachmentStatus).toBe("pending");
  expect(h.feishu.uploadLog).toHaveLength(0);
  return recordIds[0];
}

describe("concurrent fillRowAttachments — double-mint without a per-row lock", () => {
  // BUG: two overlapping fillRowAttachments read the same remainingSources before
  //      either persists, so each mints every file via the non-idempotent Drive
  //      upload_all => the same logical file is minted TWICE and BOTH tokens land
  //      in the row's Sales Files cell (token count > source count).
  //   Repro: createRowOnly => gateUploads() => start two fills => flush microtasks
  //          until both have read state + dispatched all uploads => release().
  //   Fix sketch: take a per-row fill lease in recordAttachmentProgress (a CAS on
  //          a `bitableAttachmentFillLeaseAt`/owner token under the mutation's
  //          transaction), OR dedup `remaining` by storageId at progress time AND
  //          have mintOneStagedSource short-circuit a storageId already minted in
  //          this row's fileTokens — so a racing pass re-reads an EMPTY remaining
  //          and no source is minted twice. (The mutation is the only true
  //          serialization point; the action interleave cannot be relied on.)
  it.fails(
    "OWNER INVARIANT (c): the Sales Files cell must contain NO duplicate logical file (token count === source count)",
    async () => {
      // 3 sources; raise the 5-QPS cap so a wide concurrent wave does not trip
      // 99991400 — we are isolating the double-mint, not the rate limiter.
      const intake = harness.makeIntake({ attachmentCount: 3 });
      harness.feishu.setUploadConcurrencyCap(100);
      const recordId = await createRowOnly(harness, intake);
      const lookup = harness.lookupFor(intake);

      // Hold every upload mid-flight so BOTH fills can read state + enter upload
      // BEFORE either persists — the faithful interleave the missing lock allows.
      const { release } = harness.feishu.gateUploads();

      const fillA = startOverlappingFill(harness, lookup);
      const fillB = startOverlappingFill(harness, lookup);

      // Flush microtasks so both fills run getAttachmentFillState and dispatch all
      // their uploads (each upload parks at the gate inside the in-flight window).
      for (let i = 0; i < 50; i++) {
        // eslint-disable-next-line no-await-in-loop -- draining the microtask queue deterministically
        await Promise.resolve();
      }

      // Sanity: both fills are genuinely overlapping in the upload window. With 3
      // sources and two fills, 6 uploads are parked at the gate concurrently.
      expect(harness.feishu.uploadConcurrencyPeak).toBeGreaterThanOrEqual(6);

      release();
      await Promise.all([fillA, fillB]);

      // INVARIANT: every source pends exactly once. 3 sources => 3 tokens. A
      // double-mint makes this 6 (each file minted twice). NO duplicate logical
      // file may appear on the row.
      const cell = harness.feishu.salesFilesTokens(recordId);
      const sourceCount = intake.attachmentSources!.length;
      expect(cell).toHaveLength(sourceCount);

      // And per logical file: minted exactly once (a second mint = a second Drive
      // object for the same bytes, the duplicate the owner forbids).
      for (const src of intake.attachmentSources!) {
        expect(harness.feishu.mintedTokensFor(src.fileName)).toHaveLength(1);
      }
    },
  );

  // CHARACTERIZATION (passing): quantify the worst case the missing lock produces.
  // Under a gated overlap BOTH fills read the same remainingSources and mint EVERY
  // source — the non-idempotent upload_all runs twice per file, a DETERMINISTIC 2x
  // over-mint. Where the surplus LANDS is interleave-dependent and therefore NOT
  // asserted here: it is either duplicate tokens in the `Sales Files` cell, OR —
  // when the two racing recordAttachmentProgress mutations lost-update each other —
  // orphaned Drive objects whose tokens never reach the row. EITHER outcome breaks
  // owner invariant (#1c): more Drive objects exist than sources (duplicate-on-row
  // or wasted/orphaned blob). We assert only the deterministic root cause (2x mint)
  // + that there IS a surplus, not the nondeterministic landing spot. When the
  // lease/dedup fix lands, mintedCount drops to sourceCount: THIS test flips red and
  // the it.fails above flips green — a paired tripwire.
  it("characterizes the worst-case double-mint: two overlapping fills mint EVERY source twice", async () => {
    const intake = harness.makeIntake({ attachmentCount: 3 });
    harness.feishu.setUploadConcurrencyCap(100);
    const recordId = await createRowOnly(harness, intake);
    const lookup = harness.lookupFor(intake);
    const sourceCount = intake.attachmentSources!.length;

    const { release } = harness.feishu.gateUploads();
    const fillA = startOverlappingFill(harness, lookup);
    const fillB = startOverlappingFill(harness, lookup);

    // Drain microtasks until BOTH fills have parked ALL their uploads at the gate
    // (so both provably read the same remainingSources before either persists).
    // This makes the 2x over-mint deterministic, independent of scheduler timing —
    // the previous fixed-iteration drain could release before fillB had dispatched,
    // yielding a flaky 1x outcome.
    for (let i = 0; i < 200 && harness.feishu.uploadConcurrencyPeak < 2 * sourceCount; i++) {
      // eslint-disable-next-line no-await-in-loop -- deterministic microtask drain
      await Promise.resolve();
    }
    expect(harness.feishu.uploadConcurrencyPeak).toBeGreaterThanOrEqual(2 * sourceCount);

    release();
    const [resA, resB] = await Promise.all([fillA, fillB]);

    // DETERMINISTIC: every source was minted by BOTH fills — 2x the Drive objects.
    expect(harness.feishu.mintedCount()).toBe(2 * sourceCount);
    expect(resA.filled).toBe(sourceCount);
    expect(resB.filled).toBe(sourceCount);
    // Each logical file minted twice (two distinct file_tokens, two Drive objects).
    for (const src of intake.attachmentSources!) {
      expect(harness.feishu.mintedTokensFor(src.fileName)).toHaveLength(2);
    }

    // INVARIANT VIOLATION (#1c): more Drive objects exist than sources. The surplus
    // is a duplicate cell entry OR an orphaned Drive blob (interleave-dependent), so
    // we assert the surplus itself — never under-counts (no source is lost).
    expect(harness.feishu.mintedCount()).toBeGreaterThan(sourceCount);
    const cell = harness.feishu.salesFilesTokens(recordId);
    const rec = harness.getByMessageId(intake.internetMessageId)!;
    const tokensOnRecord = (rec.bitableAttachmentFileTokens as string[] | undefined) ?? [];
    expect(Math.max(cell.length, tokensOnRecord.length)).toBeGreaterThanOrEqual(sourceCount);
    // The surplus is unaccounted-for: minted Drive objects exceed what landed.
    const landed = Math.max(cell.length, tokensOnRecord.length);
    expect(harness.feishu.mintedCount()).toBeGreaterThanOrEqual(landed);
    // remainingSources is drained (both fills removed every source).
    expect(rec.bitableAttachmentSources ?? []).toEqual([]);
  });

  // CHARACTERIZATION: every Sales-Files PUT from the racing fills still targets
  // the CORRECT, SELF-MINTED row and ONLY the `Sales Files` column. Invariant (b)
  // — "target the SAME row, never any column but Sales Files" — is NOT violated by
  // the race: the corruption is duplication on the right row, not a wrong-row or
  // wrong-column write. (Bounds the blast radius of weak point #1.)
  it("does NOT flip a foreign row or write a foreign column under the race (invariant (b) holds)", async () => {
    const intake = harness.makeIntake({ attachmentCount: 2 });
    harness.feishu.setUploadConcurrencyCap(100);
    const recordId = await createRowOnly(harness, intake);
    const lookup = harness.lookupFor(intake);

    const { release } = harness.feishu.gateUploads();
    const fillA = startOverlappingFill(harness, lookup);
    const fillB = startOverlappingFill(harness, lookup);
    for (let i = 0; i < 50; i++) {
      // eslint-disable-next-line no-await-in-loop -- deterministic microtask drain
      await Promise.resolve();
    }
    release();
    await Promise.all([fillA, fillB]);

    const salesPuts = harness.feishu.salesFilesPuts();
    expect(salesPuts.length).toBeGreaterThan(0);
    for (const put of salesPuts) {
      // (b) right row, only the Sales Files column — never Request Type / foreign id.
      expect(put.recordId).toBe(recordId);
      expect(put.fieldKeys).toEqual(["Sales Files"]);
    }
    // Exactly one row exists — the race never created a second.
    expect(harness.feishu.recordIds()).toEqual([recordId]);
  });

  // CHARACTERIZATION: SERIAL (non-overlapping) fills are safe — a second fill that
  // runs AFTER the first persisted reads an EMPTY remainingSources and mints
  // nothing. Proves the defect is purely the OVERLAP (missing lock), not the
  // re-drive itself, AND that the fill is idempotent once serialized. This is the
  // safe behavior the rearm-on-reopen + reconcile backstop rely on.
  it("a fill that runs AFTER another completed is a no-op (idempotent when serialized — refutes 'always double-mints')", async () => {
    const intake = harness.makeIntake({ attachmentCount: 3 });
    const recordId = await createRowOnly(harness, intake);
    const lookup = harness.lookupFor(intake);

    // First fill runs to completion (no gate).
    const res1 = await startOverlappingFill(harness, lookup);
    expect(res1.filled).toBe(3);
    expect(harness.feishu.salesFilesTokens(recordId)).toHaveLength(3);

    // Second fill, run strictly afterward, sees remainingSources === [] and the
    // markAttachmentsFilled short-circuit — mints nothing, PUTs nothing new.
    const mintsBefore = harness.feishu.mintedCount();
    const putsBefore = harness.feishu.salesFilesPuts().length;
    const res2 = await startOverlappingFill(harness, lookup);

    expect(res2).toEqual({ filled: 0, skipped: 0, deferred: 0 });
    expect(harness.feishu.mintedCount()).toBe(mintsBefore);
    expect(harness.feishu.salesFilesPuts().length).toBe(putsBefore);
    // Cell still holds exactly the 3 originals — no duplication when serialized.
    expect(harness.feishu.salesFilesTokens(recordId)).toHaveLength(3);
    const rec = harness.getByMessageId(intake.internetMessageId)!;
    expect(rec.bitableAttachmentStatus).toBe("filled");
  });

  // CHARACTERIZATION: a fill never wrongly flips a STILL-PROGRESSING row to a
  // wrong/lost state. After the overlapping race settles, the row's status is a
  // terminal-ish fill state ('filled' or 'failed'/'filling'), NOT stuck mid-flight
  // with a phantom 'pending' that lost its sources. Quantify: no token is LOST
  // (the cell has AT LEAST sourceCount tokens — the failure mode here is
  // over-counting, never under-counting / losing a token).
  it("never LOSES a token under the race — worst case is over-count, never under-count", async () => {
    const intake = harness.makeIntake({ attachmentCount: 3 });
    harness.feishu.setUploadConcurrencyCap(100);
    const recordId = await createRowOnly(harness, intake);
    const lookup = harness.lookupFor(intake);

    const { release } = harness.feishu.gateUploads();
    const fillA = startOverlappingFill(harness, lookup);
    const fillB = startOverlappingFill(harness, lookup);
    for (let i = 0; i < 50; i++) {
      // eslint-disable-next-line no-await-in-loop -- deterministic microtask drain
      await Promise.resolve();
    }
    release();
    await Promise.all([fillA, fillB]);

    const sourceCount = intake.attachmentSources!.length;
    const cell = harness.feishu.salesFilesTokens(recordId);
    // No token lost: at least one token per source survives on the row.
    expect(cell.length).toBeGreaterThanOrEqual(sourceCount);
    // Every original fileName is represented (no source silently dropped).
    for (const src of intake.attachmentSources!) {
      expect(harness.feishu.mintedTokensFor(src.fileName).length).toBeGreaterThanOrEqual(1);
    }
    // remainingSources is fully drained (no source is stranded mid-flight).
    const rec = harness.getByMessageId(intake.internetMessageId)!;
    expect(rec.bitableAttachmentSources ?? []).toEqual([]);
    // Status is not stuck at a non-terminal 'pending' that lost its work.
    expect(["filled", "filling", "failed"]).toContain(rec.bitableAttachmentStatus);
  });
});
