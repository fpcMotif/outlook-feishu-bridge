import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { RequestCards } from "./RequestCards";

function RequestCardsHarness({ initial = "" }: { initial?: string }) {
  const [values, setValues] = useState<Record<string, string>>({ quotation: initial });
  return (
    <RequestCards
      values={values}
      onChange={(id, value) => setValues((prev) => ({ ...prev, [id]: value }))}
    />
  );
}

describe("RequestCards", () => {
  it("renders a soft note shell with placeholder and char counter", () => {
    render(<RequestCards values={{}} onChange={() => {}} />);

    const card = document.querySelector('[data-request-note-card="true"]');
    expect(card).toHaveClass("rounded-2xl", "bg-card-soft");
    expect(card?.querySelector('[data-slot="textarea"]')).toBeTruthy();

    const textarea = screen.getByPlaceholderText(/Describe your requirements/i);
    expect(textarea).toHaveClass("placeholder:italic");
    expect(screen.getByText("0 chars")).toBeInTheDocument();
  });

  it("updates the char counter as the note changes", () => {
    render(<RequestCardsHarness initial="Hi" />);

    expect(screen.getByText("2 chars")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/Describe your requirements/i), {
      target: { value: "Hello" },
    });
    expect(screen.getByText("5 chars")).toBeInTheDocument();
  });
});
