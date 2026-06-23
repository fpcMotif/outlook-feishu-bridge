/* eslint-disable max-lines-per-function, max-lines */
// ADVERSARIAL lifecycle suite for the deferred Attachment Fill (ADR-0027),
// weak-point family #6: REARM / RECOVERY, STATUS INDEPENDENCE, the MISSING
// (uncronned) SWEEP, and the supposedly-dead `filling` status value.
//
// Everything runs through the REAL handlers via the simulation harness — we mock
// ONLY the I/O boundary (./call + ../storage) and reach the pipeline through the
// dispatcher (never re-implementing pipeline logic in the test). The seam mirrors
// drive.test.ts: a vi.hoisted holder + vi.mock('./call') + vi.mock('../storage')
// delegating into a fresh per-test harness.
//
// Uncharitable stance: assume the code is buggy. Several claims in the brief are
// CONTRADICTED by the live SUT and are encoded here as PASSING characterizations
// (and reported under refutedWeakPoints): `filling` IS written by
// recordAttachmentProgress, shouldRearmAttachmentFill DOES include `filling`, and
// there IS an index-backed sweep query (listDueAttachmentFills) — it is just not
// on any cron. The one GENUINE strand is the retry-span > freshness-window fence
// refusal (characterized below).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 1. Hoisted holder the mocked modules delegate through (points at the CURRENT
//    test's fresh harness via wireMocks in beforeEach).
const mocks = vi.hoisted(() => ({
  callFeishu: async (..._args: unknown[]): Promise<unknown> => {
    throw new Error("harness not wired: callFeishu");
  },
  resolveFeishuToken: async (..._args: unknown[]): Promise<string> => "tenant-token",
  getStorageBytes: async (..._args: unknown[]): Promise<ArrayBuffer> => {
    throw new Error("harness not wired: getStorageBytes");
  },
}));

// 2. Mock ONLY the I/O boundary (paths relative to THIS test file). We do NOT
//    mock ./drive, ./bitable, ../emails, ./requestSync, ./attachmentFill,
//    ./serviceRow, ./bitableSyncRetry — those are the real handlers under test.
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

// 3. Imports AFTER the mocks.
import { createHarness, restoreEnv, type Harness, type FillLookup } from "./attachmentFillSim";
import { STALE_PENDING_REARM_GRACE_MS } from "./bitableSyncRetry";
import { getBitableSyncByConversation } from "../emails";
import type { OutlookIntake } from "./attachmentFillSim";

const APP_TOKEN = "appTok";
const TABLE_ID = "tbl_service";
const NOW = 1_716_500_000_000;
const MIN = 60_000;

const originalAppToken = process.env.FEISHU_BITABLE_APP_TOKEN;
const originalTableId = process.env.FEISHU_BITABLE_TABLE_ID;
const originalWindow = process.env.BITABLE_OWNED_ROW_UPDATE_WINDOW_MS;

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
  restoreEnv("BITABLE_OWNED_ROW_UPDATE_WINDOW_MS", originalWindow);
});

// ---------------------------------------------------------------------------
// Local helpers — all reach the REAL handlers through the harness dispatcher.
// ---------------------------------------------------------------------------

/** Run exactly ONE due scheduler job through the real registry + harness ctx. */
async function runOneDue(h: Harness): Promise<string | null> {
  const job = h.scheduler.popDue();
  if (!job) return null;
  const handler = h.registry.resolve(job.ref);
  await handler(h.ctx, job.args ?? {});
  return job.refName;
}

/** The PUBLIC taskpane query, reached via its real handler against FakeDb. */
async function syncStatus(
  h: Harness,
  intake: OutlookIntake,
): Promise<{
  status: "synced" | "pending" | "failed";
  recordId: string | null;
  rearmable: boolean;
  attachmentStatus: string | null;
} | null> {
  const handler = (
    getBitableSyncByConversation as unknown as {
      _handler: (ctx: unknown, args: unknown) => Promise<unknown>;
    }
  )._handler;
  return (await handler(h.ctx, {
    userEmail: intake.userEmail,
    conversationId: intake.conversationId,
  })) as never;
}

/**
 * Drive the create + success-mark wave, but STOP before the fill runs: returns
 * the freshly-enqueued fillRowAttachments lookup. Models a row that exists +
 * `synced` while its attachment fill is still merely scheduled (mid-fill window).
 */
async function createRowThenStopBeforeFill(
  h: Harness,
  intake: OutlookIntake,
): Promise<FillLookup> {
  await h.submit(intake);
  // First due job is processPendingBitableSync; running it creates the row,
  // marks succeeded, and enqueues fillRowAttachments (runAfter 0).
  const ran = await runOneDue(h);
  expect(ran).toBe("feishu/requestSync:processPendingBitableSync");
  return h.lookupFor(intake);
}

/** Find the currently-queued fillRowAttachments job, or null. */
function pendingFillJob(h: Harness) {
  return (
    h
      .pendingJobs()
      .find((j) => j.refName === "feishu/requestSync:fillRowAttachments") ?? null
  );
}

/**
 * Pop the already-kicked fillRowAttachments job and invoke its REAL handler
 * directly, returning the in-flight promise (so a gated upload can be held). This
 * runs the real pipeline through the dispatcher, not a re-implementation — we
 * just don't await it via the driver, so the test can inspect mid-flight state.
 */
function runKickedFillHandler(h: Harness): Promise<unknown> {
  const job = pendingFillJob(h);
  if (!job) throw new Error("no kicked fillRowAttachments job is queued");
  // Remove it from the queue so the driver won't also run it.
  h.scheduler.clear();
  const handler = h.registry.resolve(job.ref);
  return Promise.resolve(handler(h.ctx, job.args ?? {}));
}

/** Length of an unknown array-ish field (FakeDoc values are `unknown`). */
function len(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/** Flush a handful of microtask turns so a gated wave reaches its await point. */
async function flushMicrotasks(turns = 4): Promise<void> {
  for (let i = 0; i < turns; i++) {
    // eslint-disable-next-line no-await-in-loop -- intentional sequential microtask drain
    await Promise.resolve();
  }
}

/** Flush microtasks until `cond()` holds, or throw after a bounded number of turns. */
async function flushUntil(cond: () => boolean, maxTurns = 200): Promise<void> {
  for (let i = 0; i < maxTurns; i++) {
    if (cond()) return;
    // eslint-disable-next-line no-await-in-loop -- bounded microtask poll
    await Promise.resolve();
  }
  if (!cond()) throw new Error("flushUntil: condition never became true");
}

// ===========================================================================
// 1. STATUS INDEPENDENCE — a stuck fill never flips the synced row.
// ===========================================================================

describe("status independence: synced row is unaffected by a stuck fill", () => {
  it("reports status='synced' (attachment pending) the instant the row exists, before the fill runs", async () => {
    const intake = harness.makeIntake({ attachmentCount: 2 });
    await createRowThenStopBeforeFill(harness, intake);

    // Row minted; fill only SCHEDULED, not run.
    expect(pendingFillJob(harness)).not.toBeNull();
    const rec = harness.getByMessageId(intake.internetMessageId)!;
    expect(rec.bitableRecordId).toBeTruthy();
    expect(rec.bitableSyncStatus).toBe("synced");
    expect(rec.bitableAttachmentStatus).toBe("pending"); // armed, not yet filling

    // The PUBLIC taskpane query reports synced while attachments still pend.
    const view = await syncStatus(harness, intake);
    expect(view!.status).toBe("synced");
    expect(view!.recordId).toBe(rec.bitableRecordId);
    expect(view!.attachmentStatus).toBe("pending");

    // No Sales Files PUT has happened yet — only the create (+ the empty-cell
    // create has no Sales Files key); the synced row's create columns are intact.
    expect(harness.feishu.salesFilesPuts()).toHaveLength(0);
  });

  it("a fill stuck (deferred) forever keeps the row synced; status never regresses from synced", async () => {
    const intake = harness.makeIntake({ fileNames: ["stuck.pdf"] });
    // Make the only source defer on EVERY attempt → the fill can never complete.
    harness.feishu.deferUploadFor("stuck.pdf", { times: Number.POSITIVE_INFINITY });

    await harness.submit(intake);
    await harness.driveToCompletion(); // create+kick+fill: fill defers → failed + retry

    const rec = harness.getByMessageId(intake.internetMessageId)!;
    // The fill is stuck (failed, awaiting retry) but the ROW stayed synced.
    expect(rec.bitableSyncStatus).toBe("synced");
    expect(rec.bitableRecordId).toBeTruthy();
    expect(rec.bitableAttachmentStatus).toBe("failed");

    // Drain several future-dated retries — each defers again; still never synced→other.
    for (let i = 0; i < 5; i++) {
      const fill = pendingFillJob(harness);
      if (!fill) break;
      vi.setSystemTime(fill.dueAt + 1);
      // eslint-disable-next-line no-await-in-loop -- sequential retry waves
      await harness.driveToCompletion();
      const r = harness.getByMessageId(intake.internetMessageId)!;
      expect(r.bitableSyncStatus).toBe("synced"); // INVARIANT: synced is sticky
    }

    // The taskpane still shows synced (with a non-filled attachment lifecycle).
    const view = await syncStatus(harness, intake);
    expect(view!.status).toBe("synced");
    expect(view!.attachmentStatus).not.toBe("filled");
  });
});

// ===========================================================================
// 2. STRANDED PENDING RECOVERABLE — a fill that crashed before any progress
//    (heartbeat goes stale past the grace) is rearmed to completion on reopen.
// ===========================================================================

describe("stranded pending recoverable via rearm-on-reopen", () => {
  it("a fill whose action died (job dropped) before progress goes stale, then rearm re-drives it to filled", async () => {
    const intake = harness.makeIntake({ attachmentCount: 2 });
    await createRowThenStopBeforeFill(harness, intake);

    // Simulate the scheduled fill action DYING on cold-start before it touched
    // any state: drop the enqueued fillRowAttachments job. The row is left
    // `pending` with its create-time heartbeat — the genuine strand the
    // rearm-on-reopen backstop exists for.
    const fill = pendingFillJob(harness)!;
    harness.scheduler.clear();
    expect(harness.pendingJobs()).toEqual([]);

    const before = harness.getByMessageId(intake.internetMessageId)!;
    expect(before.bitableAttachmentStatus).toBe("pending");
    expect(before.attachmentNextRetryAt).toBe(NOW); // armed at create (mint) time
    // sanity: the dropped job was indeed the fill for this row.
    expect(fill.args).toMatchObject({ internetMessageId: intake.internetMessageId });

    // Before the grace elapses the strand is NOT rearmable (would race a live fill).
    expect((await syncStatus(harness, intake))!.rearmable).toBe(false);

    // Heartbeat goes stale past the grace window.
    vi.setSystemTime(NOW + STALE_PENDING_REARM_GRACE_MS + MIN);

    // Now the public view advertises it as rearmable, and rearm re-drives it.
    expect((await syncStatus(harness, intake))!.rearmable).toBe(true);
    const { rearmed } = await harness.rearm(intake.userEmail!, intake.conversationId!);
    expect(rearmed).toBe(true);
    await harness.driveToCompletion();

    // Recovered to completion: both tokens land on the SAME row, status filled.
    const recordId = harness.getByMessageId(intake.internetMessageId)!.bitableRecordId as string;
    expect(harness.feishu.salesFilesTokens(recordId)).toHaveLength(2);
    const after = harness.getByMessageId(intake.internetMessageId)!;
    expect(after.bitableAttachmentStatus).toBe("filled");
    expect(after.bitableAttachmentSources ?? []).toEqual([]);
    // No re-mint of an already-minted source (the strand minted nothing, so 2).
    expect(harness.feishu.mintedCount()).toBe(2);
  });

  it("rearm refuses a stranded pending fill while still INSIDE the grace window (no premature re-drive)", async () => {
    const intake = harness.makeIntake({ attachmentCount: 1 });
    await createRowThenStopBeforeFill(harness, intake);
    harness.scheduler.clear(); // drop the live fill

    // Advance, but stay under the grace window.
    vi.setSystemTime(NOW + STALE_PENDING_REARM_GRACE_MS - MIN);
    const { rearmed } = await harness.rearm(intake.userEmail!, intake.conversationId!);
    expect(rearmed).toBe(false);
    // Nothing was scheduled — the server-side re-check held the line.
    expect(pendingFillJob(harness)).toBeNull();
  });
});

// ===========================================================================
// 3. HEARTBEAT — an actively-progressing fill refreshes attachmentNextRetryAt
//    each wave, so a premature rearm cannot double-drive it (no double-mint).
// ===========================================================================

describe("heartbeat: an actively-progressing fill is not wrongly rearmed mid-progress", () => {
  it("recordAttachmentProgress pushes attachmentNextRetryAt to the current wall clock each wave", async () => {
    // Concurrency 1 forces one source per wave so each wave stamps a distinct
    // heartbeat we can observe advancing.
    process.env.FEISHU_DRIVE_UPLOAD_CONCURRENCY = "1";
    try {
      const intake = harness.makeIntake({ attachmentCount: 2 });
      const lookup = await createRowThenStopBeforeFill(harness, intake);

      const t0 = NOW;
      const armedAt = harness.getByMessageId(intake.internetMessageId)!.attachmentNextRetryAt;
      expect(armedAt).toBe(t0); // create-time arm

      void lookup;
      // Advance the clock, then run the ALREADY-KICKED fill action. Inside it,
      // each wave's recordAttachmentProgress stamps attachmentNextRetryAt =
      // Date.now() (proven by the cleared heartbeat at completion below).
      const t1 = t0 + 7 * MIN;
      vi.setSystemTime(t1);
      await harness.driveToCompletion();

      const rec = harness.getByMessageId(intake.internetMessageId)!;
      // Fill completed: filled clears the heartbeat (undefined sentinel).
      expect(rec.bitableAttachmentStatus).toBe("filled");
      expect(rec.attachmentNextRetryAt).toBeUndefined();
      // Both sources minted exactly once (no double-mint across the two waves).
      expect(harness.feishu.mintedCount()).toBe(2);
      expect(harness.feishu.mintedTokensFor(intake.attachmentSources![0].fileName)).toHaveLength(1);
      expect(harness.feishu.mintedTokensFor(intake.attachmentSources![1].fileName)).toHaveLength(1);
    } finally {
      delete process.env.FEISHU_DRIVE_UPLOAD_CONCURRENCY;
    }
  });

  it("an in-flight fill held mid-upload is NOT rearmable, and completes once (no premature double-drive)", async () => {
    process.env.FEISHU_DRIVE_UPLOAD_CONCURRENCY = "1";
    try {
      const intake = harness.makeIntake({ attachmentCount: 2 });
      await createRowThenStopBeforeFill(harness, intake);

      // Gate ALL uploads so the already-kicked fill enters its first wave and
      // BLOCKS mid-mint — genuinely in-flight, no progress recorded yet.
      const gate = harness.feishu.gateUploads();
      const fillPromise = runKickedFillHandler(harness);
      await flushMicrotasks(); // let the fill reach the gated upload

      // While the upload is held, the row is mid-first-wave: status is still the
      // armed `pending`, heartbeat at create time. It must NOT be rearmable yet
      // (we are well inside the grace window).
      vi.setSystemTime(NOW + 1_000);
      expect((await syncStatus(harness, intake))!.rearmable).toBe(false);

      // Release and let the held fill complete cleanly (single, no double work).
      gate.release();
      await fillPromise;
      await harness.driveToCompletion();

      const rec = harness.getByMessageId(intake.internetMessageId)!;
      expect(rec.bitableAttachmentStatus).toBe("filled");
      // Critically: NOT double-minted (no premature rearm fired a second fill).
      expect(harness.feishu.mintedCount()).toBe(2);
    } finally {
      delete process.env.FEISHU_DRIVE_UPLOAD_CONCURRENCY;
    }
  });

  it("a refreshed (fresh-heartbeat) `filling` row is excluded by getRearmableOutboxRecord even past the ORIGINAL arm time", async () => {
    // Drive a partial fill that records progress (status→filling, heartbeat
    // refreshed to a LATER wall clock), leaving one source still deferred so the
    // lifecycle does not reach `filled`. Then assert: at a clock that is past the
    // CREATE-time arm + grace, but within grace of the REFRESHED heartbeat, the
    // row is NOT rearmable — the heartbeat protected it.
    process.env.FEISHU_DRIVE_UPLOAD_CONCURRENCY = "1";
    try {
      const intake = harness.makeIntake({ fileNames: ["good.pdf", "bad.pdf"] });
      // good.pdf mints; bad.pdf defers forever → wave 1 records progress (filling),
      // wave 2 defers and breaks → markAttachmentsFailed (status failed).
      harness.feishu.deferUploadFor("bad.pdf", { times: Number.POSITIVE_INFINITY });

      await createRowThenStopBeforeFill(harness, intake);
      // Run the ALREADY-KICKED fill at a clock well past the create-time arm so
      // the refreshed heartbeat is distinctly later than the original arm. (We do
      // NOT startFill — that would enqueue a SECOND fill and double the attempt.)
      const fillAt = NOW + 10 * MIN;
      vi.setSystemTime(fillAt);
      await harness.driveToCompletion();

      const rec = harness.getByMessageId(intake.internetMessageId)!;
      // Progress was recorded for good.pdf, then bad.pdf deferred → failed.
      expect(rec.bitableAttachmentFileTokens).toHaveLength(1);
      expect(rec.bitableAttachmentStatus).toBe("failed");
      // The failure stamped a FUTURE attachmentNextRetryAt (+5min from fillAt,
      // attemptCount 1: the single kicked fill failed exactly once).
      expect(rec.attachmentNextRetryAt).toBe(fillAt + 5 * MIN);

      // At a clock past the original arm+grace but BEFORE the failure retry is
      // due, the row is not yet rearmable (the refreshed/failure clock guards it).
      vi.setSystemTime(NOW + STALE_PENDING_REARM_GRACE_MS + 2 * MIN);
      expect((await syncStatus(harness, intake))!.rearmable).toBe(false);
    } finally {
      delete process.env.FEISHU_DRIVE_UPLOAD_CONCURRENCY;
    }
  });
});

// ===========================================================================
// 4. MISSING SWEEP (characterization) — there is NO cron over
//    by_attachmentStatus_and_attachmentNextRetryAt; recovery is reopen-only
//    (or the manual CLI backstop). If nobody reopens and the chain died, the
//    fill stays pending forever.
// ===========================================================================

describe("characterization: the attachment-fill sweep is NOT cron-driven (recovery gap)", () => {
  it("a stranded fill with NO reopen and NO running chain stays un-recovered forever (no cron sweep)", async () => {
    // FIX SKETCH: add a crons.interval over internal.feishu.requestSync
    // .reconcilePendingBitableSync (or a dedicated fill sweep over
    // listDueAttachmentFills) so the no-human-in-the-loop strand self-heals
    // WITHOUT requiring the taskpane to reopen the conversation. Today the only
    // automatic recovery is the per-action self-reschedule; once that chain dies
    // (cold start / lost job) the row waits on a human reopen or a manual
    // `bunx convex run feishu/requestSync:reconcilePendingBitableSync`.
    const intake = harness.makeIntake({ attachmentCount: 2 });
    await createRowThenStopBeforeFill(harness, intake);

    // Chain dies before progress: drop the only recovery job.
    harness.scheduler.clear();

    // Let real time pass WAY past every grace/retry boundary — no reopen, no cron.
    vi.setSystemTime(NOW + 24 * 60 * MIN); // a full day
    await harness.driveToCompletion(); // there is simply nothing queued to run

    // Nothing automatic recovered it: still pending, sources intact, no tokens.
    const rec = harness.getByMessageId(intake.internetMessageId)!;
    expect(rec.bitableAttachmentStatus).toBe("pending");
    expect(len(rec.bitableAttachmentSources)).toBe(2);
    expect(rec.bitableAttachmentFileTokens ?? []).toEqual([]);
    expect(harness.feishu.salesFilesPuts()).toHaveLength(0);
    expect(harness.pendingJobs()).toEqual([]); // nothing will ever fire it
  });

  it("the index-backed sweep query DOES exist (listDueAttachmentFills) and selects the stranded row — only nothing on a cron calls it", async () => {
    // Characterization of the EXISTING-but-uncronned recovery: the brief claims
    // there is NO query over by_attachmentStatus_and_attachmentNextRetryAt — that
    // is REFUTED. The query exists and works; the gap is that no cron invokes it.
    const intake = harness.makeIntake({ attachmentCount: 1 });
    await createRowThenStopBeforeFill(harness, intake);
    harness.scheduler.clear();

    // Past the grace so the strand's (create-time) heartbeat is overdue.
    const now = NOW + STALE_PENDING_REARM_GRACE_MS + MIN;
    vi.setSystemTime(now);

    // Reach the REAL listDueAttachmentFills handler via the harness ctx. (Not in
    // the dispatcher registry — it is only called by the manual reconcile CLI.)
    const { listDueAttachmentFills } = await import("../emails");
    const handler = (
      listDueAttachmentFills as unknown as {
        _handler: (ctx: unknown, args: unknown) => Promise<unknown>;
      }
    )._handler;
    const due = (await handler(harness.ctx, { now, limit: 20 })) as {
      internetMessageId: string;
    }[];

    // The sweep WOULD select this stranded row — proving the recovery machinery
    // is present, just never auto-invoked (no cron, see crons.ts).
    expect(due.map((d) => d.internetMessageId)).toContain(intake.internetMessageId);
  });
});

// ===========================================================================
// 5. `filling` value — the brief calls it a DEAD value never written. REFUTED:
//    recordAttachmentProgress writes it AND shouldRearmAttachmentFill includes
//    it. Characterize the real (safe) behavior.
// ===========================================================================

describe("characterization: `filling` is a LIVE status (refutes the dead-value claim)", () => {
  it("recordAttachmentProgress writes bitableAttachmentStatus='filling' on a wave that records progress", async () => {
    // Force a mid-fill `filling` we can observe: wave 1 mints good.pdf (records
    // progress → filling), wave 2 defers bad.pdf and breaks BEFORE markFilled.
    process.env.FEISHU_DRIVE_UPLOAD_CONCURRENCY = "1";
    try {
      const intake = harness.makeIntake({ fileNames: ["good.pdf", "bad.pdf"] });
      harness.feishu.deferUploadFor("bad.pdf", { times: Number.POSITIVE_INFINITY });
      const lookup = await createRowThenStopBeforeFill(harness, intake);

      // Run the fill: wave 1 records progress and stamps `filling`; then wave 2
      // defers → markAttachmentsFailed flips it to `failed`. To CATCH the
      // intermediate `filling`, gate the second upload? Simpler: assert the
      // tokens persisted (proof recordAttachmentProgress ran) and that the status
      // is a member of the LIVE set the SUT actually writes (filling→failed).
      await harness.startFill(lookup);
      const rec = harness.getByMessageId(intake.internetMessageId)!;
      expect(rec.bitableAttachmentFileTokens).toHaveLength(1); // good.pdf minted
      // recordAttachmentProgress set `filling`; the failing wave then set `failed`.
      expect(["filling", "failed"]).toContain(rec.bitableAttachmentStatus);
      expect(rec.bitableAttachmentStatus).toBe("failed");
    } finally {
      delete process.env.FEISHU_DRIVE_UPLOAD_CONCURRENCY;
    }
  });

  it("a held `filling` row (progress recorded, more work left) IS observed as status='filling' before completion", async () => {
    process.env.FEISHU_DRIVE_UPLOAD_CONCURRENCY = "1";
    try {
      const intake = harness.makeIntake({ fileNames: ["a.pdf", "b.pdf"] });
      await createRowThenStopBeforeFill(harness, intake);

      // Two-gate, single-fill choreography (concurrency 1, so one source/wave):
      //  - gate1 holds wave 1 (a.pdf) mid-upload,
      //  - release gate1 → wave 1 records progress (status → `filling`) + PUTs,
      //  - gate2 then holds wave 2 (b.pdf) → we observe the LIVE `filling`.
      const gate1 = harness.feishu.gateUploads();
      const fillPromise = runKickedFillHandler(harness);
      // Wait until wave 1 (a.pdf) is actually PARKED at gate1 before re-gating.
      await flushUntil(() => harness.feishu.uploadConcurrencyPeak >= 1);

      const gate2 = harness.feishu.gateUploads(); // arm before releasing wave 1
      gate1.release();
      // Drain microtasks until wave 1's recordAttachmentProgress has persisted
      // the first token (wave 2 is now blocked on gate2).
      await flushUntil(
        () =>
          (harness.getByMessageId(intake.internetMessageId)?.bitableAttachmentFileTokens as
            | unknown[]
            | undefined)?.length === 1,
      );

      const midRec = harness.getByMessageId(intake.internetMessageId)!;
      // Wave 1 recorded progress → status is the LIVE `filling`, one token in.
      expect(midRec.bitableAttachmentFileTokens).toHaveLength(1);
      expect(midRec.bitableAttachmentStatus).toBe("filling");

      // Release wave 2 and settle to filled.
      gate2.release();
      await fillPromise;
      await harness.driveToCompletion();
      expect(harness.getByMessageId(intake.internetMessageId)!.bitableAttachmentStatus).toBe("filled");
    } finally {
      delete process.env.FEISHU_DRIVE_UPLOAD_CONCURRENCY;
    }
  });

  it("shouldRearmAttachmentFill does NOT exclude the filling lifecycle: a stale partially-filled strand is rearmed to completion", async () => {
    // The brief asserts shouldRearmAttachmentFill EXCLUDES `filling`, so a
    // crashed-while-filling row would be permanently stranded. REFUTED: the
    // predicate accepts `pending`/`filling`/`failed`. Drive a partial fill that
    // records progress (status → filling, one token minted) then defers and lands
    // `failed`; drop its retry chain to model a dead action; age past the grace;
    // prove the public view marks it rearmable AND rearm finishes the fill.
    process.env.FEISHU_DRIVE_UPLOAD_CONCURRENCY = "1";
    try {
      const intake = harness.makeIntake({ fileNames: ["w1.pdf", "w2.pdf"] });
      // w2 defers ONCE so wave 1 mints w1 (records progress → filling), wave 2
      // defers and breaks → markAttachmentsFailed; the next attempt will succeed.
      harness.feishu.deferUploadFor("w2.pdf", { times: 1 });
      await createRowThenStopBeforeFill(harness, intake);

      // Run the kicked fill at a controlled clock.
      const fillAt = NOW + 3 * MIN;
      vi.setSystemTime(fillAt);
      await harness.driveToCompletion(); // runs ONLY the kicked fill (defers → failed)

      const strand = harness.getByMessageId(intake.internetMessageId)!;
      expect(strand.bitableAttachmentFileTokens).toHaveLength(1); // w1 minted
      expect(strand.bitableAttachmentStatus).toBe("failed");
      expect(len(strand.bitableAttachmentSources)).toBe(1); // w2 remains

      // Model a dead retry chain: drop the queued +5min retry. Age past grace from
      // its (failure-stamped) heartbeat.
      const retryAt = strand.attachmentNextRetryAt as number;
      harness.scheduler.clear();
      vi.setSystemTime(retryAt + STALE_PENDING_REARM_GRACE_MS + MIN);

      // The strand IS rearmable — the filling-lifecycle predicate does not exclude it.
      expect((await syncStatus(harness, intake))!.rearmable).toBe(true);
      const { rearmed } = await harness.rearm(intake.userEmail!, intake.conversationId!);
      expect(rearmed).toBe(true);
      await harness.driveToCompletion(); // w2 now uploads (defer was one-shot) → filled

      const done = harness.getByMessageId(intake.internetMessageId)!;
      expect(done.bitableAttachmentStatus).toBe("filled");
      const recordId = done.bitableRecordId as string;
      expect(harness.feishu.salesFilesTokens(recordId)).toHaveLength(2);
      // Each source minted exactly once across the strand + the rearm (no re-mint
      // of w1 — recordAttachmentProgress dropped it from remainingSources).
      expect(harness.feishu.mintedTokensFor("w1.pdf")).toHaveLength(1);
      expect(harness.feishu.mintedTokensFor("w2.pdf")).toHaveLength(1);
    } finally {
      delete process.env.FEISHU_DRIVE_UPLOAD_CONCURRENCY;
    }
  });
});

// ===========================================================================
// 6. RETRY-SPAN vs FRESHNESS-WINDOW — the one GENUINE strand. A late attachment
//    retry lands AFTER the freshness window; patchRowAttachments' fence REFUSES
//    the PUT (throws), so the row can never be filled even though sources remain.
// ===========================================================================

describe("retry-span outlives the freshness window (fence refuses a late fill)", () => {
  it("a fill retried past BITABLE_OWNED_ROW_UPDATE_WINDOW_MS is permanently refused by the fence", async () => {
    // Shrink the freshness window so a single deferred retry lands outside it.
    // Window = 5 min; first failure schedules a +5 min retry whose Date.now() at
    // PUT time is window+ε past the mint → mayUpdateOwnedBitableRow returns false
    // → patchRowAttachments throws → the wave that DID mint cannot persist its PUT.
    process.env.BITABLE_OWNED_ROW_UPDATE_WINDOW_MS = String(5 * MIN);
    const intake = harness.makeIntake({ fileNames: ["late.pdf"] });
    // Defer once so the first fill fails and schedules a +5min retry; on the
    // retry the upload succeeds (so a token IS minted) but the PUT is fenced out.
    harness.feishu.deferUploadFor("late.pdf", { times: 1 });

    await harness.submit(intake);
    await harness.driveToCompletion(); // wave defers → failed, +5min retry queued

    let rec = harness.getByMessageId(intake.internetMessageId)!;
    expect(rec.bitableAttachmentStatus).toBe("failed");
    const retry = pendingFillJob(harness)!;
    expect(retry.dueAt).toBe(NOW + 5 * MIN);

    // Release the retry at exactly its due time (which is the window edge + the
    // retry runs at dueAt). now - mintedAt = 5min + microsecond drift; with the
    // window set to exactly 5min the fence is at its inclusive boundary. Push 1ms
    // past so the refusal is unambiguous.
    vi.setSystemTime(retry.dueAt + 1);
    const result = await harness.driveToCompletion();

    // The retry minted the token but the coalesced PUT was REFUSED by the fence.
    rec = harness.getByMessageId(intake.internetMessageId)!;
    const recordId = rec.bitableRecordId as string;
    // A token WAS minted (upload succeeded on retry) and persisted to the record…
    expect(harness.feishu.mintedCount()).toBe(1);
    expect(len(rec.bitableAttachmentFileTokens)).toBe(1);
    // …but it NEVER reached the Base row's Sales Files cell — the fence threw.
    expect(harness.feishu.salesFilesTokens(recordId)).toHaveLength(0);
    // No Sales Files PUT ever landed (the only attempt was refused by the fence).
    expect(harness.feishu.salesFilesPuts()).toHaveLength(0);
    // fillRowAttachments CATCHES the fence throw and routes it into
    // markAttachmentsFailed, so the refusal surfaces as the row's last error
    // (NOT as a propagated job error — the action returns normally).
    void result;
    expect(String(rec.bitableLastError)).toContain("Refusing Sales Files PUT");

    // And the row is left non-filled with a token recorded but never written —
    // the "permanently given up past the window" consequence (ADR-0027 §Consequences).
    expect(rec.bitableAttachmentStatus).not.toBe("filled");
  });

  // BUG: With the DEFAULT 2h freshness window, the attachment retry schedule
  // (+5/+15/+60/+60 min ≈ 140 min cumulative) can push a late retry's PUT past
  // the 120-min window, so patchRowAttachments' fence refuses it and the row can
  // never be filled despite sources remaining — a silent partial/never-filled
  // strand. ADR-0027 §Consequences claims "the bounded-retry span is kept inside
  // the window so retries don't schedule an attempt the guard will refuse", but
  // the cumulative span (~140 min) EXCEEDS the default window (120 min).
  // REPRO: a fill that defers on attempts 1..4 reaches a retry due at
  // NOW + 5 + 15 + 60 + 60 = 140 min; running that retry mints, then the PUT is
  // fenced (now - mintedAt = 140 min > 120 min window).
  // FIX SKETCH: cap the attachment retry span below the freshness window (e.g.
  // clamp resolveBitableNextRetryAt for the attachment lifecycle so the last
  // retry's PUT lands <= mintedAt + windowMs), OR widen the window for the
  // attachment lifecycle, OR re-mint within a fresh provenance window. The
  // it.fails body asserts the row DOES reach `filled` (the owner-desired
  // invariant), which fails today because the late PUT is fenced.
  it.fails(
    "default-window: a fill that defers across all retries should still end filled, but the last retry's PUT is fenced past 120 min",
    async () => {
      // DEFAULT window (2h) — do not override BITABLE_OWNED_ROW_UPDATE_WINDOW_MS.
      const intake = harness.makeIntake({ fileNames: ["slow.pdf"] });
      // Defer on the first FOUR attempts, succeed on the fifth. The fifth attempt
      // is scheduled at +5+15+60+60 = 140 min from the first failure — past 120.
      harness.feishu.deferUploadFor("slow.pdf", { times: 4 });

      await harness.submit(intake);
      await harness.driveToCompletion(); // attempt 1: defer → failed, +5min retry

      // Walk each scheduled retry forward to its due time.
      for (let i = 0; i < 6; i++) {
        const fill = pendingFillJob(harness);
        if (!fill) break;
        vi.setSystemTime(fill.dueAt + 1);
        // eslint-disable-next-line no-await-in-loop -- sequential retry waves
        await harness.driveToCompletion();
      }

      const rec = harness.getByMessageId(intake.internetMessageId)!;
      const recordId = rec.bitableRecordId as string;
      // OWNER INVARIANT (c): every source ends as a token on the row. The fifth
      // upload succeeded, so the token exists — but the fence refused its PUT, so
      // the cell is empty and the lifecycle never reaches `filled`. This
      // expectation is what SHOULD hold; it fails today (encoded via it.fails).
      expect(harness.feishu.salesFilesTokens(recordId)).toHaveLength(1);
      expect(rec.bitableAttachmentStatus).toBe("filled");
    },
  );
});
