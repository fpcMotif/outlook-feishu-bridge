/* eslint-disable max-lines-per-function */
// ADVERSARIAL integration suite — Family "retry": freshness-window vs retry-span,
// rate-limit recovery, transient deferral, and TERMINAL observability (weak
// point #2). Driven end to end through the REAL deferred Attachment Fill handlers
// (syncRequest -> processPendingBitableSync -> markBitableSyncSucceeded ->
// fillRowAttachments -> recordAttachmentProgress -> patchRowAttachments fence)
// via the ADR-0027 simulation harness. We mock ONLY the I/O boundary (./call and
// ../storage) and exercise everything else for real (drive.ts, bitable.ts,
// emails.ts, attachmentFill.ts, bitableSyncRetry.ts, serviceRow.ts).
//
// The seam mirrors convex/feishu/drive.test.ts exactly: a vi.hoisted holder the
// mocked modules delegate through, vi.mock('./call') + vi.mock('../storage')
// delegating into a fresh harness built per test, env set in beforeEach and
// restored in afterEach, fake timers + setSystemTime for every time-dependent
// scenario. Real handlers are reached ONLY through the harness dispatcher — the
// test never re-implements pipeline logic.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mock holder — populated by harness.wireMocks in beforeEach. Each mocked
// module function delegates through this holder so it always points at the
// CURRENT test's fresh harness (vi.mock is hoisted above the harness import).
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

import { createHarness, type Harness } from "./attachmentFillSim";

const APP_TOKEN = "appTok";
const TABLE_ID = "tbl_service";
const NOW = 1_716_500_000_000;
const MIN = 60_000;

const originalAppToken = process.env.FEISHU_BITABLE_APP_TOKEN;
const originalTableId = process.env.FEISHU_BITABLE_TABLE_ID;
const originalWindow = process.env.BITABLE_OWNED_ROW_UPDATE_WINDOW_MS;
const originalConcurrency = process.env.FEISHU_DRIVE_UPLOAD_CONCURRENCY;

let harness: Harness;

beforeEach(() => {
  process.env.FEISHU_BITABLE_APP_TOKEN = APP_TOKEN;
  process.env.FEISHU_BITABLE_TABLE_ID = TABLE_ID;
  // Force a deterministic single-file-per-wave so the retry span is the only
  // moving part (the 5-QPS / batch width is exercised in other family files).
  process.env.FEISHU_DRIVE_UPLOAD_CONCURRENCY = "1";
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  harness = createHarness();
  harness.wireMocks(mocks as never);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  const restore = (key: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  restore("FEISHU_BITABLE_APP_TOKEN", originalAppToken);
  restore("FEISHU_BITABLE_TABLE_ID", originalTableId);
  restore("BITABLE_OWNED_ROW_UPDATE_WINDOW_MS", originalWindow);
  restore("FEISHU_DRIVE_UPLOAD_CONCURRENCY", originalConcurrency);
});

/**
 * Run the create path to a created+synced row whose fill is kicked, settle the
 * first wave, and return the row's lookup + recordId. The default-timer scenario
 * (no deferral) lands `filled`; faults injected before this drive change that.
 */
async function sendAndGetRecordId(intake: ReturnType<Harness["makeIntake"]>): Promise<string> {
  await harness.submit(intake);
  await harness.driveToCompletion();
  const ids = harness.feishu.recordIds();
  expect(ids).toHaveLength(1);
  return ids[0];
}

/** Release the earliest pending retry by jumping the fake clock onto its dueAt. */
async function releaseNextDueRetry(): Promise<void> {
  const pending = harness.pendingJobs();
  expect(pending.length).toBeGreaterThan(0);
  const next = pending.reduce((a, b) => (a.dueAt <= b.dueAt ? a : b));
  vi.setSystemTime(next.dueAt + 1);
  await harness.driveToCompletion();
}

// ===========================================================================
// SCENARIO 1 — Transient Drive failure: defer once, wave breaks, retry finishes
// ===========================================================================

describe("transient Drive failure defers one file, then the retry completes", () => {
  it("breaks the wave, reschedules, and on the next-retry mints the rest with no double-mint", async () => {
    const intake = harness.makeIntake({ fileNames: ["alpha.pdf", "beta.pdf"] });
    // beta defers ONCE (a transient non-Feishu throw => mintOneStagedSource
    // classifies it `deferred`, the fill stops the wave and reschedules).
    harness.feishu.deferUploadFor("beta.pdf", { times: 1 });

    const recordId = await sendAndGetRecordId(intake);

    // With concurrency=1, alpha mints in wave-1 (PUT lands it), then beta defers
    // in wave-2 => loop breaks => markAttachmentsFailed schedules a retry.
    const afterFirst = harness.getByMessageId(intake.internetMessageId)!;
    expect(afterFirst.bitableAttachmentStatus).toBe("failed");
    // alpha is on the row already; beta is still a remaining source.
    expect(harness.feishu.salesFilesTokens(recordId)).toEqual(
      harness.feishu.mintedTokensFor("alpha.pdf"),
    );
    expect(harness.feishu.mintedTokensFor("alpha.pdf")).toHaveLength(1);
    expect(harness.feishu.mintedTokensFor("beta.pdf")).toHaveLength(0);
    const remaining = (afterFirst.bitableAttachmentSources ?? []) as { fileName: string }[];
    expect(remaining.map((s) => s.fileName)).toEqual(["beta.pdf"]);

    // A retry is queued (transient => self-reschedule). Release it.
    expect(harness.pendingJobs().some((j) => j.refName.includes("fillRowAttachments"))).toBe(true);
    await releaseNextDueRetry();

    // The fill completed: beta minted exactly once, both tokens on the row.
    const settled = harness.getByMessageId(intake.internetMessageId)!;
    expect(settled.bitableAttachmentStatus).toBe("filled");
    expect(harness.feishu.mintedTokensFor("beta.pdf")).toHaveLength(1);
    // No double-mint of the deferred file (the defining persist-before-delete +
    // remaining-tail guarantee): alpha minted once, beta minted once, total 2.
    expect(harness.feishu.mintedTokensFor("alpha.pdf")).toHaveLength(1);
    expect(harness.feishu.mintedCount()).toBe(2);

    // Both file_tokens are on the SAME row, Sales-Files column only.
    const cell = harness.feishu.salesFilesTokens(recordId);
    expect(cell).toHaveLength(2);
    for (const put of harness.feishu.salesFilesPuts()) {
      expect(put.recordId).toBe(recordId);
      expect(put.fieldKeys).toEqual(["Sales Files"]);
    }
    // Staged blobs all deleted; terminal retry sentinel cleared.
    expect(harness.storage.size()).toBe(0);
    expect(settled.attachmentNextRetryAt).toBeUndefined();
    expect(harness.pendingJobs()).toEqual([]);
  });
});

// ===========================================================================
// SCENARIO 2 — Rate-limit recovery: 99991400 storm, retry wrapper recovers
// ===========================================================================

describe("rate-limit (99991400) recovery via withFeishuRateLimitRetry", () => {
  it("retries the frequency-limit transparently; the token still mints onto the row", async () => {
    const intake = harness.makeIntake({ fileNames: ["limited.pdf"] });
    // The next 2 uploads (any file) throw 99991400, then succeed. The real
    // withFeishuRateLimitRetry must recover (it sleeps via setTimeout — drive the
    // backoff with the fake timers below).
    harness.feishu.rateLimitNextUpload(2);

    await harness.submit(intake);

    // withFeishuRateLimitRetry uses real setTimeout backoff; under fake timers the
    // sleep never resolves on its own. Launch the drive (whose in-flight handler
    // awaits those sleeps) WITHOUT awaiting, flush the backoff timers so the
    // sleeps resolve, then await the drive to quiescence. runAllTimersAsync also
    // yields the microtasks the harness scheduler needs between waves.
    const drive = harness.driveToCompletion();
    await vi.runAllTimersAsync();
    await drive;
    // A second pass catches any wave the scheduler enqueued after the timer flush.
    await harness.driveToCompletion();

    const recordId = harness.feishu.recordIds()[0];
    const settled = harness.getByMessageId(intake.internetMessageId)!;

    // The fill recovered WITHOUT being deferred/failed: it landed `filled`.
    expect(settled.bitableAttachmentStatus).toBe("filled");
    // The token still minted (exactly once) and still landed on the row.
    expect(harness.feishu.mintedTokensFor("limited.pdf")).toHaveLength(1);
    expect(harness.feishu.salesFilesTokens(recordId)).toEqual(
      harness.feishu.mintedTokensFor("limited.pdf"),
    );
    // The recovery is internal: no attachment failure was recorded, no retry job.
    expect(settled.attachmentAttemptCount ?? 0).toBe(0);
    expect(settled.attachmentNextRetryAt).toBeUndefined();
    expect(harness.pendingJobs()).toEqual([]);
    expect(harness.storage.size()).toBe(0);
  });
});

// ===========================================================================
// SCENARIO 3 — WINDOW vs SPAN (the suspected defect)
// ===========================================================================

describe("WINDOW vs SPAN: retry span walks past the freshness window", () => {
  // BUG: ADR-0027 claims the attachment retry span stays inside the freshness
  // window, but with the DEFAULT 120-min window the retry chain walks the
  // cumulative offsets +5,+20,+80,+140 min from the first failure. The retry
  // that fires at +140 min mints the token (persisted to bitableAttachmentFileTokens)
  // but patchRowAttachments' fence (mayUpdateOwnedBitableRow: now-mintedAt<=120min)
  // REFUSES the PUT — so the token never lands on the `Sales Files` cell. The row
  // is then marked terminal `failed` (attemptCount hits MAX=5), but invariant (c)
  // is violated: a source minted a token that is observably absent from the row,
  // with NO 'skipped' record either. Partial-and-silent. The attempt cap (MAX=5)
  // prevents an *infinite* loop, so this is NOT a reschedule storm — but the
  // user-facing outcome is a dropped attachment. The numbers below prove the
  // ADR's "retry span inside the window" claim FALSE.
  //
  // Fix sketch: keep the retry span inside the window per ADR-0027 — either cap
  // the attachment attempts so the LAST retry still fires before mintedAt+window
  // (e.g. cap at 3 attempts: +5,+20 < 120), or shrink the schedule (e.g. +5,+10,
  // +20,+40 cumulative = 75 < 120), or refresh bitableRowMintedAt is NOT allowed
  // (provenance), so the schedule MUST be bounded by the window. Today nothing
  // ties the two together => the defect.
  //
  // Encoded as a PASSING characterization (the loop terminates, so it.fails is
  // not warranted for "infinite loop") that ASSERTS the observable dropped-token
  // defect. See the it.fails companion below for the invariant the SUT should hold.

  it("characterizes: late retry mints a token the fence refuses to PUT (terminates, not infinite)", async () => {
    // Default window = 120 min (do NOT set BITABLE_OWNED_ROW_UPDATE_WINDOW_MS).
    delete process.env.BITABLE_OWNED_ROW_UPDATE_WINDOW_MS;
    const intake = harness.makeIntake({ fileNames: ["late.pdf"] });
    // Defer the only file for the first 4 attempts; the 5th attempt (at +140 min)
    // would mint, but the fence then refuses the PUT.
    harness.feishu.deferUploadFor("late.pdf", { times: 4 });

    const recordId = await sendAndGetRecordId(intake);
    const mintedAt = harness.getByMessageId(intake.internetMessageId)!.bitableRowMintedAt as number;
    expect(mintedAt).toBe(NOW);

    // Walk the retry chain by releasing each scheduled retry in turn. Cap the
    // number of releases so a genuine infinite reschedule loop is detectable.
    const observedRetryOffsets: number[] = [];
    let rounds = 0;
    const MAX_ROUNDS = 12; // generous cap; the real chain should terminate at 5.
    while (harness.pendingJobs().some((j) => j.refName.includes("fillRowAttachments"))) {
      rounds += 1;
      if (rounds > MAX_ROUNDS) break;
      const next = harness
        .pendingJobs()
        .filter((j) => j.refName.includes("fillRowAttachments"))
        .reduce((a, b) => (a.dueAt <= b.dueAt ? a : b));
      observedRetryOffsets.push(Math.round((next.dueAt - NOW) / MIN));
      vi.setSystemTime(next.dueAt + 1);
      // eslint-disable-next-line no-await-in-loop -- the retry chain is inherently sequential
      await harness.driveToCompletion();
    }

    // The chain TERMINATED (no infinite loop) within the MAX attempts.
    expect(rounds).toBeLessThanOrEqual(MAX_ROUNDS);

    // Prove the ADR claim FALSE with the actual numbers: the retry chain walks the
    // cumulative offsets and the LATE retry fires past the 120-min window.
    expect(observedRetryOffsets).toEqual([5, 20, 80, 140]);
    const windowMin = 120;
    const lastRetryOffset = observedRetryOffsets[observedRetryOffsets.length - 1];
    expect(lastRetryOffset).toBeGreaterThan(windowMin); // span (140) > window (120)

    // TERMINAL observable failed state: no perpetual reschedule.
    const settled = harness.getByMessageId(intake.internetMessageId)!;
    expect(settled.bitableAttachmentStatus).toBe("failed");
    expect(settled.attachmentNextRetryAt).toBeUndefined();
    expect(settled.bitableLastError).toBeTruthy();
    expect(harness.pendingJobs()).toEqual([]);

    // THE DEFECT, observed: the token minted on the late attempt but the fence
    // refused the PUT, so it is NOT on the row — and it was NOT recorded skipped.
    expect(harness.feishu.mintedTokensFor("late.pdf")).toHaveLength(1); // minted
    expect(harness.feishu.salesFilesTokens(recordId)).toEqual([]); // but absent from row
    expect(settled.bitableAttachmentSkipped ?? []).toEqual([]); // and not skipped
    // The token IS persisted on the record (orphaned: known but un-PUT-able).
    expect(((settled.bitableAttachmentFileTokens ?? []) as string[]).length).toBe(1);
    // The error mentions the fence refusal (terminal cause is the window, not Drive).
    expect(String(settled.bitableLastError)).toMatch(/Refusing Sales Files PUT/);
  });

  // BUG: invariant (c) violated — a source minted a token that never reaches the
  // row and is never recorded as skipped (partial-and-silent). The owner anchor
  // says every source ends as a token ON THE ROW or observably skipped. This
  // it.fails encodes the invariant the SUT SHOULD satisfy; it currently FAILS
  // because the windowed fence drops the late-minted token silently. It auto-
  // flips green once the retry span is bounded inside the window (so the PUT
  // always lands) OR the dropped token is recorded as skipped on terminal refusal.
  //
  // Fix sketch: bound the attachment retry schedule by bitableUpdateWindowMs() so
  // the final retry's PUT is still inside the window; alternatively, on a terminal
  // fence refusal, record the orphaned token's fileName in bitableAttachmentSkipped
  // so the source is at least observably accounted for (closes invariant (c)).
  it.fails(
    "owner invariant (c): every minted source lands on the row OR is observably skipped",
    async () => {
      delete process.env.BITABLE_OWNED_ROW_UPDATE_WINDOW_MS;
      const intake = harness.makeIntake({ fileNames: ["late.pdf"] });
      harness.feishu.deferUploadFor("late.pdf", { times: 4 });

      const recordId = await sendAndGetRecordId(intake);

      let rounds = 0;
      while (
        harness.pendingJobs().some((j) => j.refName.includes("fillRowAttachments")) &&
        rounds < 12
      ) {
        rounds += 1;
        const next = harness
          .pendingJobs()
          .filter((j) => j.refName.includes("fillRowAttachments"))
          .reduce((a, b) => (a.dueAt <= b.dueAt ? a : b));
        vi.setSystemTime(next.dueAt + 1);
        // eslint-disable-next-line no-await-in-loop -- sequential retry chain
        await harness.driveToCompletion();
      }

      const settled = harness.getByMessageId(intake.internetMessageId)!;
      const onRow = harness.feishu.salesFilesTokens(recordId); // []
      const skipped = (settled.bitableAttachmentSkipped ?? []) as string[]; // []
      // Every source name is accounted for: ON the row (impossible here) or skipped.
      // Currently neither holds for "late.pdf" => this assertion FAILS (the bug).
      const accountedFor = onRow.length + skipped.length;
      const sourceCount = 1;
      expect(accountedFor).toBe(sourceCount);
    },
  );
});

// ===========================================================================
// SCENARIO 4 — Exhaustion: MAX attempts => undefined terminal sentinel, no rearm
// ===========================================================================

describe("attachment-fill exhaustion is terminal (no perpetual rearm)", () => {
  it("after MAX attempts attachmentNextRetryAt is the undefined sentinel and shouldRearmAttachmentFill is false", async () => {
    // Shrink the window so it is NOT the cause of termination here — we isolate the
    // MAX_ATTEMPTS cap. A generously-large window keeps the fence happy; the file
    // simply keeps deferring forever (transient Drive failure that never clears).
    process.env.BITABLE_OWNED_ROW_UPDATE_WINDOW_MS = String(1000 * MIN);
    const intake = harness.makeIntake({ fileNames: ["doomed.pdf"] });
    // Defer for far more than MAX attempts so termination is driven purely by the
    // attempt cap, not by the Drive transient clearing.
    harness.feishu.deferUploadFor("doomed.pdf", { times: 99 });

    await sendAndGetRecordId(intake);

    // Walk every scheduled retry to quiescence.
    let rounds = 0;
    while (
      harness.pendingJobs().some((j) => j.refName.includes("fillRowAttachments")) &&
      rounds < 20
    ) {
      rounds += 1;
      // eslint-disable-next-line no-await-in-loop -- sequential retry chain
      await releaseNextDueRetry();
    }

    const settled = harness.getByMessageId(intake.internetMessageId)!;
    // Terminal: status failed, undefined next-retry sentinel, MAX attempts reached.
    expect(settled.bitableAttachmentStatus).toBe("failed");
    expect(settled.attachmentNextRetryAt).toBeUndefined();
    expect(settled.attachmentAttemptCount).toBe(5); // MAX_BITABLE_SYNC_ATTEMPTS

    // No further fill retry is queued — the chain stopped enqueuing itself.
    expect(harness.pendingJobs().some((j) => j.refName.includes("fillRowAttachments"))).toBe(
      false,
    );

    // And rearm-on-reopen refuses to revive it: the terminal sentinel is excluded
    // by shouldRearmAttachmentFill (reached through the real getRearmableOutboxRecord
    // query via the public rearm action). Jump well past any grace window first.
    vi.setSystemTime(NOW + 10_000 * MIN);
    const { rearmed } = await harness.rearm(intake.userEmail!, intake.conversationId!);
    expect(rearmed).toBe(false);
    // No fill job was scheduled by the (refused) rearm.
    expect(harness.pendingJobs().some((j) => j.refName.includes("fillRowAttachments"))).toBe(
      false,
    );
  });

  it("a failed fill that is still BELOW max IS rearmable once its real next-retry is overdue", async () => {
    // Contrast case: one deferral leaves a non-terminal `failed` row with a real
    // (numeric) next-retry. After it goes overdue past the grace window, rearm-on-
    // reopen revives it (proving the undefined sentinel — not merely `failed` — is
    // what gates rearm). Large window keeps the fence out of it.
    process.env.BITABLE_OWNED_ROW_UPDATE_WINDOW_MS = String(1000 * MIN);
    const intake = harness.makeIntake({ fileNames: ["recoverable.pdf"] });
    harness.feishu.deferUploadFor("recoverable.pdf", { times: 1 });

    await sendAndGetRecordId(intake);
    const failed = harness.getByMessageId(intake.internetMessageId)!;
    expect(failed.bitableAttachmentStatus).toBe("failed");
    expect(failed.attachmentNextRetryAt).toBeTypeOf("number"); // real, not sentinel

    // The in-action self-reschedule already queued the retry; drop it so the ONLY
    // path back to life is the public rearm (we are testing rearm, not the chain).
    harness.scheduler.clear();

    // Move past the next-retry + the rearm grace window, then rearm.
    const retryAt = failed.attachmentNextRetryAt as number;
    vi.setSystemTime(retryAt + 3 * MIN);
    const { rearmed } = await harness.rearm(intake.userEmail!, intake.conversationId!);
    expect(rearmed).toBe(true);
    // Rearm scheduled a fresh fill; drive it (the deferral has cleared by now).
    await harness.driveToCompletion();

    const settled = harness.getByMessageId(intake.internetMessageId)!;
    expect(settled.bitableAttachmentStatus).toBe("filled");
    expect(harness.feishu.mintedTokensFor("recoverable.pdf")).toHaveLength(1);
    expect(settled.attachmentNextRetryAt).toBeUndefined();
  });
});
