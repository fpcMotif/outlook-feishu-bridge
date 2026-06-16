import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type { Coworker } from "./coworkers";

import { SalesPicker } from "./SalesPicker";
const TEST_AVATAR =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

vi.mock("../../hooks/useCoworkerSearch", () => {
  const testAvatar =
    "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  const coworkers = [
    { openId: "ou_jenny", name: "Jenny Xu", avatarUrl: testAvatar },
    { openId: "ou_michael", name: "Michael Chen" },
  ];
  return {
    useCoworkerSearch: () =>
      vi.fn((query: string) =>
        Promise.resolve(
          coworkers.filter((c) =>
            c.name.toLowerCase().includes(query.toLowerCase()),
          ),
        ),
      ),
  };
});

describe("SalesPicker selected row", () => {
  it("shows sales prompt before any selection", () => {
    render(<SalesPicker sessionId="sess" onSelect={() => {}} />);

    expect(screen.getByText("sales")).toBeInTheDocument();
    expect(document.querySelector('[data-sales-row="true"]')).toBeNull();
  });

  it("gives assistive tech a full heading while the visible chip stays terse", () => {
    render(<SalesPicker sessionId="sess" onSelect={() => {}} />);

    // Visible chip is decorative; the labelled element carries the fuller name.
    expect(screen.getByText("sales")).toHaveAttribute("aria-hidden", "true");
    const label = document.getElementById("sales-picker-title");
    expect(label).toHaveTextContent("Sales rep");
    expect(label).toHaveClass("sr-only");
    expect(
      screen
        .getByText("sales")
        .closest('[aria-labelledby="sales-picker-title"]'),
    ).not.toBeNull();
  });

  it("enters the selected row with stagger when the system applies a default", () => {
    const { rerender } = render(
      <SalesPicker sessionId="sess" onSelect={() => {}} />,
    );

    rerender(
      <SalesPicker
        sessionId="sess"
        onSelect={() => {}}
        salesFromDefault
        selectedSales={{
          openId: "ou_jenny",
          name: "Jenny Xu",
          avatarUrl: TEST_AVATAR,
        }}
      />,
    );

    const row = document.querySelector(
      '[data-sales-row="true"]',
    ) as HTMLElement;
    expect(row).not.toBeNull();
    const panel = screen
      .getByText("sales")
      .closest('[aria-labelledby="sales-picker-title"]');
    expect(panel).not.toBeNull();
    expect(panel).toContainElement(row);
    expect(row).toHaveClass("taskpane-selection-enter-group");
    expect(within(row).getByText("Jenny Xu")).toBeInTheDocument();
    expect(row.querySelector('[data-slot="avatar"]')).toBeInTheDocument();
  });

  it("does not stagger enter when the user explicitly picks sales", async () => {
    function ControlledPicker() {
      const [selected, setSelected] = useState<Coworker | null>(null);
      return (
        <SalesPicker
          sessionId="sess"
          selectedSales={selected}
          onSelect={setSelected}
        />
      );
    }
    render(<ControlledPicker />);

    fireEvent.change(screen.getByLabelText("Search Feishu sales"), {
      target: { value: "Jenny" },
    });
    fireEvent.click(await screen.findByRole("button", { name: /Jenny Xu/i }));

    const row = document.querySelector(
      '[data-sales-row="true"]',
    ) as HTMLElement;
    expect(row).not.toHaveClass("taskpane-selection-enter-group");
  });

  it("clears the default stagger when an explicit pick replaces it", () => {
    const { rerender } = render(
      <SalesPicker
        sessionId="sess"
        salesFromDefault
        selectedSales={{
          openId: "ou_jenny",
          name: "Jenny Xu",
          avatarUrl: TEST_AVATAR,
        }}
        onSelect={() => {}}
      />,
    );

    expect(document.querySelector('[data-sales-row="true"]')).toHaveClass(
      "taskpane-selection-enter-group",
    );

    rerender(
      <SalesPicker
        sessionId="sess"
        selectedSales={{
          openId: "ou_michael",
          name: "Michael Chen",
        }}
        onSelect={() => {}}
      />,
    );

    expect(document.querySelector('[data-sales-row="true"]')).not.toHaveClass(
      "taskpane-selection-enter-group",
    );
  });

  it("shows Feishu avatar on the selected row when avatarUrl is present", () => {
    render(
      <SalesPicker
        sessionId="sess"
        selectedSales={{
          openId: "ou_jenny",
          name: "Jenny Xu",
          avatarUrl: TEST_AVATAR,
        }}
        onSelect={() => {}}
      />,
    );

    const row = document.querySelector(
      '[data-sales-row="true"]',
    ) as HTMLElement;
    expect(row).not.toBeNull();
    const leadingSlot = row.querySelector(':scope > span[aria-hidden="true"]');
    expect(leadingSlot).not.toHaveClass("text-muted-foreground");
    expect(row.querySelector('[data-slot="avatar"]')).toBeInTheDocument();
  });

  it("uses a quiet person icon when avatarUrl is missing", () => {
    render(
      <SalesPicker
        sessionId="sess"
        selectedSales={{ openId: "ou_michael", name: "Michael Chen" }}
        onSelect={() => {}}
      />,
    );

    const row = document.querySelector(
      '[data-sales-row="true"]',
    ) as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.querySelector(':scope > span[aria-hidden="true"]')).toHaveClass(
      "flex",
    );
    expect(row.querySelector('[data-slot="avatar"]')).toBeInTheDocument();
    expect(row.querySelector("svg")).toBeInTheDocument();
    expect(within(row).queryByText("MC")).not.toBeInTheDocument();
    expect(within(row).getByText("Michael Chen")).toBeInTheDocument();
  });

  it("passes avatarUrl when selecting sales from search", async () => {
    const onSelect = vi.fn();
    render(<SalesPicker sessionId="sess" onSelect={onSelect} />);

    fireEvent.change(screen.getByLabelText("Search Feishu sales"), {
      target: { value: "Jenny" },
    });
    fireEvent.click(await screen.findByRole("button", { name: /Jenny Xu/i }));

    expect(onSelect).toHaveBeenCalledWith({
      openId: "ou_jenny",
      name: "Jenny Xu",
      avatarUrl: TEST_AVATAR,
    });
  });

  it("shows preview fixture avatar when usePreviewCoworkers is enabled", async () => {
    const onSelect = vi.fn();
    render(
      <SalesPicker sessionId="sess" usePreviewCoworkers onSelect={onSelect} />,
    );

    fireEvent.change(screen.getByLabelText("Search Feishu sales"), {
      target: { value: "Jenny" },
    });
    fireEvent.click(await screen.findByRole("button", { name: /Jenny Xu/i }));

    expect(onSelect).toHaveBeenCalledWith({
      openId: "ou_jenny",
      name: "Jenny Xu",
      avatarUrl: "https://example.test/jenny.png",
    });
  });
});
