/* eslint-disable max-lines-per-function, no-loop-func -- table-driven tests: each it() closes over a block-scoped `const n` (safe). */
// ANCHOR-INVARIANT adversarial suite for the deferred Attachment Fill server
// pipeline (ADR-0027), built on the existing simulation harness. Family:
//
//   "the fill ALWAYS runs, hits the RIGHT row, pends ALL tokens"
//
// Every test reaches the REAL handlers (syncRequest -> processPendingBitableSync
// -> markBitableSyncSucceeded -> fillRowAttachments -> patchRowAttachments) only
// through the harness dispatcher; we never re-implement pipeline logic. The seam
// matches drive.test.ts / the smoke test: a vi.hoisted holder + vi.mock('./call')
// + vi.mock('../storage') delegating into THIS test's fresh harness. We mock ONLY
// the I/O boundary (callFeishu/resolveFeishuToken + getStorageBytes); ./drive,
// ./bitable, ../emails, ./requestSync, ./attachmentFill, ./serviceRow are real.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mock holder — pointed at the current test's harness by wireMocks().
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

const originalAppToken = process.env.FEISHU_BITABLE_APP_TOKEN;
const originalTableId = process.env.FEISHU_BITABLE_TABLE_ID;
const originalConcurrency = process.env.FEISHU_DRIVE_UPLOAD_CONCURRENCY;

let harness: Harness;

beforeEach(() => {
  process.env.FEISHU_BITABLE_APP_TOKEN = APP_TOKEN;
  process.env.FEISHU_BITABLE_TABLE_ID = TABLE_ID;
  delete process.env.FEISHU_DRIVE_UPLOAD_CONCURRENCY;
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

// =====================================================================
// (1) The anchor invariant proven WHOLE: (a) runs, (b) right row,
//     (c) ALL N tokens pended — for several N.
// =====================================================================
describe("anchor invariant — fill runs, hits the row, pends ALL tokens", () => {
  for (const n of [1, 2, 5]) {
    it(`send/confirm with ${n} source(s): cell holds exactly ${n} distinct tokens, filled, blobs gone, sources drained`, async () => {
      const intake = harness.makeIntake({ attachmentCount: n });

      const result = await harness.submit(intake);
      expect(result).toEqual({ status: "pending", recordId: null, detailUrl: null });

      const drive = await harness.driveToCompletion();
      expect(drive.errors).toEqual([]); // no scheduled job threw on the happy path

      // Exactly ONE row was created (no duplicate create).
      const recordIds = harness.feishu.recordIds();
      expect(recordIds).toHaveLength(1);
      const recordId = recordIds[0];

      const record = harness.getByMessageId(intake.internetMessageId)!;
      expect(record).not.toBeNull();

      // (b) The Email Record points at exactly that minted row.
      expect(record.bitableRecordId).toBe(recordId);

      // (a) The fill ran: N distinct tokens were minted, one per source.
      expect(harness.feishu.mintedCount()).toBe(n);
      const minted = harness.feishu.uploadLog.map((u) => u.fileToken);
      expect(new Set(minted).size).toBe(n);

      // (c) ALL N tokens landed on the row, distinct, none dropped/duplicated.
      const cell = harness.feishu.salesFilesTokens(recordId);
      expect(cell).toHaveLength(n);
      expect(new Set(cell).size).toBe(n);
      expect(new Set(cell)).toEqual(new Set(minted));

      // Lifecycle terminal-green, sources drained, blobs gone, nothing pending.
      expect(record.bitableAttachmentStatus).toBe("filled");
      expect(record.bitableAttachmentSources ?? []).toEqual([]);
      expect(harness.storage.size()).toBe(0);
      for (const src of intake.attachmentSources ?? []) {
        expect(harness.storage.has(src.storageId)).toBe(false);
      }
      expect(harness.pendingJobs()).toEqual([]);
    });
  }

  it("token cell order matches source order (no reordering across the persist→PUT)", async () => {
    const intake = harness.makeIntake({ attachmentCount: 5 });
    await harness.submit(intake);
    await harness.driveToCompletion();

    const recordId = harness.feishu.recordIds()[0];
    // The fill mints in source order; the cell must reflect that exact order.
    const mintedInSourceOrder = (intake.attachmentSources ?? []).flatMap((s) =>
      harness.feishu.mintedTokensFor(s.fileName),
    );
    expect(mintedInSourceOrder).toHaveLength(5);
    expect(harness.feishu.salesFilesTokens(recordId)).toEqual(mintedInSourceOrder);
  });
});

// =====================================================================
// (2) The fill is KICKED exactly when sources exist — and ONLY then.
// =====================================================================
describe("the kick fires iff sources exist", () => {
  it("with sources: markBitableSyncSucceeded scheduled the fill (a Sales-Files PUT happened, status filled)", async () => {
    const intake = harness.makeIntake({ attachmentCount: 3 });
    await harness.submit(intake);
    await harness.driveToCompletion();

    // The kick is observable: a fill ran, the Sales-Files column was written,
    // and the attachment lifecycle reached `filled`.
    expect(harness.feishu.salesFilesPuts().length).toBeGreaterThan(0);
    const record = harness.getByMessageId(intake.internetMessageId)!;
    expect(record.bitableAttachmentStatus).toBe("filled");
  });

  it("with ZERO sources: the fill is NEVER scheduled and no attachment lifecycle is armed", async () => {
    const intake = harness.makeIntake({ attachmentCount: 0 });
    expect(intake.attachmentSources).toEqual([]);

    await harness.submit(intake);
    const drive = await harness.driveToCompletion();

    // The create path still ran (one row), but the fill chain never did.
    expect(harness.feishu.recordIds()).toHaveLength(1);
    expect(drive.ran).not.toContain("feishu/requestSync:fillRowAttachments");

    // No upload, no Sales-Files PUT — the cell was never touched.
    expect(harness.feishu.mintedCount()).toBe(0);
    expect(harness.feishu.salesFilesPuts()).toEqual([]);

    // The attachment lifecycle was never armed (no status, no retry clock).
    const record = harness.getByMessageId(intake.internetMessageId)!;
    expect(record.bitableRecordId).toBe(harness.feishu.recordIds()[0]);
    expect(record.bitableAttachmentStatus).toBeUndefined();
    expect(record.attachmentNextRetryAt).toBeUndefined();
    expect(harness.pendingJobs()).toEqual([]);
  });

  it("a row already `filled` is not re-kicked even though it carries sources", async () => {
    // First send fills it.
    const intake = harness.makeIntake({ attachmentCount: 2 });
    await harness.submit(intake);
    await harness.driveToCompletion();
    const record = harness.getByMessageId(intake.internetMessageId)!;
    expect(record.bitableAttachmentStatus).toBe("filled");

    const putsBefore = harness.feishu.salesFilesPuts().length;
    const mintedBefore = harness.feishu.mintedCount();

    // Re-kick the fill directly (rearm-style). getAttachmentFillState reports
    // status `filled`, so fillRowAttachments must noop: no new mint, no new PUT.
    await harness.startFill(harness.lookupFor(intake));

    expect(harness.feishu.mintedCount()).toBe(mintedBefore);
    expect(harness.feishu.salesFilesPuts().length).toBe(putsBefore);
  });
});

// =====================================================================
// (3) Multi-wave: N > concurrency => correct # of waves, cumulative
//     PUTs MONOTONIC (each PUT's token set ⊇ the previous), final = all
//     N, tokens in source order, none dropped.
// =====================================================================
describe("multi-wave fill is cumulative + monotonic", () => {
  it("12 sources at concurrency 4 => 3 waves, 3 cumulative PUTs each a superset of the last, final cell = all 12 in source order", async () => {
    process.env.FEISHU_DRIVE_UPLOAD_CONCURRENCY = "4";
    const intake = harness.makeIntake({ attachmentCount: 12 });

    await harness.submit(intake);
    await harness.driveToCompletion();

    const recordId = harness.feishu.recordIds()[0];
    const sfPuts = harness.feishu.salesFilesPuts();

    // 12 / 4 = exactly 3 coalesced waves (one PUT per minted wave).
    expect(sfPuts).toHaveLength(3);

    // Each PUT targets the same row, only the Sales Files column.
    for (const put of sfPuts) {
      expect(put.recordId).toBe(recordId);
      expect(put.fieldKeys).toEqual(["Sales Files"]);
    }

    // Extract the cumulative token list each PUT wrote.
    const tokenSets = sfPuts.map((p) => {
      const cell = (p.fields["Sales Files"] ?? []) as { file_token: string }[];
      return cell.map((c) => c.file_token);
    });

    // MONOTONIC growth: 4, 8, 12 — and each set is a strict superset of the prior.
    expect(tokenSets.map((s) => s.length)).toEqual([4, 8, 12]);
    for (let i = 1; i < tokenSets.length; i++) {
      const prev = new Set(tokenSets[i - 1]);
      // every earlier token survives (a CUMULATIVE write, never a replace)
      for (const tok of prev) expect(tokenSets[i]).toContain(tok);
      // and it is a prefix (append-only, order preserved)
      expect(tokenSets[i].slice(0, tokenSets[i - 1].length)).toEqual(tokenSets[i - 1]);
    }

    // Final cell = all 12, distinct, in source order, none dropped.
    const finalCell = harness.feishu.salesFilesTokens(recordId);
    expect(finalCell).toHaveLength(12);
    expect(new Set(finalCell).size).toBe(12);
    const mintedInSourceOrder = (intake.attachmentSources ?? []).flatMap((s) =>
      harness.feishu.mintedTokensFor(s.fileName),
    );
    expect(finalCell).toEqual(mintedInSourceOrder);

    // No source minted twice (no double-mint across waves).
    for (const s of intake.attachmentSources ?? []) {
      expect(harness.feishu.mintedTokensFor(s.fileName)).toHaveLength(1);
    }

    const record = harness.getByMessageId(intake.internetMessageId)!;
    expect(record.bitableAttachmentStatus).toBe("filled");
    expect(record.bitableAttachmentSources ?? []).toEqual([]);
  });

  it("the wave width respects driveUploadConcurrency (peak concurrent uploads = 4)", async () => {
    process.env.FEISHU_DRIVE_UPLOAD_CONCURRENCY = "4";
    const intake = harness.makeIntake({ attachmentCount: 12 });
    await harness.submit(intake);
    await harness.driveToCompletion();

    // The sim records the true wave width; the SUT must never overrun the cap.
    expect(harness.feishu.uploadConcurrencyPeak).toBeLessThanOrEqual(4);
    expect(harness.feishu.uploadConcurrencyPeak).toBeGreaterThan(1); // it parallelized
  });

  it("concurrency 1 (serial) => 5 sources fill in 5 single-token waves, still cumulative", async () => {
    process.env.FEISHU_DRIVE_UPLOAD_CONCURRENCY = "1";
    const intake = harness.makeIntake({ attachmentCount: 5 });
    await harness.submit(intake);
    await harness.driveToCompletion();

    const recordId = harness.feishu.recordIds()[0];
    const sfPuts = harness.feishu.salesFilesPuts();
    expect(sfPuts).toHaveLength(5);

    const lengths = sfPuts.map(
      (p) => ((p.fields["Sales Files"] ?? []) as unknown[]).length,
    );
    expect(lengths).toEqual([1, 2, 3, 4, 5]); // strictly growing, append-only

    expect(harness.feishu.salesFilesTokens(recordId)).toHaveLength(5);
    expect(harness.feishu.uploadConcurrencyPeak).toBe(1);
  });
});

// =====================================================================
// (4) Correct-row + column-scope: every attachment PUT hits the created
//     record_id and writes ONLY 'Sales Files'.
// =====================================================================
describe("correct-row + column-scope discipline", () => {
  it("every attachment PUT targets the created record_id and writes ONLY the Sales Files column", async () => {
    const intake = harness.makeIntake({ attachmentCount: 6 });
    await harness.submit(intake);
    await harness.driveToCompletion();

    const created = harness.feishu.createLog.filter((c) => !c.deduped);
    expect(created).toHaveLength(1);
    const createdRecordId = created[0].recordId;

    const sfPuts = harness.feishu.salesFilesPuts();
    expect(sfPuts.length).toBeGreaterThan(0);
    for (const put of sfPuts) {
      // (b) SAME row the create minted — never a foreign / ancient / wrong id.
      expect(put.recordId).toBe(createdRecordId);
      // column-scope: EXACTLY ['Sales Files'] — never 'Sales', 'Request Type',
      // 'Co Worker', or anything else.
      expect(put.fieldKeys).toEqual(["Sales Files"]);
      expect(put.fieldKeys).not.toContain("Sales");
      expect(put.fieldKeys).not.toContain("Request Type");
    }
  });

  it("the attachment fill never writes the Feishu-owned 'Request Type' column on ANY write", async () => {
    const intake = harness.makeIntake({ attachmentCount: 3 });
    await harness.submit(intake);
    await harness.driveToCompletion();

    // Across the entire conversation — create + Sales patch + all fill PUTs —
    // 'Request Type' must NEVER appear (ADR-0012/0022 hard rule).
    for (const c of harness.feishu.createLog) {
      expect(Object.keys(c.fields)).not.toContain("Request Type");
    }
    for (const p of harness.feishu.putLog) {
      expect(p.fieldKeys).not.toContain("Request Type");
    }
  });

  it("the row is created with an EMPTY Sales Files cell (the fill, not create, pends tokens)", async () => {
    const intake = harness.makeIntake({ attachmentCount: 3 });
    await harness.submit(intake);

    // Run only the create worker (markSucceeded kicks the fill, but stop before
    // the fill itself runs) to inspect the just-created row's cell.
    // processPendingBitableSync + markBitableSyncSucceeded run in round 1; the
    // fill it schedules runs in round 2. We snapshot the create payload itself.
    await harness.driveToCompletion();

    const create = harness.feishu.createLog.find((c) => !c.deduped)!;
    // The ADR-0027 path stages sources and fills AFTER create — the create
    // payload must NOT carry the legacy 'Sales Files' write.
    expect(Object.keys(create.fields)).not.toContain("Sales Files");
  });
});

// =====================================================================
// (5) Dedup short-circuit: re-submitting the same conversation returns
//     the existing row, creates no 2nd row, does not double the cell.
// =====================================================================
describe("dedup short-circuit on re-submit", () => {
  it("re-submitting the same conversation returns synced w/ the existing row, no 2nd row, cell unchanged", async () => {
    const intake = harness.makeIntake({ attachmentCount: 3 });

    // First send drives to a fully-filled row.
    const first = await harness.submit(intake);
    expect(first).toEqual({ status: "pending", recordId: null, detailUrl: null });
    await harness.driveToCompletion();

    const recordId = harness.feishu.recordIds()[0];
    const cellAfterFirst = harness.feishu.salesFilesTokens(recordId);
    expect(cellAfterFirst).toHaveLength(3);
    const createsAfterFirst = harness.feishu.createLog.filter((c) => !c.deduped).length;
    const sfPutsAfterFirst = harness.feishu.salesFilesPuts().length;

    // Re-submit the SAME intake (same userEmail + conversationId => same
    // requestSyncKey). beginBitableSync finds the existing bitableRecordId and
    // short-circuits: syncRequest returns {status:'synced', recordId}.
    const second = await harness.submit(intake);
    expect(second).toEqual({
      status: "synced",
      recordId,
      detailUrl: expect.anything(),
    });

    // No work was scheduled by the dedup path.
    const drive = await harness.driveToCompletion();
    expect(drive.ranJobs).toBe(0);

    // No SECOND real row, no extra fill PUT, the cell is byte-for-byte unchanged.
    expect(harness.feishu.recordIds()).toHaveLength(1);
    expect(harness.feishu.createLog.filter((c) => !c.deduped).length).toBe(createsAfterFirst);
    expect(harness.feishu.salesFilesPuts().length).toBe(sfPutsAfterFirst);
    expect(harness.feishu.salesFilesTokens(recordId)).toEqual(cellAfterFirst);
    expect(harness.feishu.salesFilesTokens(recordId)).toHaveLength(3); // not doubled to 6
  });

  it("dedup re-submit MID-FILL (row created, fill parked in-flight) spawns no 2nd row or 2nd fill", async () => {
    const intake = harness.makeIntake({ attachmentCount: 4 });

    // Send/confirm: enqueues the create worker (processPendingBitableSync).
    await harness.submit(intake);

    // Park ALL uploads mid-flight so the very first fill wave hangs after the row
    // exists but before any token is persisted. This is a genuine "row created,
    // attachments not yet done" window — not a harness artifact.
    const { release } = harness.feishu.gateUploads();

    // Drive in the BACKGROUND: create + markSucceeded run, then the fill enters
    // its first wave and blocks on the gate. Do NOT await — it cannot finish yet.
    const driving = harness.driveToCompletion();
    // Flush the synchronous create + markSucceeded + the fill's pre-upload steps.
    await vi.advanceTimersByTimeAsync(0);

    const record = harness.getByMessageId(intake.internetMessageId)!;
    expect(record.bitableRecordId).toBeTruthy();
    const recordId = record.bitableRecordId as string;
    // The row exists but the cell is still empty (fill is parked pre-persist).
    expect(harness.feishu.salesFilesTokens(recordId)).toEqual([]);

    // Re-submit MID-FILL: begin sees the existing bitableRecordId and
    // short-circuits to `synced` WITHOUT scheduling another create or fill.
    const second = await harness.submit(intake);
    expect(second).toMatchObject({ status: "synced", recordId });

    // The re-submit queued no new fill (only the in-flight one remains, which is
    // already popped off the queue and running).
    expect(
      harness
        .pendingJobs()
        .filter((j) => j.refName === "feishu/requestSync:fillRowAttachments").length,
    ).toBe(0);

    // Release the parked uploads and let the single fill finish.
    release();
    await driving;
    await harness.driveToCompletion();

    // Exactly ONE row, 4 distinct tokens, none double-minted by the re-submit.
    expect(harness.feishu.recordIds()).toHaveLength(1);
    expect(harness.feishu.salesFilesTokens(recordId)).toHaveLength(4);
    for (const s of intake.attachmentSources ?? []) {
      expect(harness.feishu.mintedTokensFor(s.fileName)).toHaveLength(1);
    }
  });
});
