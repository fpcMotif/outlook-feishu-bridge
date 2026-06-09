/* eslint-disable max-lines-per-function */
// Smoke test for the deferred Attachment Fill simulation harness (ADR-0027).
// Proves the owner's #1 invariant on the happy path, end to end through the REAL
// handlers (syncRequest -> processPendingBitableSync -> markBitableSyncSucceeded
// -> fillRowAttachments -> patchRowAttachments): submitting an intake with 3
// attachment sources fills exactly those 3 distinct file_tokens onto the SAME
// row the flow minted, in the `Sales Files` column only, with the staged blobs
// deleted and the remaining-sources list drained.
//
// The vi.mock seam: ./call (callFeishu + resolveFeishuToken) and ../storage
// (getStorageBytes) delegate into the harness via a hoisted holder. We DO NOT
// mock ./drive, ./bitable, ../emails, ./requestSync, ./attachmentFill,
// ./serviceRow, or ./bitableSyncRetry — those are the real handlers under test.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mock holder — populated by harness.wireMocks in beforeEach. Each
// mocked module function delegates through this holder so it always points at
// the CURRENT test's fresh harness.
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
// and override ONLY the two functions that touch the network — otherwise the
// missing withFeishuRateLimitRetry export makes the create path throw before any
// row is minted (Vitest: "No export defined on the ./call mock").
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

const originalAppToken = process.env.FEISHU_BITABLE_APP_TOKEN;
const originalTableId = process.env.FEISHU_BITABLE_TABLE_ID;

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
  if (originalAppToken === undefined) delete process.env.FEISHU_BITABLE_APP_TOKEN;
  else process.env.FEISHU_BITABLE_APP_TOKEN = originalAppToken;
  if (originalTableId === undefined) delete process.env.FEISHU_BITABLE_TABLE_ID;
  else process.env.FEISHU_BITABLE_TABLE_ID = originalTableId;
});

describe("attachment fill harness smoke (happy path)", () => {
  it("fills 3 distinct tokens onto the same created row, then settles clean", async () => {
    const intake = harness.makeIntake({ attachmentCount: 3 });

    // Send/confirm: writes the pending backup and enqueues the create worker.
    const result = await harness.submit(intake);
    expect(result).toEqual({ status: "pending", recordId: null, detailUrl: null });

    // Drive create -> markSucceeded (kicks fill) -> fill -> PUT, to quiescence.
    await harness.driveToCompletion();

    // Exactly one row was created (the create path ran once, no duplicates).
    const recordIds = harness.feishu.recordIds();
    expect(recordIds).toHaveLength(1);
    const recordId = recordIds[0];

    // The Email Record now points at that exact row.
    const record = harness.getByMessageId(intake.internetMessageId);
    expect(record).not.toBeNull();
    expect(record!.bitableRecordId).toBe(recordId);

    // (a) The fill ran and (c) every source pended: 3 distinct tokens minted.
    const minted = harness.feishu.uploadLog.map((u) => u.fileToken);
    expect(new Set(minted).size).toBe(3);

    // (b) The tokens landed on the SAME row, in the `Sales Files` column only.
    const cell = harness.feishu.salesFilesTokens(recordId);
    expect(cell).toHaveLength(3);
    expect(new Set(cell)).toEqual(new Set(minted));

    // Every Sales-Files PUT targeted the created row and ONLY that column-scope
    // value plus the `Sales Files` key — never `Request Type`, never a foreign id.
    for (const put of harness.feishu.salesFilesPuts()) {
      expect(put.recordId).toBe(recordId);
      expect(put.fieldKeys).toEqual(["Sales Files"]);
    }

    // Lifecycle landed at `filled`.
    expect(record!.bitableAttachmentStatus).toBe("filled");

    // The 3 staged blobs were deleted after the persist.
    expect(harness.storage.size()).toBe(0);
    for (const src of intake.attachmentSources ?? []) {
      expect(harness.storage.has(src.storageId)).toBe(false);
    }

    // The remaining-sources list is drained; no retry is pending.
    expect(record!.bitableAttachmentSources ?? []).toEqual([]);
    expect(harness.pendingJobs()).toEqual([]);
  });
});
