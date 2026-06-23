import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import type { AttachmentSource } from "../emailRecord";
import { mintOneStagedSource } from "./drive";
import { errorMessage } from "./requestSyncCore";

export type AttachmentFillTotals = { filled: number; skipped: number; deferred: number };

type AttachmentFillState = {
  remainingSources: AttachmentSource[];
  bitableRecordId?: string | null;
  bitableAttachmentStatus?: string | null;
};

// One wave of the deferred Attachment Fill: mint `concurrency` staged sources
// concurrently, persist the minted tokens + skipped names BEFORE deleting the
// staged blobs (upload_all is not idempotent), then coalesce into ONE cumulative
// Sales Files PUT (fenced). Returns running totals plus whether a transient
// deferral was hit (caller stops and reschedules).
async function processAttachmentFillWave(
  ctx: ActionCtx,
  batch: AttachmentSource[],
  lookup: { internetMessageId: string; requestSyncKey?: string },
  creds: { appToken: string; tenantToken: string },
): Promise<{ filled: number; skipped: number; deferred: number }> {
  const outcomes = await Promise.all(
    batch.map((s) => mintOneStagedSource(ctx, s, creds)),
  );
  const minted = outcomes.flatMap((o) => (o.kind === "minted" ? [o] : []));
  const skippedNow = outcomes.flatMap((o) => (o.kind === "skipped" ? [o] : []));
  const deferredNow = outcomes.flatMap((o) => (o.kind === "deferred" ? [o] : []));
  if (minted.length > 0 || skippedNow.length > 0) {
    // Persist BEFORE deleting the staged blobs.
    await ctx.runMutation(internal.emails.recordAttachmentProgress, {
      ...lookup,
      mintedTokens: minted.map((m) => m.fileToken),
      skippedNames: skippedNow.map((s) => s.fileName),
      completedStorageIds: [...minted, ...skippedNow].map((o) => o.storageId),
    });
    await Promise.all(
      minted.map((m) => ctx.storage.delete(m.storageId as Id<"_storage">).catch(() => {})),
    );
    await ctx.runAction(internal.feishu.bitable.patchRowAttachments, lookup);
  }
  return { filled: minted.length, skipped: skippedNow.length, deferred: deferredNow.length };
}

// Drive the remaining staged sources in waves of `concurrency` (bounded ≤5 under
// the 5 QPS budget). Stops early on the first transient deferral so the caller
// can reschedule. Surfaces a captured error message instead of throwing.
export async function runAttachmentFillWaves(
  ctx: ActionCtx,
  state: AttachmentFillState,
  lookup: { internetMessageId: string; requestSyncKey?: string },
  creds: { appToken: string; tenantToken: string },
  concurrency: number,
): Promise<AttachmentFillTotals & { lastError: string | null }> {
  let filled = 0;
  let skipped = 0;
  let deferred = 0;
  let lastError: string | null = null;
  try {
    for (let i = 0; i < state.remainingSources.length; i += concurrency) {
      const batch = state.remainingSources.slice(i, i + concurrency);
      // waves are sequential by design: one coalesced cumulative PUT per wave (ADR-0027)
      // eslint-disable-next-line no-await-in-loop, react-doctor/async-await-in-loop -- deliberate serialisation; ordered persist -> delete -> PUT is a correctness invariant
      const waveTotals = await processAttachmentFillWave(ctx, batch, lookup, creds);
      filled += waveTotals.filled;
      skipped += waveTotals.skipped;
      deferred += waveTotals.deferred;
      // transient — stop and reschedule
      if (waveTotals.deferred > 0) break;
    }
  } catch (e: unknown) {
    lastError = errorMessage(e);
  }
  return { filled, skipped, deferred, lastError };
}
