import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useCoworkerSearch } from "./useCoworkerSearch";
import type { Coworker } from "../components/taskpane/coworkers";

import * as convexReact from "convex/react";

vi.mock("convex/react", () => ({
  useAction: vi.fn(),
}));

const mockUseAction = vi.mocked(convexReact.useAction);

describe("useCoworkerSearch", () => {
  const sample: Coworker[] = [
    { openId: "ou_1", name: "Alice", avatarUrl: "https://example/avatar-1.png" },
  ];

  beforeEach(() => {
    vi.restoreAllMocks();
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
