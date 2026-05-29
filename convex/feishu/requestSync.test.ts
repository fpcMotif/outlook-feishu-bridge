// Unit tests for the pure intake guard that fronts the Bitable Sync write path.
// `requireExactlyOneCoworker` is the only branching logic in requestSync.ts
// that does not need a live Convex ctx — the syncRequest/correctRequest handler
// bodies are thin ctx.runAction/ctx.runMutation orchestration (covered by
// integration/e2e). Bitable Sync requires EXACTLY one Feishu coworker so the
// Service row's `Co Worker` User column maps to a single open_id (ADR-0012);
// this guard rejects the under/over cases before any Feishu write happens.

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
    // Same reference passes straight through — no copy / no mutation.
    expect(result).toBe(input);
    expect(result).toEqual([jenny]);
  });

  it("throws when given undefined (the SPA submitted no coworker)", () => {
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
