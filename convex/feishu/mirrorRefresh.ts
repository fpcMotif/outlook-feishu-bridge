// The Mirror Refresh engine — the ONE place the mirror-refresh lifecycle is
// sequenced for every Feishu read-model mirror (the Customer Mirror and the
// Feishu Contacts Mirror today). PURE orchestration behind a port (the
// ADR-0019 seam): crawl → completeness verdict → gated write → the
// all-or-nothing prune gate → finish/watermark. No ctx, no db, no I/O — the
// Convex adapters (customersMirror.ts, contactsMirror.ts) supply the effectful
// port; tests pass an in-memory fake (mirrorRefresh.test.ts).
//
// Invariants the engine owns (formerly implemented separately, in divergent
// shapes, by customersMirror.runFullSync and contactsMirrorSync):
//   - NEVER bulk-write an assembled crawl, and NEVER prune, unless the crawl's
//     verdict is "complete" — a partial walk must not tombstone live rows
//     that simply were not paged this run (ADR-0021 / ADR-0023).
//   - EMPTY-SOURCE GUARD: a crawl that claims "complete" with an EMPTY
//     seen-set is downgraded to the "emptySource" failure verdict. Pruning
//     against an empty liveness set would tombstone the ENTIRE mirror; an
//     empty directory/table is treated as an upstream anomaly (scope or
//     data-range regression), never as a reason to wipe the read model.
//   - finish() runs on EVERY path (complete, partial, emptySource), so the
//     adapter can stamp a failure watermark; throwing on a failed run stays
//     adapter business, which keeps the engine itself non-throwing.
//
// Two write policies, one engine: an ASSEMBLED crawl (Contacts — the directory
// has no global `total`, so the whole org is gathered in memory first) returns
// `assembledRows` and the engine writes them only after the verdict; a
// STREAMED crawl (Customer — upserts each page as it walks, which is safe
// because upserts are idempotent and only the prune deletes) omits
// `assembledRows` and the engine's write phase is a no-op.

export interface MirrorWriteTotals {
  inserted: number;
  updated: number;
  unchanged: number;
}

export interface MirrorPruneTotals {
  scanned: number;
  deleted: number;
}

export function zeroWriteTotals(): MirrorWriteTotals {
  return { inserted: 0, updated: 0, unchanged: 0 };
}

export function zeroPruneTotals(): MirrorPruneTotals {
  return { scanned: 0, deleted: 0 };
}

// The engine-issued failure verdict for a "complete" crawl with an empty
// seen-set. Lives beside the adapters' own stop reasons on the watermark.
export const EMPTY_SOURCE = "emptySource" as const;

// What every crawl must report back, whatever its walk shape: the adapter's
// own completeness verdict ("complete" is the only success), the liveness set
// for the prune, and — for assembled crawls only — the rows to write behind
// the completeness gate.
export interface MirrorCrawl<Row, Reason extends string> {
  stopReason: Reason;
  seenKeys: ReadonlySet<string>;
  assembledRows?: readonly Row[];
}

export interface MirrorRefreshOutcome<Crawl, Reason extends string> {
  crawl: Crawl;
  mirroredAt: number;
  // The final verdict: the crawl's own stop reason, or "emptySource" when the
  // engine downgraded an empty-but-"complete" crawl.
  stopReason: Reason | typeof EMPTY_SOURCE;
  complete: boolean;
  // Gated-write totals; zeros for streamed crawls (their write totals travel
  // inside the adapter's Crawl type) and for failed runs.
  writes: MirrorWriteTotals;
  prune: MirrorPruneTotals;
}

// The seam: every effectful op a refresh needs. `write` is only required when
// the crawl is assembled (returns assembledRows); the engine never calls
// `tombstone` on a failed run.
export interface MirrorRefreshPort<Row, Reason extends string, Crawl extends MirrorCrawl<Row, Reason>, R> {
  crawl: () => Promise<Crawl>;
  write?: (rows: readonly Row[], mirroredAt: number) => Promise<MirrorWriteTotals>;
  tombstone: (seenKeys: ReadonlySet<string>) => Promise<MirrorPruneTotals>;
  finish: (outcome: MirrorRefreshOutcome<Crawl, Reason>) => Promise<R>;
}

// Drive one full Mirror Refresh through the injected port. Returns whatever
// finish produces; the adapter decides whether a failed run throws.
export async function runMirrorRefresh<
  Row,
  Reason extends string,
  Crawl extends MirrorCrawl<Row, Reason>,
  R,
>(
  port: MirrorRefreshPort<Row, Reason, Crawl, R>,
  options: { startedAt: number; label: string },
): Promise<R> {
  const mirroredAt = options.startedAt;
  const crawl = await port.crawl();
  const emptySource = crawl.stopReason === "complete" && crawl.seenKeys.size === 0;
  if (emptySource) {
    console.error(
      `[${options.label}] EMPTY SOURCE: crawl reported complete with zero seen keys — ` +
        `refusing to write/prune (an empty seen-set would tombstone the whole mirror); failing the run`,
    );
  }
  const stopReason = emptySource ? EMPTY_SOURCE : crawl.stopReason;
  // Completeness gate: a partial (or empty-source) crawl is handed to finish
  // WITHOUT writing or pruning, so the mirror and its liveness are untouched.
  if (stopReason !== "complete") {
    return port.finish({
      crawl,
      mirroredAt,
      stopReason,
      complete: false,
      writes: zeroWriteTotals(),
      prune: zeroPruneTotals(),
    });
  }
  let writes = zeroWriteTotals();
  if (crawl.assembledRows) {
    if (!port.write) {
      throw new Error(`[${options.label}] crawl returned assembledRows but the port has no write()`);
    }
    writes = await port.write(crawl.assembledRows, mirroredAt);
  }
  const prune = await port.tombstone(crawl.seenKeys);
  return port.finish({ crawl, mirroredAt, stopReason, complete: true, writes, prune });
}

// --- Shared page-pacing helpers ----------------------------------------------
// 20 requests/sec is Feishu's documented ceiling; both mirrors pace page
// requests with the same throttle math (~60ms apart). Pure so it is testable.

export function pageSlotWaitMs(
  previousRequestStartedAt: number,
  minIntervalMs: number,
  now: number,
): number {
  if (previousRequestStartedAt === 0) return 0;
  return minIntervalMs - (now - previousRequestStartedAt);
}

export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
