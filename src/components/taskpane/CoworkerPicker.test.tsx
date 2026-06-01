/* eslint-disable max-lines-per-function, require-unicode-regexp */
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CoworkerPicker } from "./CoworkerPicker";
import { useCoworkerDirectory } from "../../hooks/useCoworkerDirectory";
import { useCoworkerSearch } from "../../hooks/useCoworkerSearch";

vi.mock("../../hooks/useCoworkerSearch", () => ({
  useCoworkerSearch: vi.fn(),
}));
vi.mock("../../hooks/useCoworkerDirectory", () => ({
  useCoworkerDirectory: vi.fn(),
}));

const mockUseCoworkerSearch = vi.mocked(useCoworkerSearch);
const mockUseCoworkerDirectory = vi.mocked(useCoworkerDirectory);

function renderCoworkerPicker(search = vi.fn(() => Promise.resolve([]))) {
  mockUseCoworkerSearch.mockReturnValue(search);
  mockUseCoworkerDirectory.mockReturnValue({
    state: { status: "error", records: [] },
    refresh: vi.fn(),
  });
  render(
    <CoworkerPicker
      clientEmail="client@example.com"
      onClientEmailChange={vi.fn()}
      sessionId="sess-1"
      selectedOpenId={undefined}
      onSelect={vi.fn()}
    />,
  );
  return search;
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  localStorage.clear();
});

describe("CoworkerPicker remote search", () => {
  it("uses the warm Coworker Directory locally without debouncing a remote search", async () => {
    vi.useFakeTimers();
    const search = vi.fn(() => Promise.resolve([]));
    mockUseCoworkerSearch.mockReturnValue(search);
    mockUseCoworkerDirectory.mockReturnValue({
      state: {
        status: "ready",
        records: [
          { openId: "ou_alice", name: "Alice Directory" },
          { openId: "ou_bob", name: "Bob Directory" },
        ],
      },
      refresh: vi.fn(),
    });
    render(
      <CoworkerPicker
        clientEmail="client@example.com"
        onClientEmailChange={vi.fn()}
        sessionId="sess-1"
        selectedOpenId={undefined}
        onSelect={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByRole("combobox", { name: /search feishu coworkers/i }), {
      target: { value: "al" },
    });

    expect(screen.getByRole("button", { name: /alice directory/i })).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(500);
    expect(search).not.toHaveBeenCalled();
  });

  it("does not debounce or call coworker search for one-character queries", async () => {
    vi.useFakeTimers();
    const search = renderCoworkerPicker();

    fireEvent.change(screen.getByRole("combobox", { name: /search feishu coworkers/i }), {
      target: { value: "a" },
    });
    await vi.advanceTimersByTimeAsync(500);

    expect(search).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox", { name: /search results/i })).not.toBeInTheDocument();
  });

  it("debounces remote coworker search once the query is specific", async () => {
    vi.useFakeTimers();
    const search = renderCoworkerPicker();

    fireEvent.change(screen.getByRole("combobox", { name: /search feishu coworkers/i }), {
      target: { value: "al" },
    });

    expect(search).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);

    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith("al");
  });
});
