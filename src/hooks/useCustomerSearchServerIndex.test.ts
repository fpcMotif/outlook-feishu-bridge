// Transport-level tests for the server-index Customer search hook. The
// mirror-vs-live STRATEGY lives server-side (customerSearchEngine.test.ts);
// what is pinned here is the client's transport behaviour: debounce, request
// coalescing, empty-live-result suppression, and the domain negative-cache TTL.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useCustomerSearchServerIndex } from "./useCustomerSearchServerIndex";

import * as convexReact from "convex/react";

vi.mock("convex/react", () => ({
  useAction: vi.fn(),
  useConvex: vi.fn(),
}));

const mockUseAction = vi.mocked(convexReact.useAction);
const mockUseConvex = vi.mocked(convexReact.useConvex);

describe("useCustomerSearchServerIndex", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    mockUseConvex.mockReturnValue({ query: vi.fn() } as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("skips the server search for one-character queries (round-trip saver; the engine backstops)", async () => {
    const query = vi.fn();
    const searchCustomers = vi.fn();
    mockUseConvex.mockReturnValue({ query } as never);
    mockUseAction.mockReturnValueOnce(searchCustomers).mockReturnValueOnce(vi.fn());

    const { result } = renderHook(() => useCustomerSearchServerIndex());

    await expect(result.current.search(" a ")).resolves.toEqual([]);

    expect(query).not.toHaveBeenCalled();
    expect(searchCustomers).not.toHaveBeenCalled();
  });

  it("skips Convex match-by-email for invalid email domains", async () => {
    const query = vi.fn();
    const searchCustomers = vi.fn();
    mockUseConvex.mockReturnValue({ query } as never);
    mockUseAction.mockReturnValueOnce(searchCustomers).mockReturnValueOnce(vi.fn());

    const { result } = renderHook(() => useCustomerSearchServerIndex());

    await expect(result.current.matchEmail("buyer@")).resolves.toBeNull();

    expect(query).not.toHaveBeenCalled();
  });

  it("coalesces repeated in-flight match-by-email calls for the same domain", async () => {
    let resolveQuery!: (value: { customer: { recordId: string; name: string; owner: null } }) => void;
    const pendingQuery = new Promise<{ customer: { recordId: string; name: string; owner: null } }>((resolve) => {
      resolveQuery = resolve;
    });
    const query = vi.fn(() => pendingQuery);
    const searchCustomers = vi.fn();
    mockUseConvex.mockReturnValue({ query } as never);
    mockUseAction.mockReturnValueOnce(searchCustomers).mockReturnValueOnce(vi.fn());

    const { result } = renderHook(() => useCustomerSearchServerIndex());

    const p1 = result.current.matchEmail("buyer@example.com");
    const p2 = result.current.matchEmail("accounts@example.com");

    expect(p1).toBe(p2);
    expect(query).toHaveBeenCalledTimes(1);

    resolveQuery({ customer: { recordId: "rec_example", name: "Example", owner: null } });

    await expect(Promise.all([p1, p2])).resolves.toEqual([
      { recordId: "rec_example", name: "Example", owner: null },
      { recordId: "rec_example", name: "Example", owner: null },
    ]);
  });

  it("debounces rapid typed-search calls into one server round-trip", async () => {
    let resolveSearch!: (value: {
      records: Array<{ recordId: string; name: string; owner: null }>;
      source: "mirror";
      backfilled: number;
      mirroredAt: number | null;
    }) => void;
    const pendingSearch = new Promise<{
      records: Array<{ recordId: string; name: string; owner: null }>;
      source: "mirror";
      backfilled: number;
      mirroredAt: number | null;
    }>((resolve) => {
      resolveSearch = resolve;
    });
    const searchCustomers = vi.fn(() => pendingSearch);
    mockUseAction.mockReturnValueOnce(searchCustomers).mockReturnValueOnce(vi.fn());

    const { result } = renderHook(() => useCustomerSearchServerIndex());

    // Two calls within the debounce window for the same normalised key.
    const p1 = result.current.search("Acme");
    const p2 = result.current.search(" acme ");

    // Neither has hit the server yet — the 150 ms timer is still pending.
    expect(searchCustomers).not.toHaveBeenCalled();

    // Fire the debounce timer — the server call starts now.
    vi.advanceTimersByTime(200);
    expect(searchCustomers).toHaveBeenCalledTimes(1);

    resolveSearch({
      records: [{ recordId: "rec_acme", name: "Acme", owner: null }],
      source: "mirror",
      backfilled: 0,
      mirroredAt: 1_000,
    });
    // Both debounced callers resolve to the same records.
    await expect(Promise.all([p1, p2])).resolves.toEqual([
      [{ recordId: "rec_acme", name: "Acme", owner: null }],
      [{ recordId: "rec_acme", name: "Acme", owner: null }],
    ]);
  });

  it("re-asks the mirror (liveAllowed:false) after the live leg answered empty (30s negative cache)", async () => {
    const searchCustomers = vi.fn(async () => ({
      records: [],
      source: "live" as const,
      backfilled: 0,
      mirroredAt: null,
    }));
    mockUseAction.mockReturnValueOnce(searchCustomers).mockReturnValueOnce(vi.fn());

    const { result } = renderHook(() => useCustomerSearchServerIndex());

    // First search: live leg returns empty, negative cache stamped.
    const p1 = result.current.search("zz");
    vi.advanceTimersByTime(200);
    await expect(p1).resolves.toEqual([]);

    // Second search: negative cache is active — liveAllowed:false is sent.
    const p2 = result.current.search(" zz ");
    vi.advanceTimersByTime(200);
    await expect(p2).resolves.toEqual([]);

    // Both calls reach the server, but the second explicitly suppresses the live leg.
    expect(searchCustomers).toHaveBeenCalledTimes(2);
    expect(searchCustomers.mock.calls[1]?.[0]).toMatchObject({ liveAllowed: false });
  });

  it("does not start a negative-cache window for a mirror-sourced answer", async () => {
    const searchCustomers = vi.fn(async () => ({
      records: [{ recordId: "rec_hit", name: "Hit", owner: null }],
      source: "mirror" as const,
      backfilled: 0,
      mirroredAt: 5,
    }));
    mockUseAction.mockReturnValueOnce(searchCustomers);

    const { result } = renderHook(() => useCustomerSearchServerIndex());

    const p1 = result.current.search("hit");
    vi.advanceTimersByTime(200);
    await expect(p1).resolves.toHaveLength(1);

    const p2 = result.current.search("hit");
    vi.advanceTimersByTime(200);
    await expect(p2).resolves.toHaveLength(1);

    // A mirror hit never suppresses — both searches reach the server.
    expect(searchCustomers).toHaveBeenCalledTimes(2);
  });

  it("falls through to the live domain match and backfill when the mirror misses", async () => {
    const query = vi.fn(async () => ({ customer: null }));
    const searchCustomers = vi.fn();
    const matchEmailAndCacheMiss = vi.fn(async () => ({
      customer: { recordId: "rec_fresh", name: "Fresh GmbH", owner: null },
      backfilled: 3,
    }));
    mockUseConvex.mockReturnValue({ query } as never);
    mockUseAction
      .mockReturnValueOnce(searchCustomers)
      .mockReturnValueOnce(matchEmailAndCacheMiss);

    const { result } = renderHook(() => useCustomerSearchServerIndex());

    await expect(result.current.matchEmail("buyer@fresh-gmbh.example")).resolves.toEqual({
      recordId: "rec_fresh",
      name: "Fresh GmbH",
      owner: null,
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(matchEmailAndCacheMiss).toHaveBeenCalledWith({ email: "buyer@fresh-gmbh.example" });
  });

  it("skips repeated live domain matches after Feishu reported the domain empty", async () => {
    const query = vi.fn(async () => ({ customer: null }));
    const searchCustomers = vi.fn();
    const matchEmailAndCacheMiss = vi.fn(async () => ({ customer: null, backfilled: 0 }));
    mockUseConvex.mockReturnValue({ query } as never);
    mockUseAction
      .mockReturnValueOnce(searchCustomers)
      .mockReturnValueOnce(matchEmailAndCacheMiss);

    const { result } = renderHook(() => useCustomerSearchServerIndex());

    await expect(result.current.matchEmail("buyer@no-such-customer.example")).resolves.toBeNull();
    await expect(result.current.matchEmail("sales@no-such-customer.example")).resolves.toBeNull();

    expect(query).toHaveBeenCalledTimes(2);
    expect(matchEmailAndCacheMiss).toHaveBeenCalledTimes(1);
  });

  it("domain negative-cache expires after EMPTY_DOMAIN_MATCH_TTL_MS (5 min) and re-probes live", async () => {
    const query = vi.fn(async () => ({ customer: null }));
    const searchCustomers = vi.fn();
    const matchEmailAndCacheMiss = vi.fn(async () => ({ customer: null, backfilled: 0 }));
    mockUseConvex.mockReturnValue({ query } as never);
    mockUseAction
      .mockReturnValueOnce(searchCustomers)
      .mockReturnValueOnce(matchEmailAndCacheMiss);

    const { result } = renderHook(() => useCustomerSearchServerIndex());

    // First probe: live returns null, negative cache stamped.
    await expect(result.current.matchEmail("buyer@old-lead.example")).resolves.toBeNull();
    expect(matchEmailAndCacheMiss).toHaveBeenCalledTimes(1);

    // Second probe before TTL expiry: cache still active, live NOT re-probed.
    await expect(result.current.matchEmail("buyer@old-lead.example")).resolves.toBeNull();
    expect(matchEmailAndCacheMiss).toHaveBeenCalledTimes(1);

    // Advance past the 5-min TTL.
    vi.advanceTimersByTime(300_001);

    // Third probe: cache expired, live re-probed.
    await expect(result.current.matchEmail("buyer@old-lead.example")).resolves.toBeNull();
    expect(matchEmailAndCacheMiss).toHaveBeenCalledTimes(2);
  });

  it("triggerRefresh is a no-op (Mirror Refresh is cron-managed only)", () => {
    const searchCustomers = vi.fn();
    mockUseAction.mockReturnValueOnce(searchCustomers).mockReturnValueOnce(vi.fn());

    const { result } = renderHook(() => useCustomerSearchServerIndex());

    // triggerRefresh must not throw and must not trigger any action call.
    act(() => {
      result.current.triggerRefresh();
      result.current.triggerRefresh();
    });
    // searchCustomers was never called (no search made), confirming it's a no-op.
    expect(searchCustomers).not.toHaveBeenCalled();
  });
});
