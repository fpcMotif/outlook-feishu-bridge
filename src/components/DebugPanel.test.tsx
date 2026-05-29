import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

// Mock the debug module so we control the buffer the panel renders and capture
// the subscribe callback (the panel re-renders by bumping a tick on each emit).
const mockEntries: import("../debug").DebugEntry[] = [];
let capturedSubscriber: (() => void) | null = null;

vi.mock("../debug", () => ({
  getDebugEntries: () => mockEntries,
  subscribeDebug: (fn: () => void) => {
    capturedSubscriber = fn;
    return () => {
      capturedSubscriber = null;
    };
  },
}));

import { DebugPanel } from "./DebugPanel";

const office = { isReady: true, host: "Outlook", error: null as string | null };

beforeEach(() => {
  mockEntries.length = 0;
  capturedSubscriber = null;
  // Default: no Office, no __convex.
  delete (globalThis as unknown as { Office?: unknown }).Office;
  delete (window as unknown as { __convex?: unknown }).__convex;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete (globalThis as unknown as { Office?: unknown }).Office;
  delete (window as unknown as { __convex?: unknown }).__convex;
});

describe("DebugPanel header", () => {
  it("renders the BUILD_TAG, host, ready flag and the Office facts in the sticky header", () => {
    render(<DebugPanel office={office} />);
    // BUILD_TAG is dbg-2; host=Outlook ready=true; Office undefined -> Office=false.
    expect(screen.getByText(/DBG dbg-2/)).toBeInTheDocument();
    expect(screen.getByText(/host=Outlook/)).toBeInTheDocument();
    expect(screen.getByText(/ready=true/)).toBeInTheDocument();
    expect(screen.getByText(/Office=false mailbox=false item=false/)).toBeInTheDocument();
  });

  it("falls back to '?' for the host when office.host is null", () => {
    render(<DebugPanel office={{ isReady: false, host: null, error: null }} />);
    expect(screen.getByText(/host=\? ready=false/)).toBeInTheDocument();
  });

  it("reports Office=true mailbox/item flags when the Office global is present", () => {
    (globalThis as unknown as { Office: unknown }).Office = {
      context: { mailbox: { item: {} } },
    };
    render(<DebugPanel office={office} />);
    expect(screen.getByText(/Office=true mailbox=true item=true/)).toBeInTheDocument();
  });

  it("reports mailbox=true item=false when Office.context.mailbox exists but has no item", () => {
    (globalThis as unknown as { Office: unknown }).Office = {
      context: { mailbox: {} },
    };
    render(<DebugPanel office={office} />);
    expect(screen.getByText(/Office=true mailbox=true item=false/)).toBeInTheDocument();
  });
});

describe("DebugPanel show/hide", () => {
  it("is collapsed by default: the body (url line) is not rendered", () => {
    render(<DebugPanel office={office} />);
    expect(screen.getByRole("button", { name: "show" })).toBeInTheDocument();
    expect(screen.queryByText(/^url /)).not.toBeInTheDocument();
  });

  it("expands the body and shows the url/env lines when 'show' is clicked, then collapses again", () => {
    render(<DebugPanel office={office} />);
    fireEvent.click(screen.getByRole("button", { name: "show" }));
    // Body now visible: url + convexUrl + siteUrl + feishuAppId lines.
    expect(screen.getByText(new RegExp(`url ${location.href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`))).toBeInTheDocument();
    expect(screen.getByText(/convexUrl/)).toBeInTheDocument();
    expect(screen.getByText(/siteUrl/)).toBeInTheDocument();
    expect(screen.getByText(/feishuAppId/)).toBeInTheDocument();
    // Toggle button label flips to "hide".
    const hideBtn = screen.getByRole("button", { name: "hide" });
    fireEvent.click(hideBtn);
    expect(screen.getByRole("button", { name: "show" })).toBeInTheDocument();
  });
});

describe("DebugPanel body entries", () => {
  it("renders each debug entry's time, level tag and message when expanded", () => {
    mockEntries.push(
      { id: 1, time: "00:00:01.000", level: "log", msg: "boot done" },
      { id: 2, time: "00:00:02.000", level: "warn", msg: "slow sync" },
      { id: 3, time: "00:00:03.000", level: "error", msg: "fetch failed" },
    );
    render(<DebugPanel office={office} />);
    fireEvent.click(screen.getByRole("button", { name: "show" }));

    expect(screen.getByText(/boot done/)).toBeInTheDocument();
    // warn/error entries carry a "[warn] "/"[error] " prefix; log entries don't.
    expect(screen.getByText(/\[warn\]/)).toBeInTheDocument();
    expect(screen.getByText(/slow sync/)).toBeInTheDocument();
    expect(screen.getByText(/\[error\]/)).toBeInTheDocument();
    expect(screen.getByText(/fetch failed/)).toBeInTheDocument();
  });

  it("shows the office.error line in the body when office.error is set", () => {
    render(<DebugPanel office={{ isReady: false, host: null, error: "init blew up" }} />);
    fireEvent.click(screen.getByRole("button", { name: "show" }));
    expect(screen.getByText(/office\.error init blew up/)).toBeInTheDocument();
  });

  it("does not render an office.error line when office.error is null", () => {
    render(<DebugPanel office={office} />);
    fireEvent.click(screen.getByRole("button", { name: "show" }));
    expect(screen.queryByText(/office\.error/)).not.toBeInTheDocument();
  });
});

describe("DebugPanel reactivity", () => {
  it("re-renders new buffer entries when the debug subscriber fires", () => {
    render(<DebugPanel office={office} />);
    fireEvent.click(screen.getByRole("button", { name: "show" }));
    expect(screen.queryByText(/late entry/)).not.toBeInTheDocument();

    // Simulate a new debug emit: push to buffer + invoke the captured subscriber.
    mockEntries.push({ id: 9, time: "00:00:09.000", level: "log", msg: "late entry" });
    act(() => {
      capturedSubscriber?.();
    });
    expect(screen.getByText(/late entry/)).toBeInTheDocument();
  });
});

describe("DebugPanel convex connection probe", () => {
  it("shows 'n/a' when window.__convex is absent", () => {
    vi.useFakeTimers();
    render(<DebugPanel office={office} />);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText(/convex\[n\/a\]/)).toBeInTheDocument();
  });

  it("reflects the websocket + inflight flags from __convex.connectionState()", () => {
    vi.useFakeTimers();
    (window as unknown as { __convex: unknown }).__convex = {
      connectionState: () => ({ isWebSocketConnected: true, hasInflightRequests: false }),
    };
    render(<DebugPanel office={office} />);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText(/convex\[ws=true inflight=false\]/)).toBeInTheDocument();
  });

  it("shows 'err' when connectionState() throws", () => {
    vi.useFakeTimers();
    (window as unknown as { __convex: unknown }).__convex = {
      connectionState: () => {
        throw new Error("not connected");
      },
    };
    render(<DebugPanel office={office} />);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText(/convex\[err\]/)).toBeInTheDocument();
  });
});
