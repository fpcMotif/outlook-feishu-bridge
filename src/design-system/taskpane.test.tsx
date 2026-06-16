import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  InlineActionButton,
  TaskpaneEyebrow,
  TaskpaneScrollShell,
  TaskpaneStateMessage,
} from "./taskpane";

describe("taskpane design-system components", () => {
  it("keeps the taskpane scroll shell on semantic tokens", () => {
    const { container } = render(<TaskpaneScrollShell>Content</TaskpaneScrollShell>);

    expect(container.firstElementChild).toHaveClass(
      "bg-background",
      "text-foreground",
      "no-scrollbar",
      "overflow-y-auto",
    );
  });

  it("renders the shared eyebrow label with the muted rule", () => {
    const { container } = render(<TaskpaneEyebrow>Outlook handoff</TaskpaneEyebrow>);

    expect(screen.getByText("Outlook handoff")).toHaveClass("text-muted-foreground");
    expect(container.querySelector("span")).toHaveClass("bg-muted-foreground", "h-px");
  });

  it("renders centered state copy, icon, and actions without changing button behavior", () => {
    const onClick = vi.fn();
    render(
      <TaskpaneStateMessage
        title="No message open"
        titleAs="h2"
        description="Open a received message in Outlook."
        icon={<span data-testid="state-icon" />}
        actions={<button type="button" onClick={onClick}>Read current email</button>}
      />,
    );

    expect(screen.getByRole("heading", { name: /No message open/i })).toHaveProperty(
      "tagName",
      "H2",
    );
    expect(screen.getByText("Open a received message in Outlook.")).toHaveClass(
      "text-muted-foreground",
    );

    fireEvent.click(screen.getByRole("button", { name: /Read current email/i }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("standardizes link-like action buttons", () => {
    render(<InlineActionButton disabled>Use backup login</InlineActionButton>);

    expect(screen.getByRole("button", { name: /Use backup login/i })).toHaveClass(
      "disabled:text-muted-foreground/55",
      "underline-offset-2",
    );
  });
});

