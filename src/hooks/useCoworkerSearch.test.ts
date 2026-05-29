// Tests for useCoworkerSearch — the thin renderHook wrapper over the Convex
// `searchCoworkers` action (ADR-0003). Confirms the trim/blank guard, arg
// forwarding ({ sessionId, query, userAccessToken }), the default-arg path for
// userAccessToken, and the useCallback identity contract across re-renders.

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Coworker } from "../components/taskpane/coworkers";

// The hook calls useAction(api.feishu.coworkers.searchCoworkers); the generated
// `api` import is harmless under this mock. useAction always hands back our spy.
const searchAction = vi.fn();
vi.mock("convex/react", () => ({
  useAction: () => searchAction,
}));

import { useCoworkerSearch } from "./useCoworkerSearch";

const JENNY: Coworker = { openId: "ou_jenny", name: "Jenny", avatarUrl: "http://x/72.png" };

describe("useCoworkerSearch", () => {
  beforeEach(() => {
    searchAction.mockReset();
  });

  it("returns [] without calling the action for a blank (empty string) query", async () => {
    const { result } = renderHook(() => useCoworkerSearch("sess-1", "tok"));

    let out: Coworker[] = [];
    await act(async () => {
      out = await result.current("");
    });

    expect(out).toEqual([]);
    expect(searchAction).not.toHaveBeenCalled();
  });

  it("returns [] without calling the action for a whitespace-only query (trims first)", async () => {
    const { result } = renderHook(() => useCoworkerSearch("sess-1", "tok"));

    let out: Coworker[] = [];
    await act(async () => {
      out = await result.current("   \t  ");
    });

    expect(out).toEqual([]);
    expect(searchAction).not.toHaveBeenCalled();
  });

  it("trims the query and forwards { sessionId, query, userAccessToken } to searchCoworkers, returning its resolved Coworker[]", async () => {
    searchAction.mockResolvedValue([JENNY]);
    const { result } = renderHook(() => useCoworkerSearch("sess-9", "user-tok"));

    let out: Coworker[] = [];
    await act(async () => {
      out = await result.current("  jen  ");
    });

    expect(searchAction).toHaveBeenCalledTimes(1);
    expect(searchAction).toHaveBeenCalledWith({
      sessionId: "sess-9",
      query: "jen",
      userAccessToken: "user-tok",
    });
    expect(out).toEqual([JENNY]);
  });

  it("passes userAccessToken=undefined through when the hook is called without one (default arg path)", async () => {
    searchAction.mockResolvedValue([]);
    const { result } = renderHook(() => useCoworkerSearch("sess-2"));

    await act(async () => {
      await result.current("jenny");
    });

    expect(searchAction).toHaveBeenCalledWith({
      sessionId: "sess-2",
      query: "jenny",
      userAccessToken: undefined,
    });
  });

  it("returns a stable callback across re-renders when sessionId/userAccessToken are unchanged, and a new identity when sessionId changes", () => {
    const { result, rerender } = renderHook(
      ({ sid, tok }: { sid: string; tok?: string }) => useCoworkerSearch(sid, tok),
      { initialProps: { sid: "sess-A", tok: "t1" } },
    );

    const first = result.current;
    // Same deps -> same callback identity (useCallback memoization).
    rerender({ sid: "sess-A", tok: "t1" });
    expect(result.current).toBe(first);

    // Changing sessionId is a dep change -> new callback identity.
    rerender({ sid: "sess-B", tok: "t1" });
    expect(result.current).not.toBe(first);
  });
});
