// Shared harness for the customer-mirror handler tests (split out of the former
// 1.1k-line customersMirror.test.ts so each concern lives in its own file under
// the architecture line limit). NOT a `.test.ts` — vitest does not collect it as
// a suite; it only exports the fake-ctx builders, the registered-handler refs,
// and the env install hook the split suites share.
//
// IMPORTANT: `vi.mock("./call", ...)` is file-hoisted, so it must be declared in
// EACH importing test file, not here. This module merely reads the resulting
// mock via `vi.mocked(callFeishu)` — valid because the mock replaces "./call"
// across the whole test-file module graph, this testkit included.

import { afterEach, beforeEach, vi } from "vitest";

import { callFeishu } from "./call";
import {
  applyPage,
  fullSync,
  kick,
  matchByEmail,
  matchEmailAndCacheMiss,
  search,
  searchCustomers,
} from "./customersMirror";

type KickHandler = (
  ctx: {
    runMutation: (
      fn: unknown,
      args: Record<string, unknown>,
    ) => Promise<unknown>;
    runQuery?: (fn: unknown, args: Record<string, unknown>) => Promise<unknown>;
  },
  args: Record<string, never>,
) => Promise<{
  pages: number;
  rows: number;
  inserted: number;
  updated: number;
  unchanged: number;
  duplicateRows: number;
  stopReason: string;
  pruneScanned: number;
  deletedStale: number;
}>;

export const kickHandler = (kick as unknown as { _handler: KickHandler })._handler;
// fullSync shares the single-flight lease with kick (ADR-0021); the handler is
// exercised directly to prove two concurrent cron/kick runs cannot both page.
export const fullSyncHandler = (fullSync as unknown as {
  _handler: (
    ctx: {
      runMutation: (fn: unknown, args: Record<string, unknown>) => Promise<unknown>;
      runQuery: (fn: unknown, args?: Record<string, unknown>) => Promise<unknown>;
    },
    args: Record<string, never>,
  ) => Promise<{ pages: number; pruneScanned: number; deletedStale: number }>;
})._handler;
export const searchCustomersHandler = (searchCustomers as unknown as {
  _handler: (
    ctx: {
      runQuery: (
        fn: unknown,
        args: Record<string, unknown>,
      ) => Promise<{ records: unknown[]; mirroredAt: number | null }>;
      runMutation: (
        fn: unknown,
        args: Record<string, unknown>,
      ) => Promise<{ inserted: number; updated: number; unchanged: number; duplicateRows: number }>;
    },
    args: { q: string; mineFor?: string },
  ) => Promise<{
    records: unknown[];
    source: "mirror" | "live";
    backfilled: number;
    mirroredAt: number | null;
  }>;
})._handler;
export const searchHandler = (search as unknown as {
  _handler: (
    ctx: {
      db: {
        query: (table: "customersMirrorState" | "customers") => unknown;
      };
    },
    args: { q: string; mineFor?: string; limit?: number },
  ) => Promise<{ records: unknown[]; mirroredAt: number | null }>;
})._handler;
export const applyPageHandler = (applyPage as unknown as {
  _handler: (
    ctx: {
      db: {
        query: (table: "customers") => {
          withIndex: (
            name: "by_recordId",
            callback: (q: { eq: (field: "recordId", value: string) => unknown }) => unknown,
          ) => { unique: () => Promise<Record<string, unknown> | null> };
        };
        patch: (id: string, fields: Record<string, unknown>) => Promise<void>;
        insert: (table: "customers", fields: Record<string, unknown>) => Promise<void>;
      };
    },
    args: {
      rows: Array<{
        recordId: string;
        name: string;
        domain?: string;
        domainKey?: string;
        fullName?: string;
        accountNo?: string;
        countryRegion?: string;
        ownerOpenId?: string;
        ownerName?: string;
        searchBlob: string;
      }>;
      mirroredAt: number;
    },
  ) => Promise<{ inserted: number; updated: number; unchanged: number; duplicateRows: number }>;
})._handler;
export const matchByEmailHandler = (matchByEmail as unknown as {
  _handler: (
    ctx: { db: { query: (table: "customers") => unknown } },
    args: { email: string },
  ) => Promise<{ customer: { recordId: string } | null }>;
})._handler;
export const matchEmailAndCacheMissHandler = (matchEmailAndCacheMiss as unknown as {
  _handler: (
    ctx: {
      runMutation: (
        fn: unknown,
        args: Record<string, unknown>,
      ) => Promise<
        | { started: boolean; remainingMs?: number }
        | { inserted: number; updated: number; unchanged: number; duplicateRows: number }
      >;
    },
    args: { email: string },
  ) => Promise<{ customer: { recordId: string } | null; backfilled: number }>;
})._handler;

export const mockCallFeishu = vi.mocked(callFeishu);

export function feishuPage(index: number, hasMore: boolean): {
  items: Array<{ record_id: string; fields: Record<string, Array<{ text: string; type: string }>> }>;
  has_more: boolean;
  page_token: string | undefined;
  total?: number;
} {
  return {
    items: [
      {
        record_id: `rec_${index}`,
        fields: { "Account Name": [{ text: `Customer ${index}`, type: "text" }] },
      },
    ],
    has_more: hasMore,
    page_token: hasMore ? `page_${index + 1}` : undefined,
  };
}

export function makeCtx() {
  const completions: Record<string, unknown>[] = [];
  // Mocks return resolved promises (not `async`) so the registered handlers can
  // `await` them exactly as in production, without an unused-await lint flag.
  const runMutation = vi.fn((_fn: unknown, args: Record<string, unknown>): Promise<unknown> => {
    if (typeof args.cooldownMs === "number") return Promise.resolve({ started: true });
    if (Array.isArray(args.rows)) {
      return Promise.resolve({ inserted: args.rows.length, updated: 0, unchanged: 0, duplicateRows: 0 });
    }
    // deleteRowsById (Mirror Prune) — never called for an empty mirror, but keep
    // it out of `completions` so a populated-table test does not see a phantom.
    if (Array.isArray(args.ids)) return Promise.resolve({ deleted: args.ids.length });
    // Defensive guard for a bare {startedAt} mutation; the refresh start lease
    // now stamps the start via the cooldownMs branch above (ADR-0021). Not a
    // watermark completion, so keep it out of `completions`.
    if (typeof args.startedAt === "number") return Promise.resolve(null);
    completions.push(args);
    return Promise.resolve(null);
  });
  // listRowsForPrune — empty mirror in the unit ctx, so the prune scans and
  // deletes nothing. (The legacy getMirrorRefreshStartedAt path returns null.)
  const runQuery = vi.fn((_fn: unknown, args?: Record<string, unknown>): Promise<unknown> => {
    if (args && "paginationOpts" in args) {
      return Promise.resolve({ page: [], isDone: true, continueCursor: "" });
    }
    return Promise.resolve(null);
  });
  return { ctx: { runMutation, runQuery }, completions };
}

// Register the env + console isolation the handler suites share. Called once at
// the top of each split test file (vitest collects the hooks into that file's
// default suite).
export function installMirrorTestEnv(): void {
  const originalConvexDeployment = process.env.CONVEX_DEPLOYMENT;
  const originalFixturesFlag = process.env.ENABLE_DEV_CUSTOMER_FIXTURES;
  const originalAppToken = process.env.FEISHU_BITABLE_APP_TOKEN;

  beforeEach(() => {
    delete process.env.CONVEX_DEPLOYMENT;
    delete process.env.ENABLE_DEV_CUSTOMER_FIXTURES;
    process.env.FEISHU_BITABLE_APP_TOKEN = "apptest";
    mockCallFeishu.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalConvexDeployment === undefined) {
      delete process.env.CONVEX_DEPLOYMENT;
    } else {
      process.env.CONVEX_DEPLOYMENT = originalConvexDeployment;
    }
    if (originalFixturesFlag === undefined) {
      delete process.env.ENABLE_DEV_CUSTOMER_FIXTURES;
    } else {
      process.env.ENABLE_DEV_CUSTOMER_FIXTURES = originalFixturesFlag;
    }
    if (originalAppToken === undefined) {
      delete process.env.FEISHU_BITABLE_APP_TOKEN;
    } else {
      process.env.FEISHU_BITABLE_APP_TOKEN = originalAppToken;
    }
    vi.restoreAllMocks();
  });
}
