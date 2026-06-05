import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Button } from "./button";

describe("Button", () => {
  it("renders a native button by default", () => {
    render(<Button>Save</Button>);

    expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute(
      "data-slot",
      "button",
    );
  });

  it("can pass button styling through to a child control", () => {
    render(
      <Button asChild variant="link">
        <a href="https://example.com">Open record</a>
      </Button>,
    );

    const link = screen.getByRole("link", { name: "Open record" });
    expect(link).toHaveAttribute("href", "https://example.com");
    expect(link).toHaveAttribute("data-slot", "button");
    expect(link).toHaveClass("text-primary");
  });
});
