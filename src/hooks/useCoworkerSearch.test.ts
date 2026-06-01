import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useCoworkerSearch } from "./useCoworkerSearch";
import type { Coworker } from "../components/taskpane/coworkers";

import * as convexReact from "convex/react";

vi.mock("convex/react", () => ({
  useAction: vi.fn(),
  useConvex: vi.fn(),
}));

const mockUseAction = vi.mocked(convexReact.useAction);
const mockUseConvex = vi.mocked(convexReact.useConvex);

describe("useCoworkerSearch", () => {
  const sample: Coworker[] = [
    { openId: "ou_1", name: "Alice", avatarUrl: "https://example/avatar-1.png" },
  ];

  beforeEach(() => {
    vi.restoreAllMocks();
    mockUseConvex.mockReturnValue({ query: vi.fn(async () => null) } as never);
  });

  it("skips Convex and Feishu search for one-character queries", async () => {
    const query = vi.fn(async () => null);
    const action = vi.fn().mockResolvedValue(sample);
    mockUseConvex.mockReturnValue({ query } as never);
    mockUseAction.mockReturnValue(action);

    const { result } = renderHook(() => useCoworkerSearch("session-short"));

    const found = await act(async () => result.current(" a "));

    expect(found).toEqual([]);
    expect(query).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
  });

  it("caches identical queries for the same session", async () => {
    const action = vi.fn().mockResolvedValue(sample);
    mockUseAction.mockReturnValue(action);

    const { result } = renderHook(() => useCoworkerSearch("session-1"));

    const first = await act(async () => {
      return result.current("Alice ");
    });
    const second = await act(async () => {
      return result.current("alice");
    });

    expect(action).toHaveBeenCalledTimes(1);
    expect(first).toEqual(sample);
    expect(second).toEqual(sample);
  });

  it("uses the Convex query cache before falling back to the action", async () => {
    const action = vi.fn().mockResolvedValue(sample);
    const query = vi.fn(async () => ({ results: sample }));
    mockUseAction.mockReturnValue(action);
    mockUseConvex.mockReturnValue({ query } as never);

    const { result } = renderHook(() => useCoworkerSearch("session-query"));

    const found = await act(async () => result.current("Alice"));

    expect(found).toEqual(sample);
    expect(query).toHaveBeenCalledTimes(1);
    expect(action).not.toHaveBeenCalled();
  });

  it("scopes cached fallback results by user access token", async () => {
    const action = vi.fn()
      .mockResolvedValueOnce([{ openId: "ou_1", name: "Alice Token 1" }])
      .mockResolvedValueOnce([{ openId: "ou_2", name: "Alice Token 2" }]);
    mockUseAction.mockReturnValue(action);

    const { result, rerender } = renderHook(
      ({ token }) => useCoworkerSearch("session-token", token),
      { initialProps: { token: "token-one" } },
    );

    const first = await act(async () => result.current("Alice"));
    rerender({ token: "token-two" });
    const second = await act(async () => result.current("alice"));

    expect(action).toHaveBeenCalledTimes(2);
    expect(first).toEqual([{ openId: "ou_1", name: "Alice Token 1" }]);
    expect(second).toEqual([{ openId: "ou_2", name: "Alice Token 2" }]);
  });

  it("reuses an in-flight promise for repeated query bursts", async () => {
    let resolve!: (rows: Coworker[]) => void;
    const pending = new Promise<Coworker[]>((res) => {
      resolve = res;
    });
    const action = vi.fn().mockReturnValue(pending);
    mockUseAction.mockReturnValue(action);

    const { result } = renderHook(() => useCoworkerSearch("session-2"));

    const p1 = result.current("Manager");
    const p2 = result.current("manager");
    expect(p1).toBe(p2);
    await Promise.resolve();
    expect(action).toHaveBeenCalledTimes(1);

    resolve(sample);

    const both = await Promise.all([p1, p2]);
    expect(both).toEqual([sample, sample]);

    const fromCache = await act(async () => {
      return result.current("  MANAGER  ");
    });
    expect(action).toHaveBeenCalledTimes(1);
    expect(fromCache).toEqual(sample);
  });

});
