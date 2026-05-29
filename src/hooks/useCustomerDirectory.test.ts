// useCustomerDirectory (ADR-0013): module-level singleton that fires the
// tenant-token listCustomers action once on login and shares the projection via
// useSyncExternalStore. The singleton (cache/inflight/listeners) survives across
// tests, so every test calls resetCustomerDirectory() in afterEach to isolate.
//
// The convex/react useAction is mocked to a controllable function so we can
// drive the idle->loading->ready ordering, the inflight dedupe, the error
// branch, and the refresh() nonce bump deterministically.

/* eslint-disable max-lines-per-function */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useCustomerDirectory, resetCustomerDirectory } from "./useCustomerDirectory";
import type { CustomerRecord } from "../components/taskpane/customers";
import * as debug from "../debug";

// The hook calls useAction(api.feishu.customers.listCustomers); the generated
// `api` import is harmless under this mock. `listAction` is reassigned per test
// so we can hand back a deferred/rejecting/resolving promise as needed.
let listAction: (args: Record<string, never>) => Promise<{ records: CustomerRecord[] }>;
vi.mock("convex/react", () => ({
  useAction: () => listAction,
}));

const ROWS: CustomerRecord[] = [
  { recordId: "rec_a", name: "Acme", domain: "acme.example", owner: null },
  { recordId: "rec_b", name: "Bayer", domain: "bayer.example", owner: null },
];

/** A promise whose resolve/reject is exposed so the test controls timing. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  // Default: a never-resolving action so a test must opt in to completion.
  listAction = () => new Promise(() => {});
});

afterEach(() => {
  resetCustomerDirectory();
  vi.restoreAllMocks();
});

describe("useCustomerDirectory login guard", () => {
  it("does not call listCustomers and stays {status:'idle'} when isLoggedIn=false", () => {
    const spy = vi.fn(listAction);
    listAction = spy;

    const { result } = renderHook(() => useCustomerDirectory(false));

    expect(spy).not.toHaveBeenCalled();
    expect(result.current.state).toEqual({ status: "idle", records: [] });
  });
});

describe("useCustomerDirectory first-login fetch", () => {
  it("fires listCustomers once and transitions idle -> loading -> ready, publishing loading before ready", async () => {
    const d = deferred<{ records: CustomerRecord[] }>();
    const spy = vi.fn(() => d.promise);
    listAction = spy;

    const { result } = renderHook(() => useCustomerDirectory(true));

    // The effect runs synchronously after mount: loading is published first,
    // with the (empty) previous records carried over.
    expect(result.current.state).toEqual({ status: "loading", records: [] });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({});

    await act(async () => {
      d.resolve({ records: ROWS });
      await d.promise;
    });

    expect(result.current.state).toEqual({ status: "ready", records: ROWS });
    // Still exactly one call — ready cache short-circuits any re-run.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("publishes {status:'error', records:<previous>} and clears inflight when listCustomers rejects", async () => {
    // Seed a ready cache first so the error branch can prove it preserves the
    // previously-loaded records (catch publishes cache.records).
    const first = deferred<{ records: CustomerRecord[] }>();
    listAction = () => first.promise;
    const seed = renderHook(() => useCustomerDirectory(true));
    await act(async () => {
      first.resolve({ records: ROWS });
      await first.promise;
    });
    expect(seed.result.current.state).toEqual({ status: "ready", records: ROWS });
    seed.unmount();

    // Now refresh into a rejecting action.
    const second = deferred<{ records: CustomerRecord[] }>();
    listAction = () => second.promise;
    const mounted = renderHook(() => useCustomerDirectory(true));
    act(() => {
      mounted.result.current.refresh();
    });
    expect(mounted.result.current.state.status).toBe("loading");

    await act(async () => {
      second.reject(new Error("Bitable down"));
      await second.promise.catch(() => undefined);
    });

    expect(mounted.result.current.state).toEqual({ status: "error", records: ROWS });

    // inflight was cleared by finally(): a subsequent refresh re-fetches.
    const third = deferred<{ records: CustomerRecord[] }>();
    const spy = vi.fn(() => third.promise);
    listAction = spy;
    act(() => {
      mounted.result.current.refresh();
    });
    expect(spy).toHaveBeenCalledTimes(1);
    mounted.unmount();
  });

  it("formats the FAILED log with String(e) when a non-Error value is thrown", async () => {
    const dtimeSpy = vi.spyOn(debug, "dtime");
    const d = deferred<{ records: CustomerRecord[] }>();
    listAction = () => d.promise;
    renderHook(() => useCustomerDirectory(true));

    await act(async () => {
      d.reject("string failure");
      await d.promise.catch(() => undefined);
    });

    expect(dtimeSpy).toHaveBeenCalledWith(
      expect.stringContaining("customer directory: preload FAILED — string failure"),
      expect.any(Number),
    );
  });
});

describe("useCustomerDirectory dedupe + cache short-circuit", () => {
  it("dedupes concurrent mounts: two hooks mounted while a fetch is inflight trigger ONE listCustomers call", () => {
    const d = deferred<{ records: CustomerRecord[] }>();
    const spy = vi.fn(() => d.promise);
    listAction = spy;

    const a = renderHook(() => useCustomerDirectory(true));
    const b = renderHook(() => useCustomerDirectory(true));

    // Both share the singleton inflight promise, so only one network call.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(a.result.current.state.status).toBe("loading");
    expect(b.result.current.state.status).toBe("loading");
  });

  it("skips re-fetch on a fresh mount when cache.status==='ready' and nonce===0", async () => {
    const d = deferred<{ records: CustomerRecord[] }>();
    const spy = vi.fn(() => d.promise);
    listAction = spy;

    const first = renderHook(() => useCustomerDirectory(true));
    await act(async () => {
      d.resolve({ records: ROWS });
      await d.promise;
    });
    expect(first.result.current.state.status).toBe("ready");
    expect(spy).toHaveBeenCalledTimes(1);

    // A second hook mounts: it reads the cached ready state, no new call.
    const second = renderHook(() => useCustomerDirectory(true));
    expect(second.result.current.state).toEqual({ status: "ready", records: ROWS });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("useCustomerDirectory refresh()", () => {
  it("bumps the nonce so the effect re-runs and re-fetches even when cache is 'ready'", async () => {
    const d1 = deferred<{ records: CustomerRecord[] }>();
    const spy = vi.fn(() => d1.promise);
    listAction = spy;

    const { result } = renderHook(() => useCustomerDirectory(true));
    await act(async () => {
      d1.resolve({ records: ROWS });
      await d1.promise;
    });
    expect(result.current.state.status).toBe("ready");
    expect(spy).toHaveBeenCalledTimes(1);

    // refresh() bumps refreshNonce; the effect re-runs and falls through the
    // "ready && nonce===0" short-circuit to fetch again.
    const d2 = deferred<{ records: CustomerRecord[] }>();
    const spy2 = vi.fn(() => d2.promise);
    listAction = spy2;
    act(() => {
      result.current.refresh();
    });
    expect(spy2).toHaveBeenCalledTimes(1);
    expect(result.current.state).toEqual({ status: "loading", records: ROWS });

    const NEXT: CustomerRecord[] = [
      { recordId: "rec_c", name: "Ciba", owner: null },
    ];
    await act(async () => {
      d2.resolve({ records: NEXT });
      await d2.promise;
    });
    expect(result.current.state).toEqual({ status: "ready", records: NEXT });
  });

  it("is a no-op while a fetch is inflight (does not bump nonce nor add a second call)", () => {
    const d = deferred<{ records: CustomerRecord[] }>();
    const spy = vi.fn(() => d.promise);
    listAction = spy;

    const { result } = renderHook(() => useCustomerDirectory(true));
    expect(result.current.state.status).toBe("loading");
    expect(spy).toHaveBeenCalledTimes(1);

    // The fetch is still inflight: refresh() returns early before setRefreshNonce.
    act(() => {
      result.current.refresh();
      result.current.refresh();
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.current.state.status).toBe("loading");
  });
});

describe("useCustomerDirectory SLOW-budget warning", () => {
  it("logs the SLOW warning branch when the ready-path dtime reports elapsed > 1500ms", async () => {
    const dlogSpy = vi.spyOn(debug, "dlog");
    // The hook does `elapsed = dtime("...ready...", started)` then warns when
    // elapsed > 1500. Stub dtime to report >1500 for the "ready" line so the
    // SLOW branch fires regardless of the real (instant) test clock.
    vi.spyOn(debug, "dtime").mockImplementation((label: string) =>
      label.includes("ready") ? 2000 : 0,
    );

    const d = deferred<{ records: CustomerRecord[] }>();
    listAction = () => d.promise;
    renderHook(() => useCustomerDirectory(true));

    await act(async () => {
      d.resolve({ records: ROWS });
      await d.promise;
    });

    expect(dlogSpy).toHaveBeenCalledWith(
      expect.stringContaining("customer directory: preload SLOW"),
    );
  });

  it("does NOT log the SLOW warning when elapsed <= 1500ms", async () => {
    const dlogSpy = vi.spyOn(debug, "dlog");
    vi.spyOn(debug, "dtime").mockReturnValue(0); // elapsed 0 -> not slow

    const d = deferred<{ records: CustomerRecord[] }>();
    listAction = () => d.promise;
    renderHook(() => useCustomerDirectory(true));

    await act(async () => {
      d.resolve({ records: ROWS });
      await d.promise;
    });

    expect(
      dlogSpy.mock.calls.some(([msg]) => String(msg).includes("preload SLOW")),
    ).toBe(false);
  });
});

describe("resetCustomerDirectory", () => {
  it("publishes {status:'idle', records:[]} and notifies subscribers", async () => {
    const d = deferred<{ records: CustomerRecord[] }>();
    listAction = () => d.promise;
    const { result } = renderHook(() => useCustomerDirectory(true));
    await act(async () => {
      d.resolve({ records: ROWS });
      await d.promise;
    });
    expect(result.current.state.status).toBe("ready");

    // resetCustomerDirectory must notify the live subscriber so the rendered
    // hook re-reads the idle snapshot.
    act(() => {
      resetCustomerDirectory();
    });
    expect(result.current.state).toEqual({ status: "idle", records: [] });
  });

  it("nulls inflight so a subsequent login re-fetches", () => {
    const d = deferred<{ records: CustomerRecord[] }>();
    const spy = vi.fn(() => d.promise);
    listAction = spy;
    const { unmount } = renderHook(() => useCustomerDirectory(true));
    expect(spy).toHaveBeenCalledTimes(1);
    unmount();

    act(() => {
      resetCustomerDirectory();
    });

    // inflight was nulled, so a fresh mount fires a new call.
    const spy2 = vi.fn(() => new Promise<{ records: CustomerRecord[] }>(() => {}));
    listAction = spy2;
    renderHook(() => useCustomerDirectory(true));
    expect(spy2).toHaveBeenCalledTimes(1);
  });
});

describe("useCustomerDirectory subscribe/unsubscribe lifecycle", () => {
  it("removes the listener on unmount so a later publish does not re-render the gone subscriber", async () => {
    const d = deferred<{ records: CustomerRecord[] }>();
    listAction = () => d.promise;
    const { result, unmount } = renderHook(() => useCustomerDirectory(true));
    expect(result.current.state.status).toBe("loading");

    const snapshotAtUnmount = result.current.state;
    unmount();

    // The unmounted hook unsubscribed (subscribe's returned cleanup ran). A
    // publish (resolve) after unmount must not throw nor re-render the gone
    // subscriber — its last snapshot stays frozen.
    await act(async () => {
      d.resolve({ records: ROWS });
      await d.promise;
    });

    expect(result.current.state).toBe(snapshotAtUnmount);
    expect(result.current.state.status).toBe("loading");
  });
});
