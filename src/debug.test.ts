import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// debug.ts keeps a module-level ring buffer + listener set + a pinned copy of
// the REAL console methods captured at import time. To isolate the buffer per
// test (and to let the pinned console refs point at our spies) we install the
// console spies FIRST, then vi.resetModules() + dynamic import so each test
// gets a fresh module instance whose realLog/realWarn/realError are bound to
// the current (spied) console.
type DebugModule = typeof import("./debug");

let logSpy: ReturnType<typeof vi.spyOn>;

async function freshDebug(): Promise<DebugModule> {
  vi.resetModules();
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  // warn/error are spied to keep test output quiet; their values aren't read.
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  return import("./debug");
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("dlog", () => {
  it("pushes a 'log' entry into the buffer and returns it via getDebugEntries", async () => {
    const dbg = await freshDebug();
    dbg.dlog("hello world");
    const entries = dbg.getDebugEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: 0, level: "log", msg: "hello world" });
    // time is the HH:MM:SS.mmm slice of an ISO timestamp.
    expect(entries[0].time).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
  });

  it("mirrors the message to the real console.log with a [dbg] prefix", async () => {
    const dbg = await freshDebug();
    dbg.dlog("mirror me");
    expect(logSpy).toHaveBeenCalledWith("[dbg]", "mirror me");
  });

  it("assigns monotonically increasing ids to successive entries", async () => {
    const dbg = await freshDebug();
    dbg.dlog("a");
    dbg.dlog("b");
    const entries = dbg.getDebugEntries();
    expect(entries.map((e) => e.id)).toEqual([0, 1]);
  });
});

describe("dtime", () => {
  it("logs an elapsed-ms line and returns the elapsed milliseconds", async () => {
    const dbg = await freshDebug();
    // Control performance.now: start=100, end=350 -> elapsed 250ms.
    const nowSpy = vi.spyOn(performance, "now").mockReturnValue(350);
    const elapsed = dbg.dtime("phase", 100);
    expect(elapsed).toBe(250);
    const entry = dbg.getDebugEntries().at(-1);
    expect(entry?.level).toBe("log");
    expect(entry?.msg).toBe("⏱ phase: 250ms");
    expect(logSpy).toHaveBeenCalledWith("[dbg]", "⏱ phase: 250ms");
    nowSpy.mockRestore();
  });

  it("rounds the elapsed milliseconds for the log line", async () => {
    const dbg = await freshDebug();
    vi.spyOn(performance, "now").mockReturnValue(100.6);
    const elapsed = dbg.dtime("round", 100);
    // raw elapsed kept un-rounded as the return; the LINE is Math.round'd.
    expect(elapsed).toBeCloseTo(0.6, 5);
    expect(dbg.getDebugEntries().at(-1)?.msg).toBe("⏱ round: 1ms");
  });
});

describe("dload", () => {
  it("logs a 'since pane load' line using the rounded performance.now()", async () => {
    const dbg = await freshDebug();
    vi.spyOn(performance, "now").mockReturnValue(1234.4);
    dbg.dload("boot");
    const entry = dbg.getDebugEntries().at(-1);
    expect(entry?.level).toBe("log");
    expect(entry?.msg).toBe("⏱ boot: 1234ms since pane load");
    expect(logSpy).toHaveBeenCalledWith("[dbg]", "⏱ boot: 1234ms since pane load");
  });
});

describe("ring buffer cap (MAX=300)", () => {
  it("drops the oldest entry once the buffer exceeds 300 so length stays at 300", async () => {
    const dbg = await freshDebug();
    for (let i = 0; i < 305; i++) dbg.dlog(`m${i}`);
    const entries = dbg.getDebugEntries();
    expect(entries).toHaveLength(300);
    // First 5 (m0..m4) were shifted out; the head is now m5.
    expect(entries[0].msg).toBe("m5");
    expect(entries.at(-1)?.msg).toBe("m304");
    // ids keep climbing even after shifts (nextId is never reset).
    expect(entries.at(-1)?.id).toBe(304);
  });
});

describe("subscribeDebug", () => {
  it("notifies subscribers on each emit and returns an unsubscribe that stops further calls", async () => {
    const dbg = await freshDebug();
    const fn = vi.fn();
    const unsub = dbg.subscribeDebug(fn);
    dbg.dlog("one");
    expect(fn).toHaveBeenCalledTimes(1);
    dbg.dlog("two");
    expect(fn).toHaveBeenCalledTimes(2);
    unsub();
    dbg.dlog("three");
    // No further notifications after unsubscribe.
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("notifies every registered listener", async () => {
    const dbg = await freshDebug();
    const a = vi.fn();
    const b = vi.fn();
    dbg.subscribeDebug(a);
    dbg.subscribeDebug(b);
    dbg.dlog("x");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});

describe("getDebugEntries", () => {
  it("returns the live buffer array reflecting subsequent emits", async () => {
    const dbg = await freshDebug();
    const first = dbg.getDebugEntries();
    expect(first).toHaveLength(0);
    dbg.dlog("added");
    // getDebugEntries returns the same underlying array, so it now has the entry.
    expect(dbg.getDebugEntries()).toHaveLength(1);
  });
});

describe("initDebug", () => {
  it("is idempotent: a second call does not re-wrap the console or re-emit the boot line", async () => {
    const dbg = await freshDebug();
    vi.spyOn(performance, "now").mockReturnValue(0);
    dbg.initDebug();
    const afterFirst = dbg.getDebugEntries().length;
    // first call emits 'boot <href>' + the dload boot line.
    expect(afterFirst).toBe(2);
    dbg.initDebug();
    // Guarded by `installed`; no new entries.
    expect(dbg.getDebugEntries().length).toBe(afterFirst);
  });

  it("captures window 'error' events into the buffer as an error entry", async () => {
    const dbg = await freshDebug();
    vi.spyOn(performance, "now").mockReturnValue(0);
    dbg.initDebug();
    window.dispatchEvent(
      new ErrorEvent("error", { message: "boom", filename: "f.js", lineno: 7 }),
    );
    const entry = dbg.getDebugEntries().at(-1);
    expect(entry?.level).toBe("error");
    expect(entry?.msg).toBe("window.onerror: boom (f.js:7)");
  });

  it("captures unhandledrejection events as an error entry", async () => {
    const dbg = await freshDebug();
    vi.spyOn(performance, "now").mockReturnValue(0);
    dbg.initDebug();
    // jsdom's PromiseRejectionEvent isn't always constructible; dispatch a
    // plain Event carrying a `reason` to exercise the listener.
    const ev = new Event("unhandledrejection") as Event & { reason?: unknown };
    ev.reason = "nope";
    window.dispatchEvent(ev);
    const entry = dbg.getDebugEntries().at(-1);
    expect(entry?.level).toBe("error");
    expect(entry?.msg).toBe("unhandledrejection: nope");
  });

  it("captures securitypolicyviolation events with the violated directive and blocked URI", async () => {
    const dbg = await freshDebug();
    vi.spyOn(performance, "now").mockReturnValue(0);
    dbg.initDebug();
    const ev = new Event("securitypolicyviolation") as Event & {
      violatedDirective?: string;
      blockedURI?: string;
    };
    ev.violatedDirective = "worker-src";
    ev.blockedURI = "blob:abc";
    window.dispatchEvent(ev);
    expect(dbg.getDebugEntries().at(-1)?.msg).toBe("CSP blocked worker-src: blob:abc");
  });

  it("falls back to '(inline)' for a CSP violation with no blockedURI", async () => {
    const dbg = await freshDebug();
    vi.spyOn(performance, "now").mockReturnValue(0);
    dbg.initDebug();
    const ev = new Event("securitypolicyviolation") as Event & {
      violatedDirective?: string;
      blockedURI?: string;
    };
    ev.violatedDirective = "script-src";
    ev.blockedURI = "";
    window.dispatchEvent(ev);
    expect(dbg.getDebugEntries().at(-1)?.msg).toBe("CSP blocked script-src: (inline)");
  });

  it("wraps console.warn/console.error so their calls land in the buffer with the right level", async () => {
    const dbg = await freshDebug();
    vi.spyOn(performance, "now").mockReturnValue(0);
    dbg.initDebug();
    const before = dbg.getDebugEntries().length;
    console.warn("careful");
    console.error("kaput");
    const tail = dbg.getDebugEntries().slice(before);
    expect(tail.find((e) => e.msg === "careful")?.level).toBe("warn");
    expect(tail.find((e) => e.msg === "kaput")?.level).toBe("error");
  });

  it("wrapConsole formats non-string args: an Error contributes its stack/message, objects are JSON", async () => {
    const dbg = await freshDebug();
    vi.spyOn(performance, "now").mockReturnValue(0);
    dbg.initDebug();
    const before = dbg.getDebugEntries().length;
    console.log({ a: 1 }, "tail");
    const objEntry = dbg.getDebugEntries().slice(before).at(-1);
    expect(objEntry?.msg).toBe('{"a":1} tail');

    const before2 = dbg.getDebugEntries().length;
    const err = new Error("explode");
    err.stack = "STACKTRACE";
    console.log(err);
    expect(dbg.getDebugEntries().slice(before2).at(-1)?.msg).toBe("STACKTRACE");
  });

  it("wrapConsole falls back to an Error's message when its stack is undefined", async () => {
    const dbg = await freshDebug();
    vi.spyOn(performance, "now").mockReturnValue(0);
    dbg.initDebug();
    const before = dbg.getDebugEntries().length;
    const err = new Error("only-message");
    err.stack = undefined; // exercise the `a.stack ?? a.message` fallback
    console.log(err);
    expect(dbg.getDebugEntries().slice(before).at(-1)?.msg).toBe("only-message");
  });

  it("wrapConsole formats a circular object via the catch -> String(a) fallback", async () => {
    const dbg = await freshDebug();
    vi.spyOn(performance, "now").mockReturnValue(0);
    dbg.initDebug();
    const before = dbg.getDebugEntries().length;
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    console.log(circular);
    // JSON.stringify throws on the cycle -> fmt returns String(a) = "[object Object]".
    expect(dbg.getDebugEntries().slice(before).at(-1)?.msg).toBe("[object Object]");
  });

  it("truncates a very long wrapped-console message to 1000 chars", async () => {
    const dbg = await freshDebug();
    vi.spyOn(performance, "now").mockReturnValue(0);
    dbg.initDebug();
    const before = dbg.getDebugEntries().length;
    console.log("x".repeat(2000));
    expect(dbg.getDebugEntries().slice(before).at(-1)?.msg.length).toBe(1000);
  });
});
