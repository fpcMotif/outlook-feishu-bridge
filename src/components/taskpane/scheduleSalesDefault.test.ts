import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SALES_DEFAULT_DELAY_MS,
  resetSalesDefaultForTests,
  scheduleSalesDefault,
} from "./scheduleSalesDefault";

describe("scheduleSalesDefault", () => {
  const rafCallbacks: FrameRequestCallback[] = [];

  beforeEach(() => {
    resetSalesDefaultForTests();
    rafCallbacks.length = 0;
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("waits for rAF and delay before applying", () => {
    const apply = vi.fn();
    scheduleSalesDefault(apply, 100);
    expect(apply).not.toHaveBeenCalled();

    for (const cb of rafCallbacks) cb(0);
    expect(apply).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("defaults to a 2.5 second post-paint pause", () => {
    const apply = vi.fn();
    scheduleSalesDefault(apply);

    for (const cb of rafCallbacks) cb(0);
    vi.advanceTimersByTime(2499);
    expect(apply).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("does not apply after cleanup", () => {
    const apply = vi.fn();
    const cancel = scheduleSalesDefault(apply, SALES_DEFAULT_DELAY_MS);
    cancel();
    for (const cb of rafCallbacks) cb(0);
    vi.advanceTimersByTime(SALES_DEFAULT_DELAY_MS);
    expect(apply).not.toHaveBeenCalled();
  });

  it("applies immediately after the first default in the session (no 2.5s on a context switch)", () => {
    // First application consumes the one-time onboarding delay.
    scheduleSalesDefault(vi.fn());
    // A later application — e.g. a pinned-pane conversation switch — must not wait.
    const onSwitch = vi.fn();
    scheduleSalesDefault(onSwitch);
    for (const cb of rafCallbacks) cb(0);
    vi.advanceTimersByTime(1);
    expect(onSwitch).toHaveBeenCalledTimes(1);
  });
});
