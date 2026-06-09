/* eslint-disable max-lines-per-function */
// Scale + networking-at-scale tests for the deferred Attachment Fill (ADR-0027).
// The upload-latency experiment lifts the count cap to 50; these prove the fill
// path holds at that size — correct wave count, Drive concurrency bounded at the
// 5-QPS ceiling, a cumulative cell in source order, no double-mint, and the
// Item-2 fill-complete timestamp — and that it recovers transparently from a
// rate-limit storm mid-batch. Companions to attachmentFill.always/retry, which
// top out at 12 files.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mock holder — populated by harness.wireMocks in beforeEach.
const mocks = vi.hoisted(() => ({
  callFeishu: async (..._args: unknown[]): Promise<unknown> => {
    throw new Error("harness not wired: callFeishu");
  },
  resolveFeishuToken: async (..._args: unknown[]): Promise<string> => "tenant-token",
  getStorageBytes: async (..._args: unknown[]): Promise<ArrayBuffer> => {
    throw new Error("harness not wired: getStorageBytes");
  },
}));

// Preserve the REAL ./call exports (withFeishuRateLimitRetry, FEISHU_* codes) and
// override ONLY the two network functions — see the harness suite for why.
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
const SCALE = 50;
const CONCURRENCY = 5; // the documented Drive 5-QPS ceiling

const originalAppToken = process.env.FEISHU_BITABLE_APP_TOKEN;
const originalTableId = process.env.FEISHU_BITABLE_TABLE_ID;
const originalConcurrency = process.env.FEISHU_DRIVE_UPLOAD_CONCURRENCY;

let harness: Harness;

beforeEach(() => {
  process.env.FEISHU_BITABLE_APP_TOKEN = APP_TOKEN;
  process.env.FEISHU_BITABLE_TABLE_ID = TABLE_ID;
  process.env.FEISHU_DRIVE_UPLOAD_CONCURRENCY = String(CONCURRENCY);
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  harness = createHarness();
  harness.wireMocks(mocks as never);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (originalAppToken === undefined) delete process.env.FEISHU_BITABLE_APP_TOKEN;
  else process.env.FEISHU_BITABLE_APP_TOKEN = originalAppToken;
  if (originalTableId === undefined) delete process.env.FEISHU_BITABLE_TABLE_ID;
  else process.env.FEISHU_BITABLE_TABLE_ID = originalTableId;
  if (originalConcurrency === undefined) delete process.env.FEISHU_DRIVE_UPLOAD_CONCURRENCY;
  else process.env.FEISHU_DRIVE_UPLOAD_CONCURRENCY = originalConcurrency;
});

describe("deferred fill at experiment scale (50 files)", () => {
  it("fills all 50 in source order across exactly 10 bounded waves, no double-mint, and stamps the fill-complete time", async () => {
    const intake = harness.makeIntake({ attachmentCount: SCALE });
    expect(intake.attachmentSources).toHaveLength(SCALE);

    await harness.submit(intake);
    await harness.driveToCompletion();

    const recordId = harness.feishu.recordIds()[0];
    const sfPuts = harness.feishu.salesFilesPuts();

    // 50 / 5 = exactly 10 coalesced waves (one cumulative PUT per minted wave).
    expect(sfPuts).toHaveLength(SCALE / CONCURRENCY);
    // Monotonic cumulative growth: 5, 10, …, 50.
    const counts = sfPuts.map(
      (p) => ((p.fields["Sales Files"] ?? []) as unknown[]).length,
    );
    expect(counts).toEqual([5, 10, 15, 20, 25, 30, 35, 40, 45, 50]);

    // Every PUT targets the one row, Sales Files column only — never Request Type.
    for (const put of sfPuts) {
      expect(put.recordId).toBe(recordId);
      expect(put.fieldKeys).toEqual(["Sales Files"]);
    }

    // Final cell = all 50, distinct, in SOURCE order, none dropped.
    const finalCell = harness.feishu.salesFilesTokens(recordId);
    expect(finalCell).toHaveLength(SCALE);
    expect(new Set(finalCell).size).toBe(SCALE);
    const mintedInSourceOrder = (intake.attachmentSources ?? []).flatMap((s) =>
      harness.feishu.mintedTokensFor(s.fileName),
    );
    expect(finalCell).toEqual(mintedInSourceOrder);

    // No source minted twice across the 10 waves (the pool never double-mints).
    for (const s of intake.attachmentSources ?? []) {
      expect(harness.feishu.mintedTokensFor(s.fileName)).toHaveLength(1);
    }

    // Drive concurrency stayed bounded at the 5-QPS ceiling, yet parallelized.
    expect(harness.feishu.uploadConcurrencyPeak).toBeLessThanOrEqual(CONCURRENCY);
    expect(harness.feishu.uploadConcurrencyPeak).toBeGreaterThan(1);

    const record = harness.getByMessageId(intake.internetMessageId)!;
    expect(record.bitableAttachmentStatus).toBe("filled");
    expect(record.bitableAttachmentSources ?? []).toEqual([]);
    // Item-2 timing: the fence stamps the fill-complete instant for [fillTotal].
    expect(record.attachmentsFilledAt).toBe(NOW);
    expect(harness.pendingJobs()).toEqual([]);
    expect(harness.storage.size()).toBe(0);
  });

  it("recovers from a mid-batch 99991400 rate-limit storm and still lands all 50 exactly once", async () => {
    const intake = harness.makeIntake({ attachmentCount: SCALE });
    // The first 3 Drive uploads hit the frequency limit, then succeed — the real
    // withDriveRateLimitRetry must absorb it (it sleeps via setTimeout; flush the
    // backoff with the fake timers, as the single-file retry test does).
    harness.feishu.rateLimitNextUpload(3);

    await harness.submit(intake);
    const drive = harness.driveToCompletion();
    await vi.runAllTimersAsync();
    await drive;
    await harness.driveToCompletion();

    const recordId = harness.feishu.recordIds()[0];
    const record = harness.getByMessageId(intake.internetMessageId)!;

    // Transparent recovery: filled, every file minted exactly once, none lost.
    expect(record.bitableAttachmentStatus).toBe("filled");
    expect(harness.feishu.salesFilesTokens(recordId)).toHaveLength(SCALE);
    for (const s of intake.attachmentSources ?? []) {
      expect(harness.feishu.mintedTokensFor(s.fileName)).toHaveLength(1);
    }
    // The storm was absorbed INSIDE the retry wrapper — no attachment-level
    // failure or retry job was recorded.
    expect(record.attachmentAttemptCount ?? 0).toBe(0);
    expect(harness.pendingJobs()).toEqual([]);
    expect(harness.storage.size()).toBe(0);
  });
});
