import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { IntakeHeader } from "./RequestIntakeScaffold";

describe("IntakeHeader", () => {
  it("renders the Sales Service logo as the page header", () => {
    render(<IntakeHeader />);

    expect(screen.getByRole("img", { name: /Sales Service logo/i })).toBeInTheDocument();
    expect(screen.getByText("Sales Service")).toHaveClass("sr-only");
  });
});
