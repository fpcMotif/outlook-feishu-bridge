// The Attachment Fill engine (ADR-0027) — the ONE place the deferred fill's
// lifecycle is sequenced. PURE orchestration behind a port (the ADR-0019 seam,
// same shape as the Mirror Refresh engine in mirrorRefresh.ts): read state →
// early-exit fences → wave loop (mint → persist → delete → cumulative PUT) →
// fence `filled` or arm the bounded retry. No ctx, no db, no I/O — the Convex
// adapter (requestSync.fillRowAttachments) supplies the effectful port; tests
// drive the engine against an in-memory fake (attachmentFillEngine.test.ts),
// and the attachmentFillSim harness keeps covering the real adapter end to end.
//
// Invariants the engine owns (ADR-0027):
//   - PERSIST-BEFORE-DELETE: a wave's minted tokens are persisted to the Email
//     Record BEFORE their staged blobs are deleted — Drive upload_all is not
//     idempotent, so a crash must replay only the still-un-minted tail.
//   - COALESCED CUMULATIVE PUT: waves are sequential; each wave ends in one
//     cumulative Sales Files PUT, so no two PUTs to one row ever race.
//   - DEFERRED-BREAK: a transient (deferred) mint stops the loop — the rest of
//     the tail is retried later rather than hammered now.
//   - Blob deletion is best-effort: a failed delete never fails the fill (the
//     token is already persisted; the blob at worst leaks until GC).
//   - Failure arms the bounded retry only when the failure planner returns a
//     numeric delay; the undefined/null sentinel is terminal.
//   - prepare() runs OUTSIDE the failure path: a config error (missing env)
//     propagates to the caller instead of consuming a bounded-retry attempt.

export interface StagedSource {
  storageId: string;
  fileName: string;
}

// Structurally identical to drive.ts's StagedSourceOutcome — declared here so
// the engine stays pure (no imports from Convex-coupled modules).
export type MintOutcome =
  | { kind: "minted"; fileToken: string; storageId: string; fileName: string }
  // Permanent per-file failure (dead/GC'd source, >20 MB): never retried.
  | { kind: "skipped"; fileName: string; storageId: string }
  // Transient (rate-limit storm beyond retry, network): kept for the retry.
  | { kind: "deferred"; fileName: string; storageId: string };

// What the engine reads off the Email Record each pass (a structural subset of
// emails.getAttachmentFillState's return).
export interface AttachmentFillState {
  bitableRecordId: string | null;
  bitableAttachmentStatus: string | null;
  remainingSources: readonly StagedSource[];
}

export interface AttachmentFillTotals {
  filled: number;
  skipped: number;
  deferred: number;
}

export interface AttachmentFillProgress {
  mintedTokens: string[];
  skippedNames: string[];
  completedStorageIds: string[];
}

// The seam: every effectful op one fill pass needs. The prod adapter wires
// these to Convex/Feishu (requestSync.ts); tests pass an in-memory fake.
export interface AttachmentFillPort {
  /** Current fill state, or null when the Email Record is gone. */
  getState: () => Promise<AttachmentFillState | null>;
  /**
   * Resolve config/tokens once, after the early exits and before any wave.
   * Throws propagate to the caller (config errors are not retried as fills).
   */
  prepare: () => Promise<{ concurrency: number }>;
  /** Mint one staged source's Drive file_token (classifies its own failures). */
  mint: (source: StagedSource) => Promise<MintOutcome>;
  /** Persist one wave's outcome — MUST land before the blobs are deleted. */
  recordProgress: (progress: AttachmentFillProgress) => Promise<void>;
  /** Delete one consumed staged blob. The engine swallows failures. */
  deleteStagedBlob: (storageId: string) => Promise<void>;
  /** One coalesced cumulative Sales Files PUT (fenced inside the adapter). */
  patchRow: () => Promise<void>;
  /** Fence the fill `filled` (terminal success). */
  markFilled: () => Promise<void>;
  /** Record the failure; returns the bounded-retry delay or null (terminal). */
  markFailed: (reason: string) => Promise<{ retryDelayMs: number | null } | null>;
  /** Arm the next fill attempt after the planner's delay. */
  scheduleRetry: (delayMs: number) => Promise<void>;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const ZERO_TOTALS: AttachmentFillTotals = { filled: 0, skipped: 0, deferred: 0 };

/**
 * Drive one Attachment Fill pass through the injected port: process the
 * REMAINING staged sources in waves of `concurrency` — each wave mints
 * concurrently, persists tokens BEFORE deleting blobs, then coalesces into ONE
 * cumulative PUT. A deferred (transient) mint breaks the loop and arms the
 * bounded retry; a clean pass fences `filled`.
 */
export async function runAttachmentFill(port: AttachmentFillPort): Promise<AttachmentFillTotals> {
  const state = await port.getState();
  if (!state || !state.bitableRecordId || state.bitableAttachmentStatus === "filled") {
    return { ...ZERO_TOTALS };
  }
  if (state.remainingSources.length === 0) {
    await port.markFilled();
    return { ...ZERO_TOTALS };
  }
  const { concurrency } = await port.prepare();

  const totals: AttachmentFillTotals = { ...ZERO_TOTALS };
  let lastError: string | null = null;
  try {
    for (let i = 0; i < state.remainingSources.length; i += concurrency) {
      const batch = state.remainingSources.slice(i, i + concurrency);
      // eslint-disable-next-line no-await-in-loop, react-doctor/async-await-in-loop -- waves are sequential by design: one coalesced cumulative PUT per wave (ADR-0027)
      const outcomes = await Promise.all(batch.map((source) => port.mint(source)));
      const minted = outcomes.flatMap((o) => (o.kind === "minted" ? [o] : []));
      const skippedNow = outcomes.flatMap((o) => (o.kind === "skipped" ? [o] : []));
      const deferredNow = outcomes.flatMap((o) => (o.kind === "deferred" ? [o] : []));
      totals.filled += minted.length;
      totals.skipped += skippedNow.length;
      totals.deferred += deferredNow.length;
      if (minted.length > 0 || skippedNow.length > 0) {
        // Persist BEFORE deleting the staged blobs.
        // eslint-disable-next-line no-await-in-loop, react-doctor/async-parallel -- ordered persist -> delete -> PUT is a correctness invariant, NOT independent work
        await port.recordProgress({
          mintedTokens: minted.map((m) => m.fileToken),
          skippedNames: skippedNow.map((s) => s.fileName),
          completedStorageIds: [...minted, ...skippedNow].map((o) => o.storageId),
        });
        // eslint-disable-next-line no-await-in-loop -- delete consumed blobs after persist
        await Promise.all(
          minted.map((m) => port.deleteStagedBlob(m.storageId).catch(() => {})),
        );
        // eslint-disable-next-line no-await-in-loop -- coalesced cumulative PUT for this wave
        await port.patchRow();
      }
      if (deferredNow.length > 0) {
        // Transient — stop and reschedule.
        break;
      }
    }
  } catch (e: unknown) {
    lastError = errorMessage(e);
  }

  if (totals.deferred > 0 || lastError) {
    const reason = lastError ?? `${totals.deferred} attachment(s) deferred (transient Drive failure)`;
    const outcome = await port.markFailed(reason);
    if (typeof outcome?.retryDelayMs === "number") {
      await port.scheduleRetry(outcome.retryDelayMs);
    }
  } else {
    await port.markFilled();
  }
  return totals;
}
