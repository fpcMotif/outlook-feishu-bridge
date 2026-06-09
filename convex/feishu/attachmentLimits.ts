// Server half of the attachment-count single source of truth (ADR-0022 / ADR-0027).
//
// The client reducer (src/office/attachments.ts MAX_ATTACHMENT_COUNT) is the
// primary gate, but `syncRequest` is the public, internet-facing action and its
// validator only checks the SHAPE of `attachmentSources`/`attachments`, never the
// array LENGTH — a crafted or buggy client could submit an unbounded batch and
// fan out a 5 QPS Drive storm in the deferred fill. This guard rejects an
// over-cap batch BEFORE any Base row is created.
//
// Same default as the client (10), overridable for the upload-latency experiment
// via the ATTACHMENT_CAP Convex env var (mirror of the client VITE_ATTACHMENT_CAP).
// Read at call time because Convex env is live.

export const DEFAULT_ATTACHMENT_CAP = 10;

export function attachmentCap(): number {
  const raw = process.env.ATTACHMENT_CAP;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : DEFAULT_ATTACHMENT_CAP;
}

/**
 * Throw when the combined staged + legacy attachment count exceeds the cap. Pure
 * (cap injectable) so it unit-tests without touching process.env (ADR-0019 seam).
 * Counts both `attachmentSources` (the ADR-0027 staged-blob path) and legacy
 * `attachments` (pre-minted Drive tokens) because both land in the one Sales
 * Files cell.
 */
export function assertWithinAttachmentCap(
  counts: {
    attachmentSources?: readonly unknown[];
    attachments?: readonly unknown[];
  },
  cap: number = attachmentCap(),
): void {
  const total =
    (counts.attachmentSources?.length ?? 0) + (counts.attachments?.length ?? 0);
  if (total > cap) {
    throw new Error(`Too many attachments: ${total} exceeds the ${cap}-file cap`);
  }
}
