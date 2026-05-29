// useCustomerSearch composite hook (ADR-0013 + ADR-0016). It bundles the
// Customer Directory preload and server-side search behind one interface; a
// build-time flag (VITE_CUSTOMER_SEARCH_MODE) selects the data layer.
//
// SEARCH_MODE is FROZEN at module load from import.meta.env, so the two branches
// cannot coexist in one import. The default (no env) tests use a normal import;
// the "server-index" tests use vi.resetModules() + vi.stubEnv + a dynamic import
// so the module re-reads the env. convex/react (useAction/useConvex) and the
// sibling useCustomerDirectory hook are both mocked.

/* eslint-disable max-lines-per-function */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CustomerDirectoryState,
  CustomerRecord,
} from "../components/taskpane/customers";

// --- convex/react mock --------------------------------------------------------
// useAction is called twice (searchCustomers, kick, searchAndCacheMiss); the
// hook keys nothing off the FunctionReference, so we hand back a per-test fn by
// call order isn't reliable — instead we dispatch on a tagged ref. The generated
// `api` import is harmless under this mock; we tag each action via a registry.
let legacyAction: (args: { query: string }) => Promise<{ records: CustomerRecord[] }>;
let kickAction: (args: Record<string, never>) => Promise<{ pages: number; rows: number }>;
let searchAndCacheMissAction: (args: {
  q: string;
  mineFor?: string;
}) => Promise<{ records: CustomerRecord[]; backfilled: number }>;
let convexQuery: (ref: unknown, args: unknown) => Promise<{ records: CustomerRecord[] }>;

// Route each useAction(ref) to the right mock by the FunctionReference's stable
// path (getFunctionName), NOT object identity — identity breaks across the
// vi.resetModules() the server-index tests use to re-freeze SEARCH_MODE, since
// the re-imported `api` produces fresh ref objects. The path string survives.
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useAction: (ref: unknown) => {
      const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
      if (name === "feishu/customers:searchCustomers")
        return (...a: unknown[]) => legacyAction(...(a as [{ query: string }]));
      if (name === "feishu/customersMirror:kick")
        return (...a: unknown[]) => kickAction(...(a as [Record<string, never>]));
      if (name === "feishu/customersMirror:searchAndCacheMiss")
        return (...a: unknown[]) => searchAndCacheMissAction(...(a as [{ q: string; mineFor?: string }]));
      throw new Error(`unexpected useAction ref: ${name}`);
    },
    useConvex: () => ({ query: (ref: unknown, args: unknown) => convexQuery(ref, args) }),
  };
});

// --- useCustomerDirectory mock -----------------------------------------------
const directoryRefresh = vi.fn();
let directoryState: CustomerDirectoryState = { status: "ready", records: [] };
vi.mock("./useCustomerDirectory", () => ({
  useCustomerDirectory: vi.fn(() => ({ state: directoryState, refresh: directoryRefresh })),
}));

const BAYER: CustomerRecord = {
  recordId: "rec_bayer",
  name: "Bayer",
  domain: "bayer.example",
  owner: { openId: "ou_flo", name: "Florian" },
};
const NOVO: CustomerRecord = {
  recordId: "rec_novo",
  name: "Novo",
  domain: "novo.example",
  owner: { openId: "ou_jenny", name: "Jenny" },
};
const NO_OWNER: CustomerRecord = {
  recordId: "rec_x",
  name: "Orphan Co",
  owner: null,
};

beforeEach(() => {
  directoryRefresh.mockReset();
  directoryState = { status: "ready", records: [] };
  legacyAction = vi.fn(() => Promise.resolve({ records: [] }));
  kickAction = vi.fn(() => Promise.resolve({ pages: 1, rows: 0 }));
  searchAndCacheMissAction = vi.fn(() => Promise.resolve({ records: [], backfilled: 0 }));
  convexQuery = vi.fn(() => Promise.resolve({ records: [] }));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// =============================================================================
// PRELOAD MODE — default import (no VITE_CUSTOMER_SEARCH_MODE / not server-index)
// =============================================================================
describe("useCustomerSearch preload mode", () => {
  // Imported fresh so the default SEARCH_MODE ("preload") is frozen at load.
  async function loadPreload() {
    const mod = await import("./useCustomerSearch");
    return mod.useCustomerSearch;
  }

  it("search('') and search('   ') return [] without hitting any action (trim guard)", async () => {
    const useCustomerSearch = await loadPreload();
    const { result } = renderHook(() => useCustomerSearch(true));

    await act(async () => {
      expect(await result.current.search("")).toEqual([]);
      expect(await result.current.search("   ")).toEqual([]);
    });

    expect(legacyAction).not.toHaveBeenCalled();
  });

  it("search(q) calls legacyAction({query:q}) and returns records unfiltered when mineFor is undefined", async () => {
    legacyAction = vi.fn(() => Promise.resolve({ records: [BAYER, NOVO] }));
    const useCustomerSearch = await loadPreload();
    const { result } = renderHook(() => useCustomerSearch(true));

    let out: CustomerRecord[] = [];
    await act(async () => {
      out = await result.current.search("  bay  ");
    });

    expect(legacyAction).toHaveBeenCalledWith({ query: "bay" });
    expect(out).toEqual([BAYER, NOVO]);
  });

  it("search(q,{mineFor}) filters legacyAction records to owner.openId===mineFor, excluding owner:null", async () => {
    legacyAction = vi.fn(() => Promise.resolve({ records: [BAYER, NOVO, NO_OWNER] }));
    const useCustomerSearch = await loadPreload();
    const { result } = renderHook(() => useCustomerSearch(true));

    let out: CustomerRecord[] = [];
    await act(async () => {
      out = await result.current.search("co", { mineFor: "ou_flo" });
    });

    // Only Bayer is owned by ou_flo; Novo (ou_jenny) and the owner:null row drop.
    expect(out).toEqual([BAYER]);
  });

  it("triggerRefresh() delegates to the directory hook's refresh()", async () => {
    const useCustomerSearch = await loadPreload();
    const { result } = renderHook(() => useCustomerSearch(true));

    act(() => {
      result.current.triggerRefresh();
    });

    expect(directoryRefresh).toHaveBeenCalledTimes(1);
    // Server-index-only actions are never touched in preload mode.
    expect(kickAction).not.toHaveBeenCalled();
  });

  it("exposedDirectory equals the directory hook's state and reflects loading->ready", async () => {
    directoryState = { status: "loading", records: [] };
    const useCustomerSearch = await loadPreload();
    const { result, rerender } = renderHook(() => useCustomerSearch(true));

    expect(result.current.directory).toEqual({ status: "loading", records: [] });

    directoryState = { status: "ready", records: [BAYER] };
    rerender();
    expect(result.current.directory).toEqual({ status: "ready", records: [BAYER] });
  });
});

// =============================================================================
// SERVER-INDEX MODE — re-imported with VITE_CUSTOMER_SEARCH_MODE=server-index
// =============================================================================
describe("useCustomerSearch server-index mode", () => {
  // Re-read the module so SEARCH_MODE freezes to "server-index".
  async function loadServerIndex() {
    vi.resetModules();
    vi.stubEnv("VITE_CUSTOMER_SEARCH_MODE", "server-index");
    const mod = await import("./useCustomerSearch");
    return mod.useCustomerSearch;
  }

  it("search hits convex.query and returns records on a mirror HIT without calling searchAndCacheMiss", async () => {
    convexQuery = vi.fn(() => Promise.resolve({ records: [BAYER, NOVO] }));
    const useCustomerSearch = await loadServerIndex();
    const { result } = renderHook(() => useCustomerSearch(true));

    let out: CustomerRecord[] = [];
    await act(async () => {
      out = await result.current.search("bay");
    });

    expect(convexQuery).toHaveBeenCalledTimes(1);
    expect(out).toEqual([BAYER, NOVO]);
    expect(searchAndCacheMissAction).not.toHaveBeenCalled();
  });

  it("falls through to searchAndCacheMiss on a mirror MISS (empty hit) and returns its live records", async () => {
    convexQuery = vi.fn(() => Promise.resolve({ records: [] }));
    searchAndCacheMissAction = vi.fn(() => Promise.resolve({ records: [NOVO], backfilled: 3 }));
    const useCustomerSearch = await loadServerIndex();
    const { result } = renderHook(() => useCustomerSearch(true));

    let out: CustomerRecord[] = [];
    await act(async () => {
      out = await result.current.search("novo");
    });

    expect(convexQuery).toHaveBeenCalledTimes(1);
    expect(searchAndCacheMissAction).toHaveBeenCalledTimes(1);
    expect(out).toEqual([NOVO]);
  });

  it("passes {q} when mineFor undefined and {q,mineFor} when set, to BOTH convex.query and searchAndCacheMiss", async () => {
    convexQuery = vi.fn(() => Promise.resolve({ records: [] })); // force the miss path too
    searchAndCacheMissAction = vi.fn(() => Promise.resolve({ records: [], backfilled: 0 }));
    const useCustomerSearch = await loadServerIndex();
    const { result } = renderHook(() => useCustomerSearch(true));

    await act(async () => {
      await result.current.search(" acme ");
    });
    // mineFor undefined -> bare { q }
    expect(convexQuery).toHaveBeenLastCalledWith(expect.anything(), { q: "acme" });
    expect(searchAndCacheMissAction).toHaveBeenLastCalledWith({ q: "acme" });

    await act(async () => {
      await result.current.search("acme", { mineFor: "ou_flo" });
    });
    // mineFor set -> { q, mineFor }
    expect(convexQuery).toHaveBeenLastCalledWith(expect.anything(), { q: "acme", mineFor: "ou_flo" });
    expect(searchAndCacheMissAction).toHaveBeenLastCalledWith({ q: "acme", mineFor: "ou_flo" });
  });

  it("blank query short-circuits to [] before touching convex.query (trim guard in server-index mode)", async () => {
    const useCustomerSearch = await loadServerIndex();
    const { result } = renderHook(() => useCustomerSearch(true));

    let out: CustomerRecord[] = [];
    await act(async () => {
      out = await result.current.search("   ");
    });

    expect(out).toEqual([]);
    expect(convexQuery).not.toHaveBeenCalled();
  });

  it("triggerRefresh() calls kickAction({}) and does NOT delegate to directory.refresh", async () => {
    kickAction = vi.fn(() => Promise.resolve({ pages: 2, rows: 5 }));
    const useCustomerSearch = await loadServerIndex();
    const { result } = renderHook(() => useCustomerSearch(true));

    act(() => {
      result.current.triggerRefresh();
    });

    await waitFor(() => expect(kickAction).toHaveBeenCalledWith({}));
    expect(directoryRefresh).not.toHaveBeenCalled();
  });

  it("triggerRefresh() swallows a kickAction rejection without an unhandled rejection", async () => {
    kickAction = vi.fn(() => Promise.reject(new Error("mirror sync boom")));
    const useCustomerSearch = await loadServerIndex();
    const { result } = renderHook(() => useCustomerSearch(true));

    // If the catch did not swallow, this would surface as an unhandled rejection
    // and fail the test run. We assert the kick was attempted and nothing throws.
    await act(async () => {
      result.current.triggerRefresh();
      // let the rejected promise + .catch settle
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(kickAction).toHaveBeenCalledTimes(1);
  });

  it("triggerRefresh() also swallows a non-Error kickAction rejection (String(error) branch)", async () => {
    kickAction = vi.fn(() => Promise.reject("string rejection"));
    const useCustomerSearch = await loadServerIndex();
    const { result } = renderHook(() => useCustomerSearch(true));

    await act(async () => {
      result.current.triggerRefresh();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(kickAction).toHaveBeenCalledTimes(1);
  });

  it("exposedDirectory is the synthetic {status:'ready', records:[]} (no preload in server-index mode)", async () => {
    // Even if the underlying directory hook reported rows, server-index mode
    // exposes an empty ready directory so the picker delegates to server search.
    directoryState = { status: "ready", records: [BAYER, NOVO] };
    const useCustomerSearch = await loadServerIndex();
    const { result } = renderHook(() => useCustomerSearch(true));

    expect(result.current.directory).toEqual({ status: "ready", records: [] });
  });
});
