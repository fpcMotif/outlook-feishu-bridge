import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DEV_SYNC_PREVIEW } from "../../testing/sync-preview-fixtures";
import { SyncScreen } from "./SyncScreen";

describe("SyncScreen layout", () => {
  it("renders progress, customer, multiple notes, and attachments", () => {
    render(<SyncScreen preview={DEV_SYNC_PREVIEW} />);

    expect(
      screen.getByRole("heading", { name: /Syncing to Feishu Base/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: /Sync progress/i })).toBeInTheDocument();
    expect(screen.getByText(/Base row preview/i)).toBeInTheDocument();
    const customer = screen.getByText("Bayer Pharma AG");
    expect(customer).toBeInTheDocument();
    expect(customer).toHaveClass("text-foreground");
    expect(customer.closest("[class*='sage']")).toBeNull();
    expect(screen.queryByRole("img", { hidden: true })).toBeNull();
    expect(screen.getByText(/Request notes/i)).toBeInTheDocument();
    expect(screen.getByText(/3 notes/i)).toBeInTheDocument();
    expect(screen.getByText(/SX-440 silica blend/i)).toBeInTheDocument();
    expect(screen.queryByText(/^Sample$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Quotation$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/R&D Support/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Attachments$/i)).not.toBeInTheDocument();
    expect(screen.getByText(/RFQ-2026-Q1\.pdf/i)).toBeInTheDocument();
    expect(screen.getByText(/SX-440-spec-sheet\.xlsx/i)).toBeInTheDocument();
    expect(screen.queryByText(/COA-reference\.pdf/i)).not.toBeInTheDocument();
    const viewMore = screen.getByRole("button", { name: /View more \(\+1\).*3 files/i });
    expect(viewMore).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(viewMore);
    expect(screen.getByText(/COA-reference\.pdf/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Show less/i })).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    const panel = screen.getByRole("region", { name: /Feishu Base sync progress/i });
    expect(panel).toHaveClass("overflow-hidden");
    expect(panel).toHaveClass("flex-none");
    expect(panel).not.toHaveClass("aspect-square");
    expect(panel).not.toHaveClass("flex-1");
    expect(panel).not.toHaveClass("overflow-y-auto");
    expect(panel).toHaveClass("justify-start");

    const percentage = screen.getByRole("progressbar", { name: /Sync progress/i }).parentElement
      ?.firstElementChild;
    expect(percentage).toHaveClass("tabular-nums");
    expect(percentage).not.toHaveClass("leading-none");
  });
});
