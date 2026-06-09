import { describe, expect, it, vi } from "vitest";

import {
  processPendingBitableSync,
  reconcilePendingBitableSync,
  requireExactlyOneCoworker,
  syncRequest,
} from "./requestSync";
import type { SelectedCoworker } from "../emailRecord";

const jenny: SelectedCoworker = { openId: "ou_1fa1e520f980675ed46ff40aa177a488", name: "Jenny Xu" };
const dave: SelectedCoworker = { openId: "ou_a61fa1232a614a04639cd33695d0a7da", name: "Dave Lin" };
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

  it("rejects dev preview coworker open ids", () => {
    expect(() => requireExactlyOneCoworker([{ openId: "ou_maria", name: "Maria Hoffmann" }])).toThrow(
      /dev preview id/i,
    );
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
    scheduler: {
      runAfter: (delayMs: number, fn: unknown, args: Record<string, unknown>) => Promise<string>;
    };
  },
  args: typeof baseArgs,
) => Promise<
  | { status: "pending"; recordId: null; detailUrl: null }
  | { status: "synced"; recordId: string; detailUrl: string | null }
>;

const syncRequestHandler = (syncRequest as unknown as { _handler: SyncRequestHandler })._handler;

describe("syncRequest durable dual sync", () => {
  it("writes a pending Convex backup before enqueueing the Feishu Base row create", async () => {
    const runMutation = vi
      .fn()
      .mockResolvedValueOnce({
        bitableClientToken: "client-token-1",
        bitableRecordId: null,
        detailUrl: null,
        shouldSchedule: true,
      });
    const runAction = vi.fn();
    const scheduler = { runAfter: vi.fn().mockResolvedValueOnce("scheduled-1") };

    const result = await syncRequestHandler({ runMutation, runAction, scheduler }, baseArgs);

    expect(result).toEqual({
      status: "pending",
      recordId: null,
      detailUrl: null,
    });
    expect(runMutation.mock.invocationCallOrder[0]).toBeLessThan(
      scheduler.runAfter.mock.invocationCallOrder[0],
    );
    expect(runAction).not.toHaveBeenCalled();
    expect(runMutation.mock.calls[0][1]).toMatchObject({
      internetMessageId: "<msg-1@example.com>",
      clientEmail: "buyer@example.com",
      sentToBitable: false,
      bitableRecordId: undefined,
    });
    expect(scheduler.runAfter).toHaveBeenCalledTimes(1);
    expect(scheduler.runAfter.mock.calls[0][0]).toBe(0);
    expect(scheduler.runAfter.mock.calls[0][2]).toMatchObject({
      ...baseArgs,
      clientToken: "client-token-1",
      body: "Please quote 10kg.",
      attachments: [{ fileToken: "boxcnAAA" }],
    });
  });

  it("short-circuits when the Convex backup already knows the Base record id", async () => {
    const runMutation = vi.fn().mockResolvedValueOnce({
      bitableClientToken: "client-token-1",
      bitableRecordId: "rec_existing",
      detailUrl: "https://feishu.cn/base/app?table=tbl&record=rec_existing",
      shouldSchedule: false,
    });
    const runAction = vi.fn();
    const scheduler = { runAfter: vi.fn() };

    await expect(syncRequestHandler({ runMutation, runAction, scheduler }, baseArgs)).resolves.toEqual({
      status: "synced",
      recordId: "rec_existing",
      detailUrl: "https://feishu.cn/base/app?table=tbl&record=rec_existing",
    });

    expect(runAction).not.toHaveBeenCalled();
    expect(scheduler.runAfter).not.toHaveBeenCalled();
  });

  it("does not enqueue another worker when the same request is already pending", async () => {
    const runMutation = vi.fn().mockResolvedValueOnce({
      bitableClientToken: "client-token-1",
      bitableRecordId: null,
      detailUrl: null,
      shouldSchedule: false,
    });
    const runAction = vi.fn();
    const scheduler = { runAfter: vi.fn() };

    await expect(syncRequestHandler({ runMutation, runAction, scheduler }, baseArgs)).resolves.toEqual({
      status: "pending",
      recordId: null,
      detailUrl: null,
    });

    expect(runAction).not.toHaveBeenCalled();
    expect(scheduler.runAfter).not.toHaveBeenCalled();
  });
});

type ProcessPendingHandler = (
  ctx: {
    runMutation: (fn: unknown, args: Record<string, unknown>) => Promise<unknown>;
    runAction: (fn: unknown, args: Record<string, unknown>) => Promise<{ recordId: string }>;
    scheduler: {
      runAfter: (delayMs: number, fn: unknown, args: Record<string, unknown>) => Promise<string>;
    };
  },
  args: typeof baseArgs & { clientToken: string },
) => Promise<{ status: "synced"; recordId: string; detailUrl: string | null }>;

const processPendingHandler = (
  processPendingBitableSync as unknown as { _handler: ProcessPendingHandler }
)._handler;

describe("processPendingBitableSync", () => {
  it("creates the Feishu Base row and marks the Convex backup succeeded", async () => {
    const runAction = vi.fn().mockResolvedValueOnce({ recordId: "rec_service_1" });
    const runMutation = vi
      .fn()
      .mockResolvedValueOnce({ detailUrl: "https://feishu.cn/base/app?table=tbl&record=rec_service_1" });
    const scheduler = { runAfter: vi.fn() };

    await expect(
      processPendingHandler(
        { runMutation, runAction, scheduler },
        { ...baseArgs, clientToken: "client-token-1" },
      ),
    ).resolves.toEqual({
      status: "synced",
      recordId: "rec_service_1",
      detailUrl: "https://feishu.cn/base/app?table=tbl&record=rec_service_1",
    });

    expect(runAction.mock.calls[0][1]).toMatchObject({
      clientToken: "client-token-1",
      clientRecordId: "rec_customer",
      emailConversationId: "conv-1",
      requestNote: "10kg",
      body: "Please quote 10kg.",
      attachments: [{ fileToken: "boxcnAAA" }],
    });
    expect(runMutation.mock.calls[0][1]).toMatchObject({
      internetMessageId: "<msg-1@example.com>",
      bitableRecordId: "rec_service_1",
    });
    // Happy path never schedules a retry.
    expect(scheduler.runAfter).not.toHaveBeenCalled();
  });

  it("self-schedules the next attempt under the stored token when a transient create fails", async () => {
    // Replaces the 15-min reconcile sweep: the per-task chain re-enqueues itself
    // with the planner's backoff delay, carrying the same idempotency token.
    const runAction = vi.fn().mockRejectedValueOnce(new Error("Feishu unavailable"));
    const runMutation = vi
      .fn()
      .mockResolvedValueOnce({ status: "failed", nextRetryAt: 9_999, retryDelayMs: 5 * 60_000 });
    const scheduler = { runAfter: vi.fn().mockResolvedValueOnce("scheduled-retry-1") };

    await expect(
      processPendingHandler(
        { runMutation, runAction, scheduler },
        { ...baseArgs, clientToken: "client-token-1" },
      ),
    ).rejects.toThrow("Feishu unavailable");

    expect(runMutation.mock.calls[0][1]).toMatchObject({
      internetMessageId: "<msg-1@example.com>",
      error: "Feishu unavailable",
    });
    expect(scheduler.runAfter).toHaveBeenCalledTimes(1);
    expect(scheduler.runAfter.mock.calls[0][0]).toBe(5 * 60_000);
    expect(scheduler.runAfter.mock.calls[0][2]).toMatchObject({
      clientToken: "client-token-1",
      internetMessageId: "<msg-1@example.com>",
    });
  });

  it("stops the chain when the failure is terminal (no further retry scheduled)", async () => {
    const runAction = vi.fn().mockRejectedValueOnce(new Error("UserFieldConvFail"));
    const runMutation = vi
      .fn()
      .mockResolvedValueOnce({ status: "abandoned", nextRetryAt: undefined, retryDelayMs: undefined });
    const scheduler = { runAfter: vi.fn() };

    await expect(
      processPendingHandler(
        { runMutation, runAction, scheduler },
        { ...baseArgs, clientToken: "client-token-1" },
      ),
    ).rejects.toThrow("UserFieldConvFail");

    expect(scheduler.runAfter).not.toHaveBeenCalled();
  });
});

describe("syncRequest scheduling failure", () => {
  it("keeps the pending backup retryable when immediate scheduling fails", async () => {
    const runMutation = vi.fn().mockResolvedValueOnce({
      bitableClientToken: "client-token-1",
      bitableRecordId: null,
      detailUrl: null,
      shouldSchedule: true,
    });
    const runAction = vi.fn();
    const scheduler = { runAfter: vi.fn().mockRejectedValueOnce(new Error("scheduler unavailable")) };

    await expect(syncRequestHandler({ runMutation, runAction, scheduler }, baseArgs)).rejects.toThrow(
      "scheduler unavailable",
    );

    expect(runMutation).toHaveBeenCalledTimes(2);
    expect(runMutation.mock.calls[0][1]).toMatchObject({
      internetMessageId: "<msg-1@example.com>",
      sentToBitable: false,
    });
    expect(runMutation.mock.calls[1][1]).toMatchObject({
      internetMessageId: "<msg-1@example.com>",
      requestSyncKey: "rep@example.com\nconv-1",
      error: "scheduler unavailable",
    });
    expect(runAction).not.toHaveBeenCalled();
  });
});

type ReconcileHandler = (
  ctx: {
    runQuery: (fn: unknown, args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
    runMutation: (fn: unknown, args: Record<string, unknown>) => Promise<unknown>;
    runAction: (fn: unknown, args: Record<string, unknown>) => Promise<{ recordId: string }>;
    scheduler: { runAfter: (delayMs: number, fn: unknown, args: Record<string, unknown>) => Promise<string> };
  },
  args: Record<string, never>,
) => Promise<{ checked: number; synced: number; failed: number; attachmentFills: number }>;

// The reconcile sweep now queries twice: due outbox records, then due attachment
// fills. The second runQuery returns [] in these outbox-focused tests.
const noDueFills = (runQuery: ReturnType<typeof vi.fn>): void => {
  runQuery.mockResolvedValueOnce([]);
};

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
    noDueFills(runQuery);
    const runAction = vi.fn().mockResolvedValueOnce({ recordId: "rec_service_1" });
    const runMutation = vi.fn().mockResolvedValueOnce({ detailUrl: null });
    const scheduler = { runAfter: vi.fn() };

    await expect(
      reconcileHandler({ runQuery, runAction, runMutation, scheduler }, {}),
    ).resolves.toEqual({
      checked: 1,
      synced: 1,
      failed: 0,
      attachmentFills: 0,
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

  it("abandons poisoned outbox rows without calling Feishu", async () => {
    const runQuery = vi.fn().mockResolvedValueOnce([
      {
        ...baseArgs,
        internetMessageId: "<dev-sample@fenchem.com>",
        conversationId: "dev-sample",
        bodyPreview: "Please quote 10kg.",
        sentToBitable: false,
        bitableClientToken: "client-token-1",
        selectedCoworkers: [jenny],
      },
    ]);
    noDueFills(runQuery);
    const runAction = vi.fn();
    const runMutation = vi.fn().mockResolvedValue(undefined);
    const scheduler = { runAfter: vi.fn() };

    await expect(
      reconcileHandler({ runQuery, runAction, runMutation, scheduler }, {}),
    ).resolves.toEqual({
      checked: 1,
      synced: 0,
      failed: 1,
      attachmentFills: 0,
    });

    expect(runAction).not.toHaveBeenCalled();
    expect(runMutation).toHaveBeenCalledTimes(1);
    expect(runMutation.mock.calls[0][1]).toMatchObject({
      internetMessageId: "<dev-sample@fenchem.com>",
      error: expect.stringMatching(/dev-sample mail/i),
    });
  });
});
