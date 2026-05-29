// Tests for useRequestSync — a trivial passthrough hook exposing the two public
// Bitable-sync actions (ADR-0012). We mock the generated `api` so the two
// FunctionReferences are distinguishable sentinels, then mock useAction to hand
// back a fn tagged with the reference it was given. That lets us assert `sync`
// is wired to syncRequest and `correct` to correctRequest with no transform.

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// Replace the generated api with sentinel references for the two actions the
// hook reads. Any other access returns undefined, which is fine — unused here.
vi.mock("../../convex/_generated/api", () => ({
  api: {
    feishu: {
      requestSync: {
        syncRequest: "REF_syncRequest",
        correctRequest: "REF_correctRequest",
      },
    },
  },
}));

// useAction(ref) returns a distinct fn tagged with the ref it was passed, so the
// returned {sync, correct} can be traced back to the exact FunctionReference.
vi.mock("convex/react", () => ({
  useAction: (ref: unknown) => {
    const fn = vi.fn();
    (fn as unknown as { actionRef: unknown }).actionRef = ref;
    return fn;
  },
}));

import { useRequestSync } from "./useRequestSync";

describe("useRequestSync", () => {
  it("returns {sync, correct} wired to syncRequest and correctRequest respectively", () => {
    const { result } = renderHook(() => useRequestSync());

    expect((result.current.sync as unknown as { actionRef: unknown }).actionRef).toBe(
      "REF_syncRequest",
    );
    expect((result.current.correct as unknown as { actionRef: unknown }).actionRef).toBe(
      "REF_correctRequest",
    );
  });

  it("exposes sync and correct as the action functions returned by useAction (identity passthrough, no wrapping)", () => {
    const { result } = renderHook(() => useRequestSync());

    // Both are the raw functions from useAction (callable, no transform layer).
    expect(typeof result.current.sync).toBe("function");
    expect(typeof result.current.correct).toBe("function");
    expect(result.current.sync).not.toBe(result.current.correct);
  });
});
