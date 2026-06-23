// Deferred attachment-fill policy (ADR-0022 amendment). After the Service row is
// created with an EMPTY `Sales Files` cell, a separate per-task chain mints Feishu
// Drive tokens and PATCHES them onto that same row. This module holds the pure,
// unit-tested guards that keep the deferred patch inside the ADR-0012/0022
// envelope: we may update ONLY a row this flow minted (provenance) and only while
// it is fresh (never an ancient/historical row), and we only ever re-arm a fill
// that is genuinely stranded.
import { isBitableSyncDue, STALE_PENDING_REARM_GRACE_MS } from "./bitableSyncRetry";

/**
 * Default freshness window for updating a self-minted Bitable row, in ms.
 * NEVER inline this literal at a call site — it is the single named default,
 * overridden by the `BITABLE_OWNED_ROW_UPDATE_WINDOW_MS` Convex env var.
 */
// 2 h
export const DEFAULT_BITABLE_UPDATE_WINDOW_MS = 2 * 60 * 60 * 1_000;

/** Configurable freshness window: env wins, named default fallback. */
export function bitableUpdateWindowMs(): number {
  const raw = process.env.BITABLE_OWNED_ROW_UPDATE_WINDOW_MS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BITABLE_UPDATE_WINDOW_MS;
}

/**
 * May this flow update the given Bitable row? True ONLY when all hold:
 *  - PROVENANCE: we minted it — we hold its `bitableRecordId` AND the
 *    `bitableClientToken` we created it under (never a foreign/searched id).
 *  - FRESHNESS: it was minted within the (configurable) window — never an
 *    "ancient" row, even one we created.
 * The column-scope rule (only the add-in-owned `Sales Files`, never the
 * Feishu-owned `Request Type`) is enforced at the PUT builder, not here.
 */
export function mayUpdateOwnedBitableRow(
  row: { bitableRecordId?: string; bitableClientToken?: string; bitableRowMintedAt?: number },
  now: number,
  windowMs: number = bitableUpdateWindowMs(),
): boolean {
  // not ours / no provenance
  if (!row.bitableRecordId || !row.bitableClientToken) return false;
  // unknown age → refuse
  if (row.bitableRowMintedAt === undefined) return false;
  // fresh, not ancient
  return now - row.bitableRowMintedAt <= windowMs;
}

/**
 * Should reopening a request re-drive its ATTACHMENT fill? This is the split
 * predicate the create-side rearm can't serve: the row already exists
 * (`bitableRecordId` set — which the create lifecycle treats as fully done), yet
 * its deferred attachment fill is stranded. True only for a created row whose
 * fill is non-terminal (`pending`/`filling`/`failed`, never `filled`) and whose
 * real `attachmentNextRetryAt` is overdue past the grace window. A `filling` row
 * with a FRESH heartbeat is within grace → not re-armed (so an actively-running
 * fill is never double-driven); a `filling` row whose heartbeat went stale (a
 * crashed mid-fill) IS re-armed. The undefined sentinel (terminal/exhausted
 * fill) is never re-armed.
 */
export function shouldRearmAttachmentFill(
  row: {
    bitableRecordId?: string;
    bitableAttachmentStatus?: string;
    attachmentNextRetryAt?: number;
  },
  now: number,
  graceMs: number = STALE_PENDING_REARM_GRACE_MS,
): boolean {
  // row not created yet → create lifecycle's job
  if (!row.bitableRecordId) return false;
  const s = row.bitableAttachmentStatus;
  if (s !== "pending" && s !== "filling" && s !== "failed") {
    // filled / no attachment lifecycle
    return false;
  }
  return isBitableSyncDue(row.attachmentNextRetryAt, now - graceMs);
}

/**
 * Timing snapshot for the deferred fill, computed when the cell fences as
 * `filled`. The headline the upload-latency experiment wants is `totalMs` — the
 * TRUE click-to-fully-written duration the per-Feishu-call logs can't show,
 * because the client pane is long gone by the time the fill fences. All spans are
 * null-safe: an older row (or a submit before this instrumentation shipped) lacks
 * the start stamps, so its spans read null rather than a bogus number.
 *
 * Clocks: `submitClickedAt` is a CLIENT wall clock; everything else is a SERVER
 * wall clock — so `totalMs` carries whatever click-to-receive skew exists between
 * the two machines. At the seconds-to-minutes scale of a Drive fill that skew is
 * noise; `fillMs` (pure server clock) is the exact, skew-free fill duration.
 */
export interface FillTimingRow {
  syncTraceId?: string;
  submitClickedAt?: number;
  syncReceivedAt?: number;
  bitableRowMintedAt?: number;
  bitableAttachmentFileTokens?: readonly string[];
  bitableAttachmentSkipped?: readonly string[];
}

export interface FillTotal {
  traceId: string | null;
  files: number;
  skipped: number;
  /** syncReceived → row minted (the create leg). */
  createMs: number | null;
  /** row minted → filled (the deferred Drive-fill leg, pure server clock). */
  fillMs: number | null;
  /** submit click → filled (end-to-end; crosses client↔server clocks). */
  totalMs: number | null;
  /** One structured log line, sibling to [feishu]/[storage]; grep-able in `bunx convex logs`. */
  line: string;
}

export function buildFillTotal(row: FillTimingRow, filledAt: number): FillTotal {
  const traceId = row.syncTraceId ?? null;
  const files = row.bitableAttachmentFileTokens?.length ?? 0;
  const skipped = row.bitableAttachmentSkipped?.length ?? 0;
  const createMs =
    row.syncReceivedAt !== undefined && row.bitableRowMintedAt !== undefined
      ? row.bitableRowMintedAt - row.syncReceivedAt
      : null;
  const fillMs =
    row.bitableRowMintedAt === undefined ? null : filledAt - row.bitableRowMintedAt;
  const totalMs =
    row.submitClickedAt === undefined ? null : filledAt - row.submitClickedAt;
  const parts = [
    "[fillTotal]",
    `trace=${traceId ?? "-"}`,
    `files=${files}`,
    `skipped=${skipped}`,
  ];
  if (createMs !== null) parts.push(`createMs=${createMs}`);
  if (fillMs !== null) parts.push(`fillMs=${fillMs}`);
  if (totalMs !== null) parts.push(`totalMs=${totalMs}`);
  return { traceId, files, skipped, createMs, fillMs, totalMs, line: parts.join(" ") };
}
