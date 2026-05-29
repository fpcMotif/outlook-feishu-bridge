// Tests for useSelfForward — the SPA driver for the app-only native Self-Forward
// copy (ADR-0017). The hook forwards args to the Convex `sendSelfForwardNote`
// action, logs start/result, and wraps the call in try/catch translating any
// throw into a structured {ok:false} envelope. We cover the happy path, both
// catch branches (Error vs non-Error), the start-log format, and useCallback
// identity. console.log/error are spied (and silenced) per the unit notes.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SelfForwardArgs, SelfForwardResult } from "./useSelfForward";

// The hook calls useAction(api.m365.selfForward.sendSelfForwardNote); the spy is
// returned for every useAction call. The generated api import is harmless.
const send = vi.fn();
vi.mock("convex/react", () => ({
  useAction: () => send,
}));

import { useSelfForward } from "./useSelfForward";

const ARGS: SelfForwardArgs = {
  originalMessageId: "AAMkADAwATM0", // length 12
  selfEmail: "fanpc@fenchem.com",
  customerName: "Bayer Pharma",
  clientEmail: "buyer@bayerpharma.de",
  requestSelections: [{ requestType: "Quotation", note: "pls quote" }],
};

describe("useSelfForward", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    send.mockReset();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("forwards args to sendSelfForwardNote and returns its resolved SelfForwardResult on success", async () => {
    const ok: SelfForwardResult = { ok: true, requestId: "req-1" };
    send.mockResolvedValue(ok);
    const { result } = renderHook(() => useSelfForward());

    let out: SelfForwardResult | undefined;
    await act(async () => {
      out = await result.current.sendNote(ARGS);
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(ARGS);
    expect(out).toBe(ok);
    // Logs the action result (serialized) on success.
    expect(logSpy).toHaveBeenCalledWith(
      `[selfForward] action result=${JSON.stringify(ok)}`,
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("logs the start line with self + messageIdLen before invoking the action", async () => {
    send.mockResolvedValue({ ok: true });
    const { result } = renderHook(() => useSelfForward());

    await act(async () => {
      await result.current.sendNote(ARGS);
    });

    expect(logSpy).toHaveBeenCalledWith(
      `[selfForward] start self=fanpc@fenchem.com messageIdLen=${ARGS.originalMessageId.length}`,
    );
  });

  it("catches an Error rejection and returns {ok:false, step:'convex', code:'action_error', message:<error.message>}", async () => {
    send.mockRejectedValue(new Error("boom from graph"));
    const { result } = renderHook(() => useSelfForward());

    let out: SelfForwardResult | undefined;
    await act(async () => {
      out = await result.current.sendNote(ARGS);
    });

    expect(out).toEqual({
      ok: false,
      step: "convex",
      code: "action_error",
      message: "boom from graph",
    });
    expect(errorSpy).toHaveBeenCalledWith(
      "[selfForward] action invocation FAILED boom from graph",
    );
  });

  it("catches a non-Error rejection (string thrown) and returns message:'Convex action failed'", async () => {
    // Non-Error throw exercises the `e instanceof Error ? ... : fallback` branch.
    send.mockRejectedValue("just a string");
    const { result } = renderHook(() => useSelfForward());

    let out: SelfForwardResult | undefined;
    await act(async () => {
      out = await result.current.sendNote(ARGS);
    });

    expect(out).toEqual({
      ok: false,
      step: "convex",
      code: "action_error",
      message: "Convex action failed",
    });
    expect(errorSpy).toHaveBeenCalledWith(
      "[selfForward] action invocation FAILED Convex action failed",
    );
  });

  it("returns a stable sendNote callback across re-renders while send is unchanged", () => {
    const { result, rerender } = renderHook(() => useSelfForward());

    const first = result.current.sendNote;
    rerender();
    // send identity is stable (mock returns the same fn), so useCallback memoizes.
    expect(result.current.sendNote).toBe(first);
  });
});
