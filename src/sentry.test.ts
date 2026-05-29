import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@sentry/react", () => ({
  init: vi.fn(),
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
  browserTracingIntegration: vi.fn(() => ({ name: "browserTracing" })),
  breadcrumbsIntegration: vi.fn((opts: unknown) => ({ name: "breadcrumbs", opts })),
}));

import * as Sentry from "@sentry/react";
import {
  buildSentryOptions,
  forwardLatestBreadcrumb,
  reportSyncError,
  toBreadcrumbLevel,
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
  it("maps debug levels to Sentry breadcrumb levels", () => {
    expect(toBreadcrumbLevel("warn")).toBe("warning");
    expect(toBreadcrumbLevel("log")).toBe("info");
    expect(toBreadcrumbLevel("error")).toBe("error");
  });
});

describe("buildSentryOptions", () => {
  it("includes fixed tracing options and integrations", () => {
    const opts = buildSentryOptions("https://dsn@x/1", undefined, "production");
    expect(opts.dsn).toBe("https://dsn@x/1");
    expect(opts.environment).toBe("production");
    expect(opts.tracesSampleRate).toBe(1);
    expect(opts.integrations).toEqual([
      { name: "browserTracing" },
      { name: "breadcrumbs", opts: { console: false } },
    ]);
  });

  it("only includes a tunnel when one is provided", () => {
    expect("tunnel" in buildSentryOptions("d", undefined, "test")).toBe(false);
    expect("tunnel" in buildSentryOptions("d", "", "test")).toBe(false);
    expect(buildSentryOptions("d", "/_sentry/", "test").tunnel).toBe("/_sentry/");
  });
});

describe("forwardLatestBreadcrumb", () => {
  it("skips empty buffers and already-forwarded entries", () => {
    const add = vi.fn();
    expect(forwardLatestBreadcrumb([], 5, add)).toBe(5);
    expect(forwardLatestBreadcrumb([entry({ id: 3 })], 3, add)).toBe(3);
    expect(add).not.toHaveBeenCalled();
  });

  it("forwards only the newest entry and returns its id", () => {
    const add = vi.fn();
    const next = forwardLatestBreadcrumb(
      [entry({ id: 1, msg: "first" }), entry({ id: 2, level: "error", msg: "latest" })],
      0,
      add,
    );
    expect(next).toBe(2);
    expect(add).toHaveBeenCalledWith({ category: "dbg", message: "latest", level: "error" });
  });
});

describe("reportSyncError", () => {
  it("captures an Error as-is", () => {
    const err = new Error("kaboom");
    reportSyncError(err);
    expect(Sentry.captureException).toHaveBeenCalledWith(err, {
      tags: { feature: "bitable-sync" },
    });
  });

  it("wraps a non-Error value in Error(String(value))", () => {
    reportSyncError("plain string failure");
    const [captured, ctx] = vi.mocked(Sentry.captureException).mock.calls[0];
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toBe("plain string failure");
    expect(ctx).toEqual({ tags: { feature: "bitable-sync" } });
  });
});
