/* eslint-disable max-lines-per-function */
// Adversarial integration suite — FAMILY "compat":
//   Legacy attachments + sources duplication, and begin re-attempt wipe.
//   Weak points #4 (legacy double-attachment) and #5 (begin re-attempt wipes
//   minted tokens / double-counts sources).
//
// Built on the EXISTING simulation harness (convex/feishu/attachmentFillSim).
// Drives the REAL pipeline handlers (syncRequest -> processPendingBitableSync ->
// markBitableSyncSucceeded -> fillRowAttachments -> patchRowAttachments, and the
// real beginBitableSync) through the harness dispatcher. We mock ONLY the I/O
// boundary (./call + ../storage) per the seam in drive.test.ts; we never mock
// ./drive, ./bitable, ../emails, ./requestSync, ./attachmentFill, ./serviceRow,
// or ./bitableSyncRetry, and never re-implement pipeline logic here.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 1. Hoisted holder the two mocked modules delegate through (so each test's
//    fresh harness owns the sim/storage the real handlers reach).
const mocks = vi.hoisted(() => ({
  callFeishu: async (..._args: unknown[]): Promise<unknown> => {
    throw new Error("harness not wired: callFeishu");
  },
  resolveFeishuToken: async (..._args: unknown[]): Promise<string> => "tenant-token",
  getStorageBytes: async (..._args: unknown[]): Promise<ArrayBuffer> => {
    throw new Error("harness not wired: getStorageBytes");
  },
}));

// 2. Mock ONLY the I/O boundary (paths relative to this test file). Preserve the
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

// 3. Import the harness AFTER the mocks.
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

// ===========================================================================
// WEAK POINT #4 — Backward-compat duplication.
//
// `intakeArgs` accepts BOTH legacy `attachments` ([{ fileToken }], written onto
// the row's `Sales Files` cell at CREATE by buildServiceCreateFields) AND new
// `attachmentSources` (minted + PUT after, by the deferred fill). There is no
// mutual-exclusion guard. When an intake carries both, the create writes the
// legacy tokens onto `Sales Files`, then the fill PUTs the minted tokens onto
// the SAME cell.
//
// Owner invariant (c): every source ends as a token on the row, NEVER
// duplicated. The legacy tokens are ALSO meant to be on the row (they are the
// pre-minted form of the same files). So the safe outcome is: the cell holds
// each file exactly once. We characterize what the real pipeline actually does.
// ===========================================================================
describe("weak point #4 — legacy attachments + attachmentSources on one intake", () => {
  it("characterizes the Sales Files cell when both legacy + sources are present (overwrite vs union)", async () => {
    // Intake carries BOTH a legacy pre-minted token AND two staged sources.
    const intake = harness.makeIntake({
      attachmentCount: 2,
      overrides: { attachments: [{ fileToken: "LEGACY_TOKEN_A" }] },
    });

    await harness.submit(intake);
    await harness.driveToCompletion();

    const recordId = harness.feishu.recordIds()[0];
    expect(recordId).toBeDefined();

    // The CREATE wrote the legacy token onto Sales Files (buildServiceCreateFields).
    const create = harness.feishu.createLog.find((c) => !c.deduped)!;
    const createdCell = create.fields["Sales Files"];
    expect(Array.isArray(createdCell)).toBe(true);
    expect((createdCell as { file_token: string }[]).map((c) => c.file_token)).toEqual([
      "LEGACY_TOKEN_A",
    ]);

    // The fill minted exactly the two staged sources (no double-mint).
    expect(harness.feishu.mintedCount()).toBe(2);
    const mintedTokens = harness.feishu.uploadLog.map((u) => u.fileToken);

    // The fill PUT only ever carries the MINTED tokens (state.fileTokens =
    // bitableAttachmentFileTokens, which never includes the legacy create token).
    for (const put of harness.feishu.salesFilesPuts()) {
      const tokens = (put.fields["Sales Files"] as { file_token: string }[]).map(
        (c) => c.file_token,
      );
      expect(tokens).not.toContain("LEGACY_TOKEN_A");
    }

    // Final cell = whatever the last write left (sim models a Feishu record
    // update PUT as a full column REPLACE, so the fill PUT overwrote the legacy
    // token entirely). Characterize the observed final cell.
    const finalCell = harness.feishu.salesFilesTokens(recordId);
    expect(new Set(finalCell)).toEqual(new Set(mintedTokens));
    // The legacy token is NOT in the final cell — it was overwritten by the fill.
    expect(finalCell).not.toContain("LEGACY_TOKEN_A");
  });

  // BUG: legacy `attachments` + `attachmentSources` on one intake → the deferred
  // fill PUT overwrites the legacy create-time token, so a file the SPA already
  // pre-minted onto the row is DROPPED. The owner invariant (c) — every source
  // ends as a token on the row, never silently lost — is violated for the legacy
  // file: it lands on CREATE, then vanishes when the fill replaces the cell.
  // Fix sketch (mutual-exclusion): when `attachmentSources` is present, do NOT
  // also pass `attachments` to createServiceRecord (drop the legacy create-time
  // write) so the fill is the single writer; OR carry the legacy tokens into the
  // cumulative `bitableAttachmentFileTokens` seed so the coalesced PUT unions
  // them instead of clobbering. Either way the legacy file must survive.
  it.fails(
    "loses the legacy create-time token when sources are also present (data loss)",
    async () => {
      const intake = harness.makeIntake({
        attachmentCount: 2,
        overrides: { attachments: [{ fileToken: "LEGACY_TOKEN_A" }] },
      });

      await harness.submit(intake);
      await harness.driveToCompletion();

      const recordId = harness.feishu.recordIds()[0];
      const finalCell = harness.feishu.salesFilesTokens(recordId);

      // INVARIANT (c): the legacy file the create already wrote must still be on
      // the row after the fill settles. It is not — the fill PUT clobbered it.
      expect(finalCell).toContain("LEGACY_TOKEN_A");
      // And the cell should hold every file exactly once: 1 legacy + 2 minted.
      expect(finalCell).toHaveLength(3);
    },
  );

  it("refutes pure double-mint: a legacy fileToken is never re-minted by the fill", async () => {
    // Even though both are present, the fill only mints `attachmentSources`; the
    // legacy `attachments` (already a Drive token) is never re-uploaded. So the
    // upload log has no entry for the legacy token and no source is minted twice.
    const intake = harness.makeIntake({
      attachmentCount: 2,
      overrides: { attachments: [{ fileToken: "LEGACY_TOKEN_A" }] },
    });

    await harness.submit(intake);
    await harness.driveToCompletion();

    expect(harness.feishu.mintedCount()).toBe(2);
    for (const src of intake.attachmentSources ?? []) {
      // No staged source minted more than once.
      expect(harness.feishu.mintedTokensFor(src.fileName)).toHaveLength(1);
    }
    // The legacy token was never sent through upload_all.
    expect(harness.feishu.uploadLog.map((u) => u.fileToken)).not.toContain("LEGACY_TOKEN_A");
  });
});

// ===========================================================================
// WEAK POINT #5 — begin re-attempt wipe.
//
// beginBitableSync, for an EXISTING record that has NO bitableRecordId yet,
// patches recordFields which (a) sets bitableAttachmentFileTokens = undefined
// (a HARD WIPE of any minted tokens) and (b) resets bitableAttachmentSources to
// the re-submit's FULL source set. We construct a partially-minted state on a
// not-yet-created row (the documented partial-mint shape) and re-run the REAL
// beginBitableSync via a second submit on the same record.
// ===========================================================================
describe("weak point #5 — begin re-attempt wipes minted tokens / resets sources", () => {
  // Helper: directly mint the partial state the spec asks for — some sources
  // already minted into bitableAttachmentFileTokens, some still remaining, NO
  // bitableRecordId, status 'failed' (a stranded re-sync). This is the on-disk
  // shape the pipeline can reach (e.g. a fill that minted before its sync mark
  // was reverted), exercised against the REAL begin handler on re-submit.
  function partiallyMint(
    intake: ReturnType<Harness["makeIntake"]>,
    mintedTokens: string[],
    remaining: { storageId: string; fileName: string }[],
  ): void {
    const rec = harness.getByMessageId(intake.internetMessageId)!;
    // Use the FakeDb escape hatch to install the documented partial-mint state.
    void harness.db.patch(rec._id, {
      bitableSyncStatus: "failed",
      bitableRecordId: undefined,
      bitableAttachmentStatus: "filling",
      bitableAttachmentFileTokens: mintedTokens,
      bitableAttachmentSources: remaining,
      attachmentAttemptCount: 1,
    });
  }

  // BUG: beginBitableSync on a re-attempt (existing record, no bitableRecordId)
  // sets `bitableAttachmentFileTokens: undefined` — a HARD WIPE of tokens the
  // fill already minted into Drive. Drive upload_all is NOT idempotent, so the
  // wiped tokens reference Drive blobs that are now orphaned and will be re-
  // minted (duplicate Drive uploads) when the fill re-runs against the reset
  // full source set. Owner invariant (c): a minted token must end on the row,
  // never silently discarded. The wipe discards them.
  // Fix sketch: in beginBitableSync, do NOT blanket-wipe
  // bitableAttachmentFileTokens on a re-attempt; PRESERVE already-minted tokens
  // (existing.bitableAttachmentFileTokens) and only re-arm the REMAINING
  // (un-minted) sources — i.e. set bitableAttachmentSources to the un-minted
  // tail, not the full re-submit set, and keep the minted-token accumulator.
  it.fails(
    "preserves already-minted tokens across a re-attempt begin (no wipe)",
    async () => {
      // First send/confirm: arms the attachment lifecycle.
      const intake = harness.makeIntake({ attachmentCount: 3 });
      await harness.submit(intake);
      // Do NOT drive the create; install the partial-mint state directly.
      const minted = ["boxcn_already_1", "boxcn_already_2"];
      const remaining = [(intake.attachmentSources ?? [])[2]];
      partiallyMint(intake, minted, remaining);

      // Re-attempt: re-submit the SAME intake -> real beginBitableSync runs.
      await harness.submit(intake);

      const after = harness.getByMessageId(intake.internetMessageId)!;
      // INVARIANT (c): the two already-minted tokens must survive the re-attempt.
      expect(after.bitableAttachmentFileTokens ?? []).toEqual(minted);
    },
  );

  // BUG: the same re-attempt resets bitableAttachmentSources to the re-submit's
  // FULL set (all 3), even though one source was already minted and dropped from
  // the remaining list. Combined with the token wipe above, the fill will re-
  // mint EVERY source on the next run, double-uploading the already-minted files
  // to Drive (a leak + duplicate Drive blobs) instead of finishing only the
  // un-minted tail. Owner invariant (c): never duplicated.
  // Fix sketch: re-arm only the REMAINING (un-minted) sources on a re-attempt,
  // i.e. preserve existing.bitableAttachmentSources rather than overwriting with
  // the full args.bitableAttachmentSources.
  it.fails(
    "re-arms only the un-minted tail, not the full source set, on a re-attempt",
    async () => {
      const intake = harness.makeIntake({ attachmentCount: 3 });
      await harness.submit(intake);
      const minted = ["boxcn_already_1", "boxcn_already_2"];
      const remaining = [(intake.attachmentSources ?? [])[2]];
      partiallyMint(intake, minted, remaining);

      await harness.submit(intake);

      const after = harness.getByMessageId(intake.internetMessageId)!;
      const remainingAfter = (after.bitableAttachmentSources ?? []) as {
        storageId: string;
        fileName: string;
      }[];
      // INVARIANT (c): only the single un-minted source should remain armed.
      expect(remainingAfter.map((s) => s.storageId)).toEqual(
        remaining.map((s) => s.storageId),
      );
    },
  );

  it("characterizes the actual post-re-attempt state: tokens wiped, sources fully reset", async () => {
    // A PASSING characterization of the real (buggy) behavior so the wipe is
    // pinned even before the it.fails above flip green: begin DOES wipe the
    // minted accumulator and DOES reset to the full source set.
    const intake = harness.makeIntake({ attachmentCount: 3 });
    await harness.submit(intake);
    const fullSources = (intake.attachmentSources ?? []).map((s) => ({ ...s }));
    const minted = ["boxcn_already_1", "boxcn_already_2"];
    const remaining = [fullSources[2]];
    partiallyMint(intake, minted, remaining);

    // Sanity: the partial state is installed as described.
    const before = harness.getByMessageId(intake.internetMessageId)!;
    expect(before.bitableAttachmentFileTokens).toEqual(minted);
    expect((before.bitableAttachmentSources as unknown[]).length).toBe(1);

    await harness.submit(intake);

    const after = harness.getByMessageId(intake.internetMessageId)!;
    // The minted-token accumulator was WIPED to undefined (deleted).
    expect(after.bitableAttachmentFileTokens).toBeUndefined();
    // The remaining sources were RESET back to the full re-submit set (all 3),
    // so the already-minted file is re-armed for a duplicate Drive upload.
    const remainingAfter = (after.bitableAttachmentSources ?? []) as {
      storageId: string;
    }[];
    expect(remainingAfter.map((s) => s.storageId).toSorted()).toEqual(
      fullSources.map((s) => s.storageId).toSorted(),
    );
    // Status was re-armed to 'pending' and the row is still not created.
    expect(after.bitableAttachmentStatus).toBe("pending");
    expect(after.bitableRecordId).toBeUndefined();
  });

  it("end-to-end: a wiped re-attempt that then drives to completion RE-MINTS the already-minted file", async () => {
    // Compose the wipe with the real fill to show the observable consequence:
    // the file already minted before the re-attempt is uploaded to Drive AGAIN.
    const intake = harness.makeIntake({ attachmentCount: 2 });
    await harness.submit(intake);
    const sources = (intake.attachmentSources ?? []).map((s) => ({ ...s }));

    // Pretend source[0] was already minted on a prior pass (token + dropped from
    // remaining), source[1] still pending — but NO bitableRecordId yet (failed).
    partiallyMint(intake, ["boxcn_already_for_file0"], [sources[1]]);

    // Re-attempt begin wipes tokens + resets sources to BOTH files.
    await harness.submit(intake);

    // Now let the create + fill run to completion against the reset state.
    await harness.driveToCompletion();

    const recordId = harness.feishu.recordIds()[0];
    expect(recordId).toBeDefined();

    // INVARIANT (c) — characterization: BOTH files were minted in this run,
    // including file[0] which had already been minted before the re-attempt.
    // That is a duplicate Drive upload of an already-minted file (the wipe's
    // observable cost). We pin it as the real behavior.
    expect(harness.feishu.mintedTokensFor(sources[0].fileName)).toHaveLength(1);
    expect(harness.feishu.mintedTokensFor(sources[1].fileName)).toHaveLength(1);
    // The prior token ("boxcn_already_for_file0") never made it onto the row —
    // it was wiped before any PUT, so the cell holds only the freshly re-minted
    // tokens, and the earlier Drive upload is orphaned.
    const finalCell = harness.feishu.salesFilesTokens(recordId);
    expect(finalCell).not.toContain("boxcn_already_for_file0");
    expect(finalCell).toHaveLength(2);
  });
});
