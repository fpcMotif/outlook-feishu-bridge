import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// We mock @sentry/react so the pure helpers can reference its integration
// factories without booting a real client, and so initSentry's Sentry.init can
// be asserted as a mock call. The integration factories return tagged sentinels
// so buildSentryOptions's integrations array is verifiable.
vi.mock("@sentry/react", () => ({
  init: vi.fn(),
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
  browserTracingIntegration: vi.fn(() => ({ name: "browserTracing" })),
  breadcrumbsIntegration: vi.fn((opts: unknown) => ({ name: "breadcrumbs", opts })),
}));

import * as Sentry from "@sentry/react";
import {
  toBreadcrumbLevel,
  buildSentryOptions,
  forwardLatestBreadcrumb,
  reportSyncError,
} from "./sentry";
import type { DebugEntry } from "./debug";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const entry = (over: Partial<DebugEntry>): DebugEntry => ({
  id: 0,
  time: "00:00:00.000",
  level: "log",
  msg: "m",
  ...over,
});

describe("toBreadcrumbLevel", () => {
  it("maps 'warn' to 'warning'", () => {
    expect(toBreadcrumbLevel("warn")).toBe("warning");
  });
  it("maps 'log' to 'info'", () => {
    expect(toBreadcrumbLevel("log")).toBe("info");
  });
  it("maps 'error' through to 'error'", () => {
    expect(toBreadcrumbLevel("error")).toBe("error");
  });
});

describe("buildSentryOptions", () => {
  it("includes the dsn, environment(mode), tracesSampleRate=1, and both integrations", () => {
    const opts = buildSentryOptions("https://dsn@x/1", undefined, "production");
    expect(opts.dsn).toBe("https://dsn@x/1");
    expect(opts.environment).toBe("production");
    expect(opts.tracesSampleRate).toBe(1);
    expect(opts.integrations).toEqual([
      { name: "browserTracing" },
      { name: "breadcrumbs", opts: { console: false } },
    ]);
    // breadcrumbsIntegration is configured with console:false (we mirror ourselves).
    expect(Sentry.breadcrumbsIntegration).toHaveBeenCalledWith({ console: false });
  });

  it("omits the tunnel key when tunnelValue is undefined", () => {
    const opts = buildSentryOptions("d", undefined, "test");
    expect("tunnel" in opts).toBe(false);
  });

  it("omits the tunnel key when tunnelValue is an empty string (falsy)", () => {
    const opts = buildSentryOptions("d", "", "test");
    expect("tunnel" in opts).toBe(false);
  });

  it("includes tunnel when tunnelValue is provided (ECS Host build)", () => {
    const opts = buildSentryOptions("d", "/_sentry/", "test");
    expect(opts.tunnel).toBe("/_sentry/");
  });
});

describe("forwardLatestBreadcrumb", () => {
  it("returns lastId unchanged and does not add a breadcrumb when the buffer is empty", () => {
    const add = vi.fn();
    expect(forwardLatestBreadcrumb([], 5, add)).toBe(5);
    expect(add).not.toHaveBeenCalled();
  });

  it("returns lastId unchanged and skips when the newest entry was already forwarded (id <= lastId)", () => {
    const add = vi.fn();
    const entries = [entry({ id: 3, msg: "old" })];
    expect(forwardLatestBreadcrumb(entries, 3, add)).toBe(3);
    expect(add).not.toHaveBeenCalled();
  });

  it("forwards a new entry as a 'dbg'-category breadcrumb with the mapped level and returns its id", () => {
    const add = vi.fn();
    const entries = [entry({ id: 10, level: "warn", msg: "careful" })];
    const next = forwardLatestBreadcrumb(entries, 3, add);
    expect(next).toBe(10);
    expect(add).toHaveBeenCalledWith({
      category: "dbg",
      message: "careful",
      level: "warning",
    });
  });

  it("uses only the newest (last) entry of the buffer", () => {
    const add = vi.fn();
    const entries = [entry({ id: 1, msg: "first" }), entry({ id: 2, level: "error", msg: "latest" })];
    forwardLatestBreadcrumb(entries, 0, add);
    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith({ category: "dbg", message: "latest", level: "error" });
  });
});

describe("reportSyncError", () => {
  it("captures an Error as-is, tagged feature:'bitable-sync'", () => {
    const err = new Error("kaboom");
    reportSyncError(err);
    expect(Sentry.captureException).toHaveBeenCalledWith(err, {
      tags: { feature: "bitable-sync" },
    });
  });

  it("wraps a non-Error value in an Error(String(...)) before capturing", () => {
    reportSyncError("plain string failure");
    const [captured, ctx] = vi.mocked(Sentry.captureException).mock.calls[0];
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toBe("plain string failure");
    expect(ctx).toEqual({ tags: { feature: "bitable-sync" } });
  });
});

describe("initSentry", () => {
  it("is a no-op (does not call Sentry.init) when VITE_SENTRY_DSN is unset", async () => {
    vi.resetModules();
    // No VITE_SENTRY_DSN stub -> module-level dsn is undefined -> early return.
    const mod = await import("./sentry");
    mod.initSentry();
    expect(Sentry.init).not.toHaveBeenCalled();
  });

  it("calls Sentry.init with the built options and wires the breadcrumb subscription when DSN is set", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_SENTRY_DSN", "https://dsn@example/9");
    vi.stubEnv("VITE_SENTRY_TUNNEL", "/_sentry/");
    const mod = await import("./sentry");
    mod.initSentry();
    expect(Sentry.init).toHaveBeenCalledTimes(1);
    const passed = vi.mocked(Sentry.init).mock.calls[0][0];
    expect(passed?.dsn).toBe("https://dsn@example/9");
    expect(passed?.tunnel).toBe("/_sentry/");

    // The subscription forwards subsequent debug entries as breadcrumbs. Emitting
    // a dlog should produce exactly one addBreadcrumb call for the new entry.
    const debug = await import("./debug");
    debug.dlog("after-init");
    expect(Sentry.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ category: "dbg", message: "after-init", level: "info" }),
    );
  });
});
