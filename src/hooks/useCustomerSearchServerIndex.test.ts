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

  it("skips Convex search for one-character queries", async () => {
    const query = vi.fn();
    const kick = vi.fn(async () => ({ pages: 1, rows: 1 }));
    const searchAndCacheMiss = vi.fn();
    mockUseConvex.mockReturnValue({ query } as never);
    mockUseAction
      .mockReturnValueOnce(kick)
      .mockReturnValueOnce(searchAndCacheMiss)
      .mockReturnValueOnce(vi.fn());

    const { result } = renderHook(() => useCustomerSearchServerIndex());

    await expect(result.current.search(" a ")).resolves.toEqual([]);

    expect(query).not.toHaveBeenCalled();
    expect(searchAndCacheMiss).not.toHaveBeenCalled();
  });

  it("skips Convex match-by-email for invalid email domains", async () => {
    const query = vi.fn();
    const kick = vi.fn(async () => ({ pages: 1, rows: 1 }));
    const searchAndCacheMiss = vi.fn();
    mockUseConvex.mockReturnValue({ query } as never);
    mockUseAction
      .mockReturnValueOnce(kick)
      .mockReturnValueOnce(searchAndCacheMiss)
      .mockReturnValueOnce(vi.fn());

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
    const searchAndCacheMiss = vi.fn();
    mockUseConvex.mockReturnValue({ query } as never);
    mockUseAction
      .mockReturnValueOnce(kick)
      .mockReturnValueOnce(searchAndCacheMiss)
      .mockReturnValueOnce(vi.fn());

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

  it("coalesces repeated in-flight customer searches", async () => {
    let resolveQuery!: (value: { records: Array<{ recordId: string; name: string; owner: null }> }) => void;
    const pendingQuery = new Promise<{ records: Array<{ recordId: string; name: string; owner: null }> }>((resolve) => {
      resolveQuery = resolve;
    });
    const query = vi.fn(() => pendingQuery);
    const kick = vi.fn(async () => ({ pages: 1, rows: 1 }));
    const searchAndCacheMiss = vi.fn();
    mockUseConvex.mockReturnValue({ query } as never);
    mockUseAction
      .mockReturnValueOnce(kick)
      .mockReturnValueOnce(searchAndCacheMiss)
      .mockReturnValueOnce(vi.fn());

    const { result } = renderHook(() => useCustomerSearchServerIndex());

    const p1 = result.current.search("Acme");
    const p2 = result.current.search(" acme ");

    expect(p1).toBe(p2);
    expect(query).toHaveBeenCalledTimes(1);

    resolveQuery({ records: [{ recordId: "rec_acme", name: "Acme", owner: null }] });
    await expect(Promise.all([p1, p2])).resolves.toEqual([
      [{ recordId: "rec_acme", name: "Acme", owner: null }],
      [{ recordId: "rec_acme", name: "Acme", owner: null }],
    ]);
  });

  it("skips repeated live cache-miss actions after an empty result", async () => {
    const query = vi.fn(async () => ({ records: [] }));
    const kick = vi.fn(async () => ({ pages: 1, rows: 1 }));
    const searchAndCacheMiss = vi.fn(async () => ({ records: [], backfilled: 0 }));
    mockUseConvex.mockReturnValue({ query } as never);
    mockUseAction
      .mockReturnValueOnce(kick)
      .mockReturnValueOnce(searchAndCacheMiss)
      .mockReturnValueOnce(vi.fn());

    const { result } = renderHook(() => useCustomerSearchServerIndex());

    await expect(result.current.search("zz")).resolves.toEqual([]);
    await expect(result.current.search(" zz ")).resolves.toEqual([]);

    expect(query).toHaveBeenCalledTimes(2);
    expect(searchAndCacheMiss).toHaveBeenCalledTimes(1);
  });

  it("falls through to the live domain match and backfill when the mirror misses", async () => {
    const query = vi.fn(async () => ({ customer: null }));
    const kick = vi.fn(async () => ({ pages: 1, rows: 1 }));
    const searchAndCacheMiss = vi.fn();
    const matchEmailAndCacheMiss = vi.fn(async () => ({
      customer: { recordId: "rec_fresh", name: "Fresh GmbH", owner: null },
      backfilled: 3,
    }));
    mockUseConvex.mockReturnValue({ query } as never);
    mockUseAction
      .mockReturnValueOnce(kick)
      .mockReturnValueOnce(searchAndCacheMiss)
      .mockReturnValueOnce(matchEmailAndCacheMiss);

    const { result } = renderHook(() => useCustomerSearchServerIndex());

    await expect(result.current.matchEmail("buyer@fresh-gmbh.example")).resolves.toEqual({
      recordId: "rec_fresh",
      name: "Fresh GmbH",
      owner: null,
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(matchEmailAndCacheMiss).toHaveBeenCalledWith({ email: "buyer@fresh-gmbh.example" });
    expect(kick).not.toHaveBeenCalled();
  });

  it("skips repeated live domain matches after Feishu reported the domain empty", async () => {
    const query = vi.fn(async () => ({ customer: null }));
    const kick = vi.fn(async () => ({ pages: 1, rows: 1 }));
    const searchAndCacheMiss = vi.fn();
    const matchEmailAndCacheMiss = vi.fn(async () => ({ customer: null, backfilled: 0 }));
    mockUseConvex.mockReturnValue({ query } as never);
    mockUseAction
      .mockReturnValueOnce(kick)
      .mockReturnValueOnce(searchAndCacheMiss)
      .mockReturnValueOnce(matchEmailAndCacheMiss);

    const { result } = renderHook(() => useCustomerSearchServerIndex());

    await expect(result.current.matchEmail("buyer@no-such-customer.example")).resolves.toBeNull();
    await expect(result.current.matchEmail("sales@no-such-customer.example")).resolves.toBeNull();

    expect(query).toHaveBeenCalledTimes(2);
    expect(matchEmailAndCacheMiss).toHaveBeenCalledTimes(1);
  });

  it("throttles repeated mirror refresh kicks from rapid picker opens", () => {
    const kick = vi.fn(async () => ({ pages: 1, rows: 1 }));
    const searchAndCacheMiss = vi.fn();
    mockUseAction
      .mockReturnValueOnce(kick)
      .mockReturnValueOnce(searchAndCacheMiss)
      .mockReturnValueOnce(vi.fn());

    const { result } = renderHook(() => useCustomerSearchServerIndex());

    act(() => {
      result.current.triggerRefresh();
      result.current.triggerRefresh();
    });

    expect(kick).toHaveBeenCalledTimes(1);
  });
});
