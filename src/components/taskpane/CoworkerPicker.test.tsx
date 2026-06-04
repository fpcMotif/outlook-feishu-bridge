/* eslint-disable max-lines-per-function, require-unicode-regexp */
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CoworkerPicker } from "./CoworkerPicker";
import { useCoworkerSearch } from "../../hooks/useCoworkerSearch";

vi.mock("../../hooks/useCoworkerSearch", () => ({
  useCoworkerSearch: vi.fn(),
}));

const mockUseCoworkerSearch = vi.mocked(useCoworkerSearch);

function renderCoworkerPicker(search = vi.fn(() => Promise.resolve([]))) {
  mockUseCoworkerSearch.mockReturnValue(search);
  render(
    <CoworkerPicker
      sessionId="sess-1"
      selectedCoworker={null}
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
  it("debounces remote coworker search by 250ms", async () => {
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

  it("forwards short queries too — min-length gating lives in the kept hook (ADR-0020)", async () => {
    vi.useFakeTimers();
    const search = renderCoworkerPicker();

    fireEvent.change(screen.getByRole("combobox", { name: /search feishu coworkers/i }), {
      target: { value: "a" },
    });
    await vi.advanceTimersByTimeAsync(250);

    // The picker no longer gates by length; it forwards the query and the kept
    // useCoworkerSearch hook resolves [] below MIN_COWORKER_SEARCH_LENGTH.
    expect(search).toHaveBeenCalledWith("a");
  });

  it("shows the empty message when no Feishu coworkers match the query", async () => {
    renderCoworkerPicker();

    fireEvent.change(screen.getByRole("combobox", { name: /search feishu coworkers/i }), {
      target: { value: "zzzznomatch" },
    });

    expect(
      await screen.findByText('No real Feishu coworkers match "zzzznomatch"'),
    ).toBeInTheDocument();
  });

  it("does not flash the empty message while the debounced search is pending", async () => {
    renderCoworkerPicker();

    fireEvent.change(screen.getByRole("combobox", { name: /search feishu coworkers/i }), {
      target: { value: "zzzznomatch" },
    });

    // Before the debounce settles, the no-match message must NOT be shown.
    expect(
      screen.queryByText('No real Feishu coworkers match "zzzznomatch"'),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Searching…")).toBeInTheDocument();

    // Once settled with no results, the empty message appears and the pending row goes.
    expect(
      await screen.findByText('No real Feishu coworkers match "zzzznomatch"'),
    ).toBeInTheDocument();
    expect(screen.queryByText("Searching…")).not.toBeInTheDocument();
  });
});
