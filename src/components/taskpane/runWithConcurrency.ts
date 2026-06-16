// Fixed-pool concurrency limiter for the eager intake upload queue (ADR-0027).
//
// Why this exists: dropping ~15 screenshots used to fire ~15 simultaneous
// generateUploadUrl mutations + ~15 simultaneous XHR byte-POSTs to Convex
// storage. Outlook's WebView2/Edge caps concurrent connections per origin (~6,
// fewer behind a corporate proxy), so the overflow connections were reset or
// stalled past the per-attempt timeout and surfaced as the XHR `error` event —
// "Convex storage upload failed (network)". Worse, every file's retry used the
// SAME backoff schedule, so all the retry waves re-stampeded together and failed
// together ("retry, fails again"). Capping concurrency here keeps the pool from
// saturating; the jitter added in uploadBlobWithRetry de-syncs the retries.
//
// Pure + React-free so it stays unit-testable without timers or a real network.

// Headroom under the ~6-per-origin browser/WebView connection cap: leaves room
// for the live Convex subscription socket and the interleaved generateUploadUrl
// mutations, while keeping each upload's share of bandwidth high enough to finish
// inside the 60s per-attempt timeout. Drains 15 files in ~4 waves.
export const UPLOAD_CONCURRENCY = 4;

/**
 * Run `worker` over every item with at most `limit` in flight at once. Items are
 * claimed from a shared cursor BEFORE awaiting, so the pool stays full as workers
 * finish (not lock-stepped into waves). Never rejects: each item's errors are the
 * worker's own concern — a throwing worker drops that item and frees its slot.
 * An empty input resolves immediately with zero worker calls.
 */
export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<unknown>,
): Promise<void> {
  if (items.length === 0) return;
  const poolSize = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;

  const pump = async (): Promise<void> => {
    const index = cursor;
    cursor += 1;
    if (index >= items.length) return;
    try {
      await worker(items[index], index);
    } catch {
      // The worker owns its own failure surface (the upload reducer records the
      // error row); swallow here so one bad item can't reject the whole pool.
    }
    return pump();
  };

  await Promise.all(Array.from({ length: poolSize }, () => pump()));
}
