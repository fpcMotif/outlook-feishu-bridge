// Transport-level tests for the server-index Customer search hook. The
// mirror-vs-live STRATEGY lives server-side (customerSearchEngine.test.ts);
// what is pinned here is the client's transport behaviour: the round-trip
// saver gate, request coalescing, empty-live-result suppression, and the kick
// cooldown.

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    mockUseConvex.mockReturnValue({ query: vi.fn() } as never);
  });

  it("skips the server search for one-character queries (round-trip saver; the engine backstops)", async () => {
    const query = vi.fn();
    const kick = vi.fn(async () => ({ pages: 1, rows: 1 }));
    const searchCustomers = vi.fn();
    mockUseConvex.mockReturnValue({ query } as never);
    mockUseAction.mockReturnValueOnce(kick).mockReturnValueOnce(searchCustomers);

    const { result } = renderHook(() => useCustomerSearchServerIndex());

    await expect(result.current.search(" a ")).resolves.toEqual([]);

    expect(query).not.toHaveBeenCalled();
    expect(searchCustomers).not.toHaveBeenCalled();
  });

  it("skips Convex match-by-email for invalid email domains", async () => {
    const query = vi.fn();
    const kick = vi.fn(async () => ({ pages: 1, rows: 1 }));
    const searchCustomers = vi.fn();
    mockUseConvex.mockReturnValue({ query } as never);
    mockUseAction.mockReturnValueOnce(kick).mockReturnValueOnce(searchCustomers);

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
    const kick = vi.fn(async () => ({ pages: 1, rows: 1 }));
    const searchCustomers = vi.fn();
    mockUseConvex.mockReturnValue({ query } as never);
    mockUseAction.mockReturnValueOnce(kick).mockReturnValueOnce(searchCustomers);

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

  it("coalesces repeated in-flight customer searches into one server call", async () => {
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
    const kick = vi.fn(async () => ({ pages: 1, rows: 1 }));
    const searchCustomers = vi.fn(() => pendingSearch);
    mockUseAction.mockReturnValueOnce(kick).mockReturnValueOnce(searchCustomers);

    const { result } = renderHook(() => useCustomerSearchServerIndex());

    const p1 = result.current.search("Acme");
    const p2 = result.current.search(" acme ");

    expect(p1).toBe(p2);
    expect(searchCustomers).toHaveBeenCalledTimes(1);

    resolveSearch({
      records: [{ recordId: "rec_acme", name: "Acme", owner: null }],
      source: "mirror",
      backfilled: 0,
      mirroredAt: 1_000,
    });
    await expect(Promise.all([p1, p2])).resolves.toEqual([
      [{ recordId: "rec_acme", name: "Acme", owner: null }],
      [{ recordId: "rec_acme", name: "Acme", owner: null }],
    ]);
  });

  it("suppresses repeat searches after the live leg answered empty (30s negative cache)", async () => {
    const kick = vi.fn(async () => ({ pages: 1, rows: 1 }));
    const searchCustomers = vi.fn(async () => ({
      records: [],
      source: "live" as const,
      backfilled: 0,
      mirroredAt: null,
    }));
    mockUseAction.mockReturnValueOnce(kick).mockReturnValueOnce(searchCustomers);

    const { result } = renderHook(() => useCustomerSearchServerIndex());

    await expect(result.current.search("zz")).resolves.toEqual([]);
    await expect(result.current.search(" zz ")).resolves.toEqual([]);

    // The live leg already proved this exact query empty — don't re-pay it.
    expect(searchCustomers).toHaveBeenCalledTimes(1);
  });

  it("does not start a negative-cache window for a mirror-sourced answer", async () => {
    const kick = vi.fn(async () => ({ pages: 1, rows: 1 }));
    const searchCustomers = vi.fn(async () => ({
      records: [{ recordId: "rec_hit", name: "Hit", owner: null }],
      source: "mirror" as const,
      backfilled: 0,
      mirroredAt: 5,
    }));
    mockUseAction.mockReturnValueOnce(kick).mockReturnValueOnce(searchCustomers);

    const { result } = renderHook(() => useCustomerSearchServerIndex());

    await expect(result.current.search("hit")).resolves.toHaveLength(1);
    await expect(result.current.search("hit")).resolves.toHaveLength(1);

    // A mirror hit never suppresses — both searches reach the server.
    expect(searchCustomers).toHaveBeenCalledTimes(2);
  });

  it("throttles repeated mirror refresh kicks from rapid picker opens", () => {
    const kick = vi.fn(async () => ({ pages: 1, rows: 1 }));
    const searchCustomers = vi.fn();
    mockUseAction.mockReturnValueOnce(kick).mockReturnValueOnce(searchCustomers);

    const { result } = renderHook(() => useCustomerSearchServerIndex());

    act(() => {
      result.current.triggerRefresh();
      result.current.triggerRefresh();
    });

    expect(kick).toHaveBeenCalledTimes(1);
  });
});
