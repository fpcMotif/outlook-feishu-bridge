import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetCustomerDirectory, useCustomerDirectory } from "./useCustomerDirectory";

import * as convexReact from "convex/react";

vi.mock("convex/react", () => ({
  useAction: vi.fn(),
}));

const mockUseAction = vi.mocked(convexReact.useAction);

describe("useCustomerDirectory", () => {
  let mockFetchCustomers: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockFetchCustomers = vi.fn();
    mockUseAction.mockReturnValue(mockFetchCustomers as never);
    resetCustomerDirectory();
  });

  it("should have initial status 'idle' when not logged in", () => {
    const { result } = renderHook(() => useCustomerDirectory(false));
    expect(result.current.state).toEqual({ status: "idle", records: [] });
    expect(mockFetchCustomers).not.toHaveBeenCalled();
  });

  it("should fetch customers on login and transition to ready state", async () => {
    const records = [{ recordId: "rec_1", name: "Customer 1", owner: null }];
    mockFetchCustomers.mockResolvedValueOnce({ records });

    const { result } = renderHook(() => useCustomerDirectory(true));

    expect(result.current.state).toEqual({ status: "loading", records: [] });
    expect(mockFetchCustomers).toHaveBeenCalledTimes(1);

    await waitFor(() => {
      expect(result.current.state).toEqual({ status: "ready", records });
    });
  });

  it("should transition to error state if fetch fails", async () => {
    mockFetchCustomers.mockRejectedValueOnce(new Error("Fetch failed"));

    const { result } = renderHook(() => useCustomerDirectory(true));

    expect(result.current.state).toEqual({ status: "loading", records: [] });

    await waitFor(() => {
      expect(result.current.state).toEqual({ status: "error", records: [] });
    });
  });

  it("should deduplicate concurrent renders (singleton behavior)", async () => {
    const records = [{ recordId: "rec_1", name: "Customer 1", owner: null }];
    let resolveFetch!: (value: { records: typeof records }) => void;
    const pendingFetch = new Promise<{ records: typeof records }>((resolve) => {
      resolveFetch = resolve;
    });
    mockFetchCustomers.mockReturnValue(pendingFetch);

    const { result: r1 } = renderHook(() => useCustomerDirectory(true));
    const { result: r2 } = renderHook(() => useCustomerDirectory(true));

    expect(r1.current.state).toEqual({ status: "loading", records: [] });
    expect(r2.current.state).toEqual({ status: "loading", records: [] });
    expect(mockFetchCustomers).toHaveBeenCalledTimes(1);

    act(() => {
      resolveFetch({ records });
    });

    await waitFor(() => {
      expect(r1.current.state).toEqual({ status: "ready", records });
      expect(r2.current.state).toEqual({ status: "ready", records });
    });
  });

  it("should fetch again and retain previous records on refresh", async () => {
    const records1 = [{ recordId: "rec_1", name: "Customer 1", owner: null }];
    const records2 = [{ recordId: "rec_1", name: "Customer 1", owner: null }, { recordId: "rec_2", name: "Customer 2", owner: null }];

    let resolveFetch1!: (value: { records: typeof records1 }) => void;
    const pendingFetch1 = new Promise<{ records: typeof records1 }>((resolve) => {
      resolveFetch1 = resolve;
    });
    let resolveFetch2!: (value: { records: typeof records2 }) => void;
    const pendingFetch2 = new Promise<{ records: typeof records2 }>((resolve) => {
      resolveFetch2 = resolve;
    });

    mockFetchCustomers.mockReturnValueOnce(pendingFetch1).mockReturnValueOnce(pendingFetch2);

    const { result } = renderHook(() => useCustomerDirectory(true));

    act(() => resolveFetch1({ records: records1 }));

    await waitFor(() => {
      expect(result.current.state).toEqual({ status: "ready", records: records1 });
    });

    act(() => {
      result.current.refresh();
    });

    // Should transition back to loading but retain old records
    expect(result.current.state).toEqual({ status: "loading", records: records1 });

    act(() => resolveFetch2({ records: records2 }));

    await waitFor(() => {
      expect(result.current.state).toEqual({ status: "ready", records: records2 });
    });
  });

  it("should deduplicate concurrent refresh calls", async () => {
    const records = [{ recordId: "rec_1", name: "Customer 1", owner: null }];
    let resolveFetch1!: (value: { records: typeof records }) => void;
    const pendingFetch1 = new Promise<{ records: typeof records }>((resolve) => resolveFetch1 = resolve);
    let resolveFetch2!: (value: { records: typeof records }) => void;
    const pendingFetch2 = new Promise<{ records: typeof records }>((resolve) => resolveFetch2 = resolve);

    mockFetchCustomers.mockReturnValueOnce(pendingFetch1).mockReturnValueOnce(pendingFetch2);

    const { result } = renderHook(() => useCustomerDirectory(true));

    act(() => resolveFetch1({ records }));
    await waitFor(() => expect(result.current.state.status).toBe("ready"));

    act(() => {
      result.current.refresh();
      result.current.refresh();
    });

    expect(mockFetchCustomers).toHaveBeenCalledTimes(2);

    act(() => resolveFetch2({ records }));
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
  });

  it("should recover from error state on refresh", async () => {
    mockFetchCustomers.mockRejectedValueOnce(new Error("Failed"));

    const { result } = renderHook(() => useCustomerDirectory(true));

    await waitFor(() => expect(result.current.state.status).toBe("error"));

    const records = [{ recordId: "rec_1", name: "Customer 1", owner: null }];
    mockFetchCustomers.mockResolvedValueOnce({ records });

    act(() => {
      result.current.refresh();
    });

    expect(result.current.state).toEqual({ status: "loading", records: [] });

    await waitFor(() => {
      expect(result.current.state).toEqual({ status: "ready", records });
    });
  });

  it("should maintain state when one of concurrent instances unmounts", async () => {
    const records = [{ recordId: "rec_1", name: "Customer 1", owner: null }];
    mockFetchCustomers.mockResolvedValueOnce({ records });

    const { result: r1, unmount: unmount1 } = renderHook(() => useCustomerDirectory(true));
    const { result: r2 } = renderHook(() => useCustomerDirectory(true));

    await waitFor(() => {
      expect(r1.current.state.status).toBe("ready");
      expect(r2.current.state.status).toBe("ready");
    });

    act(() => {
      unmount1();
    });

    expect(r2.current.state).toEqual({ status: "ready", records });

    // Confirm state holds after a tick
    await new Promise(r => setTimeout(r, 0));
    expect(r2.current.state).toEqual({ status: "ready", records });
  });

  it("should reset directory correctly", async () => {
    const records = [{ recordId: "rec_1", name: "Customer 1", owner: null }];
    mockFetchCustomers.mockResolvedValueOnce({ records });

    const { result } = renderHook(() => useCustomerDirectory(true));

    await waitFor(() => expect(result.current.state.status).toBe("ready"));

    act(() => {
      resetCustomerDirectory();
    });

    expect(result.current.state).toEqual({ status: "idle", records: [] });
  });
});
