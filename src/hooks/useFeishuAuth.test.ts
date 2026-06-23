import { act, renderHook, waitFor } from "@testing-library/react";
import { useAction, useMutation, useQuery } from "convex/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  useFeishuAuth,
} from "./useFeishuAuth";
import {
  PRESENCE_TTL_MS,
  clearAuthSnapshot,
  readAuthSnapshot,
  rememberAuthSnapshot,
} from "./feishuAuthSnapshot";

vi.mock("convex/react", () => ({
  useAction: vi.fn(),
  useMutation: vi.fn(),
  useQuery: vi.fn(),
}));

const mockUseQuery = vi.mocked(useQuery);
const mockUseMutation = vi.mocked(useMutation);
const mockUseAction = vi.mocked(useAction);
// useQuery returns undefined until Convex resolves (the still-loading frame).
const QUERY_LOADING = undefined as ReturnType<typeof useQuery>;

// touchSession action stub; tests override the resolved status as needed.
function setTouchResult(status: "absent" | "ok" | "terminal" | "never") {
  mockUseAction.mockReturnValue(
    vi.fn(async () =>
      status === "never" ? await new Promise(() => {}) : status,
    ) as unknown as ReturnType<typeof useAction>,
  );
}

describe("auth fast resume", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-04T08:00:00.000Z"));
    mockUseMutation.mockReturnValue(
      vi.fn(async () => {}) as unknown as ReturnType<typeof useMutation>,
    );
    // Default: touchSession resolves 'ok' (live/refreshed) and never clears.
    setTouchResult("ok");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("stores only a non-token auth snapshot for instant reopen", () => {
    rememberAuthSnapshot(
      "sess-1",
      { openId: "ou_jenny", userName: "Jenny Xu", avatarUrl: "https://example.test/jenny.png" },
      Date.now() + 60_000,
    );

    expect(readAuthSnapshot("sess-1")).toEqual({
      sessionId: "sess-1",
      openId: "ou_jenny",
      userName: "Jenny Xu",
      avatarUrl: "https://example.test/jenny.png",
      expiresAt: Date.now() + 60_000,
      resumeUntil: Date.now() + PRESENCE_TTL_MS,
    });
    const storageValues = Array.from({ length: localStorage.length }, (_, i) =>
      localStorage.getItem(localStorage.key(i) ?? ""),
    ).join("\n");
    expect(storageValues).not.toContain("accessToken");
    expect(storageValues).not.toContain("refreshToken");
  });

  it("ignores snapshots for another session or past the presence horizon", () => {
    rememberAuthSnapshot("sess-1", { openId: "ou_jenny", userName: "Jenny Xu" }, Date.now() + 60_000);

    expect(readAuthSnapshot("sess-2")).toBeNull();
    // Eligibility is gated on the presence horizon, not the access-token expiry,
    // so a read just past the access-token expiry (+61s) still resumes...
    expect(readAuthSnapshot("sess-1", Date.now() + 61_000)).not.toBeNull();
    // ...but past the presence horizon it is rejected.
    expect(readAuthSnapshot("sess-1", Date.now() + PRESENCE_TTL_MS + 1)).toBeNull();
  });

  it("opens as logged in immediately from a fresh auth snapshot while Convex validates", () => {
    localStorage.setItem("feishu_session_id", "sess-1");
    rememberAuthSnapshot("sess-1", { openId: "ou_jenny", userName: "Jenny Xu" }, Date.now() + 60_000);
    mockUseQuery.mockReturnValue(QUERY_LOADING);

    const { result } = renderHook(() => useFeishuAuth());

    expect(result.current.isLoading).toBe(false);
    expect(result.current.isLoggedIn).toBe(true);
    expect(result.current.user).toEqual({ openId: "ou_jenny", userName: "Jenny Xu", avatarUrl: undefined });
  });

  it("clears the instant resume snapshot when Convex rejects the session", async () => {
    localStorage.setItem("feishu_session_id", "sess-1");
    rememberAuthSnapshot("sess-1", { openId: "ou_jenny", userName: "Jenny Xu" }, Date.now() + 60_000);
    let session: unknown;
    mockUseQuery.mockImplementation(() => session);

    const { result, rerender } = renderHook(() => useFeishuAuth());
    expect(result.current.isLoggedIn).toBe(true);

    await act(async () => {
      session = null;
      rerender();
    });
    expect(result.current.isLoggedIn).toBe(false);
    expect(readAuthSnapshot("sess-1")).toBeNull();
  });

  it("can explicitly clear the stored auth snapshot", () => {
    rememberAuthSnapshot("sess-1", { openId: "ou_jenny" }, Date.now() + 60_000);
    clearAuthSnapshot();

    expect(readAuthSnapshot("sess-1")).toBeNull();
  });

  it("stays logged in past the access-token expiry while within the presence horizon", () => {
    localStorage.setItem("feishu_session_id", "sess-1");
    // Access token expires in 60s; presence horizon is ~30 days.
    rememberAuthSnapshot("sess-1", { openId: "ou_jenny", userName: "Jenny Xu" }, Date.now() + 60_000);
    mockUseQuery.mockReturnValue(QUERY_LOADING);

    // Advance past the OLD 2h access-token gate; the snapshot must still resume.
    vi.setSystemTime(new Date(Date.now() + 3 * 60 * 60 * 1000));
    const { result } = renderHook(() => useFeishuAuth());

    expect(result.current.isLoading).toBe(false);
    expect(result.current.isLoggedIn).toBe(true);
  });

  it("drops the instant resume once the presence horizon lapses", () => {
    localStorage.setItem("feishu_session_id", "sess-1");
    rememberAuthSnapshot("sess-1", { openId: "ou_jenny" }, Date.now() + 60_000);
    mockUseQuery.mockReturnValue(QUERY_LOADING);

    vi.setSystemTime(new Date(Date.now() + PRESENCE_TTL_MS + 1));
    const { result } = renderHook(() => useFeishuAuth());

    // No resumable snapshot + query in flight → checking shell, not connected.
    expect(result.current.isLoggedIn).toBe(false);
    expect(result.current.isLoading).toBe(true);
  });

  it("does not revert to a checking shell after getUserSession resolves non-null", async () => {
    localStorage.setItem("feishu_session_id", "sess-1");
    rememberAuthSnapshot("sess-1", { openId: "ou_jenny", userName: "Jenny Xu" }, Date.now() + 60_000);
    let session: unknown;
    mockUseQuery.mockImplementation(() => session);

    const { result, rerender } = renderHook(() => useFeishuAuth());
    expect(result.current.isLoggedIn).toBe(true);
    expect(result.current.isLoading).toBe(false);

    // Query resolves to a valid (non-expired) session.
    await act(async () => {
      session = {
        openId: "ou_jenny",
        userName: "Jenny Xu",
        expiresAt: Date.now() + 60_000,
        isExpired: false,
      };
      rerender();
    });

    // Never flips to the checking shell across the resolution.
    expect(result.current.isLoggedIn).toBe(true);
    expect(result.current.isLoading).toBe(false);
  });

  it("clears the snapshot and logs out when touchSession returns 'terminal' even if the query is briefly stale", async () => {
    vi.useRealTimers(); // need real microtask flushing for the async touch effect
    localStorage.setItem("feishu_session_id", "sess-1");
    rememberAuthSnapshot("sess-1", { openId: "ou_jenny" }, Date.now() + 60_000);
    // getUserSession stays in-flight (undefined) the whole time — only the
    // touchSession verdict tears the seam down.
    mockUseQuery.mockReturnValue(QUERY_LOADING);
    setTouchResult("terminal");

    const { result } = renderHook(() => useFeishuAuth());
    expect(result.current.isLoggedIn).toBe(true);

    await waitFor(() => {
      expect(result.current.isLoggedIn).toBe(false);
    });
    expect(readAuthSnapshot("sess-1")).toBeNull();
  });

  it("does NOT clear the snapshot on a transient in-flight query (undefined)", async () => {
    localStorage.setItem("feishu_session_id", "sess-1");
    rememberAuthSnapshot("sess-1", { openId: "ou_jenny" }, Date.now() + 60_000);
    let session: unknown = {
      openId: "ou_jenny",
      expiresAt: Date.now() + 60_000,
      isExpired: false,
    };
    mockUseQuery.mockImplementation(() => session);

    const { result, rerender } = renderHook(() => useFeishuAuth());
    expect(result.current.isLoggedIn).toBe(true);

    // Mid-deploy blip: the query momentarily returns undefined.
    await act(async () => {
      session = undefined;
      rerender();
    });

    // Seam survives — still resumable from the snapshot, not wiped.
    expect(result.current.isLoggedIn).toBe(true);
    expect(readAuthSnapshot("sess-1")).not.toBeNull();
  });
});
