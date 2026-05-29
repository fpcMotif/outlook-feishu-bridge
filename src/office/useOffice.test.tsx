// useOffice hand-shakes with the Office.js host: it waits for Office.onReady to
// fire and publishes { isReady, host, error }. In local browser dev there is no
// host to hand-shake with, so a 3s timed fallback publishes a synthetic
// "browser" state instead of flashing a wrong "no mailbox" message.
//
// The Office namespace only exists inside Outlook, so we stub globalThis.Office
// and capture the onReady callback per test (the mailBody.test.ts stub pattern).
// import.meta.env.DEV is toggled with vi.stubEnv so both the DEV-fallback and
// production (no-fallback) branches are covered.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

import { useOffice } from "./useOffice";

type OnReadyInfo = { host?: { toString(): string }; platform?: { toString(): string } };
type OnReadyCb = (info: OnReadyInfo) => void;

// Install a stub Office namespace whose onReady stashes the registered callback
// so tests can fire it (or never fire it, to exercise the timed fallback).
function installOffice(): { fire: (info: OnReadyInfo) => void; calls: number } {
  const state = { cb: undefined as OnReadyCb | undefined, calls: 0 };
  (globalThis as unknown as { Office: unknown }).Office = {
    onReady: (cb: OnReadyCb) => {
      state.calls += 1;
      state.cb = cb;
    },
  };
  return {
    get calls() {
      return state.calls;
    },
    fire: (info: OnReadyInfo) => state.cb?.(info),
  };
}

afterEach(() => {
  delete (globalThis as unknown as { Office?: unknown }).Office;
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("useOffice", () => {
  it("returns { isReady:false, host:null, error:null } before Office.onReady fires", () => {
    installOffice();
    const { result } = renderHook(() => useOffice());
    expect(result.current).toEqual({ isReady: false, host: null, error: null });
  });

  it("sets { isReady:true, host:'Outlook', error:null } when onReady fires with a host", () => {
    const office = installOffice();
    const { result } = renderHook(() => useOffice());

    act(() => {
      office.fire({ host: { toString: () => "Outlook" }, platform: { toString: () => "PC" } });
    });

    expect(result.current).toEqual({ isReady: true, host: "Outlook", error: null });
  });

  it("sets host:null when info.host is undefined (covers host?.toString() ?? null)", () => {
    const office = installOffice();
    const { result } = renderHook(() => useOffice());

    // info with neither host nor platform exercises both `?? null` (host) and
    // the `?? '?'` platform fallback used only for the debug log.
    act(() => {
      office.fire({});
    });

    expect(result.current).toEqual({ isReady: true, host: null, error: null });
  });

  it("clears the DEV fallback timer when onReady fires first, so 'browser' never overwrites the real host", () => {
    vi.useFakeTimers();
    vi.stubEnv("DEV", true);
    const office = installOffice();
    const { result } = renderHook(() => useOffice());

    act(() => {
      office.fire({ host: { toString: () => "Outlook" } });
    });
    // Advancing past 3s must NOT trigger the browser fallback — the timer was
    // cleared on the onReady handshake (clearTimeout at useOffice.ts:32).
    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(result.current).toEqual({ isReady: true, host: "Outlook", error: null });
  });

  it("in DEV, falls back to { isReady:true, host:'browser', error:null } when onReady never fires within 3s", () => {
    vi.useFakeTimers();
    vi.stubEnv("DEV", true);
    installOffice(); // onReady stashes the cb but we never fire it
    const { result } = renderHook(() => useOffice());

    expect(result.current.isReady).toBe(false);
    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(result.current).toEqual({ isReady: true, host: "browser", error: null });
  });

  it("the DEV fallback is a no-op when state is already ready (s.isReady ? s : ...)", () => {
    vi.useFakeTimers();
    vi.stubEnv("DEV", true);
    const office = installOffice();
    const { result } = renderHook(() => useOffice());

    act(() => {
      office.fire({ host: { toString: () => "Outlook" } });
    });
    // Even if the timer somehow survived, the functional update returns the
    // existing ready state unchanged — host stays "Outlook", not "browser".
    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(result.current).toEqual({ isReady: true, host: "Outlook", error: null });
  });

  it("schedules no DEV fallback timer when import.meta.env.DEV is false", () => {
    vi.useFakeTimers();
    vi.stubEnv("DEV", false);
    installOffice(); // onReady never fired
    const { result } = renderHook(() => useOffice());

    act(() => {
      vi.advanceTimersByTime(10000);
    });

    // No fallback in production: state remains the initial not-ready snapshot.
    expect(result.current).toEqual({ isReady: false, host: null, error: null });
    // No timers were scheduled (the cleanup also short-circuits on undefined).
    expect(vi.getTimerCount()).toBe(0);
  });

  it("publishes the real host with no fallback timer to clear when onReady fires in production (DEV=false)", () => {
    vi.stubEnv("DEV", false);
    const office = installOffice();
    const { result } = renderHook(() => useOffice());

    // In production no fallback timeout is scheduled, so the onReady handshake
    // hits the `if (fallback)` false branch (nothing to clearTimeout).
    act(() => {
      office.fire({ host: { toString: () => "OutlookWebApp" } });
    });

    expect(result.current).toEqual({ isReady: true, host: "OutlookWebApp", error: null });
  });

  it("clears the pending DEV fallback timeout on unmount (effect cleanup)", () => {
    vi.useFakeTimers();
    vi.stubEnv("DEV", true);
    installOffice(); // onReady never fired
    const { result, unmount } = renderHook(() => useOffice());

    expect(vi.getTimerCount()).toBe(1); // fallback scheduled
    unmount();
    expect(vi.getTimerCount()).toBe(0); // cleanup cleared it

    // Advancing after unmount must not throw nor mutate the captured state.
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(result.current).toEqual({ isReady: false, host: null, error: null });
  });
});
