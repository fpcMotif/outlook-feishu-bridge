import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DEV_SYNC_PREVIEW } from "../../testing/sync-preview-fixtures";
import { SyncScreen } from "./SyncScreen";
import type { SyncPreviewPayload } from "./syncPreviewModel";

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
    // Notes + files are aggregated into one stacked card — no per-section label or count.
    expect(screen.queryByText(/Request notes/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/3 notes/i)).not.toBeInTheDocument();
    expect(screen.getByText(/SX-440 silica blend/i)).toBeInTheDocument();
    expect(screen.queryByText(/^Sample$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Quotation$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/R&D Support/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Attachments$/i)).not.toBeInTheDocument();
    expect(screen.getByText(/RFQ-2026-Q1\.pdf/i)).toBeInTheDocument();
    expect(screen.getByText(/SX-440-spec-sheet\.xlsx/i)).toBeInTheDocument();
    expect(screen.queryByText(/COA-reference\.pdf/i)).not.toBeInTheDocument();
    // Overflow attachments are elided statically — a quiet "+N more", no expand
    // control. The third file stays hidden: the preview is a teaser, not a list.
    expect(screen.getByText(/\+1 more file/i)).toBeInTheDocument();
    expect(screen.getByText(/^3 files$/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /view more/i })).not.toBeInTheDocument();

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

  it("bounds overflowing Base row preview content without clipping", () => {
    const customerLabel =
      "Bayer Pharma AG global procurement respiratory formulations international context owner";
    const attachmentName =
      "Bayer-Pharma-AG-respiratory-formulations-technical-package-with-extra-long-context.pdf";
    const overflowingPreview: SyncPreviewPayload = {
      customerLabel,
      notes: [
        {
          id: "long-note",
          label: "Request notes",
          text:
            "This selected Outlook context has a very long request note with molecular stability details, target applications, approval routing, and follow-up instructions that should remain inside the Base row preview card.",
        },
      ],
      attachments: [{ name: attachmentName }],
    };

    render(<SyncScreen preview={overflowingPreview} />);

    const previewCard = screen.getByText(/Base row preview/i).parentElement?.parentElement;
    expect(previewCard).toHaveClass("min-w-0", "overflow-hidden");
    expect(previewCard).not.toHaveClass("max-h-64");
    expect(screen.getByText(customerLabel)).toHaveClass("min-w-0", "truncate");
    expect(screen.getByText(/molecular stability details/i)).toHaveClass(
      "line-clamp-2",
      "break-words",
    );
    expect(screen.getByText(attachmentName)).toHaveClass("truncate");
  });

  it("labels the phase from the real sync leg and completes to 100% when finalizing", () => {
    const { rerender } = render(<SyncScreen preview={DEV_SYNC_PREVIEW} phase="staging" />);
    expect(
      screen.getByRole("heading", { name: /Preparing your request/i }),
    ).toBeInTheDocument();

    rerender(<SyncScreen preview={DEV_SYNC_PREVIEW} phase="writing" />);
    expect(
      screen.getByRole("heading", { name: /Writing to Feishu Base/i }),
    ).toBeInTheDocument();

    rerender(<SyncScreen preview={DEV_SYNC_PREVIEW} phase="finalizing" />);
    expect(screen.getByRole("heading", { name: /^Synced$/i })).toBeInTheDocument();
    // Real completion: the meter fills to 100% before the handoff, instead of
    // snapping away mid-climb or stalling at a fake 98%.
    expect(screen.getByText(/^100%$/)).toBeInTheDocument();
  });
});
