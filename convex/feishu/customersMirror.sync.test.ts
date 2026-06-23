/* eslint-disable max-lines */
// Handler tests for the Customer mirror FULL-SYNC surface: the paginated page
// walk + completeness gate, the Mirror Prune tombstoning, the single-flight
// lease (ADR-0021), the immutable identity key (ADR-0021), and the residual
// drift alarm. The pure pagination/stop-reason state machine is unit-tested in
// customerMirrorSync.test.ts; these drive the registered fullSync/kick handlers
// through the shared fake-ctx harness (customersMirror.testkit.ts).

import { describe, expect, it, vi } from "vitest";

import {
  feishuPage,
  fullSyncHandler,
  installMirrorTestEnv,
  kickHandler,
  makeCtx,
  mockCallFeishu,
} from "./customersMirror.testkit";

vi.mock("./call", () => ({
  callFeishu: vi.fn(),
}));

installMirrorTestEnv();

const incompleteTotalPage = (id: string, hasMore: boolean, token?: string) => ({
  items: [{ record_id: id, fields: { "Account Name": [{ text: id, type: "text" }] } }],
  has_more: hasMore,
  page_token: token,
  total: 5,
});

describe("customer mirror full sync pagination", () => {
  it("keeps paging past the old 20-page ceiling until Feishu has_more is false", async () => {
    const pages = Array.from({ length: 22 }, (_, index) => feishuPage(index + 1, index < 21));
    pages.forEach((page) => {
      page.total = 22;
    });
    mockCallFeishu.mockImplementation(async () => pages.shift());
    const { ctx, completions } = makeCtx();

    const result = await kickHandler(ctx, {});

    expect(mockCallFeishu).toHaveBeenCalledTimes(22);
    expect(mockCallFeishu).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({
        path: "/bitable/v1/apps/apptest/tables/tbl4TE2GV472sKzp/records/search",
        method: "POST",
        query: { page_size: "500" },
        json: {
          field_names: [
            "Account Name",
            "Record Id",
            "域名",
            "全名",
            "Account No.",
            "Country and Regio",
            "Owner",
          ],
        },
      }),
    );
    expect(result).toMatchObject({
      pages: 22,
      rows: 22,
      inserted: 22,
      updated: 0,
      unchanged: 0,
      duplicateRows: 0,
      stopReason: "complete",
    });
    expect(completions[0]).toMatchObject({
      lastRowCount: 22,
      lastPageCount: 22,
      lastPageSize: 500,
      lastInsertedCount: 22,
      lastUpdatedCount: 0,
      lastUnchangedCount: 0,
      lastDuplicateCount: 0,
      lastHadMore: false,
      lastStopReason: "complete",
      lastReportedTotal: 22,
      lastSourceRowCount: 22,
      lastSourceTableId: "tbl4TE2GV472sKzp",
    });
  });

  it("records an audit stop reason before failing on broken Feishu pagination", async () => {
    mockCallFeishu.mockResolvedValueOnce({
      items: [
        {
          record_id: "rec_first",
          fields: { "Account Name": [{ text: "First", type: "text" }] },
        },
      ],
      has_more: true,
    });
    const { ctx, completions } = makeCtx();

    await expect(kickHandler(ctx, {})).rejects.toThrow(
      "Customers mirror stopped before completion",
    );

    expect(completions[0]).toMatchObject({
      lastRowCount: 1,
      lastPageCount: 1,
      lastHadMore: true,
      lastStopReason: "missingPageToken",
    });
  });

  it("flags an incompleteTotal shortfall when paged rows fall short of Feishu total", async () => {
    // Feishu reports a table total of 5, but pagination cleanly ends after 3 rows.
    mockCallFeishu
      .mockResolvedValueOnce(incompleteTotalPage("rec_1", true, "p2"))
      .mockResolvedValueOnce(incompleteTotalPage("rec_2", true, "p3"))
      .mockResolvedValueOnce(incompleteTotalPage("rec_3", false));
    const { ctx, completions } = makeCtx();

    await expect(kickHandler(ctx, {})).rejects.toThrow(
      "Customers mirror stopped before completion",
    );

    expect(completions[0]).toMatchObject({
      lastReportedTotal: 5,
      lastSourceRowCount: 3,
      lastStopReason: "incompleteTotal",
    });
  });

  it("tombstones mirror rows whose recordId was not seen during a complete sync", async () => {
    // Feishu returns one live row; the mirror also holds two orphans left behind
    // by earlier Feishu deletes/re-imports that the upsert-only mirror never removed.
    mockCallFeishu.mockResolvedValueOnce({
      items: [{ record_id: "rec_live", fields: { "Account Name": [{ text: "Live", type: "text" }] } }],
      has_more: false,
      total: 1,
    });
    const mirrorRows = [
      { _id: "d_live", recordId: "rec_live" },
      { _id: "d_orphan1", recordId: "rec_old1" },
      { _id: "d_orphan2", recordId: "rec_old2" },
    ];
    const deleted: string[][] = [];
    const completions: Record<string, unknown>[] = [];
    const runMutation = vi.fn(async (_fn: unknown, args: Record<string, unknown>) => {
      if (typeof args.cooldownMs === "number") return { started: true };
      if (Array.isArray(args.rows)) {
        return { inserted: args.rows.length, updated: 0, unchanged: 0, duplicateRows: 0 };
      }
      if (Array.isArray(args.ids)) {
        deleted.push(args.ids as string[]);
        return { deleted: args.ids.length };
      }
      if (typeof args.startedAt === "number") return null;
      completions.push(args);
      return null;
    });
    const runQuery = vi.fn(async (_fn: unknown, args?: Record<string, unknown>) =>
      args && "paginationOpts" in args
        ? { page: mirrorRows, isDone: true, continueCursor: "" }
        : null,
    );

    const result = await kickHandler({ runMutation, runQuery }, {});

    expect(result.stopReason).toBe("complete");
    expect(deleted).toEqual([["d_orphan1", "d_orphan2"]]);
    expect(result.pruneScanned).toBe(3);
    expect(result.deletedStale).toBe(2);
    expect(completions[0]).toMatchObject({
      lastPruneScannedCount: 3,
      lastDeletedStaleCount: 2,
      lastStopReason: "complete",
    });
  });

  it("never prunes when the sync stops incomplete, so a partial fetch cannot wipe the mirror", async () => {
    // has_more=true with no page_token -> missingPageToken (incomplete). An orphan
    // is present in the mirror, but the prune MUST be skipped entirely.
    mockCallFeishu.mockResolvedValueOnce({
      items: [{ record_id: "rec_1", fields: { "Account Name": [{ text: "One", type: "text" }] } }],
      has_more: true,
    });
    const deleted: string[][] = [];
    const runMutation = vi.fn(async (_fn: unknown, args: Record<string, unknown>) => {
      if (typeof args.cooldownMs === "number") return { started: true };
      if (Array.isArray(args.rows)) {
        return { inserted: args.rows.length, updated: 0, unchanged: 0, duplicateRows: 0 };
      }
      if (Array.isArray(args.ids)) {
        deleted.push(args.ids as string[]);
        return { deleted: args.ids.length };
      }
      if (typeof args.startedAt === "number") return null;
      return null;
    });
    const runQuery = vi.fn(async (_fn: unknown, args?: Record<string, unknown>) =>
      args && "paginationOpts" in args
        ? { page: [{ _id: "d_orphan", recordId: "rec_old" }], isDone: true, continueCursor: "" }
        : null,
    );

    await expect(kickHandler({ runMutation, runQuery }, {})).rejects.toThrow(
      "Customers mirror stopped before completion",
    );

    // The prune scan never ran and nothing was deleted (safety gate held).
    expect(runQuery).not.toHaveBeenCalled();
    expect(deleted).toEqual([]);
  });

  it("allows only one full re-page when two mirror kicks race before the cooldown stamp is visible", async () => {
    mockCallFeishu.mockResolvedValue({
      items: [
        {
          record_id: "rec_race",
          fields: { "Account Name": [{ text: "Race", type: "text" }] },
        },
      ],
      has_more: false,
      total: 1,
    });
    const completions: Record<string, unknown>[] = [];
    let refreshAlreadyStarted = false;
    const runMutation = vi.fn(async (_fn: unknown, args: Record<string, unknown>) => {
      if (typeof args.cooldownMs === "number") {
        if (refreshAlreadyStarted) return { started: false, remainingMs: args.cooldownMs };
        refreshAlreadyStarted = true;
        return { started: true };
      }
      if (Array.isArray(args.rows)) {
        return { inserted: args.rows.length, updated: 0, unchanged: 0, duplicateRows: 0 };
      }
      if (Array.isArray(args.ids)) return { deleted: args.ids.length };
      if (typeof args.startedAt === "number") return null;
      completions.push(args);
      return null;
    });
    const ctx = {
      runMutation,
      // Current implementation reads the timestamp outside the mutation. Return
      // stale state for both racing actions to reproduce the production burst;
      // the prune scan (listRowsForPrune) sees an empty mirror.
      runQuery: vi.fn(async (_fn: unknown, qArgs?: Record<string, unknown>) =>
        qArgs && "paginationOpts" in qArgs
          ? { page: [], isDone: true, continueCursor: "" }
          : null,
      ),
    };

    const results = await Promise.all([kickHandler(ctx, {}), kickHandler(ctx, {})]);

    expect(mockCallFeishu).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.pages).toSorted()).toEqual([0, 1]);
    expect(completions).toHaveLength(1);
  });
});

describe("customer mirror identity key", () => {
  // ADR-0021: the mirror must upsert on the immutable API `record_id`, never the
  // user-facing "Record Id" column. This captures the rows handed to `applyPage`
  // from a Feishu page whose "Record Id" column DIVERGES from the API id and
  // pins that the persisted dedup key is the API id.
  it("upserts on the API record_id even when the human `Record Id` column diverges", async () => {
    mockCallFeishu.mockResolvedValueOnce({
      items: [
        {
          record_id: "recAPIimmutable",
          fields: {
            "Account Name": [{ text: "Divergent Co", type: "text" }],
            "Record Id": [{ text: "recHumanColumn", type: "text" }],
          },
        },
      ],
      has_more: false,
      total: 1,
    });

    const appliedRows: Array<{ recordId: string }> = [];
    const runMutation = vi.fn(async (_fn: unknown, args: Record<string, unknown>) => {
      if (typeof args.cooldownMs === "number") return { started: true };
      if (Array.isArray(args.rows)) {
        appliedRows.push(...(args.rows as Array<{ recordId: string }>));
        return { inserted: args.rows.length, updated: 0, unchanged: 0, duplicateRows: 0 };
      }
      if (Array.isArray(args.ids)) return { deleted: args.ids.length };
      if (typeof args.startedAt === "number") return null;
      return null;
    });
    // Empty mirror scan so the now-active prune deletes nothing — this test only
    // asserts the persisted identity key.
    const runQuery = vi.fn(async (_fn: unknown, args?: Record<string, unknown>) =>
      args && "paginationOpts" in args
        ? { page: [], isDone: true, continueCursor: "" }
        : null,
    );

    await kickHandler({ runMutation, runQuery }, {});

    expect(appliedRows).toHaveLength(1);
    expect(appliedRows[0].recordId).toBe("recAPIimmutable");
    expect(appliedRows[0].recordId).not.toBe("recHumanColumn");
  });
});

describe("customer mirror full sync single-flight (ADR-0021)", () => {
  it("backs off a second concurrent full sync so only one pages — no prune race", async () => {
    mockCallFeishu.mockResolvedValue({
      items: [{ record_id: "rec_sf", fields: { "Account Name": [{ text: "SF", type: "text" }] } }],
      has_more: false,
      total: 1,
    });
    // The shared start lease grants exactly one holder; the second concurrent
    // fullSync sees the lease held and skips its entire page walk.
    let leaseHeld = false;
    const runMutation = vi.fn(async (_fn: unknown, args: Record<string, unknown>) => {
      if (typeof args.cooldownMs === "number") {
        if (leaseHeld) return { started: false, remainingMs: args.cooldownMs };
        leaseHeld = true;
        return { started: true };
      }
      if (Array.isArray(args.rows)) {
        return { inserted: args.rows.length, updated: 0, unchanged: 0, duplicateRows: 0 };
      }
      if (Array.isArray(args.ids)) return { deleted: args.ids.length };
      if (typeof args.startedAt === "number") return null;
      return null;
    });
    const runQuery = vi.fn(async (_fn: unknown, args?: Record<string, unknown>) =>
      args && "paginationOpts" in args
        ? { page: [], isDone: true, continueCursor: "" }
        : null,
    );

    const results = await Promise.all([
      fullSyncHandler({ runMutation, runQuery }, {}),
      fullSyncHandler({ runMutation, runQuery }, {}),
    ]);

    // Only the lease holder pages Feishu; the other returns the skipped result.
    expect(mockCallFeishu).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.pages).toSorted()).toEqual([0, 1]);
  });
});

describe("customer mirror drift alarm (ADR-0021)", () => {
  it("logs a DRIFT ALARM when the retained mirror count still exceeds the source total after prune", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockCallFeishu.mockResolvedValueOnce({
      items: [{ record_id: "rec_live", fields: { "Account Name": [{ text: "Live", type: "text" }] } }],
      has_more: false,
      total: 1,
    });
    // The mirror still holds many DUPLICATE docs for the one live recordId (the
    // exact overcount that an upsert-only re-key drift produced). None are stale
    // (all seen), so the prune deletes nothing and the retained count stays far
    // above the source total — the alarm must fire.
    const dupDocs = Array.from({ length: 40 }, (_, i) => ({ _id: `d_${i}`, recordId: "rec_live" }));
    const runMutation = vi.fn(async (_fn: unknown, args: Record<string, unknown>) => {
      if (typeof args.cooldownMs === "number") return { started: true };
      if (Array.isArray(args.rows)) {
        return { inserted: args.rows.length, updated: 0, unchanged: 0, duplicateRows: 0 };
      }
      if (Array.isArray(args.ids)) return { deleted: args.ids.length };
      if (typeof args.startedAt === "number") return null;
      return null;
    });
    const runQuery = vi.fn(async (_fn: unknown, args?: Record<string, unknown>) =>
      args && "paginationOpts" in args
        ? { page: dupDocs, isDone: true, continueCursor: "" }
        : null,
    );

    const result = await kickHandler({ runMutation, runQuery }, {});

    expect(result.stopReason).toBe("complete");
    expect(result.pruneScanned).toBe(40);
    expect(result.deletedStale).toBe(0);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("DRIFT ALARM"));
  });
});
