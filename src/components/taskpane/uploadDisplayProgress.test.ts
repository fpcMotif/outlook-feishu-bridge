import { describe, expect, it } from "vitest";

import {
  uploadDisplayProgressTarget,
  uploadSimulatedCap,
  uploadSmoothedStep,
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

describe("uploadSmoothedStep", () => {
  it("eases toward the target without overshooting", () => {
    const { next, done } = uploadSmoothedStep(10, 50);
    expect(next).toBeGreaterThan(10);
    expect(next).toBeLessThan(50);
    expect(done).toBe(false);
  });
});
