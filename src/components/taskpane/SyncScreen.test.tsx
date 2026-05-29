// SyncScreen behavior — the Act IV "Syncing to Feishu Bitable" screen. Covers
// the useSyncProgress interval (initial 8% start, the three step bands, the 98%
// cap/hold, and interval cleanup on unmount), phaseForProgress thresholds, the
// summary memo pluralization, and BitablePreview's empty / >3-request handling.

/* eslint-disable max-lines-per-function */
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SyncScreen } from "./SyncScreen";

const PROGRESS_TICK_MS = 180;

function tick(times: number) {
  // Each call to the interval handler advances the visual progress one band step.
  act(() => {
    vi.advanceTimersByTime(PROGRESS_TICK_MS * times);
  });
}

function makeRequests(n: number) {
  return Array.from({ length: n }, (_, i) => ({ id: `r${i}`, title: `Title ${i}`, note: `Note ${i}` }));
}

describe("SyncScreen", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("starts at 8% with the 'Reading Outlook context' phase and a labelled progressbar", () => {
    render(<SyncScreen requests={makeRequests(1)} clientEmail="a@b.com" coworkerCount={1} />);
    expect(screen.getByText("8%")).toBeInTheDocument();
    expect(screen.getByText("Reading Outlook context")).toBeInTheDocument();

    const bar = screen.getByRole("progressbar", { hidden: true });
    expect(bar).toHaveAttribute("aria-label", "Sync progress");
    expect(bar).toHaveAttribute("value", "8");
  });

  it("steps progress through the phase thresholds and updates the phase label", () => {
    render(<SyncScreen requests={makeRequests(1)} clientEmail="a@b.com" coworkerCount={1} />);

    // Bands (phaseForProgress thresholds 0/34/68/90, step bands current<48 -> +8,
    // current<82 -> +5, else +2):
    // 8 -> 16 -> 24 -> 32 -> 40 -> 48 (crosses the 34 "Writing Bitable row" phase).
    tick(5);
    expect(screen.getByText("48%")).toBeInTheDocument();
    expect(screen.getByText("Writing Bitable row")).toBeInTheDocument();

    // 48 -> 53 -> 58 -> 63 -> 68 (lands exactly on the 68 "Backing up in Convex" phase).
    tick(4);
    expect(screen.getByText("68%")).toBeInTheDocument();
    expect(screen.getByText("Backing up in Convex")).toBeInTheDocument();

    // 68 -> 73 -> 78 -> 83 (78<82 still uses the +5 band; min(98,...) keeps it 83).
    tick(3);
    expect(screen.getByText("83%")).toBeInTheDocument();
    expect(screen.getByText("Backing up in Convex")).toBeInTheDocument();

    // 83 -> 85 -> 87 -> 89 -> 91 (>=82 uses the +2 band; 91 crosses the 90 "Final checks" phase).
    tick(4);
    expect(screen.getByText("91%")).toBeInTheDocument();
    expect(screen.getByText("Final checks")).toBeInTheDocument();
  });

  it("caps progress at 98% and holds there (>=98 early return)", () => {
    render(<SyncScreen requests={makeRequests(1)} clientEmail="a@b.com" coworkerCount={1} />);
    tick(100); // far more ticks than needed to reach the ceiling
    expect(screen.getByText("98%")).toBeInTheDocument();
    // Holding: more ticks do not push past 98.
    tick(20);
    expect(screen.getByText("98%")).toBeInTheDocument();
  });

  it("renders singular 'request'/'coworker' in the summary when both counts are 1", () => {
    render(<SyncScreen requests={makeRequests(1)} clientEmail="lead@acme.com" coworkerCount={1} />);
    expect(screen.getByText("lead@acme.com -> 1 request -> 1 coworker")).toBeInTheDocument();
  });

  it("renders plural 'requests'/'coworkers' in the summary when counts !== 1", () => {
    render(<SyncScreen requests={makeRequests(2)} clientEmail="lead@acme.com" coworkerCount={3} />);
    expect(screen.getByText("lead@acme.com -> 2 requests -> 3 coworkers")).toBeInTheDocument();
  });

  it("renders the single 'Request / Ready' placeholder row when there are zero requests", () => {
    render(<SyncScreen requests={[]} clientEmail="a@b.com" coworkerCount={0} />);
    // The placeholder BitableRow's combined text is "Request / Ready"; scoping to
    // the " / Ready" note text avoids colliding with the DataPacket "Request" fallback.
    expect(screen.getByText("/ Ready")).toBeInTheDocument();
  });

  it("renders only the first 3 rows when given more than 3 requests", () => {
    render(<SyncScreen requests={makeRequests(5)} clientEmail="a@b.com" coworkerCount={1} />);
    // BitableRow renders each title in <strong> followed by " / {note}". The note
    // span ("/ Note N") is unique to the rows (the DataPacket reuses Title 0 too),
    // and the preview keeps only slice(0, 3).
    expect(screen.getByText("/ Note 0")).toBeInTheDocument();
    expect(screen.getByText("/ Note 1")).toBeInTheDocument();
    expect(screen.getByText("/ Note 2")).toBeInTheDocument();
    expect(screen.queryByText("/ Note 3")).not.toBeInTheDocument();
    expect(screen.queryByText("/ Note 4")).not.toBeInTheDocument();
  });

  it("clears the interval on unmount (no further timer callbacks fire)", () => {
    const clearSpy = vi.spyOn(window, "clearInterval");
    const { unmount } = render(
      <SyncScreen requests={makeRequests(1)} clientEmail="a@b.com" coworkerCount={1} />,
    );
    unmount();
    expect(clearSpy).toHaveBeenCalled();
    // Advancing after unmount must not throw / produce act warnings.
    tick(10);
    clearSpy.mockRestore();
  });
});
