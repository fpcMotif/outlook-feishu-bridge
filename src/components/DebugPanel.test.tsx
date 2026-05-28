/* eslint-disable max-lines-per-function */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { DebugPanel } from "./DebugPanel";

vi.mock("../debug", () => {
  return {
    getDebugEntries: () => [
      { id: "1", level: "error", time: "10:00", msg: "Test error" },
      { id: "2", level: "warn", time: "11:00", msg: "Test warn" },
      { id: "3", level: "log", time: "12:00", msg: "Test log" },
    ],
    subscribeDebug: vi.fn(),
  };
});

describe("DebugPanel", () => {
  it("shows correct office facts", () => {
    // we mock window.Office for this test
    const prevOffice = (window as any).Office;
    (window as any).Office = { context: { mailbox: { item: true } } };
    render(<DebugPanel office={{ isReady: true, host: "test", error: null }} />);
    expect(screen.getByText(/Office=true mailbox=true item=true/)).toBeInTheDocument();
    (window as any).Office = prevOffice;
  });
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (window as any).__convex;
  });

  it("handles convex connection error gracefully when connectionState throws", () => {
    Object.defineProperty(window, "__convex", {
      value: {
        connectionState: () => {
          throw new Error("Convex error");
        }
      },
      configurable: true,
    });

    render(<DebugPanel office={{ isReady: true, host: "test", error: null }} />);

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(screen.getByText(/convex\[err\]/)).toBeInTheDocument();
  });

  it("handles when __convex itself throws on access", () => {
    Object.defineProperty(window, "__convex", {
      get: () => {
        throw new Error("Access error");
      },
      configurable: true,
    });

    render(<DebugPanel office={{ isReady: true, host: "test", error: null }} />);

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(screen.getByText(/convex\[err\]/)).toBeInTheDocument();
  });

  it("handles happy path when __convex is available", () => {
    Object.defineProperty(window, "__convex", {
      value: {
        connectionState: () => ({
          isWebSocketConnected: true,
          hasInflightRequests: false,
        }),
      },
      configurable: true,
    });

    render(<DebugPanel office={{ isReady: true, host: "test", error: null }} />);

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(screen.getByText(/convex\[ws=true inflight=false\]/)).toBeInTheDocument();
  });

  it("handles when __convex is undefined", () => {
    render(<DebugPanel office={{ isReady: true, host: "test", error: null }} />);

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(screen.getByText(/convex\[n\/a\]/)).toBeInTheDocument();
  });

  it("toggles debug body and shows office facts", () => {
    render(
      <DebugPanel
        office={{ isReady: true, host: "Word", error: "Some Office Error" }}
      />
    );
    // Open debug body
    act(() => {
      screen.getByRole("button", { name: "show" }).click();
    });

    expect(screen.getByRole("button", { name: "hide" })).toBeInTheDocument();
    expect(screen.getByText(/office.error Some Office Error/)).toBeInTheDocument();
    expect(screen.getByText(/Test error/)).toBeInTheDocument();
  });

  it("cleans up intervals on unmount", () => {
    const { unmount } = render(
      <DebugPanel
        office={{ isReady: true, host: "Word", error: null }}
      />
    );
    unmount();
  });

  it("handles subscribeDebug callback", async () => {
    render(
      <DebugPanel
        office={{ isReady: true, host: "Word", error: null }}
      />
    );
    // get subscribeDebug mock and call its callback
    // we can import it
    const { subscribeDebug } = await import("../debug");
    const subscribeDebugMock = subscribeDebug as any;
    const callback = subscribeDebugMock.mock.calls[0][0];
    act(() => {
      callback();
    });
  });

});
