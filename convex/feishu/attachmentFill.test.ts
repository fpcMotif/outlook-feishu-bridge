import { describe, expect, it } from "vitest";

import { STALE_PENDING_REARM_GRACE_MS } from "./bitableSyncRetry";
import {
  DEFAULT_BITABLE_UPDATE_WINDOW_MS,
  mayUpdateOwnedBitableRow,
  shouldRearmAttachmentFill,
} from "./attachmentFill";

describe("mayUpdateOwnedBitableRow", () => {
  const now = 10_000_000;
  const win = DEFAULT_BITABLE_UPDATE_WINDOW_MS;

  it("allows a fresh row this flow minted (have recordId + clientToken provenance, within window)", () => {
    expect(
      mayUpdateOwnedBitableRow(
        { bitableRecordId: "rec1", bitableClientToken: "tok1", bitableRowMintedAt: now - 1_000 },
        now,
        win,
      ),
    ).toBe(true);
  });

  it("refuses a foreign row whose record_id we never minted (no provenance)", () => {
    expect(
      mayUpdateOwnedBitableRow(
        { bitableRecordId: "rec1", bitableClientToken: undefined, bitableRowMintedAt: now - 1_000 },
        now,
        win,
      ),
    ).toBe(false);
    expect(
      mayUpdateOwnedBitableRow(
        { bitableRecordId: undefined, bitableClientToken: "tok1", bitableRowMintedAt: now - 1_000 },
        now,
        win,
      ),
    ).toBe(false);
  });

  it("refuses an ancient row even one we minted (older than the window)", () => {
    expect(
      mayUpdateOwnedBitableRow(
        { bitableRecordId: "rec1", bitableClientToken: "tok1", bitableRowMintedAt: now - win - 1 },
        now,
        win,
      ),
    ).toBe(false);
  });

  it("refuses when the mint time is unknown (cannot prove freshness)", () => {
    expect(
      mayUpdateOwnedBitableRow(
        { bitableRecordId: "rec1", bitableClientToken: "tok1", bitableRowMintedAt: undefined },
        now,
        win,
      ),
    ).toBe(false);
  });

  it("treats exactly-at-the-window as still fresh (inclusive)", () => {
    expect(
      mayUpdateOwnedBitableRow(
        { bitableRecordId: "rec1", bitableClientToken: "tok1", bitableRowMintedAt: now - win },
        now,
        win,
      ),
    ).toBe(true);
  });
});

describe("shouldRearmAttachmentFill", () => {
  const now = 5_000_000;
  const overdue = now - STALE_PENDING_REARM_GRACE_MS - 1;

  it("re-arms a created row whose attachment fill is stranded pending", () => {
    // The split predicate: the row EXISTS (bitableRecordId set) — which the
    // create-side rearm treats as 'done' — but its attachment fill never
    // finished, so the attachment lifecycle must re-drive it independently.
    expect(
      shouldRearmAttachmentFill(
        { bitableRecordId: "rec1", bitableAttachmentStatus: "pending", attachmentNextRetryAt: overdue },
        now,
      ),
    ).toBe(true);
  });

  it("re-arms a failed-but-retryable fill that went overdue", () => {
    expect(
      shouldRearmAttachmentFill(
        { bitableRecordId: "rec1", bitableAttachmentStatus: "failed", attachmentNextRetryAt: overdue },
        now,
      ),
    ).toBe(true);
  });

  it("never re-arms before the row exists (that is the create lifecycle's job)", () => {
    expect(
      shouldRearmAttachmentFill(
        { bitableRecordId: undefined, bitableAttachmentStatus: "pending", attachmentNextRetryAt: overdue },
        now,
      ),
    ).toBe(false);
  });

  it("never re-arms a completed fill", () => {
    expect(
      shouldRearmAttachmentFill(
        { bitableRecordId: "rec1", bitableAttachmentStatus: "filled", attachmentNextRetryAt: overdue },
        now,
      ),
    ).toBe(false);
  });

  it("does not re-arm a fill already in progress within the grace window", () => {
    expect(
      shouldRearmAttachmentFill(
        { bitableRecordId: "rec1", bitableAttachmentStatus: "filling", attachmentNextRetryAt: now },
        now,
      ),
    ).toBe(false);
  });

  it("does not re-arm while the next attempt is still in the future", () => {
    expect(
      shouldRearmAttachmentFill(
        { bitableRecordId: "rec1", bitableAttachmentStatus: "failed", attachmentNextRetryAt: now + 5 * 60_000 },
        now,
      ),
    ).toBe(false);
  });

  it("never re-arms the terminal (undefined next-retry) fill sentinel", () => {
    expect(
      shouldRearmAttachmentFill(
        { bitableRecordId: "rec1", bitableAttachmentStatus: "failed", attachmentNextRetryAt: undefined },
        now,
      ),
    ).toBe(false);
  });

  it("ignores a request that has no attachment lifecycle at all", () => {
    expect(
      shouldRearmAttachmentFill(
        { bitableRecordId: "rec1", bitableAttachmentStatus: undefined, attachmentNextRetryAt: undefined },
        now,
      ),
    ).toBe(false);
  });
});
