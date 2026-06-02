import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SyncScreen } from "./SyncScreen";

const SAMPLE_REQUESTS = [
  { id: "sample", title: "Sample", note: "Need 50 g of SX-440 silica blend." },
];

describe("SyncScreen layout", () => {
  it("renders progress and fits the taskpane without inner scroll containers", () => {
    render(<SyncScreen requests={SAMPLE_REQUESTS} />);

    expect(
      screen.getByRole("heading", { name: /Syncing to Feishu Base/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: /Sync progress/i })).toBeInTheDocument();
    expect(screen.getByText(/Base row preview/i)).toBeInTheDocument();

    const panel = screen.getByRole("region", { name: /Feishu Base sync progress/i });
    expect(panel).toHaveClass("overflow-hidden");
    expect(panel).toHaveClass("flex-none");
    expect(panel).not.toHaveClass("aspect-square");
    expect(panel).not.toHaveClass("flex-1");
    expect(panel).not.toHaveClass("overflow-y-auto");
    expect(panel).toHaveClass("justify-start");

    const percentage = screen.getByText(/\d+%/);
    expect(percentage).toHaveClass("tabular-nums");
    expect(percentage).not.toHaveClass("leading-none");
  });
});
