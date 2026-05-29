// SubmitDock behavior — the sticky bottom submit button. Covers the dockLabel
// label/sending/count/hint precedence, the `live = canSubmit && !sending`
// enablement, the trailing ArrowRight visibility, the footer ?? fallback, and
// the click/disabled wiring.

/* eslint-disable max-lines-per-function */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SubmitDock } from "./SubmitDock";

function renderDock(overrides: Partial<React.ComponentProps<typeof SubmitDock>> = {}) {
  const onSubmit = vi.fn();
  const props: React.ComponentProps<typeof SubmitDock> = {
    count: 0,
    canSubmit: true,
    sending: false,
    hint: "Add a request to continue",
    onSubmit,
    ...overrides,
  };
  const utils = render(<SubmitDock {...props} />);
  return { onSubmit, ...utils };
}

describe("SubmitDock dockLabel", () => {
  it("shows 'Submitting...' and a spinner when sending, regardless of label/count", () => {
    renderDock({ sending: true, label: "Continue", count: 3 });
    expect(screen.getByRole("button")).toHaveTextContent("Submitting...");
    // The spinner is the only Loader2 icon; it carries the animate-spin class.
    expect(document.querySelector(".animate-spin")).not.toBeNull();
  });

  it("renders the explicit label when one is provided and not sending", () => {
    renderDock({ label: "Continue", count: 5 });
    expect(screen.getByRole("button")).toHaveTextContent("Continue");
  });

  it("renders 'Submit N requests' (plural) for count > 1 with no label", () => {
    renderDock({ count: 3 });
    expect(screen.getByRole("button")).toHaveTextContent("Submit 3 requests");
  });

  it("renders 'Submit 1 request' (singular) for count === 1 with no label", () => {
    renderDock({ count: 1 });
    expect(screen.getByRole("button")).toHaveTextContent("Submit 1 request");
    expect(screen.getByRole("button")).not.toHaveTextContent("requests");
  });

  it("falls back to the hint string when count === 0 and no label", () => {
    renderDock({ count: 0, hint: "Pick a coworker first" });
    expect(screen.getByRole("button")).toHaveTextContent("Pick a coworker first");
  });
});

describe("SubmitDock enablement (live = canSubmit && !sending)", () => {
  it("disables the button when canSubmit is false", () => {
    renderDock({ canSubmit: false, count: 2 });
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("disables the button when sending even if canSubmit is true", () => {
    renderDock({ canSubmit: true, sending: true, count: 2 });
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("enables the button when canSubmit && !sending", () => {
    renderDock({ canSubmit: true, sending: false, count: 2 });
    expect(screen.getByRole("button")).toBeEnabled();
  });
});

describe("SubmitDock trailing ArrowRight (live && count > 0)", () => {
  it("shows the ArrowRight when live and count > 0", () => {
    const { container } = renderDock({ canSubmit: true, count: 2 });
    // lucide ArrowRight renders an <svg class="lucide-arrow-right ...">
    expect(container.querySelector("svg.lucide-arrow-right")).not.toBeNull();
  });

  it("hides the ArrowRight when count === 0", () => {
    const { container } = renderDock({ canSubmit: true, count: 0 });
    expect(container.querySelector("svg.lucide-arrow-right")).toBeNull();
  });

  it("hides the ArrowRight when not live (canSubmit false) even with count > 0", () => {
    const { container } = renderDock({ canSubmit: false, count: 3 });
    expect(container.querySelector("svg.lucide-arrow-right")).toBeNull();
  });
});

describe("SubmitDock footer", () => {
  it("renders the provided footer prop", () => {
    renderDock({ footer: "Draft saved locally" });
    expect(screen.getByText("Draft saved locally")).toBeInTheDocument();
  });

  it("renders the default footer when footer is undefined", () => {
    renderDock();
    expect(screen.getByText("Encrypted - synced to your Feishu workspace")).toBeInTheDocument();
  });
});

describe("SubmitDock click handling", () => {
  it("calls onSubmit when the enabled button is clicked", () => {
    const { onSubmit } = renderDock({ canSubmit: true, count: 1 });
    fireEvent.click(screen.getByRole("button"));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("does not call onSubmit when the disabled button is clicked", () => {
    const { onSubmit } = renderDock({ canSubmit: false, count: 1 });
    fireEvent.click(screen.getByRole("button"));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
