import { render, screen } from "@testing-library/react";
import { UserRound } from "lucide-react";
import { describe, expect, it } from "vitest";

import { Avatar, AvatarFallback, AvatarImage } from "@/design-system";
import { TaskpaneSelectionRow } from "./TaskpaneSelectionRow";

describe("TaskpaneSelectionRow", () => {
  it("renders icon in the muted leading slot", () => {
    render(
      <TaskpaneSelectionRow
        dataRow="customer"
        icon={<UserRound data-testid="customer-icon" />}
        label="Acme Corp"
      />,
    );

    expect(screen.getByTestId("customer-icon")).toBeInTheDocument();
    expect(screen.getByText("Acme Corp")).toBeInTheDocument();
  });

  it("renders leading avatar without the muted icon treatment", () => {
    render(
      <TaskpaneSelectionRow
        dataRow="coworker"
        leading={
          <Avatar className="size-8">
            <AvatarImage src="https://example.test/avatar.png" alt="" />
            <AvatarFallback>?</AvatarFallback>
          </Avatar>
        }
        label="Jenny Xu"
      />,
    );

    const row = document.querySelector('[data-coworker-row="true"]');
    expect(row).not.toBeNull();
    const leadingSlot = row?.querySelector(':scope > span[aria-hidden="true"]');
    expect(leadingSlot).not.toHaveClass("text-muted-foreground");
    expect(row?.querySelector('[data-slot="avatar"]')).toBeInTheDocument();
  });

  it("uses search-field rhythm when embedded inside a picker panel", () => {
    render(
      <TaskpaneSelectionRow
        dataRow="sales"
        label="Jenny Xu"
        inset={false}
      />,
    );

    const row = document.querySelector('[data-sales-row="true"]');
    expect(row).toHaveClass("min-h-11", "rounded-xl", "bg-background", "shadow-edge");
    expect(row).not.toHaveClass("min-h-14", "px-3");
  });
});
