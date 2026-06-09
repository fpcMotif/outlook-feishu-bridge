import { describe, expect, it } from "vitest";

import {
  uploadDisplayFrame,
  uploadDisplayProgressTarget,
  uploadLinearStep,
  uploadSimulatedCap,
} from "./uploadDisplayProgress";

describe("uploadDisplayProgressTarget", () => {
  it("keeps display monotonic while active", () => {
    expect(uploadDisplayProgressTarget(30, 25, true)).toBe(30);
    expect(uploadDisplayProgressTarget(30, 45, true)).toBe(45);
  });

  it("ignores spurious zero while already in-flight", () => {
    expect(uploadDisplayProgressTarget(30, 0, true)).toBe(30);
  });

  it("resets when inactive", () => {
    expect(uploadDisplayProgressTarget(80, 0, false)).toBe(0);
  });
});

describe("uploadSimulatedCap", () => {
  it("ramps toward the cap over time", () => {
    expect(uploadSimulatedCap(0)).toBe(0);
    expect(uploadSimulatedCap(6000)).toBeGreaterThan(0);
    expect(uploadSimulatedCap(12_000)).toBe(88);
  });
});

describe("uploadLinearStep", () => {
  it("advances a constant amount per millisecond (no easing)", () => {
    // Equal time slices move the fill the SAME distance — the defining property
    // of linear motion, versus the old ease-out that shrank each step.
    const first = uploadLinearStep(0, 100, 100, 0.1);
    expect(first).toEqual({ next: 10, done: false });
    const second = uploadLinearStep(10, 100, 100, 0.1);
    expect(second).toEqual({ next: 20, done: false });
  });

  it("clamps to the target without overshooting", () => {
    expect(uploadLinearStep(95, 100, 100, 0.1)).toEqual({
      next: 100,
      done: true,
    });
  });

  it("never retreats when the target dips below the current fill", () => {
    expect(uploadLinearStep(60, 40, 100, 0.1)).toEqual({
      next: 60,
      done: true,
    });
  });

  it("holds still across a zero-length frame", () => {
    expect(uploadLinearStep(30, 100, 0, 0.1)).toEqual({
      next: 30,
      done: false,
    });
  });
});

describe("uploadDisplayFrame", () => {
  it("climbs toward real xhr progress and stays running below 100", () => {
    const { next, done } = uploadDisplayFrame(0, 50, 0, 100);
    expect(next).toBeGreaterThan(0);
    expect(next).toBeLessThanOrEqual(50);
    // Input is only at 50% — the loop must keep ticking.
    expect(done).toBe(false);
  });

  it("falls back to the simulated ramp when xhr is quiet", () => {
    // 6s elapsed → ramp ≈ 44%; a generous frame lets the fill reach it.
    expect(uploadDisplayFrame(0, 0, 6000, 1000).next).toBeCloseTo(44, 0);
  });

  it("settles only once the fill catches up and input hits 100", () => {
    expect(uploadDisplayFrame(99.99, 100, 0, 100)).toEqual({
      next: 100,
      done: true,
    });
  });
});
