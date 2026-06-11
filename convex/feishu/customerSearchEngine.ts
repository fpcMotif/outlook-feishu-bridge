// The Customer-search engine (ADR-0016 amendment) — the ONE place the
// mirror-first / live-fallback search strategy lives. PURE orchestration behind
// a port (the ADR-0019 seam, same shape as mirrorRefresh.ts and
// attachmentFillEngine.ts): gate → mirror leg → on miss, live leg (which also
// backfills the mirror). No ctx, no db, no I/O — the Convex adapter
// (customersMirror.searchCustomers) supplies the effectful port; tests drive an
// in-memory fake (customerSearchEngine.test.ts).
//
// Why this exists: the SPA used to decide mirror-vs-live itself (two public
// entry points + a client-side miss policy that duplicated the server's
// min-length rule). The strategy now runs server-side; the SPA sees ONE call —
// "query in → records + provenance out" — and keeps only transport concerns
// (request coalescing, empty-result suppression).
//
// Rules the engine owns:
//   - MIN-LENGTH GATE: a too-short query answers empty without touching either
//     leg (the authoritative copy of the rule — any client-side gate is a
//     best-effort round-trip saver, never the contract).
//   - MIRROR FIRST: a mirror hit never pays the live leg (the common, fast case).
//   - LIVE ON MISS: zero mirror hits fall through to the live search, whose
//     adapter also backfills the mirror so the next identical query hits fast.
//   - PROVENANCE: the outcome names which leg answered (`source`), so the SPA
//     can badge live results and logs on both sides join on one verdict.

export interface CustomerSearchPort<R> {
  /** Ranked search over the Customer Mirror's index — fast, possibly stale. */
  mirrorSearch: (
    q: string,
    mineFor?: string,
  ) => Promise<{ records: R[]; mirroredAt: number | null }>;
  /**
   * Live Feishu search with incremental mirror backfill — slow (cross-border),
   * authoritative. Only ever invoked after a mirror miss.
   */
  liveSearch: (q: string, mineFor?: string) => Promise<{ records: R[]; backfilled: number }>;
}

export interface CustomerSearchOutcome<R> {
  records: R[];
  /** Which leg answered: the mirror's index, or the live Feishu fallback. */
  source: "mirror" | "live";
  /** Rows the live leg upserted into the mirror (0 on the mirror leg). */
  backfilled: number;
  /** The Mirror Watermark's last-complete-sync stamp, when the mirror was consulted. */
  mirroredAt: number | null;
}

export async function runCustomerSearch<R>(
  port: CustomerSearchPort<R>,
  args: { q: string; mineFor?: string; minLength: number },
): Promise<CustomerSearchOutcome<R>> {
  const q = args.q.trim();
  if (q.length < args.minLength) {
    return { records: [], source: "mirror", backfilled: 0, mirroredAt: null };
  }
  const mirror = await port.mirrorSearch(q, args.mineFor);
  if (mirror.records.length > 0) {
    return {
      records: mirror.records,
      source: "mirror",
      backfilled: 0,
      mirroredAt: mirror.mirroredAt,
    };
  }
  const live = await port.liveSearch(q, args.mineFor);
  return {
    records: live.records,
    source: "live",
    backfilled: live.backfilled,
    mirroredAt: mirror.mirroredAt,
  };
}
