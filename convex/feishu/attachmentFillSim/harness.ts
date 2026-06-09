/* eslint-disable max-lines, max-lines-per-function, require-await -- test-support harness: createHarness() wires one cohesive object; the async wireMocks/accessors mirror real async signatures. */
// The deferred Attachment Fill simulation harness (ADR-0027). `createHarness()`
// wires together:
//   • FakeDb       — the emailRecords table + its five indexes, with the exact
//                    Convex patch/insert/index contracts (see fakeConvex.ts).
//   • FakeStorage  — staged blobs the fill mints Drive tokens from.
//   • FakeScheduler — the runAfter queue, drained deterministically.
//   • Registry     — every internal.* ref the pipeline calls -> real ._handler.
//   • FeishuBaseSim — the callFeishu impl + fault knobs + upload gate.
//
// It exposes an ergonomic driver (submit / sendAndSettle / startFill / runDue /
// driveToCompletion / advanceTimeMs) plus accessors over the sim, db, storage,
// and scheduler — the surface the ~7 later adversarial test files build on.
//
// Pure TypeScript: NO `vitest` import. Tests do the vi.mock wiring; the harness
// exposes a `mocks` holder the test points its mock factories at (see README).

import { internal } from "../../_generated/api";

import { syncRequest, processPendingBitableSync, fillRowAttachments, rearmConversationSync } from "../requestSync";
import { createServiceRecord, patchRowAttachments } from "../bitable";
import {
  beginBitableSync,
  markBitableSyncSucceeded,
  markBitableSyncFailed,
  abandonBitableSync,
  getAttachmentFillState,
  recordAttachmentProgress,
  markAttachmentsFilled,
  markAttachmentsFailed,
  getRearmableOutboxRecord,
  listDueBitableSyncRecords,
} from "../../emails";

import {
  FakeDb,
  FakeStorage,
  FakeScheduler,
  Registry,
  buildHarnessCtx,
  wallClock,
  type FakeDoc,
  type ScheduledJob,
} from "./fakeConvex";
import { FeishuBaseSim } from "./feishuBaseSim";
import { makeIntake, type MakeIntakeOptions, type OutlookIntake } from "./outlookIntake";

/** Lookup key for the attachment fill (matches fillRowAttachments args). */
export interface FillLookup {
  internetMessageId: string;
  requestSyncKey?: string;
}

/**
 * The mock holder a test points its vi.mock factories at. The test creates the
 * holder via vi.hoisted, references it from vi.mock('./call') / vi.mock(
 * '../storage'), then calls `harness.wireMocks(holder)` so every mocked module
 * function delegates into THIS harness's sim/storage. See the README.
 */
export interface HarnessMocks {
  callFeishu: (ctx: unknown, opts: unknown) => Promise<unknown>;
  resolveFeishuToken: (ctx: unknown, auth: string, sessionId?: string) => Promise<string>;
  getStorageBytes: (ctx: unknown, storageId: string) => Promise<ArrayBuffer>;
}

/** A scheduled job whose handler threw (isolated, like a Convex scheduled fn). */
export interface JobError {
  refName: string;
  error: unknown;
}

export interface DriveResult {
  /** How many scheduled jobs were run to reach a quiescent queue. */
  ranJobs: number;
  /** The job names that were run, in order (for diagnostics). */
  ran: string[];
  /**
   * Errors thrown by scheduled jobs. In real Convex a scheduled function runs
   * DETACHED — a throw is recorded by the platform, never propagated to a
   * caller, and the function may already have self-rescheduled before throwing
   * (processPendingBitableSync re-throws AFTER scheduling its retry). The driver
   * mirrors that: it captures the throw here instead of crashing the drive, so a
   * test can both assert on the failure AND see the retry it queued.
   */
  errors: JobError[];
}

export interface Harness {
  // Core pieces (escape hatch for advanced tests).
  db: FakeDb;
  storage: FakeStorage;
  scheduler: FakeScheduler;
  feishu: FeishuBaseSim;
  registry: Registry;
  ctx: unknown;

  /** Point a test's mock holder at this harness (call once in beforeEach). */
  wireMocks(mocks: HarnessMocks): void;

  /** Build a fresh Outlook intake (stages its attachments into this storage). */
  makeIntake(options?: MakeIntakeOptions): OutlookIntake;

  // ---- drivers ---------------------------------------------------------

  /** Run syncRequest._handler with the intake; returns its result. */
  submit(intake: OutlookIntake): Promise<unknown>;

  /** submit() then driveToCompletion() — the full send→fill→fence path. */
  sendAndSettle(intake: OutlookIntake): Promise<DriveResult>;

  /** Directly kick a fill (rearm-style) without going through the create path. */
  startFill(lookup: FillLookup): Promise<void>;

  /**
   * Run the public rearmConversationSync action (the cron-free self-heal the
   * taskpane calls on reopen). Returns its `{ rearmed }` result; does NOT drive
   * the queue — call driveToCompletion / advanceTimeMs afterwards to run any
   * fill / replay it scheduled.
   */
  rearm(userEmail: string, conversationId: string): Promise<{ rearmed: boolean }>;

  /** Run every job currently DUE at the present clock, once. */
  runDue(): Promise<DriveResult>;

  /**
   * Drain the scheduler to quiescence WITHOUT advancing time: repeatedly run all
   * due jobs (jobs may enqueue more due jobs) until none remain due. Future-dated
   * retries are left pending — advanceTimeMs to release them.
   */
  driveToCompletion(opts?: { maxRounds?: number }): Promise<DriveResult>;

  /** Advance the fake clock by `ms`, then drive newly-due jobs to completion. */
  advanceTimeMs(ms: number): Promise<DriveResult>;

  // ---- accessors -------------------------------------------------------

  /** The stored Email Record by internetMessageId, or null. */
  getByMessageId(internetMessageId: string): FakeDoc | null;
  /** The stored Email Record by requestSyncKey, or null. */
  getBySyncKey(requestSyncKey: string): FakeDoc | null;
  /** Build the fill lookup for a submitted intake. */
  lookupFor(intake: OutlookIntake): FillLookup;
  /** Currently-queued scheduler jobs. */
  pendingJobs(): ScheduledJob[];
}

/**
 * Build a fresh, isolated harness. Time is read from the real wall clock so a
 * test using vi.useFakeTimers()/vi.setSystemTime(...) drives both the SUT's
 * Date.now() math and the scheduler's due math identically.
 */
export function createHarness(): Harness {
  // The sim exercises deferred-FILL mechanics at batch sizes (12, 50, …) above
  // the default submit cap, so lift ATTACHMENT_CAP here — otherwise syncRequest's
  // count guard (assertWithinAttachmentCap) would short-circuit a fill-behavior
  // test before it ever reaches the fill. The cap guard itself is unit-tested
  // directly in attachmentLimits.test.ts.
  process.env.ATTACHMENT_CAP = "1000";

  const db = new FakeDb(wallClock);
  const storage = new FakeStorage();
  const scheduler = new FakeScheduler(wallClock);
  const feishu = new FeishuBaseSim();
  const registry = new Registry();

  // Map EVERY internal.* ref the pipeline uses to its real registered handler.
  registry
    .register(internal.feishu.requestSync.processPendingBitableSync, processPendingBitableSync)
    .register(internal.feishu.requestSync.fillRowAttachments, fillRowAttachments)
    .register(internal.feishu.bitable.createServiceRecord, createServiceRecord)
    .register(internal.feishu.bitable.patchRowAttachments, patchRowAttachments)
    .register(internal.emails.beginBitableSync, beginBitableSync)
    .register(internal.emails.markBitableSyncSucceeded, markBitableSyncSucceeded)
    .register(internal.emails.markBitableSyncFailed, markBitableSyncFailed)
    .register(internal.emails.abandonBitableSync, abandonBitableSync)
    .register(internal.emails.getAttachmentFillState, getAttachmentFillState)
    .register(internal.emails.recordAttachmentProgress, recordAttachmentProgress)
    .register(internal.emails.markAttachmentsFilled, markAttachmentsFilled)
    .register(internal.emails.markAttachmentsFailed, markAttachmentsFailed)
    .register(internal.emails.getRearmableOutboxRecord, getRearmableOutboxRecord)
    .register(internal.emails.listDueBitableSyncRecords, listDueBitableSyncRecords);

  const ctx = buildHarnessCtx({ db, storage, scheduler, registry });

  const handlerOf = <T>(fn: { _handler: (ctx: unknown, args: unknown) => T }) =>
    (args: unknown): T => fn._handler(ctx, args);

  const runSyncRequest = handlerOf(
    syncRequest as unknown as { _handler: (ctx: unknown, args: unknown) => Promise<unknown> },
  );
  const runRearm = handlerOf(
    rearmConversationSync as unknown as {
      _handler: (ctx: unknown, args: unknown) => Promise<{ rearmed: boolean }>;
    },
  );

  const harness: Harness = {
    db,
    storage,
    scheduler,
    feishu,
    registry,
    ctx,

    wireMocks(mocks: HarnessMocks): void {
      mocks.callFeishu = (mockCtx: unknown, opts: unknown) =>
        feishu.callFeishu(mockCtx, opts as never);
      mocks.resolveFeishuToken = async () => "tenant-token";
      mocks.getStorageBytes = (_mockCtx: unknown, storageId: string) =>
        storage.getBytes(storageId);
    },

    makeIntake(options?: MakeIntakeOptions): OutlookIntake {
      return makeIntake(storage, options);
    },

    async submit(intake: OutlookIntake): Promise<unknown> {
      return await runSyncRequest(intake);
    },

    async sendAndSettle(intake: OutlookIntake): Promise<DriveResult> {
      await runSyncRequest(intake);
      return await harness.driveToCompletion();
    },

    async startFill(lookup: FillLookup): Promise<void> {
      await scheduler.runAfter(0, internal.feishu.requestSync.fillRowAttachments, {
        internetMessageId: lookup.internetMessageId,
        requestSyncKey: lookup.requestSyncKey,
      });
      await harness.driveToCompletion();
    },

    async rearm(userEmail: string, conversationId: string): Promise<{ rearmed: boolean }> {
      return await runRearm({ userEmail, conversationId });
    },

    async runDue(): Promise<DriveResult> {
      const ran: string[] = [];
      const errors: JobError[] = [];
      let job = scheduler.popDue();
      while (job) {
        ran.push(job.refName);
        const handler = registry.resolve(job.ref);
        try {
          // eslint-disable-next-line no-await-in-loop -- jobs run sequentially, like the real scheduler
          await handler(ctx, job.args ?? {});
        } catch (error) {
          // Detached-job isolation: capture, don't propagate (see DriveResult).
          errors.push({ refName: job.refName, error });
        }
        job = scheduler.popDue();
      }
      return { ranJobs: ran.length, ran, errors };
    },

    async driveToCompletion(opts?: { maxRounds?: number }): Promise<DriveResult> {
      const maxRounds = opts?.maxRounds ?? 1000;
      const ran: string[] = [];
      const errors: JobError[] = [];
      for (let round = 0; round < maxRounds; round++) {
        if (scheduler.due().length === 0) break;
        // eslint-disable-next-line no-await-in-loop, react-doctor/async-await-in-loop -- rounds are inherently sequential (drain the scheduler, then re-check for newly-scheduled jobs)
        const result = await harness.runDue();
        ran.push(...result.ran);
        errors.push(...result.errors);
        if (result.ranJobs === 0) break;
      }
      return { ranJobs: ran.length, ran, errors };
    },

    async advanceTimeMs(ms: number): Promise<DriveResult> {
      // The harness clock IS the wall clock (Date.now()), which fake timers own.
      // A test advances time with vi.setSystemTime(now + ms) (so the SUT's own
      // Date.now() / freshness / fence math move too), then drives newly-due
      // jobs. This helper is the convenience wrapper for the NON-fake-timer case
      // and a no-op shim under fake timers: it just drives whatever is now due.
      // (Under fake timers, call vi.setSystemTime BEFORE this.)
      void ms;
      return await harness.driveToCompletion();
    },

    getByMessageId(internetMessageId: string): FakeDoc | null {
      return (
        db
          .all("emailRecords")
          .find((r) => r.internetMessageId === internetMessageId) ?? null
      );
    },

    getBySyncKey(requestSyncKey: string): FakeDoc | null {
      return (
        db.all("emailRecords").find((r) => r.requestSyncKey === requestSyncKey) ?? null
      );
    },

    lookupFor(intake: OutlookIntake): FillLookup {
      const requestSyncKey = buildKey(intake.userEmail, intake.conversationId);
      return {
        internetMessageId: intake.internetMessageId,
        requestSyncKey: requestSyncKey ?? undefined,
      };
    },

    pendingJobs(): ScheduledJob[] {
      return scheduler.pending();
    },
  };

  return harness;
}

/** Mirror of buildRequestSyncKey (kept local to avoid a server import cycle). */
function buildKey(userEmail: string | undefined, conversationId: string | undefined): string | null {
  const e = userEmail?.trim().toLowerCase() ?? "";
  const c = conversationId?.trim() ?? "";
  if (!e || !c) return null;
  return `${e}\n${c}`;
}
