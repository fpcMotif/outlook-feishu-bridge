import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CoworkerPicker } from "./CoworkerPicker";

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
  it("shows Feishu avatar on the selected row when avatarUrl is present", async () => {
    const onSelect = vi.fn();
    render(
      <CoworkerPicker
        clientEmail="client@example.com"
        onClientEmailChange={() => {}}
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
        clientEmail="client@example.com"
        onClientEmailChange={() => {}}
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

  it("passes avatarUrl when selecting a coworker from search", async () => {
    const onSelect = vi.fn();
    render(
      <CoworkerPicker
        clientEmail="client@example.com"
        onClientEmailChange={() => {}}
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
});
