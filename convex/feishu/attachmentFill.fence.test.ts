/* eslint-disable max-lines, max-lines-per-function */
// ADVERSARIAL integration suite — Family: Provenance + freshness fence.
//
// The owner's #1 invariant, attacked from the fence angle: the deferred
// Attachment Fill must NEVER write the `Sales Files` cell of a row it cannot
// prove it minted (provenance) or that is no longer fresh (freshness). The
// runtime guard `mayUpdateOwnedBitableRow` lives in `patchRowAttachments`
// (convex/feishu/bitable.ts) and THROWS "Refusing Sales Files PUT..." rather
// than ever PUTting a wrong / foreign / ancient row, or any column but the one.
//
// Everything below reaches the REAL handlers through the harness dispatcher
// (createHarness): syncRequest -> processPendingBitableSync ->
// markBitableSyncSucceeded -> fillRowAttachments -> patchRowAttachments. The
// only mocked modules are the I/O boundary (./call + ../storage), delegated into
// THIS test's harness via a vi.hoisted holder — the same seam drive.test.ts and
// the smoke test use. We DO NOT mock ./drive, ./bitable, ../emails,
// ./requestSync, ./attachmentFill, ./serviceRow, or ./bitableSyncRetry.
//
// To exercise the fence on a state the happy path never produces (e.g. an absent
// provenance token), we split the run: drive ONLY the create job, then tamper the
// stored Email Record through the FakeDb escape hatch, then let the REAL fill
// (already kicked + queued by markBitableSyncSucceeded) run against it. The
// tamper is the only fixture; the refusal, the persisted failure, and the
// not-written cell are all real SUT behavior observed through the sim.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callFeishu: async (..._args: unknown[]): Promise<unknown> => {
    throw new Error("harness not wired: callFeishu");
  },
  resolveFeishuToken: async (..._args: unknown[]): Promise<string> => "tenant-token",
  getStorageBytes: async (..._args: unknown[]): Promise<ArrayBuffer> => {
    throw new Error("harness not wired: getStorageBytes");
  },
}));

// Preserve the REAL ./call exports (notably withFeishuRateLimitRetry, used by
// bitable.createServiceRecord on the create path, plus the FEISHU_* error codes)
// and override ONLY the two network functions — otherwise the missing
// withFeishuRateLimitRetry export makes the create path throw before any row is
// minted (Vitest: "No export defined on the ./call mock").
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

import { createHarness, restoreEnv, type Harness } from "./attachmentFillSim";
import { mayUpdateOwnedBitableRow, DEFAULT_BITABLE_UPDATE_WINDOW_MS } from "./attachmentFill";
import type { ScheduledJob } from "./attachmentFillSim";

/** The exact prefix patchRowAttachments throws when the fence refuses a PUT. */
const REFUSAL = "Refusing Sales Files PUT";

const APP_TOKEN = "appTok";
const TABLE_ID = "tbl_service";
const NOW = 1_716_500_000_000;

const origApp = process.env.FEISHU_BITABLE_APP_TOKEN;
const origTable = process.env.FEISHU_BITABLE_TABLE_ID;
const origWindow = process.env.BITABLE_OWNED_ROW_UPDATE_WINDOW_MS;

let harness: Harness;

beforeEach(() => {
  process.env.FEISHU_BITABLE_APP_TOKEN = APP_TOKEN;
  process.env.FEISHU_BITABLE_TABLE_ID = TABLE_ID;
  delete process.env.BITABLE_OWNED_ROW_UPDATE_WINDOW_MS;
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  harness = createHarness();
  harness.wireMocks(mocks as never);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  restoreEnv("FEISHU_BITABLE_APP_TOKEN", origApp);
  restoreEnv("FEISHU_BITABLE_TABLE_ID", origTable);
  restoreEnv("BITABLE_OWNED_ROW_UPDATE_WINDOW_MS", origWindow);
});

// ---------------------------------------------------------------------------
// Helpers — all reach REAL handlers through the harness's own dispatcher.
// ---------------------------------------------------------------------------

/**
 * Run exactly ONE due scheduled job (the earliest), through the harness's own
 * registry + ctx — identical to what runDue/driveToCompletion do internally,
 * just one job. This lets a test stop AFTER the create job (which kicks the
 * fill) and tamper the stored row BEFORE the queued fill runs. It re-implements
 * no pipeline logic: it resolves the real ._handler and invokes it.
 */
async function runOneDueJob(h: Harness): Promise<ScheduledJob> {
  const job = h.scheduler.popDue();
  if (!job) throw new Error("runOneDueJob: no job is due");
  const handler = h.registry.resolve(job.ref);
  await handler(h.ctx, job.args ?? {});
  return job;
}

/**
 * Submit an intake and run the create worker (processPendingBitableSync) but NOT
 * the attachment fill it kicks. Returns the created recordId and the fill lookup.
 * After this, the REAL fillRowAttachments job is queued (dueAt = now) and will
 * run on the next driveToCompletion — against whatever state the test leaves.
 */
async function createButHoldFill(
  h: Harness,
  intake: ReturnType<Harness["makeIntake"]>,
): Promise<{ recordId: string; lookup: ReturnType<Harness["lookupFor"]> }> {
  await h.submit(intake);
  // Exactly one job is due now: the create worker. Running it creates the row,
  // marks the sync succeeded (stamping bitableRowMintedAt), and enqueues the
  // fill at runAfter(0) — which we deliberately do NOT drain yet.
  const createJob = await runOneDueJob(h);
  if (!createJob.refName.includes("processPendingBitableSync")) {
    throw new Error(`expected create worker first, ran ${createJob.refName}`);
  }
  const recordIds = h.feishu.recordIds();
  if (recordIds.length !== 1) {
    throw new Error(`expected exactly one created row, got ${recordIds.length}`);
  }
  return { recordId: recordIds[0], lookup: h.lookupFor(intake) };
}

/**
 * Did the fence refuse the PUT? `fillRowAttachments` CATCHES the
 * patchRowAttachments throw into `lastError` and records it via
 * markAttachmentsFailed (status `failed`, `bitableLastError` = the refusal
 * message) — so the refusal never propagates as a detached-job error; it is
 * observable on the persisted Email Record. This reads that real signal.
 */
function fenceRefusedFor(h: Harness, internetMessageId: string): boolean {
  const rec = h.getByMessageId(internetMessageId);
  if (!rec) return false;
  const err = String(rec.bitableLastError ?? "");
  return rec.bitableAttachmentStatus === "failed" && err.includes(REFUSAL);
}

// ===========================================================================
// 1. Provenance: REFUSE + never PUT when bitableClientToken is missing.
// ===========================================================================

describe("fence — provenance: missing bitableClientToken", () => {
  it("refuses the Sales Files PUT (no token = no provenance) and never reaches the sim", async () => {
    const intake = harness.makeIntake({ attachmentCount: 2 });
    const { recordId, lookup } = await createButHoldFill(harness, intake);

    // Tamper: strip the provenance token from the committed row, exactly the
    // gap the fence exists to catch. Everything else stays valid (recordId,
    // mintedAt, fresh, remaining sources present).
    const rec = harness.getByMessageId(intake.internetMessageId)!;
    await harness.db.patch(rec._id as string, { bitableClientToken: undefined });
    expect(harness.getByMessageId(intake.internetMessageId)!.bitableClientToken).toBeUndefined();

    // Now let the REAL queued fill run. It mints + persists, then calls the REAL
    // patchRowAttachments, whose fence reads the tampered state and THROWS. The
    // fill catches that throw and records it as a failure (the refusal message
    // lands on bitableLastError; status -> failed).
    await harness.driveToCompletion();

    // The refusal really happened (observable on the persisted record).
    expect(fenceRefusedFor(harness, intake.internetMessageId)).toBe(true);
    expect(String(harness.getByMessageId(intake.internetMessageId)!.bitableLastError)).toContain(
      REFUSAL,
    );

    // (b) The cell was NEVER written: no Sales Files PUT reached the sim at all.
    expect(harness.feishu.salesFilesPuts()).toEqual([]);
    expect(harness.feishu.salesFilesTokens(recordId)).toEqual([]);

    // ...and the row is OBSERVABLY failed, not silently dropped.
    const after = harness.getByMessageId(lookup.internetMessageId)!;
    expect(after.bitableAttachmentStatus).toBe("failed");
  });
});

// ===========================================================================
// 2. Unknown age: REFUSE when bitableRowMintedAt is undefined.
// ===========================================================================

describe("fence — freshness: undefined bitableRowMintedAt", () => {
  it("refuses the PUT (unknown age) and fails the row instead of writing the cell", async () => {
    const intake = harness.makeIntake({ attachmentCount: 1 });
    const { recordId, lookup } = await createButHoldFill(harness, intake);

    // Tamper: remove the mint timestamp — the freshness clock is now unknown.
    const rec = harness.getByMessageId(intake.internetMessageId)!;
    await harness.db.patch(rec._id as string, { bitableRowMintedAt: undefined });
    expect(harness.getByMessageId(intake.internetMessageId)!.bitableRowMintedAt).toBeUndefined();

    await harness.driveToCompletion();

    expect(fenceRefusedFor(harness, intake.internetMessageId)).toBe(true);
    expect(harness.feishu.salesFilesPuts()).toEqual([]);
    expect(harness.feishu.salesFilesTokens(recordId)).toEqual([]);
    const after = harness.getByMessageId(lookup.internetMessageId)!;
    expect(after.bitableAttachmentStatus).toBe("failed");
  });
});

// ===========================================================================
// 3. Ancient row: REFUSE when now - mintedAt > window.
// ===========================================================================

describe("fence — freshness: ancient row (now - mintedAt > window)", () => {
  it("refuses the PUT, does NOT write the cell, and observably fails the row", async () => {
    // Shrink the freshness window to 1 minute so we can age the row past it
    // deterministically with fake time.
    const WINDOW_MS = 60_000;
    process.env.BITABLE_OWNED_ROW_UPDATE_WINDOW_MS = String(WINDOW_MS);

    const intake = harness.makeIntake({ attachmentCount: 2 });
    const { recordId, lookup } = await createButHoldFill(harness, intake);

    // The row was minted at NOW. Advance the wall clock well past the window so
    // the queued fill's PUT lands when now - mintedAt > window. The SUT reads
    // Date.now() inside the fence, which fake timers now drive past NOW + WINDOW.
    const mintedAt = harness.getByMessageId(intake.internetMessageId)!.bitableRowMintedAt as number;
    expect(mintedAt).toBe(NOW);
    vi.setSystemTime(NOW + WINDOW_MS + 5_000); // 5s past the 1-min window

    await harness.driveToCompletion();

    expect(fenceRefusedFor(harness, intake.internetMessageId)).toBe(true);

    // Cell NOT written; row observably failed (not silently dropped).
    expect(harness.feishu.salesFilesPuts()).toEqual([]);
    expect(harness.feishu.salesFilesTokens(recordId)).toEqual([]);
    const after = harness.getByMessageId(lookup.internetMessageId)!;
    expect(after.bitableAttachmentStatus).toBe("failed");
  });
});

// ===========================================================================
// 4. Boundary: exactly-at-window is INCLUSIVE → allowed.
// ===========================================================================

describe("fence — freshness boundary: exactly at the window is allowed (inclusive)", () => {
  it("PUTs the Sales Files cell when now - mintedAt === window exactly", async () => {
    const WINDOW_MS = 60_000;
    process.env.BITABLE_OWNED_ROW_UPDATE_WINDOW_MS = String(WINDOW_MS);

    const intake = harness.makeIntake({ attachmentCount: 2 });
    const { recordId } = await createButHoldFill(harness, intake);

    const mintedAt = harness.getByMessageId(intake.internetMessageId)!.bitableRowMintedAt as number;
    expect(mintedAt).toBe(NOW);
    // Exactly at the boundary: now - mintedAt === window (the `<=` must allow it).
    vi.setSystemTime(NOW + WINDOW_MS);

    await harness.driveToCompletion();

    // No refusal at the boundary (the `<=` admits exactly-at-window).
    expect(fenceRefusedFor(harness, intake.internetMessageId)).toBe(false);

    // The cell WAS written with both tokens onto the same minted row.
    expect(harness.feishu.salesFilesTokens(recordId)).toHaveLength(2);
    const after = harness.getByMessageId(intake.internetMessageId)!;
    expect(after.bitableAttachmentStatus).toBe("filled");
  });
});

// ===========================================================================
// 5. Column scope under fill: the only key the fill ever writes is 'Sales Files'.
// ===========================================================================

describe("fence — column scope: fill PUTs only the 'Sales Files' column", () => {
  it("writes 'Sales Files' and never any other field key across the whole fill", async () => {
    // Two waves so we exercise more than one coalesced PUT: concurrency 1 forces
    // a PUT per source (each wave persists then PUTs).
    const origConc = process.env.FEISHU_DRIVE_UPLOAD_CONCURRENCY;
    process.env.FEISHU_DRIVE_UPLOAD_CONCURRENCY = "1";
    try {
      const intake = harness.makeIntake({ attachmentCount: 3 });
      await harness.sendAndSettle(intake);

      const recordId = harness.feishu.recordIds()[0];
      // The fill ran and filled the cell.
      expect(harness.getByMessageId(intake.internetMessageId)!.bitableAttachmentStatus).toBe("filled");

      // There WAS at least one fill PUT (more than one, since concurrency 1).
      const fillPuts = harness.feishu.salesFilesPuts();
      expect(fillPuts.length).toBeGreaterThan(1);

      // ACROSS EVERY fill PUT: the ONLY field key written is 'Sales Files'.
      for (const put of fillPuts) {
        expect(put.recordId).toBe(recordId); // same minted row, never foreign
        expect(put.fieldKeys).toEqual(["Sales Files"]);
      }
      // And no fill PUT ever touched the Feishu-owned 'Request Type' column.
      for (const put of harness.feishu.putsForRecord(recordId)) {
        expect(put.fieldKeys).not.toContain("Request Type");
      }
    } finally {
      if (origConc === undefined) delete process.env.FEISHU_DRIVE_UPLOAD_CONCURRENCY;
      else process.env.FEISHU_DRIVE_UPLOAD_CONCURRENCY = origConc;
    }
  });
});

// ===========================================================================
// 6. Truth table for mayUpdateOwnedBitableRow at the integration level.
//    Fresh + owned => allowed (PUT lands); each missing precondition => refused
//    (no PUT, row failed). Driven end-to-end through the real fill + fence.
// ===========================================================================

describe("fence — mayUpdateOwnedBitableRow truth table (integration)", () => {
  /** Mutate the stored row, run the held fill, return the observable fence result. */
  async function fenceOutcome(
    tamper: (id: string) => Promise<void> | void,
  ): Promise<{ refused: boolean; salesFilesPuts: number; status: unknown; recordId: string }> {
    const intake = harness.makeIntake({ attachmentCount: 1 });
    const { recordId } = await createButHoldFill(harness, intake);
    const rec = harness.getByMessageId(intake.internetMessageId)!;
    await tamper(rec._id as string);
    await harness.driveToCompletion();
    return {
      refused: fenceRefusedFor(harness, intake.internetMessageId),
      salesFilesPuts: harness.feishu
        .putsForRecord(recordId)
        .filter((p) => p.fieldKeys.includes("Sales Files")).length,
      status: harness.getByMessageId(intake.internetMessageId)!.bitableAttachmentStatus,
      recordId,
    };
  }

  it("fresh + owned (no tamper) => ALLOWED: cell PUT, row filled", async () => {
    const out = await fenceOutcome(() => {});
    expect(out.refused).toBe(false);
    expect(out.salesFilesPuts).toBeGreaterThan(0);
    expect(out.status).toBe("filled");
  });

  it("missing bitableClientToken => REFUSED: no PUT, row failed", async () => {
    const out = await fenceOutcome((id) => harness.db.patch(id, { bitableClientToken: undefined }));
    expect(out.refused).toBe(true);
    expect(out.salesFilesPuts).toBe(0);
    expect(out.status).toBe("failed");
  });

  it("missing bitableRecordId => no PUT (patchRowAttachments short-circuits, not the fence)", async () => {
    // With no recordId getAttachmentFillState reports bitableRecordId=null, so
    // patchRowAttachments returns {patched:false} WITHOUT throwing — but the fill
    // itself also short-circuits to noop on a missing recordId. Either way the
    // cell is never written. This pins the safe column-write behavior.
    const out = await fenceOutcome((id) => harness.db.patch(id, { bitableRecordId: undefined }));
    expect(out.salesFilesPuts).toBe(0);
    expect(out.refused).toBe(false); // short-circuit, not a fence throw
  });

  it("missing bitableRowMintedAt => REFUSED: no PUT, row failed", async () => {
    const out = await fenceOutcome((id) => harness.db.patch(id, { bitableRowMintedAt: undefined }));
    expect(out.refused).toBe(true);
    expect(out.salesFilesPuts).toBe(0);
    expect(out.status).toBe("failed");
  });
});

// ===========================================================================
// 7. Unit-level pin of the fence predicate itself (the integration anchor's
//    pure core) — proves the boundary math the integration tests rely on.
// ===========================================================================

describe("fence — mayUpdateOwnedBitableRow pure predicate", () => {
  const owned = {
    bitableRecordId: "rec_x",
    bitableClientToken: "tok_x",
    bitableRowMintedAt: NOW,
  };

  it("fresh + owned within the default window is allowed", () => {
    expect(mayUpdateOwnedBitableRow(owned, NOW, DEFAULT_BITABLE_UPDATE_WINDOW_MS)).toBe(true);
  });

  it("exactly at the window is allowed (inclusive <=)", () => {
    expect(
      mayUpdateOwnedBitableRow(owned, NOW + DEFAULT_BITABLE_UPDATE_WINDOW_MS, DEFAULT_BITABLE_UPDATE_WINDOW_MS),
    ).toBe(true);
  });

  it("one ms past the window is refused", () => {
    expect(
      mayUpdateOwnedBitableRow(owned, NOW + DEFAULT_BITABLE_UPDATE_WINDOW_MS + 1, DEFAULT_BITABLE_UPDATE_WINDOW_MS),
    ).toBe(false);
  });

  it("no recordId, no token, or undefined mintedAt are each refused", () => {
    expect(mayUpdateOwnedBitableRow({ ...owned, bitableRecordId: undefined }, NOW)).toBe(false);
    expect(mayUpdateOwnedBitableRow({ ...owned, bitableClientToken: undefined }, NOW)).toBe(false);
    expect(mayUpdateOwnedBitableRow({ ...owned, bitableRowMintedAt: undefined }, NOW)).toBe(false);
  });
});

// ===========================================================================
// 8. SUSPECTED REAL DEFECT (characterize): the attachment retry span (~140 min
//    cumulative) outruns the default freshness window (120 min), so a late retry
//    PUT is REFUSED by the fence — the fill can NEVER complete that row, and it
//    lands terminal-failed with the cell still empty. This violates invariant
//    (c): a source that minted a token (persisted on the row state) but whose PUT
//    is fenced out is partial-and-silent at the Base. Encoded as it.fails so CI
//    stays green and auto-flips when fixed.
// ===========================================================================

describe("fence vs retry span (suspected defect)", () => {
  // The cumulative deferred-fill retry schedule, from bitableSyncRetry.ts. Each
  // failure (post-increment attemptCount) sets the next retry at attemptedAt +
  // {5,15,60,60} min; the 5th failure hits MAX_BITABLE_SYNC_ATTEMPTS and goes
  // terminal. Since each failed attempt resolves ~instantly, the Nth attempt's
  // PUT lands at ≈ mint + the cumulative offset below. The 5th attempt lands at
  // +140 min — strictly past the 120-min default freshness window.
  const ATTEMPT_OFFSETS_MS = [0, 5, 20, 80, 140].map((m) => m * 60_000);

  /**
   * Advance the fake clock to an absolute wall-time and drive whatever is now
   * due. The harness clock IS Date.now(), so this moves both the scheduler's
   * dueAt math AND the SUT's freshness fence (Date.now() inside
   * patchRowAttachments) together.
   */
  async function advanceToAndDrive(absoluteNow: number): Promise<void> {
    vi.setSystemTime(absoluteNow);
    await harness.driveToCompletion();
  }

  // BUG (UPHELD, integration-proven below): attachment retries cumulate to
  // ~140min (+5/+15/+60/+60) but the default freshness window is 120min, so the
  // worst-case retry — the one that finally mints successfully on the 5th
  // attempt — lands at mint+140 and is REFUSED by mayUpdateOwnedBitableRow inside
  // patchRowAttachments (bitable.ts L229-241). The row can NEVER be filled even
  // though its token was minted + persisted on the Email Record: it lands
  // terminal `failed` with bitableAttachmentFileTokens populated but the Base
  // `Sales Files` cell still EMPTY. This is invariant (c) violated: a source that
  // produced a token is partial-and-silent at the Base. Fix sketch: derive the
  // freshness window from the max retry span (window >= cumulative retry budget),
  // or exempt a self-minted row whose tokens are already persisted
  // (bitableAttachmentFileTokens non-empty AND bitableClientToken matches) from
  // the freshness clamp — provenance alone suffices for the row's own deferred
  // completion.
  it.fails(
    "INTEGRATION: a fill whose mint finally succeeds on the late (mint+140min) retry STILL fills the cell",
    async () => {
      // Single source whose upload defers on the first 4 attempts, then succeeds
      // on the 5th. The 5th attempt lands at mint+140min (past the 120-min
      // default window), so the real fence refuses its PUT.
      const intake = harness.makeIntake({ attachmentCount: 1 });
      const fileName = intake.attachmentSources![0].fileName;
      harness.feishu.deferUploadFor(fileName, { times: 4 });

      // Submit + run the create worker + the first fill attempt (which defers).
      await harness.sendAndSettle(intake);
      const recordId = harness.feishu.recordIds()[0];
      const mintedAt = harness.getByMessageId(intake.internetMessageId)!.bitableRowMintedAt as number;
      expect(mintedAt).toBe(NOW);

      // Walk the real per-task retry chain forward in wall-clock time. At each
      // step the scheduled fillRowAttachments retry becomes due and runs; the
      // first four defer (and reschedule), the fifth mints + tries to PUT.
      for (const offset of ATTEMPT_OFFSETS_MS.slice(1)) {
        // eslint-disable-next-line no-await-in-loop -- retries are inherently sequential in wall-clock time
        await advanceToAndDrive(NOW + offset);
      }

      // A correct policy fills the cell on the late-but-self-minted retry. The
      // current fence refuses it, so this assertion FAILS (it.fails) — and flips
      // green the moment the window/provenance fix lands.
      expect(harness.feishu.salesFilesTokens(recordId)).toHaveLength(1);
      expect(harness.getByMessageId(intake.internetMessageId)!.bitableAttachmentStatus).toBe("filled");
    },
  );

  it("INTEGRATION characterization: the late retry mints+persists a token but the cell stays EMPTY and the row is terminal-failed", async () => {
    // PASSES — documents the actual (defective) outcome so the bug is visible
    // without a red bar, and pins every facet of the invariant-(c) violation.
    const intake = harness.makeIntake({ attachmentCount: 1 });
    const fileName = intake.attachmentSources![0].fileName;
    harness.feishu.deferUploadFor(fileName, { times: 4 });

    await harness.sendAndSettle(intake);
    const recordId = harness.feishu.recordIds()[0];

    for (const offset of ATTEMPT_OFFSETS_MS.slice(1)) {
      // eslint-disable-next-line no-await-in-loop -- sequential wall-clock retries
      await advanceToAndDrive(NOW + offset);
    }

    const rec = harness.getByMessageId(intake.internetMessageId)!;

    // The 5th attempt DID mint the token (the deferUploadFor budget was 4) and it
    // WAS persisted on the Email Record — the work succeeded upstream of the PUT.
    expect(harness.feishu.mintedTokensFor(fileName)).toHaveLength(1);
    expect((rec.bitableAttachmentFileTokens as string[]) ?? []).toHaveLength(1);
    // ...yet the fence refused the PUT, so the Base cell is EMPTY and no Sales
    // Files PUT ever reached the sim.
    expect(harness.feishu.salesFilesTokens(recordId)).toEqual([]);
    expect(harness.feishu.salesFilesPuts()).toEqual([]);
    // ...the refusal is the recorded last error, and the row is TERMINAL (the
    // attempt cap was hit, so attachmentNextRetryAt is the undefined sentinel —
    // no further retry will ever re-attempt this row).
    expect(fenceRefusedFor(harness, intake.internetMessageId)).toBe(true);
    expect(rec.bitableAttachmentStatus).toBe("failed");
    expect(rec.attachmentNextRetryAt).toBeUndefined();
    // The remaining sources were drained (the source was completed upstream), so
    // even a hypothetical future retry would see remainingSources=[] and flip the
    // row to `filled` over an EMPTY cell — the partial-and-silent end state.
    expect((rec.bitableAttachmentSources as unknown[]) ?? []).toEqual([]);
  });

  it("pure-predicate anchor: the worst-case (mint+140min) retry is refused because window (120m) < retry span (140m)", () => {
    // The pure core the integration proof rests on: the default window is
    // strictly less than the cumulative retry span, so the worst-case late retry
    // of a fully-owned, self-minted row is refused by the fence predicate.
    const mintedAt = NOW;
    const lateRetryAt = NOW + 140 * 60_000;
    expect(DEFAULT_BITABLE_UPDATE_WINDOW_MS).toBeLessThan(140 * 60_000);
    expect(
      mayUpdateOwnedBitableRow(
        { bitableRecordId: "r", bitableClientToken: "t", bitableRowMintedAt: mintedAt },
        lateRetryAt,
        DEFAULT_BITABLE_UPDATE_WINDOW_MS,
      ),
    ).toBe(false);
  });
});
