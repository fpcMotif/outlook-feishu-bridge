import { describe, expect, it } from "vitest";

import { initials } from "./initials";

describe("initials", () => {
  it("takes first + last initials of a multi-word name", () => {
    expect(initials("Jenny Xu")).toBe("JX");
    expect(initials("Maria Hoffmann")).toBe("MH");
  });

  it("takes a single initial for a one-word name", () => {
    expect(initials("Sales")).toBe("S");
  });

  it("falls back to U for empty / whitespace / undefined", () => {
    expect(initials()).toBe("U");
    expect(initials("   ")).toBe("U");
  });
});
