import { describe, it, expect } from "vitest";

import { cn } from "./utils";

// cn() = twMerge(clsx(inputs)). It must (1) flatten the clsx-supported inputs
// (strings / arrays / conditional objects), and (2) let tailwind-merge collapse
// conflicting Tailwind utilities so the LAST one wins.
describe("cn", () => {
  it("joins plain string class names with single spaces", () => {
    expect(cn("a", "b", "c")).toBe("a b c");
  });

  it("flattens array inputs (clsx behavior)", () => {
    expect(cn(["a", "b"], "c")).toBe("a b c");
  });

  it("includes a class only when its conditional object value is truthy", () => {
    // clsx object form: { class: condition }
    expect(cn({ on: true, off: false }, "tail")).toBe("on tail");
  });

  it("drops falsy values (false / null / undefined / 0 / '')", () => {
    expect(cn("keep", false, null, undefined, 0 as unknown as string, "", "also")).toBe(
      "keep also",
    );
  });

  it("merges conflicting Tailwind utilities so the last wins (tailwind-merge)", () => {
    // px-2 then px-4 -> only px-4 survives.
    expect(cn("px-2", "px-4")).toBe("px-4");
  });

  it("keeps non-conflicting Tailwind utilities side by side", () => {
    expect(cn("px-2", "py-4")).toBe("px-2 py-4");
  });

  it("returns an empty string when given no inputs", () => {
    expect(cn()).toBe("");
  });

  it("dedupes a conflicting class introduced via a conditional override", () => {
    // The conditional `text-red-500` overrides the base `text-black`.
    expect(cn("text-black", { "text-red-500": true })).toBe("text-red-500");
  });
});
