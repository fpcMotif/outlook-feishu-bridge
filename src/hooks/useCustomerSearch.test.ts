import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./useCustomerSearchPreload", () => ({
  useCustomerSearchPreload: vi.fn(() => ({
    directory: { status: "ready", records: [{ recordId: "preload", name: "Preload", owner: null }] },
    search: vi.fn(),
    matchEmail: vi.fn(),
    triggerRefresh: vi.fn(),
  })),
}));

vi.mock("./useCustomerSearchServerIndex", () => ({
  useCustomerSearchServerIndex: vi.fn(() => ({
    directory: { status: "ready", records: [] },
    search: vi.fn(async () => [{ recordId: "server", name: "Server", owner: null }]),
    matchEmail: vi.fn(),
    triggerRefresh: vi.fn(),
  })),
}));

describe("useCustomerSearch", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("returns the focused server-index hook when server-index mode is enabled", async () => {
    vi.stubEnv("VITE_CUSTOMER_SEARCH_MODE", "server-index");
    const { useCustomerSearch } = await import("./useCustomerSearch");
    const { result } = renderHook(() => useCustomerSearch(true));

    expect(result.current.directory.records).toEqual([]);
  });
});
