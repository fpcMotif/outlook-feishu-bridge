import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReceivedScreen } from "./ReceivedScreen";
import { relativeSubmittedTime } from "./relativeSubmittedTime";

const NOW = new Date("2026-06-02T05:00:00Z").getTime();

describe("relativeSubmittedTime", () => {
  it("uses Just now only when no backend timestamp is available", () => {
    expect(relativeSubmittedTime(undefined, NOW)).toBe("Just now");
  });

  it("formats backend timestamps within one day without using Just now", () => {
    expect(relativeSubmittedTime(NOW - 3 * 60 * 60 * 1000, NOW)).toBe("Less than 1d ago");
  });

  it("formats backend timestamps by elapsed days before one week", () => {
    expect(relativeSubmittedTime(NOW - 6 * 24 * 60 * 60 * 1000, NOW)).toBe("6 days ago");
  });

  it("formats older backend timestamps by elapsed weeks", () => {
    expect(relativeSubmittedTime(NOW - 7 * 24 * 60 * 60 * 1000, NOW)).toBe("1 week ago");
  });
});

describe("ReceivedScreen layout", () => {
  it("uses login chrome background and centers content without a timeline card", () => {
    const { container } = render(
      <ReceivedScreen
        coworkerCount={1}
        recordId="rec1"
        detailUrl="https://feishu.cn/base/record/rec1"
      />,
    );

    const root = container.firstElementChild;
    expect(root).toHaveStyle({ backgroundColor: "var(--login-background)" });
    const layout = root?.querySelector(".intake-stagger");
    expect(layout).toHaveClass("grid", "grid-rows-[minmax(0,1fr)_auto_minmax(0,1fr)]");

    const timeline = screen.getByRole("list", { name: /Sync completion steps/i });
    const header = screen.getByRole("banner");
    expect(header).toHaveClass("row-start-2");
    expect(timeline).toHaveClass("row-start-3", "w-fit", "max-w-[320px]");
    expect(timeline).not.toHaveClass("bg-card");
    expect(timeline).not.toHaveClass("rounded-2xl");
    expect(timeline).not.toHaveClass("shadow-float");
    expect(screen.getByRole("heading", { name: /^Synced$/i })).toBeInTheDocument();

    const feishuLink = screen.getByRole("link", { name: /Open in Feishu/i });
    expect(feishuLink).toHaveClass("text-primary", "underline-offset-4");
    expect(feishuLink).not.toHaveClass("bg-primary", "shadow-edge");
  });

  it("centers the vertical timeline line through the bullet column", () => {
    const { container } = render(<ReceivedScreen coworkerCount={1} recordId="rec1" />);

    const timeline = screen.getByRole("list", { name: /Sync completion steps/i });
    const stepRows = Array.from(timeline.querySelectorAll("li"));
    expect(stepRows).toHaveLength(3);

    for (let i = 0; i < stepRows.length; i++) {
      const row = stepRows[i]!;
      const line = row.querySelector('[class~="bg-border/80"]');

      if (i === stepRows.length - 1) {
        expect(line).toBeNull();
        continue;
      }

      expect(line).toBeTruthy();
      expect(line).toHaveClass("left-1/2", "-translate-x-1/2");

      // Structural guardrail: the line and the bullet circle should share the same fixed-width column.
      const column = line!.parentElement;
      expect(column).toBeTruthy();
      expect(column).toHaveClass("w-[18px]");

      const bullet = column?.querySelector('[class~="size-[18px]"]');
      expect(bullet).toBeTruthy();
    }

    // Ensure we didn't accidentally render unexpected extra alignment line elements.
    expect(container.querySelectorAll('[class~="bg-border/80"]').length).toBe(2);
  });
});

describe("ReceivedScreen submitted timestamp", () => {
  beforeEach(() => {
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps fresh submit copy as Just now", () => {
    render(<ReceivedScreen coworkerCount={1} recordId="rec1" />);

    expect(screen.getByText("Just now")).toBeInTheDocument();
  });

  it("uses the backend timestamp copy without changing the submitted row style", () => {
    render(
      <ReceivedScreen
        coworkerCount={1}
        recordId="rec1"
        submittedAt={NOW - 6 * 24 * 60 * 60 * 1000}
      />,
    );

    expect(screen.getByText("6 days ago")).toHaveClass("text-muted-foreground", "mt-0.5", "text-xs");
    expect(screen.queryByText("Just now")).not.toBeInTheDocument();
  });
});
