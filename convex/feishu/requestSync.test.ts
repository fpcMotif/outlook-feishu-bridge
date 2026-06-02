import { describe, expect, it, vi } from "vitest";

import { reconcilePendingBitableSync, requireExactlyOneCoworker, syncRequest } from "./requestSync";
import type { SelectedCoworker } from "../emailRecord";

const jenny: SelectedCoworker = { openId: "ou_jenny", name: "Jenny Xu" };
const dave: SelectedCoworker = { openId: "ou_dave", name: "Dave Lin" };
const ERR = "Bitable Sync requires exactly one Feishu coworker";

describe("requireExactlyOneCoworker", () => {
  it("returns the array unchanged when exactly one coworker is present", () => {
    const input = [jenny];
    const result = requireExactlyOneCoworker(input);
    expect(result).toBe(input);
    expect(result).toEqual([jenny]);
  });

  it("throws when given undefined", () => {
    expect(() => requireExactlyOneCoworker(undefined)).toThrow(ERR);
  });

  it("throws when given zero coworkers", () => {
    expect(() => requireExactlyOneCoworker([])).toThrow(ERR);
  });

  it("throws when given two or more coworkers", () => {
    expect(() => requireExactlyOneCoworker([jenny, dave])).toThrow(ERR);
    expect(() => requireExactlyOneCoworker([jenny, dave, jenny])).toThrow(ERR);
  });
});

const baseArgs = {
  subject: "Need quote",
  from: "buyer@example.com",
  to: ["sales@example.com"],
  cc: [],
  body: "Please quote 10kg.",
  internetMessageId: "<msg-1@example.com>",
  itemId: "item-1",
  conversationId: "conv-1",
  userEmail: "rep@example.com",
  dateTimeCreated: 1_716_000_000_000,
  clientEmail: "buyer@example.com",
  selectedCustomer: { recordId: "rec_customer", name: "Example Customer" },
  initiator: { openId: "ou_rep", name: "Rep" },
  requestNote: "10kg",
  attachments: [{ fileToken: "boxcnAAA" }],
  selectedCoworkers: [jenny],
};

type SyncRequestHandler = (
  ctx: {
    runMutation: (fn: unknown, args: Record<string, unknown>) => Promise<unknown>;
    runAction: (fn: unknown, args: Record<string, unknown>) => Promise<{ recordId: string }>;
  },
  args: typeof baseArgs,
) => Promise<{ recordId: string; detailUrl: string | null }>;

const syncRequestHandler = (syncRequest as unknown as { _handler: SyncRequestHandler })._handler;

describe("syncRequest durable dual sync", () => {
  it("writes a pending Convex backup before creating the Feishu Base row", async () => {
    const runMutation = vi
      .fn()
      .mockResolvedValueOnce({ bitableClientToken: "client-token-1", bitableRecordId: null, detailUrl: null })
      .mockResolvedValueOnce({ detailUrl: "https://feishu.cn/base/app?table=tbl&record=rec_service_1" });
    const runAction = vi.fn().mockResolvedValueOnce({ recordId: "rec_service_1" });

    const result = await syncRequestHandler({ runMutation, runAction }, baseArgs);

    expect(result).toEqual({
      recordId: "rec_service_1",
      detailUrl: "https://feishu.cn/base/app?table=tbl&record=rec_service_1",
    });
    expect(runMutation.mock.invocationCallOrder[0]).toBeLessThan(
      runAction.mock.invocationCallOrder[0],
    );
    expect(runMutation.mock.calls[0][1]).toMatchObject({
      internetMessageId: "<msg-1@example.com>",
      clientEmail: "buyer@example.com",
      sentToBitable: false,
      bitableRecordId: undefined,
    });
    expect(runAction.mock.calls[0][1]).toMatchObject({
      clientToken: "client-token-1",
      clientRecordId: "rec_customer",
      emailConversationId: "conv-1",
      requestNote: "10kg",
      body: "Please quote 10kg.",
      attachments: [{ fileToken: "boxcnAAA" }],
    });
    expect(runMutation.mock.calls[1][1]).toMatchObject({
      internetMessageId: "<msg-1@example.com>",
      bitableRecordId: "rec_service_1",
    });
  });

  it("short-circuits when the Convex backup already knows the Base record id", async () => {
    const runMutation = vi.fn().mockResolvedValueOnce({
      bitableClientToken: "client-token-1",
      bitableRecordId: "rec_existing",
      detailUrl: "https://feishu.cn/base/app?table=tbl&record=rec_existing",
    });
    const runAction = vi.fn();

    await expect(syncRequestHandler({ runMutation, runAction }, baseArgs)).resolves.toEqual({
      recordId: "rec_existing",
      detailUrl: "https://feishu.cn/base/app?table=tbl&record=rec_existing",
    });

    expect(runAction).not.toHaveBeenCalled();
  });

  it("records a retryable failure when the Feishu Base create fails", async () => {
    const runMutation = vi
      .fn()
      .mockResolvedValueOnce({ bitableClientToken: "client-token-1", bitableRecordId: null, detailUrl: null })
      .mockResolvedValueOnce(null);
    const runAction = vi.fn().mockRejectedValueOnce(new Error("Feishu unavailable"));

    await expect(syncRequestHandler({ runMutation, runAction }, baseArgs)).rejects.toThrow(
      "Feishu unavailable",
    );

    expect(runMutation.mock.calls[1][1]).toMatchObject({
      internetMessageId: "<msg-1@example.com>",
      error: "Feishu unavailable",
    });
  });
});

type ReconcileHandler = (
  ctx: {
    runQuery: (fn: unknown, args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
    runMutation: (fn: unknown, args: Record<string, unknown>) => Promise<unknown>;
    runAction: (fn: unknown, args: Record<string, unknown>) => Promise<{ recordId: string }>;
  },
  args: Record<string, never>,
) => Promise<{ checked: number; synced: number; failed: number }>;

const reconcileHandler = (
  reconcilePendingBitableSync as unknown as { _handler: ReconcileHandler }
)._handler;

describe("reconcilePendingBitableSync", () => {
  it("replays due Convex backups with their stored idempotency token", async () => {
    const runQuery = vi.fn().mockResolvedValueOnce([
      {
        ...baseArgs,
        bodyPreview: "Please quote 10kg.",
        sentToBitable: false,
        bitableClientToken: "client-token-1",
      },
    ]);
    const runAction = vi.fn().mockResolvedValueOnce({ recordId: "rec_service_1" });
    const runMutation = vi.fn().mockResolvedValueOnce(null);

    await expect(reconcileHandler({ runQuery, runAction, runMutation }, {})).resolves.toEqual({
      checked: 1,
      synced: 1,
      failed: 0,
    });

    expect(runAction.mock.calls[0][1]).toMatchObject({
      clientToken: "client-token-1",
      clientRecordId: "rec_customer",
      emailConversationId: "conv-1",
      requestNote: "10kg",
      // ADR-0022: the reconcile (outbox) path can only write the stored ≤500-char
      // preview as the body — the full body is never persisted on the backup.
      body: "Please quote 10kg.",
    });
    // ADR-0022 decision #5: attachments are NOT persisted on the backup, so a
    // reconciled row carries none (known v1 limitation).
    expect(runAction.mock.calls[0][1].attachments).toBeUndefined();
    expect(runMutation.mock.calls[0][1]).toMatchObject({
      internetMessageId: "<msg-1@example.com>",
      bitableRecordId: "rec_service_1",
    });
  });
});
