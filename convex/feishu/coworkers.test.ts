import { describe, expect, it, vi } from "vitest";

import {
  searchCoworkers,
  type Coworker,
  getCachedCoworkerSearch,
  setCoworkerSearchCache,
  type FeishuUser,
  cleanupExpiredCoworkerSearchCache,
  mapCoworkers,
  mapFeishuUserToCoworker,
  coworkerAvatarUrl,
} from "./coworkers";
import type { ActionCtx } from "../_generated/server";

const callFeishuMock = vi.fn();
const resolveFeishuTokenMock = vi.fn();
vi.mock("./call", () => ({
  callFeishu: (...args: unknown[]) => callFeishuMock(...args),
  resolveFeishuToken: (...args: unknown[]) => resolveFeishuTokenMock(...args),
}));

const searchCoworkersHandler = (searchCoworkers as unknown as {
  _handler: (ctx: ActionCtx, args: { sessionId: string; query: string; userAccessToken?: string }) => Promise<Coworker[]>;
})._handler;

type CacheRow = {
  _id: string;
  sessionId: string;
  query: string;
  results: Coworker[];
  cachedAt: number;
  ttlMs: number;
};

type FakeDb = {
  rows: CacheRow[];
  query: (table: string) => FakeQueryBuilder;
  insert: (row: Omit<CacheRow, "_id"> & { _id?: string }) => Promise<string>;
  patch: (id: string, patch: Partial<CacheRow>) => Promise<void>;
  delete: (id: string) => Promise<void>;
};

type FakeConstraintBuilder = {
  eq: (field: keyof CacheRow, value: unknown) => FakeConstraintBuilder;
  lt: (field: keyof CacheRow, value: number) => FakeConstraintBuilder;
};

type FakeQueryBuilder = {
  withIndex: (name: string, callback: (q: FakeConstraintBuilder) => unknown) => FakeQueryChainAfterIndex;
};

type FakeQueryChainAfterIndex = {
  unique: () => Promise<CacheRow | null>;
  order: (dir: "desc") => FakeQueryBuilder;
  take: (n: number) => Promise<CacheRow[]>;
};

const makeFakeDb = (initialRows: CacheRow[] = []): FakeDb => {
  const rows = [...initialRows];
  let nextId = rows.length;

  type Constraint =
    | { op: "eq"; field: keyof CacheRow; value: unknown }
    | { op: "lt"; field: keyof CacheRow; value: number };

  const matches = (row: CacheRow, constraint: Constraint) => {
    if (constraint.op === "eq") return row[constraint.field] === constraint.value;
    return typeof row[constraint.field] === "number" && row[constraint.field] < constraint.value;
  };

  const uniqueQuery = (constraints: Constraint[]) => {
    return rows.find((row) => constraints.every((constraint) => matches(row, constraint))) ?? null;
  };

  const chainFactory = (constraints: Constraint[]): FakeQueryBuilder => {
    let order: "desc" | undefined;

    const q: FakeConstraintBuilder = {
      eq: (field, value) => {
        constraints.push({ op: "eq", field, value });
        return q;
      },
      lt: (field, value) => {
        constraints.push({ op: "lt", field, value });
        return q;
      },
    };

    const listRows = () => rows.filter((row) => constraints.every((constraint) => matches(row, constraint)));

    const chainAfterIndex: FakeQueryBuilder = {
      withIndex: () => {
        throw new Error("invalid: withIndex should not be called after withIndex");
      },
      unique: async () => uniqueQuery(constraints),
      order: (dir: "desc") => {
        order = dir;
        return chainAfterIndex;
      },
      take: async (n: number) => {
        if (order === "desc") {
          return [...listRows()].sort((a, b) => b.cachedAt - a.cachedAt).slice(0, n);
        }
        return listRows().slice(0, n);
      },
    };

    return {
      withIndex: (_name: string, callback: (qArg: FakeConstraintBuilder) => unknown) => {
        callback(q);
        return chainAfterIndex;
      },
    };
  };

  return {
    rows,
    query: (_table: string) => {
      return chainFactory([]);
    },
    insert: async (row: Omit<CacheRow, "_id"> & { _id?: string }) => {
      const id = row._id ?? `cache_${nextId++}`;
      rows.push({ ...row, _id: id });
      return id;
    },
    patch: async (id: string, patch: Partial<CacheRow>) => {
      const index = rows.findIndex((row) => row._id === id);
      if (index >= 0) {
        rows[index] = { ...rows[index], ...patch };
      }
    },
    delete: async (id: string) => {
      const index = rows.findIndex((row) => row._id === id);
      if (index >= 0) rows.splice(index, 1);
    },
  };
};

const getCachedCoworkerSearchHandler = (getCachedCoworkerSearch as unknown as {
  _handler: (ctx: { db: FakeDb }, args: { sessionId: string; query: string }) => Promise<{ cachedAt: number; results: Coworker[] } | null>;
})._handler;

const setCoworkerSearchCacheHandler = (setCoworkerSearchCache as unknown as {
  _handler: (ctx: { db: FakeDb }, args: {
    sessionId: string;
    query: string;
    results: Coworker[];
    ttlMs: number;
  }) => Promise<void>;
})._handler;

const cleanupExpiredCoworkerSearchCacheHandler = (cleanupExpiredCoworkerSearchCache as unknown as {
  _handler: (ctx: { db: FakeDb }, args: Record<string, never>) => Promise<{ deleted: number }>;
})._handler;

describe("Coworker Search Users mapping", () => {
  it("maps open_id, name, and avatar_72", () => {
    const user: FeishuUser = {
      open_id: "ou_jenny",
      name: "Jenny Xu",
      avatar: { avatar_72: "https://feishu/avatar-72.png" },
    };

    expect(mapFeishuUserToCoworker(user)).toEqual({
      openId: "ou_jenny",
      name: "Jenny Xu",
      avatarUrl: "https://feishu/avatar-72.png",
    });
  });

  it("falls back to larger Feishu avatar fields when avatar_72 is absent", () => {
    expect(
      coworkerAvatarUrl({
        open_id: "ou_big",
        name: "Big Avatar",
        avatar: { avatar_240: "https://feishu/avatar-240.png" },
      }),
    ).toBe("https://feishu/avatar-240.png");
  });

  it("falls back to top-level avatar_url when the avatar object is absent", () => {
    expect(
      coworkerAvatarUrl({
        open_id: "ou_top",
        name: "Top Level Avatar",
        avatar_url: "https://feishu/avatar-url.png",
      }),
    ).toBe("https://feishu/avatar-url.png");
  });

  it("returns [] when Search Users returns no users array", () => {
    expect(mapCoworkers({})).toEqual([]);
  });
});

describe("Coworker search cache internals", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns cached hit when entry is fresh and query-normalized", async () => {
    const db = makeFakeDb([
      {
        _id: "cached-1",
        sessionId: "sess-cache",
        query: "alice",
        cachedAt: 9000,
        ttlMs: 5000,
        results: [{ openId: "ou_cached", name: "Alice Cached", avatarUrl: "https://feishu/avatar-old.png" }],
      },
    ]);

    vi.spyOn(Date, "now").mockReturnValue(10000);

    const found = await getCachedCoworkerSearchHandler(
      { db },
      { sessionId: "sess-cache", query: "  Alice " },
    );

    expect(found).toEqual({
      cachedAt: 9000,
      results: [{ openId: "ou_cached", name: "Alice Cached", avatarUrl: "https://feishu/avatar-old.png" }],
    });
  });

  it("returns null for stale cache entries", async () => {
    const db = makeFakeDb([
      {
        _id: "cached-1",
        sessionId: "sess-cache",
        query: "alice",
        cachedAt: 1000,
        ttlMs: 1000,
        results: [{ openId: "ou_cached", name: "Alice Cached", avatarUrl: "https://feishu/avatar-old.png" }],
      },
    ]);

    vi.spyOn(Date, "now").mockReturnValue(10000);

    const found = await getCachedCoworkerSearchHandler(
      { db },
      { sessionId: "sess-cache", query: "Alice" },
    );

    expect(found).toBeNull();
  });

  it("updates existing cache entry instead of duplicating", async () => {
    const db = makeFakeDb([
      {
        _id: "cached-1",
        sessionId: "sess-upsert",
        query: "alice",
        cachedAt: 1000,
        ttlMs: 1000,
        results: [{ openId: "ou_cached", name: "Old Alice" }],
      },
    ]);

    vi.spyOn(Date, "now").mockReturnValue(5000);

    await setCoworkerSearchCacheHandler({ db }, {
      sessionId: "sess-upsert",
      query: "Alice",
      results: [{ openId: "ou_cached", name: "Fresh Alice" }],
      ttlMs: 3000,
    });

    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({
      query: "alice",
      cachedAt: 5000,
      ttlMs: 3000,
      results: [{ openId: "ou_cached", name: "Fresh Alice" }],
    });
  });

  it("deletes expired cache rows during scheduled cleanup", async () => {
    const db = makeFakeDb([
      {
        _id: "stale-1",
        sessionId: "sess-old",
        query: "alice",
        cachedAt: 1000,
        ttlMs: 1000,
        results: [{ openId: "ou_old", name: "Old Alice" }],
      },
      {
        _id: "fresh-1",
        sessionId: "sess-new",
        query: "bob",
        cachedAt: 9 * 60 * 1000,
        ttlMs: 1000,
        results: [{ openId: "ou_new", name: "Fresh Bob" }],
      },
    ]);

    vi.spyOn(Date, "now").mockReturnValue(10 * 60 * 1000);

    await expect(cleanupExpiredCoworkerSearchCacheHandler({ db }, {})).resolves.toEqual({
      deleted: 1,
    });
    expect(db.rows.map((row) => row._id)).toEqual(["fresh-1"]);
  });

  it("cleans up duplicate cache entries when normalizing query collisions occur", async () => {
    const db = makeFakeDb([
      {
        _id: "cached-old-1",
        sessionId: "sess-upsert",
        query: "alice",
        cachedAt: 1000,
        ttlMs: 1000,
        results: [{ openId: "ou_cached", name: "Old Alice" }],
      },
      {
        _id: "cached-old-2",
        sessionId: "sess-upsert",
        query: "alice",
        cachedAt: 2000,
        ttlMs: 1000,
        results: [{ openId: "ou_cached_2", name: "Rogue Alice" }],
      },
    ]);

    vi.spyOn(Date, "now").mockReturnValue(5000);

    await setCoworkerSearchCacheHandler({ db }, {
      sessionId: "sess-upsert",
      query: " Alice ",
      results: [{ openId: "ou_cached", name: "Fresh Alice" }],
      ttlMs: 3000,
    });

    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({
      query: "alice",
      cachedAt: 5000,
      ttlMs: 3000,
      results: [{ openId: "ou_cached", name: "Fresh Alice" }],
    });
  });
});

describe("searchCoworkers action cache behavior", () => {
  const userOpenSearch = {
    users: [
      {
        open_id: "ou_cached",
        name: "Alice One",
        avatar: { avatar_240: "https://feishu/avatar.png" },
      },
    ],
  };

  afterEach(() => {
    callFeishuMock.mockReset();
    resolveFeishuTokenMock.mockReset();
    vi.restoreAllMocks();
  });

  it("validates the server session before returning cached coworkers", async () => {
    resolveFeishuTokenMock.mockResolvedValue("resolved-token");
    const runQuery = vi.fn(async () => ({
      cachedAt: Date.now(),
      results: [{ openId: "ou_cached", name: "Cached Alice", avatarUrl: "https://feishu/cached.png" }],
    }));
    const runMutation = vi.fn(async () => undefined);

    const ctx = { runQuery, runMutation } as unknown as ActionCtx;

    const found = await searchCoworkersHandler(ctx, {
      sessionId: "sess-1",
      query: "  ALICE  ",
    });

    expect(found).toEqual([{ openId: "ou_cached", name: "Cached Alice", avatarUrl: "https://feishu/cached.png" }]);
    expect(resolveFeishuTokenMock).toHaveBeenCalledWith(ctx, "user", "sess-1");
    expect(runQuery).toHaveBeenCalledWith(expect.anything(), {
      sessionId: "sess-1",
      query: "alice",
    });
    expect(callFeishuMock).not.toHaveBeenCalled();
    expect(runMutation).not.toHaveBeenCalled();
  });

  it("falls back to Feishu when cache is cold", async () => {
    const runQuery = vi.fn(async () => null);
    const runMutation = vi.fn(async () => undefined);
    resolveFeishuTokenMock.mockResolvedValue("resolved-token");
    callFeishuMock.mockResolvedValue(userOpenSearch);

    const ctx = { runQuery, runMutation } as unknown as ActionCtx;

    const found = await searchCoworkersHandler(ctx, {
      sessionId: "sess-2",
      query: "  Alice  ",
    });

    expect(runQuery).toHaveBeenCalledTimes(1);
    expect(runQuery).toHaveBeenCalledWith(expect.anything(), {
      sessionId: "sess-2",
      query: "alice",
    });

    expect(callFeishuMock).toHaveBeenCalledTimes(1);
    const [passedCtx, feishuOpts] = callFeishuMock.mock.calls[0];
    expect(passedCtx).toBe(ctx);
    expect(feishuOpts).toMatchObject({
      path: "/search/v1/user",
      query: { query: "Alice", page_size: "20" },
      auth: "user",
      sessionId: "sess-2",
      token: "resolved-token",
      label: "Coworker search",
    });
    expect(found).toEqual([{ openId: "ou_cached", name: "Alice One", avatarUrl: "https://feishu/avatar.png" }]);

    expect(runMutation).toHaveBeenCalledWith(expect.anything(), {
      sessionId: "sess-2",
      query: "alice",
      results: [{ openId: "ou_cached", name: "Alice One", avatarUrl: "https://feishu/avatar.png" }],
      ttlMs: 5 * 60 * 1000,
    });
  });


  it("bypasses the shared server cache for browser-held fallback tokens", async () => {
    const runQuery = vi.fn(async () => ({
      cachedAt: Date.now(),
      results: [{ openId: "ou_cached", name: "Cached Alice" }],
    }));
    const runMutation = vi.fn(async () => undefined);
    callFeishuMock.mockResolvedValue(userOpenSearch);

    const ctx = { runQuery, runMutation } as unknown as ActionCtx;

    const found = await searchCoworkersHandler(ctx, {
      sessionId: "sess-fallback",
      query: "Alice",
      userAccessToken: "fallback-token",
    });

    expect(found).toEqual([{ openId: "ou_cached", name: "Alice One", avatarUrl: "https://feishu/avatar.png" }]);
    expect(resolveFeishuTokenMock).not.toHaveBeenCalled();
    expect(runQuery).not.toHaveBeenCalled();
    expect(runMutation).not.toHaveBeenCalled();
    expect(callFeishuMock).toHaveBeenCalledWith(ctx, expect.objectContaining({
      token: "fallback-token",
    }));
  });

  it("returns [] for blank query before cache/match and without token roundtrip", async () => {
    const runQuery = vi.fn(async () => null);
    const runMutation = vi.fn(async () => undefined);
    const ctx = { runQuery, runMutation } as unknown as ActionCtx;

    const found = await searchCoworkersHandler(ctx, {
      sessionId: "sess-3",
      query: "   ",
    });

    expect(found).toEqual([]);
    expect(runQuery).not.toHaveBeenCalled();
    expect(runMutation).not.toHaveBeenCalled();
    expect(callFeishuMock).not.toHaveBeenCalled();
  });
});
