import { beforeEach, describe, expect, it } from "vitest";

import { initialIntakeState } from "./intakeReducer";
import {
  buildIntakeDraftKey,
  clearIntakeDraft,
  clearIntakeDraftCache,
  loadIntakeDraft,
  rememberIntakeDraft,
} from "./intakeDraftCache";

beforeEach(() => {
  clearIntakeDraftCache();
});

describe("buildIntakeDraftKey", () => {
  it("normalizes the mailbox and isolates Feishu users", () => {
    const a = buildIntakeDraftKey("ou_a", " Rep@Fenchem.com ", "conv:rep@fenchem.com\nconv-1");
    const b = buildIntakeDraftKey("ou_a", "rep@fenchem.com", "conv:rep@fenchem.com\nconv-1");
    const c = buildIntakeDraftKey("ou_b", "rep@fenchem.com", "conv:rep@fenchem.com\nconv-1");

    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("returns null without a mailbox", () => {
    expect(buildIntakeDraftKey("ou_a", "", "conv:x")).toBeNull();
    expect(buildIntakeDraftKey("ou_a", "  ", "conv:x")).toBeNull();
  });
});

describe("intake draft round trip", () => {
  it("restores memoized selections for the same conversation", () => {
    const key = buildIntakeDraftKey("ou_a", "rep@fenchem.com", "conv:rep@fenchem.com\nconv-1");
    const state = {
      ...initialIntakeState("buyer@example.com"),
      notes: { request: "Need a quote" },
      selectedSales: { openId: "ou_sales", name: "Michael Chen" },
      salesTouched: true,
    };

    rememberIntakeDraft(key, state);

    expect(loadIntakeDraft(key, "buyer@example.com")).toMatchObject({
      notes: { request: "Need a quote" },
      selectedSales: { openId: "ou_sales", name: "Michael Chen" },
      salesTouched: true,
    });
  });

  it("clears a cached draft", () => {
    const key = buildIntakeDraftKey("ou_a", "rep@fenchem.com", "conv:rep@fenchem.com\nconv-1");
    rememberIntakeDraft(key, {
      ...initialIntakeState("buyer@example.com"),
      selectedSales: { openId: "ou_sales", name: "Michael Chen" },
    });

    clearIntakeDraft(key);

    expect(loadIntakeDraft(key, "buyer@example.com").selectedSales).toBeNull();
  });
});
