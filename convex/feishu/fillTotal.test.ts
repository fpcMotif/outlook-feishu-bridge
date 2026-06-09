import { describe, expect, it } from "vitest";

import { buildFillTotal } from "./attachmentFill";

describe("buildFillTotal", () => {
  it("computes all three spans + the grep-able line for a fully-stamped row", () => {
    const total = buildFillTotal(
      {
        syncTraceId: "tr_abc",
        submitClickedAt: 1_000,
        syncReceivedAt: 1_200,
        bitableRowMintedAt: 1_500,
        bitableAttachmentFileTokens: ["t1", "t2", "t3"],
        bitableAttachmentSkipped: ["dead.pdf"],
      },
      15_500,
    );
    expect(total.traceId).toBe("tr_abc");
    expect(total.files).toBe(3);
    expect(total.skipped).toBe(1);
    expect(total.createMs).toBe(300); // 1500 - 1200
    expect(total.fillMs).toBe(14_000); // 15500 - 1500
    expect(total.totalMs).toBe(14_500); // 15500 - 1000 (click → filled)
    expect(total.line).toBe(
      "[fillTotal] trace=tr_abc files=3 skipped=1 createMs=300 fillMs=14000 totalMs=14500",
    );
  });

  it("omits null spans and shows trace=- for an un-instrumented (older) row", () => {
    const total = buildFillTotal(
      { bitableRowMintedAt: 1_500, bitableAttachmentFileTokens: ["t1"] },
      9_500,
    );
    expect(total.traceId).toBeNull();
    expect(total.files).toBe(1);
    expect(total.skipped).toBe(0);
    expect(total.createMs).toBeNull(); // no syncReceivedAt
    expect(total.fillMs).toBe(8_000); // 9500 - 1500
    expect(total.totalMs).toBeNull(); // no submitClickedAt
    expect(total.line).toBe("[fillTotal] trace=- files=1 skipped=0 fillMs=8000");
  });

  it("handles a zero-attachment fence (no tokens, no skips)", () => {
    const total = buildFillTotal(
      { syncTraceId: "tr_z", submitClickedAt: 100, bitableRowMintedAt: 200 },
      900,
    );
    expect(total.files).toBe(0);
    expect(total.skipped).toBe(0);
    expect(total.fillMs).toBe(700);
    expect(total.totalMs).toBe(800);
    expect(total.line).toBe(
      "[fillTotal] trace=tr_z files=0 skipped=0 fillMs=700 totalMs=800",
    );
  });
});
