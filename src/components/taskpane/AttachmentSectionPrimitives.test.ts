import { describe, expect, it } from "vitest";

import {
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
    expect(uploadSimulatedCap(6000)).toBeGreaterThan(30);
    expect(uploadSimulatedCap(60_000)).toBe(88);
  });
});

describe("uploadLinearStep", () => {
  it("climbs at a steady rate and clamps to the target", () => {
    const first = uploadLinearStep(0, 50, 100, 0.1);
    expect(first).toEqual({ next: 10, done: false });
    const settled = uploadLinearStep(49.8, 50, 100, 0.1);
    expect(settled).toEqual({ next: 50, done: true });
  });
});
