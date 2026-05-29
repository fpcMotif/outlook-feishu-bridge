import { describe, expect, it } from "vitest";

import { requireExactlyOneCoworker } from "./requestSync";
import type { SelectedCoworker } from "../emailRecord";

const jenny: SelectedCoworker = { openId: "ou_jenny", name: "Jenny Xu" };
const dave: SelectedCoworker = { openId: "ou_dave", name: "Dave Lin" };
const ERR = "Bitable Sync requires exactly one Feishu coworker";

describe("requireExactlyOneCoworker", () => {
  it("returns the array unchanged when exactly one coworker is present", () => {
    const input = [jenny];
    const result = requireExactlyOneCoworker(input);
    expect(result).toBe(input);
    expect(result).toEqual([jenny]);
  });

  it("throws when given undefined", () => {
    expect(() => requireExactlyOneCoworker(undefined)).toThrow(ERR);
  });

  it("throws when given zero coworkers", () => {
    expect(() => requireExactlyOneCoworker([])).toThrow(ERR);
  });

  it("throws when given two or more coworkers", () => {
    expect(() => requireExactlyOneCoworker([jenny, dave])).toThrow(ERR);
    expect(() => requireExactlyOneCoworker([jenny, dave, jenny])).toThrow(ERR);
  });
});
