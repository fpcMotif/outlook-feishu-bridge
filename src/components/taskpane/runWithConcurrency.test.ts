import { describe, expect, it, vi } from "vitest";

import { runWithConcurrency, UPLOAD_CONCURRENCY } from "./runWithConcurrency";

// A controllable async worker: each call returns a promise the test resolves by
// hand, so we can freeze the pool mid-flight and inspect how many ran at once.
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("runWithConcurrency", () => {
  it("never runs more than `limit` workers at once", async () => {
    const gates = Array.from({ length: 10 }, () => deferred());
    let active = 0;
    let peak = 0;
    const order: number[] = [];

    const run = runWithConcurrency(gates, 3, async (gate, index) => {
      active += 1;
      peak = Math.max(peak, active);
      order.push(index);
      await gate.promise;
      active -= 1;
    });

    // Let the pool fill, then drain one item at a time.
    for (let i = 0; i < gates.length; i += 1) {
      await Promise.resolve();
      expect(active).toBeLessThanOrEqual(3);
      gates[i].resolve();
    }
    await run;

    expect(peak).toBe(3);
    expect(order).toHaveLength(10);
    // Every item ran exactly once, first three claimed immediately.
    expect(new Set(order).size).toBe(10);
    expect(order.slice(0, 3)).toEqual([0, 1, 2]);
  });

  it("bounds a 50-file experiment batch to UPLOAD_CONCURRENCY in flight, running each exactly once", async () => {
    // The upload cap lifts to 50 for the latency experiment; the client pool must
    // still cap simultaneous XHRs at UPLOAD_CONCURRENCY so 50 picks can't saturate
    // the WebView's ~6-per-origin connection limit and self-inflict "network" errors.
    const gates = Array.from({ length: 50 }, () => deferred());
    let active = 0;
    let peak = 0;
    const claimed: number[] = [];

    const run = runWithConcurrency(gates, UPLOAD_CONCURRENCY, async (gate, index) => {
      active += 1;
      peak = Math.max(peak, active);
      claimed.push(index);
      await gate.promise;
      active -= 1;
    });

    // Drain one item at a time; the pool refills but must never overrun the cap.
    for (let i = 0; i < gates.length; i += 1) {
      await Promise.resolve();
      expect(active).toBeLessThanOrEqual(UPLOAD_CONCURRENCY);
      gates[i].resolve();
    }
    await run;

    expect(peak).toBe(UPLOAD_CONCURRENCY);
    expect(claimed).toHaveLength(50);
    expect(new Set(claimed).size).toBe(50); // every file ran exactly once
    expect(claimed.slice(0, UPLOAD_CONCURRENCY)).toEqual(
      Array.from({ length: UPLOAD_CONCURRENCY }, (_, i) => i),
    );
  });

  it("resolves immediately and calls the worker zero times for an empty list", async () => {
    const worker = vi.fn();
    await expect(runWithConcurrency([], 4, worker)).resolves.toBeUndefined();
    expect(worker).not.toHaveBeenCalled();
  });

  it("keeps draining after a worker throws — one bad item never rejects the pool", async () => {
    const seen: number[] = [];
    await expect(
      runWithConcurrency([0, 1, 2, 3], 2, async (n) => {
        seen.push(n);
        if (n === 1) throw new Error("boom");
      }),
    ).resolves.toBeUndefined();
    expect(seen.toSorted()).toEqual([0, 1, 2, 3]);
  });

  it("clamps the pool to the item count when limit exceeds it", async () => {
    let peak = 0;
    let active = 0;
    await runWithConcurrency([0, 1], 8, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
    });
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("ships a sane default upload concurrency", () => {
    expect(UPLOAD_CONCURRENCY).toBe(4);
  });
});
