import { act, renderHook, waitFor } from "@testing-library/react";
import { useConvex } from "convex/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetColleagueDirectory, useColleagueDirectory } from "./useColleagueDirectory";

vi.mock("convex/react", () => ({ useConvex: vi.fn() }));

const mockUseConvex = vi.mocked(useConvex);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("useColleagueDirectory logout race", () => {
  beforeEach(() => {
    resetColleagueDirectory();
    vi.clearAllMocks();
  });
  afterEach(() => {
    resetColleagueDirectory();
  });

  it("does not publish a preload that resolves after reset() (logout)", async () => {
    const d = deferred<{ contacts: unknown[]; mirroredAt: number | null }>();
    const query = vi.fn(() => d.promise);
    mockUseConvex.mockReturnValue({ query } as unknown as ReturnType<typeof useConvex>);

    const { result } = renderHook(() => useColleagueDirectory(true));

    // Preload is in flight for the first (now-stale) user.
    await waitFor(() => expect(result.current.state.status).toBe("loading"));
    expect(query).toHaveBeenCalledTimes(1);

    // User logs out while the preload is still in flight.
    act(() => {
      resetColleagueDirectory();
    });
    expect(result.current.state.status).toBe("idle");

    // The stale in-flight query now resolves with the previous user's directory.
    await act(async () => {
      d.resolve({ contacts: [{ openId: "stale-user" }], mirroredAt: 123 });
      await Promise.resolve();
      await Promise.resolve();
    });

    // It must NOT repopulate the singleton — the generation guard drops it.
    expect(result.current.state.status).toBe("idle");
    expect(result.current.state.contacts).toHaveLength(0);
  });
});
