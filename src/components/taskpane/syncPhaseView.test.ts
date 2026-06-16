import { describe, expect, it } from "vitest";

import { SYNC_PHASE_VIEW, syncPhaseView } from "./syncPhaseView";

describe("syncPhaseView", () => {
  it("eases toward a higher ceiling on each successive leg, snapping to 100 on finalize", () => {
    expect(syncPhaseView("staging").ceiling).toBe(58);
    expect(syncPhaseView("writing").ceiling).toBe(93);
    expect(syncPhaseView("finalizing").ceiling).toBe(100);
    // Monotonic: the meter never goes backwards as real milestones land.
    expect(SYNC_PHASE_VIEW.staging.ceiling).toBeLessThan(SYNC_PHASE_VIEW.writing.ceiling);
    expect(SYNC_PHASE_VIEW.writing.ceiling).toBeLessThan(SYNC_PHASE_VIEW.finalizing.ceiling);
  });

  it("keeps the preview provisional during staging — the row has not been committed yet", () => {
    const staging = syncPhaseView("staging");
    expect(staging.rowLanded).toBe(false);
    expect(staging.attachmentsSettled).toBe(false);
  });

  it("commits the preview once the write begins and holds it through finalize", () => {
    for (const phase of ["writing", "finalizing"] as const) {
      const view = syncPhaseView(phase);
      expect(view.rowLanded).toBe(true);
      expect(view.attachmentsSettled).toBe(true);
    }
  });

  it("labels each leg with its real-milestone copy", () => {
    expect(syncPhaseView("staging").label).toMatch(/Preparing your request/i);
    expect(syncPhaseView("writing").label).toMatch(/Writing to Feishu Base/i);
    expect(syncPhaseView("finalizing").label).toBe("Synced");
  });
});
