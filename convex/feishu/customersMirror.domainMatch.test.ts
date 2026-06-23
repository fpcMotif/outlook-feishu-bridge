// Handler tests for the Customer mirror DOMAIN-MATCH surface: the mirror-index
// lookup (matchByEmail) and the on-demand live cache-miss probe
// (matchEmailAndCacheMiss). The pure strict-canonical paging strategy the
// cache-miss handler delegates to is pinned in customerDomainMatchEngine.test.ts;
// these tests cover the Convex adapter — the cooldown gate, the alias
// canonicalization, the backfill, and the domainKey-first index order.

import { describe, expect, it, vi } from "vitest";

import {
  installMirrorTestEnv,
  matchByEmailHandler,
  matchEmailAndCacheMissHandler,
  mockCallFeishu,
} from "./customersMirror.testkit";

vi.mock("./call", () => ({
  callFeishu: vi.fn(),
}));

installMirrorTestEnv();

// db mock for matchByEmail: each named index resolves to a fixed row (or null),
// and every probe records which index was hit with what key so the tests can
// lock the domainKey-first / raw-domain-fallback order.
function customersIndexDb(rowsByIndex: Record<string, Record<string, unknown> | null>) {
  const probes: Array<{ index: string; value: unknown }> = [];
  const query = vi.fn(() => ({
    withIndex: (
      name: string,
      callback: (q: { eq: (field: string, value: unknown) => unknown }) => unknown,
    ) => {
      let captured: unknown;
      callback({
        eq: (_field, value) => {
          captured = value;
          return {};
        },
      });
      probes.push({ index: name, value: captured });
      return { first: async () => rowsByIndex[name] ?? null };
    },
  }));
  return { query, probes };
}

describe("customer mirror domain match (matchByEmail)", () => {
  it("matches via the canonical domainKey index even when the raw 域名 cell has casing", async () => {
    const row = { recordId: "rec_acme", name: "Acme", domain: "Acme.COM", domainKey: "acme.com" };
    const { query, probes } = customersIndexDb({ by_domainKey: row });

    const result = await matchByEmailHandler({ db: { query } }, { email: "buyer@ACME.com" });

    expect(result.customer?.recordId).toBe("rec_acme");
    expect(probes).toEqual([{ index: "by_domainKey", value: "acme.com" }]);
  });

  it("falls back to the raw-domain index for rows synced before domainKey existed", async () => {
    const row = { recordId: "rec_legacy", name: "Legacy", domain: "legacy.example" };
    const { query, probes } = customersIndexDb({ by_domainKey: null, by_domain: row });

    const result = await matchByEmailHandler({ db: { query } }, { email: "buyer@legacy.example" });

    expect(result.customer?.recordId).toBe("rec_legacy");
    expect(probes.map((probe) => probe.index)).toEqual(["by_domainKey", "by_domain"]);
  });
});

describe("customer mirror domain cache-miss (matchEmailAndCacheMiss)", () => {
  it("skips live Feishu entirely for text without an email domain", async () => {
    const runMutation = vi.fn();

    const result = await matchEmailAndCacheMissHandler({ runMutation }, { email: "not-an-email" });

    expect(result).toEqual({ customer: null, backfilled: 0 });
    expect(mockCallFeishu).not.toHaveBeenCalled();
    expect(runMutation).not.toHaveBeenCalled();
  });

  it("backfills one bounded filtered page and returns only the exact canonical match", async () => {
    mockCallFeishu.mockResolvedValueOnce({
      items: [
        {
          record_id: "rec_super",
          fields: {
            "Account Name": [{ text: "Not Acme", type: "text" }],
            域名: [{ text: "notacme.com", type: "text" }],
          },
        },
        {
          record_id: "rec_acme",
          fields: {
            "Account Name": [{ text: "Acme", type: "text" }],
            域名: [{ text: "Acme.COM", type: "text" }],
          },
        },
      ],
      has_more: false,
    });
    const runMutation = vi.fn(async (_fn: unknown, args: Record<string, unknown>) => {
      if (typeof args.cooldownMs === "number") return { started: true };
      return { inserted: 2, updated: 0, unchanged: 0, duplicateRows: 0 };
    });

    const result = await matchEmailAndCacheMissHandler({ runMutation }, { email: "buyer@acme.com" });

    // `contains` pulls in the superstring domain too — it belongs in the
    // mirror, but only the strict canonical match may auto-select.
    expect(result.backfilled).toBe(2);
    expect(result.customer?.recordId).toBe("rec_acme");
    expect(mockCallFeishu).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        label: "Customers mirror — live domain match on cache miss",
        query: { page_size: "50" },
        json: expect.objectContaining({
          filter: {
            conjunction: "and",
            conditions: [{ field_name: "域名", operator: "contains", value: ["acme.com"] }],
          },
        }),
      }),
    );
    // calls[0] = cooldown gate, calls[1] = applyPage
    expect(runMutation).toHaveBeenCalledTimes(2);
    const upsert = runMutation.mock.calls[1]?.[1] as {
      rows: Array<{ recordId: string; domainKey?: string }>;
    };
    expect(upsert.rows.find((row) => row.recordId === "rec_acme")?.domainKey).toBe("acme.com");
  });

  it("queries Feishu with the alias-canonicalized domain and skips the upsert on empty results", async () => {
    mockCallFeishu.mockResolvedValueOnce({ items: [], has_more: false });
    const runMutation = vi.fn(
      async (
        _fn: unknown,
        args: Record<string, unknown>,
      ): Promise<{ started: boolean; remainingMs?: number } | { inserted: number; updated: number; unchanged: number; duplicateRows: number }> => {
        if (typeof args.cooldownMs === "number") return { started: true };
        throw new Error("unexpected runMutation call");
      },
    );

    const result = await matchEmailAndCacheMissHandler(
      { runMutation },
      { email: "buyer@microsoftonline.com" },
    );

    expect(result).toEqual({ customer: null, backfilled: 0 });
    // cooldown gate fires once; no applyPage since Feishu returned empty
    expect(runMutation).toHaveBeenCalledTimes(1);
    expect(mockCallFeishu).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        json: expect.objectContaining({
          filter: expect.objectContaining({
            conditions: [{ field_name: "域名", operator: "contains", value: ["microsoft.com"] }],
          }),
        }),
      }),
    );
  });

  it("returns null immediately when the per-domain cooldown gate denies the probe", async () => {
    const runMutation = vi.fn(
      async (
        _fn: unknown,
        args: Record<string, unknown>,
      ): Promise<{ started: boolean; remainingMs?: number } | { inserted: number; updated: number; unchanged: number; duplicateRows: number }> => {
        if (typeof args.cooldownMs === "number") return { started: false, remainingMs: 600_000 };
        throw new Error("unexpected runMutation call");
      },
    );

    const result = await matchEmailAndCacheMissHandler({ runMutation }, { email: "buyer@acme.com" });

    expect(result).toEqual({ customer: null, backfilled: 0 });
    // Cooldown gate fires but Feishu is never probed.
    expect(mockCallFeishu).not.toHaveBeenCalled();
    expect(runMutation).toHaveBeenCalledTimes(1);
  });

  it("paginates up to MAX_CACHE_MISS_PAGES (3) and upserts all records in a single applyPage", async () => {
    // Use superstring domains so each page returns rows (Feishu `contains` filter
    // would match them in prod) but none is a strict canonical match for the
    // email's domain, so the loop never short-circuits and reaches all 3 pages.
    mockCallFeishu
      .mockResolvedValueOnce({
        items: [
          {
            record_id: "rec_p1",
            fields: {
              "Account Name": [{ text: "Super Paginate Co", type: "text" }],
              "域名": [{ text: "superpaginate.com", type: "text" }],
            },
          },
        ],
        has_more: true,
        page_token: "tok2",
      })
      .mockResolvedValueOnce({
        items: [
          {
            record_id: "rec_p2",
            fields: {
              "Account Name": [{ text: "Mega Paginate Co", type: "text" }],
              "域名": [{ text: "megapaginate.com", type: "text" }],
            },
          },
        ],
        has_more: true,
        page_token: "tok3",
      })
      .mockResolvedValueOnce({
        items: [
          {
            record_id: "rec_p3",
            fields: { "Account Name": [{ text: "Plain Paginate Co", type: "text" }] },
          },
        ],
        has_more: false,
      });

    const upsertedRows: Array<{ recordId: string }> = [];
    const runMutation = vi.fn(
      async (
        _fn: unknown,
        args: Record<string, unknown>,
      ): Promise<{ started: boolean; remainingMs?: number } | { inserted: number; updated: number; unchanged: number; duplicateRows: number }> => {
        if (typeof args.cooldownMs === "number") return { started: true };
        if (Array.isArray(args.rows)) {
          upsertedRows.push(...(args.rows as Array<{ recordId: string }>));
          return { inserted: args.rows.length, updated: 0, unchanged: 0, duplicateRows: 0 };
        }
        throw new Error("unexpected runMutation call");
      },
    );

    // "paginate.com" has no strict match in any page — loop runs to the cap (3).
    const result = await matchEmailAndCacheMissHandler({ runMutation }, { email: "buyer@paginate.com" });

    expect(mockCallFeishu).toHaveBeenCalledTimes(3);
    expect(upsertedRows).toHaveLength(3);
    // Single applyPage call despite 3 pages (all-records accumulation).
    expect(runMutation).toHaveBeenCalledTimes(2); // cooldown + applyPage
    expect(result.backfilled).toBe(3);
    expect(result.customer).toBeNull(); // no strict canonical match for paginate.com
  });
});
