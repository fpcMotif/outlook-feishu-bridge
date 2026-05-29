import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@testing-library/react";

import { Input } from "./input";

// Input is a styled native <input>: it stamps data-slot='input', forwards the
// `type` prop verbatim, merges its base classes with the caller's className,
// and spreads everything else (value/onChange/placeholder/disabled/ref) onto
// the underlying element.
describe("Input", () => {
  it("renders an input with data-slot='input' and the base styling classes", () => {
    const { container } = render(<Input />);
    const el = container.querySelector('[data-slot="input"]');
    expect(el).not.toBeNull();
    expect(el?.tagName).toBe("INPUT");
    expect(el).toHaveClass("bg-card-soft", "flex", "h-10", "w-full", "rounded-xl", "text-sm");
  });

  it("forwards the type prop onto the input element", () => {
    const { container } = render(<Input type="email" />);
    const el = container.querySelector('[data-slot="input"]');
    expect(el).toHaveAttribute("type", "email");
  });

  it("renders without a type attribute when type is omitted", () => {
    // type={undefined} -> React omits the attribute entirely.
    const { container } = render(<Input />);
    const el = container.querySelector('[data-slot="input"]');
    expect(el).not.toHaveAttribute("type");
  });

  it("merges a caller className with the base classes", () => {
    const { container } = render(<Input className="mine" />);
    const el = container.querySelector('[data-slot="input"]');
    expect(el).toHaveClass("mine", "bg-card-soft");
  });

  it("spreads placeholder/disabled and other props onto the input", () => {
    const { container } = render(<Input placeholder="email" disabled />);
    const el = container.querySelector('[data-slot="input"]') as HTMLInputElement;
    expect(el).toHaveAttribute("placeholder", "email");
    expect(el).toBeDisabled();
  });

  it("fires the onChange handler with the typed value", () => {
    let captured = "";
    const { container } = render(
      <Input onChange={(e) => (captured = e.currentTarget.value)} />,
    );
    const el = container.querySelector('[data-slot="input"]') as HTMLInputElement;
    fireEvent.change(el, { target: { value: "hello" } });
    expect(captured).toBe("hello");
  });
});
