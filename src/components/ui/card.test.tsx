import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";

import {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardDescription,
  CardContent,
} from "./card";

// The Card family are thin styled <div> wrappers: each stamps a stable
// data-slot, merges its base Tailwind classes with the caller's className via
// cn(), and spreads the rest of the props onto the underlying div.
describe("Card", () => {
  it("renders a div with data-slot='card' and the base card classes", () => {
    const { container } = render(<Card>body</Card>);
    const el = container.querySelector('[data-slot="card"]');
    expect(el).not.toBeNull();
    expect(el?.tagName).toBe("DIV");
    expect(el).toHaveClass("bg-card", "text-card-foreground", "flex", "flex-col", "rounded-2xl");
    expect(el).toHaveTextContent("body");
  });

  it("merges a caller className after the base classes", () => {
    const { container } = render(<Card className="custom-x" />);
    const el = container.querySelector('[data-slot="card"]');
    expect(el).toHaveClass("custom-x");
    // base class still present (cn merge, not replace)
    expect(el).toHaveClass("bg-card");
  });

  it("spreads arbitrary props (id, aria) onto the div", () => {
    const { container } = render(<Card id="c1" aria-label="panel" />);
    const el = container.querySelector('[data-slot="card"]');
    expect(el).toHaveAttribute("id", "c1");
    expect(el).toHaveAttribute("aria-label", "panel");
  });
});

describe("CardHeader", () => {
  it("renders data-slot='card-header' with its base flex classes and merges className", () => {
    const { container } = render(<CardHeader className="hx">h</CardHeader>);
    const el = container.querySelector('[data-slot="card-header"]');
    expect(el).toHaveClass("flex", "flex-col", "gap-1.5", "hx");
    expect(el).toHaveTextContent("h");
  });
});

describe("CardTitle", () => {
  it("renders data-slot='card-title' with the serif heading classes", () => {
    const { container } = render(<CardTitle>Title</CardTitle>);
    const el = container.querySelector('[data-slot="card-title"]');
    expect(el).toHaveClass("font-serif", "text-2xl", "leading-none", "tracking-tight");
    expect(el).toHaveTextContent("Title");
  });
});

describe("CardDescription", () => {
  it("renders data-slot='card-description' with the muted small-text classes", () => {
    const { container } = render(<CardDescription>desc</CardDescription>);
    const el = container.querySelector('[data-slot="card-description"]');
    expect(el).toHaveClass("text-muted-foreground", "text-sm");
    expect(el).toHaveTextContent("desc");
  });
});

describe("CardContent", () => {
  it("renders data-slot='card-content' with only the caller className (no base classes)", () => {
    const { container } = render(<CardContent className="only-mine">x</CardContent>);
    const el = container.querySelector('[data-slot="card-content"]');
    expect(el).toHaveClass("only-mine");
    expect(el).toHaveTextContent("x");
  });
});

describe("CardFooter", () => {
  it("renders data-slot='card-footer' with the centered-flex classes and merges className", () => {
    const { container } = render(<CardFooter className="fx">f</CardFooter>);
    const el = container.querySelector('[data-slot="card-footer"]');
    expect(el).toHaveClass("flex", "items-center", "fx");
    expect(el).toHaveTextContent("f");
  });
});
