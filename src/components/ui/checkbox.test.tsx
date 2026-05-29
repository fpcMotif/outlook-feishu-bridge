import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";

import { Checkbox } from "./checkbox";

// Checkbox wraps Radix's Checkbox.Root: it stamps data-slot='checkbox', merges
// the base styling with the caller's className, renders an Indicator (with the
// lucide Check icon) inside, and forwards props (checked/onCheckedChange/
// disabled) to the primitive. Radix renders Root as a <button role="checkbox">.
describe("Checkbox", () => {
  it("renders a checkbox-role element with data-slot='checkbox' and base classes", () => {
    const { container } = render(<Checkbox />);
    const el = container.querySelector('[data-slot="checkbox"]');
    expect(el).not.toBeNull();
    expect(el).toHaveAttribute("role", "checkbox");
    expect(el).toHaveClass("peer", "size-5", "shrink-0", "cursor-pointer", "rounded-[6px]");
  });

  it("merges a caller className with the base classes", () => {
    const { container } = render(<Checkbox className="mt-1" />);
    const el = container.querySelector('[data-slot="checkbox"]');
    expect(el).toHaveClass("mt-1", "peer", "size-5");
  });

  it("reflects the unchecked state via aria-checked and data-state", () => {
    const { container } = render(<Checkbox checked={false} />);
    const el = container.querySelector('[data-slot="checkbox"]');
    expect(el).toHaveAttribute("aria-checked", "false");
    expect(el).toHaveAttribute("data-state", "unchecked");
  });

  it("renders the checked state (data-state=checked) and shows the indicator", () => {
    const { container } = render(<Checkbox checked />);
    const el = container.querySelector('[data-slot="checkbox"]');
    expect(el).toHaveAttribute("aria-checked", "true");
    expect(el).toHaveAttribute("data-state", "checked");
    // When checked, the Indicator (with the Check icon svg) is present.
    expect(container.querySelector('[data-slot="checkbox-indicator"]')).not.toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("calls onCheckedChange when clicked", () => {
    const onCheckedChange = vi.fn();
    const { container } = render(<Checkbox checked={false} onCheckedChange={onCheckedChange} />);
    const el = container.querySelector('[data-slot="checkbox"]') as HTMLElement;
    fireEvent.click(el);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("forwards the disabled prop so the control cannot be toggled", () => {
    const onCheckedChange = vi.fn();
    const { container } = render(
      <Checkbox disabled checked={false} onCheckedChange={onCheckedChange} />,
    );
    const el = container.querySelector('[data-slot="checkbox"]') as HTMLButtonElement;
    expect(el).toBeDisabled();
    fireEvent.click(el);
    expect(onCheckedChange).not.toHaveBeenCalled();
  });
});
