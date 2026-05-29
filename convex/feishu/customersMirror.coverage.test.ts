// Coverage companion to customersMirror.test.ts (which pins buildSearchBlob).
// This file drives the rest of the server-side mirror (ADR-0016): the upsert
// mutation (applyPage), the watermark mutation (recordSyncCompletion), the
// full-table sync loop (fullSync/kick → runFullSync), the cache-aside live
// search (searchAndCacheMiss), and the ranked search query (search).
//
// All of these are registered Convex functions whose handler bodies are
// reachable via `_handler` (verified by probe). We never use a real Convex
// runtime: callFeishu is mocked, ctx.db is a tiny in-memory fake, and
// ctx.runMutation is a spy that forwards to the SAME applyPage/recordSyncCompletion
// handlers so the projection + upsert path is exercised end to end.
//
// HARD RULE (ADR-0010/0012) note: the mirror NEVER touches the Bitable Customer
// Table — these tests assert writes land only on the Convex `customers`/
// `customersMirrorState` fake tables, never back on Feishu.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CallFeishuOptions } from "./call";

const callFeishu = vi.fn();
vi.mock("./call", () => ({
  callFeishu: (...args: unknown[]) => callFeishu(...args),
}));

import {
  applyPage,
  fullSync,
  kick,
  recordSyncCompletion,
  search,
  searchAndCacheMiss,
} from "./customersMirror";
import type { CustomerRecord } from "./customers";

type Handler = { _handler: (ctx: unknown, args: any) => Promise<any> };
const runApplyPage = (applyPage as unknown as Handler)["_handler"];
const runRecordSync = (recordSyncCompletion as unknown as Handler)["_handler"];
const runFullSync = (fullSync as unknown as Handler)["_handler"];
const runKick = (kick as unknown as Handler)["_handler"];
const runSearchAndCacheMiss = (searchAndCacheMiss as unknown as Handler)["_handler"];
const runSearch = (search as unknown as Handler)["_handler"];

// ── tiny in-memory Convex db fake ───────────────────────────────────────────
// Implements only the surface these handlers use:
//   query(table).withIndex(name, q => q.eq(field,val)).unique()
//   query(table).first()
//   query(table).withSearchIndex(name, b => b.search(...).eq(...)).take(n)
//   insert(table, doc) / patch(id, partial)
interface Doc {
  _id: string;
  [k: string]: unknown;
}
function makeDb() {
  const tables: Record<string, Doc[]> = { customers: [], customersMirrorState: [] };
  let seq = 0;
  // Records the predicate captured by the search-index builder so a test can
  // assert mineFor wiring without needing real ranking.
  const searchCalls: Array<{ field: string; q: string; eqOwner?: string }> = [];

  function makeQuery(table: string) {
    return {
      withIndex(_name: string, fn: (q: any) => any) {
        let eqField = "";
        let eqVal: unknown;
        fn({
          eq(field: string, val: unknown) {
            eqField = field;
            eqVal = val;
            return this;
          },
        });
        const matches = tables[table].filter((d) => d[eqField] === eqVal);
        return {
          async unique() {
            return matches[0] ?? null;
          },
        };
      },
      withSearchIndex(_name: string, fn: (b: any) => any) {
        const captured: { field: string; q: string; eqOwner?: string } = { field: "", q: "" };
        const builder = {
          search(field: string, q: string) {
            captured.field = field;
            captured.q = q;
            return this;
          },
          eq(field: string, val: unknown) {
            if (field === "ownerOpenId") captured.eqOwner = val as string;
            return this;
          },
        };
        fn(builder);
        searchCalls.push(captured);
        // Return all rows (optionally owner-filtered) so .take(limit) is testable.
        const rows = tables[table].filter(
          (d) => captured.eqOwner === undefined || d.ownerOpenId === captured.eqOwner,
        );
        return {
          async take(n: number) {
            return rows.slice(0, n);
          },
        };
      },
      async first() {
        return tables[table][0] ?? null;
      },
    };
  }

  return {
    tables,
    searchCalls,
    db: {
      query(table: string) {
        return makeQuery(table);
      },
      async insert(table: string, doc: Record<string, unknown>) {
        const _id = `${table}_${seq++}`;
        tables[table].push({ _id, ...doc });
        return _id;
      },
      async patch(id: string, partial: Record<string, unknown>) {
        for (const t of Object.values(tables)) {
          const found = t.find((d) => d._id === id);
          if (found) Object.assign(found, partial);
        }
      },
    },
  };
}

// A ctx whose runMutation forwards to the real applyPage/recordSyncCompletion
// handlers, sharing the same fake db — so runFullSync/searchAndCacheMiss drive
// the full projection→upsert path. The `internal.feishu.customersMirror.*`
// FunctionReference arg is opaque here; we route by a tag we stamp on it.
function makeActionCtx() {
  const { db, tables, searchCalls } = makeDb();
  const ctx = {
    db,
    runMutation: vi.fn(async (ref: any, args: any) => {
      // The generated reference is opaque; disambiguate by the arg shape.
      if ("rows" in args) return runApplyPage(ctx, args);
      return runRecordSync(ctx, args);
    }),
  };
  return { ctx, tables, searchCalls };
}

const item = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  record_id: id,
  fields: { "Account Name": [{ text: name }], ...extra },
});

const ownerField = (openId: string, name = "Owner") => ({ Owner: [{ id: openId, name }] });

beforeEach(() => {
  callFeishu.mockReset();
  process.env.FEISHU_BITABLE_APP_TOKEN = "app_tok_test";
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("applyPage (upsert mutation)", () => {
  const row = (recordId: string, name: string) => ({
    recordId,
    name,
    searchBlob: name,
  });

  it("inserts when by_recordId finds no existing doc and reports {inserted:1, updated:0}", async () => {
    const { ctx, tables } = makeActionCtx();
    const out = await runApplyPage(ctx, { rows: [row("rec1", "Acme")], mirroredAt: 111 });
    expect(out).toEqual({ inserted: 1, updated: 0 });
    expect(tables.customers).toHaveLength(1);
    expect(tables.customers[0]).toMatchObject({ recordId: "rec1", name: "Acme", mirroredAt: 111 });
  });

  it("patches the existing doc (not insert) and stamps mirroredAt, reporting {inserted:0, updated:1}", async () => {
    const { ctx, tables } = makeActionCtx();
    await runApplyPage(ctx, { rows: [row("rec1", "Old")], mirroredAt: 100 });
    const out = await runApplyPage(ctx, { rows: [row("rec1", "New")], mirroredAt: 222 });
    expect(out).toEqual({ inserted: 0, updated: 1 });
    expect(tables.customers).toHaveLength(1);
    expect(tables.customers[0]).toMatchObject({ name: "New", mirroredAt: 222 });
  });

  it("dedupes a page carrying the same recordId twice (last wins) → one upsert", async () => {
    const { ctx, tables } = makeActionCtx();
    const out = await runApplyPage(ctx, {
      rows: [row("rec1", "first"), row("rec1", "second")],
      mirroredAt: 5,
    });
    expect(out).toEqual({ inserted: 1, updated: 0 });
    expect(tables.customers).toHaveLength(1);
    expect(tables.customers[0]).toMatchObject({ name: "second" });
  });

  it("splits inserted/updated correctly for a mixed page", async () => {
    const { ctx } = makeActionCtx();
    await runApplyPage(ctx, { rows: [row("rec1", "Existing")], mirroredAt: 1 });
    const out = await runApplyPage(ctx, {
      rows: [row("rec1", "Updated"), row("rec2", "Brand New")],
      mirroredAt: 2,
    });
    expect(out).toEqual({ inserted: 1, updated: 1 });
  });
});

describe("recordSyncCompletion (watermark mutation)", () => {
  it("inserts a new customersMirrorState row when none exists", async () => {
    const { ctx, tables } = makeActionCtx();
    await runRecordSync(ctx, { lastFullSyncAt: 999, lastRowCount: 7 });
    expect(tables.customersMirrorState).toHaveLength(1);
    expect(tables.customersMirrorState[0]).toMatchObject({ lastFullSyncAt: 999, lastRowCount: 7 });
  });

  it("patches the existing watermark row in place instead of inserting a second", async () => {
    const { ctx, tables } = makeActionCtx();
    await runRecordSync(ctx, { lastFullSyncAt: 1, lastRowCount: 1 });
    await runRecordSync(ctx, { lastFullSyncAt: 2, lastRowCount: 50 });
    expect(tables.customersMirrorState).toHaveLength(1);
    expect(tables.customersMirrorState[0]).toMatchObject({ lastFullSyncAt: 2, lastRowCount: 50 });
  });
});

describe("runFullSync (via fullSync / kick handlers)", () => {
  it("throws when FEISHU_BITABLE_APP_TOKEN is unset", async () => {
    delete process.env.FEISHU_BITABLE_APP_TOKEN;
    const { ctx } = makeActionCtx();
    await expect(runFullSync(ctx, {})).rejects.toThrow("FEISHU_BITABLE_APP_TOKEN must be set");
  });

  it("single page (has_more=false): projects+applyPage once then records completion, returns {pages:1, rows:N}", async () => {
    callFeishu.mockResolvedValueOnce({
      items: [item("a", "Acme"), item("b", "Bayer", ownerField("ou_z"))],
      has_more: false,
    });
    const { ctx, tables } = makeActionCtx();
    const out = await runFullSync(ctx, {});
    expect(out).toEqual({ pages: 1, rows: 2 });
    expect(tables.customers).toHaveLength(2);
    // recordSyncCompletion stamped the row count.
    expect(tables.customersMirrorState[0]).toMatchObject({ lastRowCount: 2 });
    // applyPage stored the projection's searchBlob, proving projectionToRow ran.
    expect(tables.customers[0].searchBlob).toContain("Acme");
    // never calls back to write to Bitable — only the read search endpoint.
    expect(callFeishu).toHaveBeenCalledTimes(1);
  });

  it("empty page (items=[]) does NOT call applyPage but still records completion with rows:0", async () => {
    callFeishu.mockResolvedValueOnce({ items: [], has_more: false });
    const { ctx, tables } = makeActionCtx();
    const out = await runFullSync(ctx, {});
    expect(out).toEqual({ pages: 1, rows: 0 });
    expect(tables.customers).toHaveLength(0);
    expect(tables.customersMirrorState[0]).toMatchObject({ lastRowCount: 0 });
    // runMutation only fired for recordSyncCompletion, never applyPage.
    expect(ctx.runMutation).toHaveBeenCalledTimes(1);
  });

  it("a page that omits items entirely is treated as empty (data.items ?? [] at customersMirror.ts:138)", async () => {
    callFeishu.mockResolvedValueOnce({ has_more: false });
    const { ctx, tables } = makeActionCtx();
    const out = await runFullSync(ctx, {});
    expect(out).toEqual({ pages: 1, rows: 0 });
    expect(tables.customers).toHaveLength(0);
  });

  it("has_more=true with page_token loops to page 2 accumulating rows across both applyPage calls", async () => {
    callFeishu
      .mockResolvedValueOnce({ items: [item("a", "P1")], has_more: true, page_token: "t2" })
      .mockResolvedValueOnce({ items: [item("b", "P2")], has_more: false });
    const { ctx, tables } = makeActionCtx();
    const out = await runFullSync(ctx, {});
    expect(out).toEqual({ pages: 2, rows: 2 });
    expect(tables.customers.map((d) => d.name).sort()).toEqual(["P1", "P2"]);
    const secondQuery = (callFeishu.mock.calls[1][1] as CallFeishuOptions).query!;
    expect(secondQuery.page_token).toBe("t2");
  });

  it("breaks the loop after the current page when has_more=true but page_token is missing", async () => {
    callFeishu.mockResolvedValueOnce({ items: [item("a", "Only")], has_more: true });
    const { ctx } = makeActionCtx();
    const out = await runFullSync(ctx, {});
    expect(out).toEqual({ pages: 1, rows: 1 });
    expect(callFeishu).toHaveBeenCalledTimes(1);
  });

  it("stops at MAX_PAGES (20) even when has_more stays true, returning pages:20", async () => {
    callFeishu.mockResolvedValue({ items: [item("p", "P")], has_more: true, page_token: "t" });
    const { ctx } = makeActionCtx();
    const out = await runFullSync(ctx, {});
    expect(out.pages).toBe(20);
    expect(out.rows).toBe(20);
    expect(callFeishu).toHaveBeenCalledTimes(20);
  });

  it("kick delegates to runFullSync and returns the same {pages, rows}", async () => {
    callFeishu.mockResolvedValueOnce({ items: [item("a", "K")], has_more: false });
    const { ctx } = makeActionCtx();
    expect(await runKick(ctx, {})).toEqual({ pages: 1, rows: 1 });
  });
});

describe("searchAndCacheMiss (cache-aside live fill)", () => {
  it("blank/whitespace q short-circuits to {records:[], backfilled:0} without calling Feishu", async () => {
    const { ctx } = makeActionCtx();
    expect(await runSearchAndCacheMiss(ctx, { q: "" })).toEqual({ records: [], backfilled: 0 });
    expect(await runSearchAndCacheMiss(ctx, { q: "  " })).toEqual({ records: [], backfilled: 0 });
    expect(callFeishu).not.toHaveBeenCalled();
  });

  it("hits backfill via applyPage and returns all records when mineFor is undefined", async () => {
    callFeishu.mockResolvedValueOnce({
      items: [item("a", "Acme", ownerField("ou_x")), item("b", "Bayer", ownerField("ou_y"))],
    });
    const { ctx, tables } = makeActionCtx();
    const out = await runSearchAndCacheMiss(ctx, { q: "ac" });
    expect(out.backfilled).toBe(2);
    expect(out.records).toHaveLength(2);
    // backfilled into the mirror so next time is a fast-path hit.
    expect(tables.customers).toHaveLength(2);
    const opts = callFeishu.mock.calls[0][1] as CallFeishuOptions;
    const filter = (opts.json as { filter: { conjunction: string } }).filter;
    expect(filter.conjunction).toBe("or");
  });

  it("zero hits (data.items undefined) does NOT call applyPage and returns backfilled:0", async () => {
    callFeishu.mockResolvedValueOnce({});
    const { ctx, tables } = makeActionCtx();
    const out = await runSearchAndCacheMiss(ctx, { q: "nope" });
    expect(out).toEqual({ records: [], backfilled: 0 });
    expect(tables.customers).toHaveLength(0);
    expect(ctx.runMutation).not.toHaveBeenCalled();
  });

  it("mineFor filters returned records to owner.openId===mineFor while backfilled reflects ALL fetched rows", async () => {
    callFeishu.mockResolvedValueOnce({
      items: [item("a", "Mine", ownerField("ou_me")), item("b", "Theirs", ownerField("ou_other"))],
    });
    const { ctx, tables } = makeActionCtx();
    const out = await runSearchAndCacheMiss(ctx, { q: "x", mineFor: "ou_me" });
    expect(out.backfilled).toBe(2);
    expect(out.records.map((r: CustomerRecord) => r.name)).toEqual(["Mine"]);
    // both rows still backfilled into the mirror.
    expect(tables.customers).toHaveLength(2);
  });

  it("throws when FEISHU_BITABLE_APP_TOKEN is unset for a non-empty q", async () => {
    delete process.env.FEISHU_BITABLE_APP_TOKEN;
    const { ctx } = makeActionCtx();
    await expect(runSearchAndCacheMiss(ctx, { q: "Acme" })).rejects.toThrow(
      "FEISHU_BITABLE_APP_TOKEN must be set",
    );
  });
});

describe("search (ranked query)", () => {
  // Seed the fake mirror table + watermark directly, then drive search._handler.
  function seeded(rows: Array<Record<string, unknown>>, state?: Record<string, unknown>) {
    const { ctx, tables, searchCalls } = makeActionCtx();
    tables.customers.push(...rows.map((r, i) => ({ _id: `c${i}`, ...r })));
    if (state) tables.customersMirrorState.push({ _id: "s0", ...state });
    return { ctx, searchCalls };
  }

  it("blank q returns {records:[], mirroredAt:<state.lastFullSyncAt>} without touching the search index", async () => {
    const { ctx, searchCalls } = seeded([], { lastFullSyncAt: 4242, lastRowCount: 0 });
    const out = await runSearch(ctx, { q: "  " });
    expect(out).toEqual({ records: [], mirroredAt: 4242 });
    expect(searchCalls).toHaveLength(0);
  });

  it("returns mirroredAt:null when there is no watermark state row", async () => {
    const { ctx } = seeded([]);
    const out = await runSearch(ctx, { q: "" });
    expect(out).toEqual({ records: [], mirroredAt: null });
  });

  it("clamps limit: 0 → 1, 999 → 50, default → 20", async () => {
    const rows = Array.from({ length: 60 }, (_v, i) => ({
      recordId: `r${i}`,
      name: `N${i}`,
      searchBlob: `N${i}`,
    }));
    const a = await runSearch(seeded(rows).ctx, { q: "N", limit: 0 });
    expect(a.records).toHaveLength(1);
    const b = await runSearch(seeded(rows).ctx, { q: "N", limit: 999 });
    expect(b.records).toHaveLength(50);
    const c = await runSearch(seeded(rows).ctx, { q: "N" });
    expect(c.records).toHaveLength(20);
  });

  it("maps search-index hits through mirrorDocToCustomer and returns state.lastFullSyncAt as mirroredAt", async () => {
    const { ctx } = seeded(
      [{ recordId: "rec1", name: "Acme", domain: "acme.io", ownerOpenId: "ou_a", ownerName: "Al", searchBlob: "Acme" }],
      { lastFullSyncAt: 777, lastRowCount: 1 },
    );
    const out = await runSearch(ctx, { q: "Acme", limit: 5 });
    expect(out.mirroredAt).toBe(777);
    expect(out.records[0]).toEqual({
      recordId: "rec1",
      name: "Acme",
      domain: "acme.io",
      fullName: undefined,
      accountNo: undefined,
      countryRegion: undefined,
      owner: { openId: "ou_a", name: "Al" },
    });
  });

  it("adds the .eq('ownerOpenId', mineFor) filter to the search-index builder when mineFor is present", async () => {
    const { ctx, searchCalls } = seeded([
      { recordId: "r1", name: "Mine", ownerOpenId: "ou_me", searchBlob: "Mine" },
      { recordId: "r2", name: "Theirs", ownerOpenId: "ou_other", searchBlob: "Theirs" },
    ]);
    const out = await runSearch(ctx, { q: "x", mineFor: "ou_me" });
    expect(searchCalls[0]).toMatchObject({ field: "searchBlob", q: "x", eqOwner: "ou_me" });
    expect(out.records.map((r: CustomerRecord) => r.name)).toEqual(["Mine"]);
  });

  it("does not add the ownerOpenId filter when mineFor is absent", async () => {
    const { ctx, searchCalls } = seeded([{ recordId: "r1", name: "Any", searchBlob: "Any" }]);
    await runSearch(ctx, { q: "x" });
    expect(searchCalls[0].eqOwner).toBeUndefined();
  });
});
