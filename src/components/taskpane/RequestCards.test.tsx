// RequestCards behavior — the collapsible accordion of request types (Quotation,
// Sample, R&D Support) on the compose screen. Each card holds a free-text note;
// a non-empty (trimmed) note flips the card into a "Selected" state with a badge
// and surfaces a live character count. The component is controlled: `values`
// keys the note text by request id, and edits flow out via onChange(id, value).

/* eslint-disable max-lines-per-function */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RequestCards } from "./RequestCards";
import { REQUESTS } from "./requests";

describe("RequestCards rendering", () => {
  it("renders one accordion trigger per request definition", () => {
    render(<RequestCards values={{}} onChange={vi.fn()} />);
    for (const req of REQUESTS) {
      expect(screen.getByRole("button", { name: new RegExp(req.title) })).toBeInTheDocument();
    }
  });

  it("collapses content by default so the note textarea is not visible until expanded", () => {
    render(<RequestCards values={{}} onChange={vi.fn()} />);
    // Radix keeps closed AccordionContent out of the accessible tree.
    expect(screen.queryByPlaceholderText(REQUESTS[0].placeholder)).not.toBeInTheDocument();
  });
});

describe("RequestCards note editing", () => {
  it("reveals the note textarea (with the request's placeholder) when a card is expanded", () => {
    render(<RequestCards values={{}} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(REQUESTS[0].title) }));

    const textarea = screen.getByPlaceholderText(REQUESTS[0].placeholder);
    expect(textarea).toBeInTheDocument();
  });

  it("forwards edits to onChange keyed by the request id", () => {
    const onChange = vi.fn();
    render(<RequestCards values={{}} onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: new RegExp(REQUESTS[0].title) }));
    fireEvent.change(screen.getByPlaceholderText(REQUESTS[0].placeholder), {
      target: { value: "Need 200kg of citrate" },
    });

    expect(onChange).toHaveBeenCalledWith(REQUESTS[0].id, "Need 200kg of citrate");
  });

  it("shows the controlled value in the textarea and a matching character count", () => {
    const note = "12345"; // 5 chars
    render(<RequestCards values={{ [REQUESTS[0].id]: note }} onChange={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: new RegExp(REQUESTS[0].title) }));

    const textarea = screen.getByPlaceholderText(REQUESTS[0].placeholder) as HTMLTextAreaElement;
    expect(textarea.value).toBe(note);
    expect(screen.getByText("5 chars")).toBeInTheDocument();
  });

  it("treats a missing value as an empty string (0 chars) without crashing", () => {
    render(<RequestCards values={{}} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(REQUESTS[0].title) }));

    const textarea = screen.getByPlaceholderText(REQUESTS[0].placeholder) as HTMLTextAreaElement;
    expect(textarea.value).toBe("");
    expect(screen.getByText("0 chars")).toBeInTheDocument();
  });
});

describe("RequestCards selected state", () => {
  it("shows the 'Selected' badge for a card whose note has non-whitespace content", () => {
    render(<RequestCards values={{ [REQUESTS[0].id]: "real content" }} onChange={vi.fn()} />);
    expect(screen.getByText("Selected")).toBeInTheDocument();
  });

  it("does NOT show 'Selected' for a whitespace-only note (trim guard)", () => {
    render(<RequestCards values={{ [REQUESTS[0].id]: "   \n\t " }} onChange={vi.fn()} />);
    expect(screen.queryByText("Selected")).not.toBeInTheDocument();
  });

  it("does NOT show 'Selected' for any card when all notes are empty", () => {
    render(<RequestCards values={{}} onChange={vi.fn()} />);
    expect(screen.queryByText("Selected")).not.toBeInTheDocument();
  });

  it("shows one 'Selected' badge per filled card when multiple notes have content", () => {
    render(
      <RequestCards
        values={{ [REQUESTS[0].id]: "a", [REQUESTS[1].id]: "b" }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getAllByText("Selected")).toHaveLength(2);
  });
});
