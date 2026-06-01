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
