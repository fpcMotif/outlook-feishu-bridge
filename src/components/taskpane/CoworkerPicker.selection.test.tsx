import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CoworkerPicker } from "./CoworkerPicker";
import { TASKPANE_INSET_DIVIDER } from "./taskpaneSearchPanelLayout";

const TEST_AVATAR =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

vi.mock("../../hooks/useCoworkerSearch", () => {
  const testAvatar =
    "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  const coworkers = [
    { openId: "ou_jenny", name: "Jenny Xu", avatarUrl: testAvatar },
    { openId: "ou_sales_ops", name: "Sales Ops" },
  ];
  return {
    useCoworkerSearch: () =>
      vi.fn((query: string) =>
        Promise.resolve(coworkers.filter((c) => c.name.toLowerCase().includes(query.toLowerCase()))),
      ),
  };
});

describe("CoworkerPicker selected row", () => {
  it("does not render an editable client email row", () => {
    render(
      <CoworkerPicker sessionId="sess" selectedCoworker={null} onSelect={() => {}} />,
    );

    expect(document.querySelector('[data-client-row="true"]')).toBeNull();
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
  });

  it("shows Feishu avatar on the selected row when avatarUrl is present", async () => {
    const onSelect = vi.fn();
    render(
      <CoworkerPicker
        sessionId="sess"
        selectedCoworker={{
          openId: "ou_jenny",
          name: "Jenny Xu",
          avatarUrl: TEST_AVATAR,
        }}
        onSelect={onSelect}
      />,
    );

    const row = document.querySelector('[data-coworker-row="true"]') as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.querySelector(':scope > span[aria-hidden="true"]')).not.toHaveClass(
      "text-muted-foreground",
    );
    expect(row.querySelector('[data-slot="avatar"]')).toBeInTheDocument();
  });

  it("keeps coworker icon when avatarUrl is missing", () => {
    render(
      <CoworkerPicker
        sessionId="sess"
        selectedCoworker={{ openId: "ou_sales_ops", name: "Sales Ops" }}
        onSelect={() => {}}
      />,
    );

    const row = document.querySelector('[data-coworker-row="true"]') as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.querySelector(':scope > span[aria-hidden="true"]')).toHaveClass(
      "text-muted-foreground",
    );
    expect(row.querySelector('[data-slot="avatar"]')).toBeNull();
    expect(row.querySelector("svg")).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText("Sales Ops")).toBeInTheDocument();
  });

  it("shows a quiet person icon in search when avatarUrl is missing", async () => {
    render(<CoworkerPicker sessionId="sess" onSelect={() => {}} />);

    fireEvent.change(screen.getByLabelText("Search Feishu coworkers"), {
      target: { value: "Sales" },
    });

    const option = await screen.findByRole("button", { name: /Sales Ops/i });
    expect(option.querySelector(".lucide-user-round")).toBeInTheDocument();
    expect(option.querySelector('[data-slot="avatar-image"]')).toBeNull();
  });

  it("passes avatarUrl when selecting a coworker from search", async () => {
    const onSelect = vi.fn();
    render(
      <CoworkerPicker
        sessionId="sess"
        onSelect={onSelect}
      />,
    );

    fireEvent.change(screen.getByLabelText("Search Feishu coworkers"), {
      target: { value: "Jenny" },
    });
    fireEvent.click(await screen.findByRole("button", { name: /Jenny Xu/i }));

    expect(onSelect).toHaveBeenCalledWith({
      openId: "ou_jenny",
      name: "Jenny Xu",
      avatarUrl: TEST_AVATAR,
    });
  });

  it("closes the search dropdown when clicking outside", async () => {
    render(
      <div>
        <CoworkerPicker sessionId="sess" onSelect={() => {}} />
        <button type="button">Outside section</button>
      </div>,
    );

    fireEvent.change(screen.getByLabelText("Search Feishu coworkers"), {
      target: { value: "Jenny" },
    });
    expect(await screen.findByLabelText("Search results")).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole("button", { name: "Outside section" }));

    expect(screen.queryByLabelText("Search results")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Search Feishu coworkers")).toHaveValue("");
  });

  it("returns to the selected row when clicking outside during change", () => {
    render(
      <div>
        <CoworkerPicker
          sessionId="sess"
          selectedCoworker={{
            openId: "ou_jenny",
            name: "Jenny Xu",
            avatarUrl: TEST_AVATAR,
          }}
          onSelect={() => {}}
        />
        <button type="button">Outside section</button>
      </div>,
    );

    fireEvent.click(screen.getByRole("button", { name: /change/i }));
    expect(screen.getByLabelText("Search Feishu coworkers")).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole("button", { name: "Outside section" }));

    expect(screen.queryByLabelText("Search Feishu coworkers")).not.toBeInTheDocument();
    expect(screen.getByText("Jenny Xu")).toBeInTheDocument();
  });

  it("renders an inset divider between customer slot and coworker row", () => {
    render(
      <CoworkerPicker
        sessionId="sess"
        customerSlot={<div data-customer-row="true">Bayer Pharma</div>}
        selectedCoworker={{ openId: "ou_maria", name: "Maria Hoffmann" }}
        onSelect={() => {}}
      />,
    );

    const divider = document.querySelector("hr");
    expect(divider).not.toBeNull();
    expect(divider).toHaveClass(...TASKPANE_INSET_DIVIDER.split(" "));
  });
});
