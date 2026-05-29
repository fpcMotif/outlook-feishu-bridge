// SyncMotion behavior — the ConnectionRail (Outlook -> Bitable orbs + animated
// fill + DataPacket) and SyncFoldPreview. Covers the StatusOrb active/inactive
// pulse branch, the progress transform on the rail fill, and the request ??
// fallback text in both DataPacket and SyncFoldPreview.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ConnectionRail, SyncFoldPreview } from "./SyncMotion";

describe("ConnectionRail", () => {
  it("renders the Outlook and Bitable status orb labels", () => {
    render(<ConnectionRail progress={40} request={{ title: "Quotation", note: "Q3 pricing" }} />);
    expect(screen.getByText("Outlook")).toBeInTheDocument();
    expect(screen.getByText("Bitable")).toBeInTheDocument();
  });

  it("applies the scaleX(progress/100) transform to the rail fill", () => {
    const { container } = render(<ConnectionRail progress={40} request={undefined} />);
    // The animated fill is the element whose inline transform carries scaleX.
    const fill = Array.from(container.querySelectorAll<HTMLElement>("[style]")).find((el) =>
      el.style.transform.includes("scaleX"),
    );
    expect(fill).toBeDefined();
    expect(fill!.style.transform).toContain("scaleX(0.4)");
  });

  it("marks the Bitable orb active (pulse span) and leaves the Outlook orb inactive", () => {
    const { container } = render(<ConnectionRail progress={10} request={undefined} />);
    // Exactly one orb (Bitable) is active -> exactly one pulse span.
    expect(container.querySelectorAll(".sync-orb-pulse")).toHaveLength(1);
  });
});

describe("DataPacket (via ConnectionRail)", () => {
  it("renders request.title (strong) and request.note when a request is provided", () => {
    render(<ConnectionRail progress={50} request={{ title: "Sample", note: "5g aliquot" }} />);
    expect(screen.getByText("Sample:")).toBeInTheDocument();
    // note text follows the strong title in the packet card.
    expect(screen.getByText(/5g aliquot/)).toBeInTheDocument();
  });

  it("falls back to 'Request' / 'Sync packet' when request is undefined", () => {
    render(<ConnectionRail progress={50} request={undefined} />);
    expect(screen.getByText("Request:")).toBeInTheDocument();
    expect(screen.getByText(/Sync packet/)).toBeInTheDocument();
  });
});

describe("SyncFoldPreview", () => {
  it("renders request.title when a request is provided", () => {
    render(<SyncFoldPreview request={{ title: "R&D Support", note: "n/a" }} />);
    expect(screen.getByText("R&D Support")).toBeInTheDocument();
  });

  it("falls back to 'Request' when request is undefined", () => {
    render(<SyncFoldPreview request={undefined} />);
    expect(screen.getByText("Request")).toBeInTheDocument();
  });
});
