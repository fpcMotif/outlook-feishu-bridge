import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SubmitDock } from "./SubmitDock";

afterEach(() => {
  vi.useRealTimers();
});

describe("SubmitDock busy feedback", () => {
  it("shows a quiet waiting treatment while work is in progress", () => {
    render(
      <SubmitDock
        count={1}
        canSubmit={true}
        sending={true}
        hint="Pick a coworker"
        onSubmit={vi.fn()}
      />,
    );

    const working = screen.getByRole("button", { name: "Working" });
    expect(working).toBeDisabled();
    expect(screen.getByText("Working")).toBeInTheDocument();
    expect(working.querySelector(".submit-dock-busy-dots")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(working.querySelectorAll(".submit-dock-busy-dot")).toHaveLength(3);
    expect(working.querySelector(".submit-dock-countdown-ring")).not.toBeInTheDocument();
  });
});

describe("SubmitDock confirm countdown", () => {
  it("scrolls via an effect (not during render) and announces the countdown to AT", () => {
    vi.useFakeTimers();
    const onReviewStart = vi.fn();
    const { container } = render(
      <SubmitDock
        count={1}
        canSubmit={true}
        sending={false}
        hint="Pick a coworker"
        label="Sync with Jenny"
        confirmResetKey="k1"
        onReviewStart={onReviewStart}
        onSubmit={vi.fn()}
      />,
    );

    // The review scroll is a side effect — it runs from the lifecycle effect, not
    // mid-render, but it must still fire once the dock arms the countdown.
    expect(onReviewStart).toHaveBeenCalled();

    // The button keeps a clean accessible name; the seconds ride a separate
    // sr-only live region so assistive tech actually hears the countdown.
    const button = screen.getByRole("button", { name: "Checking attachments" });
    expect(button).toBeDisabled();
    const live = container.querySelector('[aria-live="polite"]');
    expect(live).toHaveClass("sr-only");
    expect(live).toHaveTextContent(/submitting in 3 seconds/i);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(live).toHaveTextContent(/submitting in 2 seconds/i);

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(live).toHaveTextContent(/ready to submit/i);
    expect(screen.getByRole("button", { name: "Sync with Jenny" })).toBeEnabled();
  });
});
