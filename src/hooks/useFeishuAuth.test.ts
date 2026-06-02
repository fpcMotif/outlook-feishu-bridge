import { renderHook, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useQuery, useMutation } from "convex/react";
import { useFeishuAuth } from "./useFeishuAuth";

vi.mock("convex/react", () => ({
  useQuery: vi.fn(),
  useMutation: vi.fn(),
}));

const mockUseQuery = vi.mocked(useQuery);
const mockUseMutation = vi.mocked(useMutation);

type MutationReturn = Parameters<(typeof mockUseMutation)["mockReturnValue"]>[0];

// convex's useMutation returns a callable that also carries a
// withOptimisticUpdate method; shape the vitest mock to match so the typed
// mockReturnValue accepts it.
function asMutation<T extends (...args: never[]) => unknown>(fn: T): MutationReturn {
  return Object.assign(fn, { withOptimisticUpdate: vi.fn() }) as unknown as MutationReturn;
}

const SESSION_KEY = "feishu_session_id";
const FALLBACK_KEY = "feishu_fallback_token";

// This vitest/jsdom config has no writable localStorage, so provide an
// in-memory stub for the hook's session/fallback persistence.
function makeStorage(): Storage {
  let store: Record<string, string> = {};
  return {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = String(v);
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    clear: () => {
      store = {};
    },
    key: (i: number) => Object.keys(store)[i] ?? null,
    get length() {
      return Object.keys(store).length;
    },
  } as Storage;
}

beforeEach(() => {
  vi.stubGlobal("localStorage", makeStorage());
  mockUseQuery.mockReturnValue(null);
  mockUseMutation.mockReturnValue(asMutation(vi.fn(async () => {})));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useFeishuAuth logout", () => {
  it("clears local fallback state and revokes the server session", async () => {
    const logoutMutation = vi.fn(async () => {});
    mockUseMutation.mockReturnValue(asMutation(logoutMutation));
    localStorage.setItem(SESSION_KEY, "sess-1");
    localStorage.setItem(
      FALLBACK_KEY,
      JSON.stringify({ accessToken: "tok", refreshToken: null, expiresAt: Date.now() + 1_000_000, openId: "ou", userName: null, avatarUrl: null }),
    );

    const { result } = renderHook(() => useFeishuAuth());
    await act(async () => {
      await result.current.logout();
    });

    expect(localStorage.getItem(FALLBACK_KEY)).toBeNull();
    expect(logoutMutation).toHaveBeenCalledWith({ sessionId: "sess-1" });
  });

  it("never rejects and still clears local state when the server revoke fails", async () => {
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    const logoutMutation = vi.fn().mockRejectedValue(new Error("network down"));
    mockUseMutation.mockReturnValue(asMutation(logoutMutation));
    localStorage.setItem(SESSION_KEY, "sess-2");
    localStorage.setItem(
      FALLBACK_KEY,
      JSON.stringify({ accessToken: "tok", refreshToken: null, expiresAt: Date.now() + 1_000_000, openId: "ou", userName: null, avatarUrl: null }),
    );

    const { result } = renderHook(() => useFeishuAuth());
    await act(async () => {
      await expect(result.current.logout()).resolves.toBeUndefined();
    });

    expect(localStorage.getItem(FALLBACK_KEY)).toBeNull();
    expect(consoleErr).toHaveBeenCalled();
  });
});
