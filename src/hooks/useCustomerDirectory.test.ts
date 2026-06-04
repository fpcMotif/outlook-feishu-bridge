import { act, renderHook, waitFor } from "@testing-library/react";
import { useAction } from "convex/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetCustomerDirectory, useCustomerDirectory } from "./useCustomerDirectory";

vi.mock("convex/react", () => ({ useAction: vi.fn() }));

const mockUseAction = vi.mocked(useAction);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("useCustomerDirectory logout race", () => {
  beforeEach(() => {
    resetCustomerDirectory();
    vi.clearAllMocks();
  });
  afterEach(() => {
    resetCustomerDirectory();
  });

  it("does not publish a preload that resolves after reset() (logout)", async () => {
    const d = deferred<{ records: unknown[] }>();
    const list = vi.fn(() => d.promise);
    mockUseAction.mockReturnValue(list as unknown as ReturnType<typeof useAction>);

    const { result } = renderHook(() => useCustomerDirectory(true));

    await waitFor(() => expect(result.current.state.status).toBe("loading"));
    expect(list).toHaveBeenCalledTimes(1);

    // Logout mid-flight.
    act(() => {
      resetCustomerDirectory();
    });
    expect(result.current.state.status).toBe("idle");

    // Stale action resolves with the previous user's CRM records (PII).
    await act(async () => {
      d.resolve({ records: [{ id: "stale-customer" }] });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.state.status).toBe("idle");
    expect(result.current.state.records).toHaveLength(0);
  });
});
