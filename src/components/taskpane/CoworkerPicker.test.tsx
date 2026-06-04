/* eslint-disable max-lines-per-function, require-unicode-regexp */
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CoworkerPicker } from "./CoworkerPicker";
import type { Coworker } from "./coworkers";
import { useCoworkerSearch } from "../../hooks/useCoworkerSearch";

vi.mock("../../hooks/useCoworkerSearch", () => ({
  useCoworkerSearch: vi.fn(),
}));

const mockUseCoworkerSearch = vi.mocked(useCoworkerSearch);

function renderCoworkerPicker(search = vi.fn((_query: string): Coworker[] => [])) {
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

describe("CoworkerPicker search", () => {
  it("searches synchronously on input — no debounce (ADR-0024)", () => {
    const search = renderCoworkerPicker();

    fireEvent.change(screen.getByRole("combobox", { name: /search feishu coworkers/i }), {
      target: { value: "al" },
    });

    // ADR-0024: the directory is preloaded and ranked in-memory, so the picker
    // ranks every keystroke immediately — no 250ms debounce, no timer to advance.
    expect(search).toHaveBeenCalledWith("al");
  });

  it("forwards short queries too — min-length gating lives in the kept hook (ADR-0020)", () => {
    const search = renderCoworkerPicker();

    fireEvent.change(screen.getByRole("combobox", { name: /search feishu coworkers/i }), {
      target: { value: "a" },
    });

    // The picker no longer gates by length; it forwards the query and the kept
    // useCoworkerSearch hook returns [] below MIN_COWORKER_SEARCH_LENGTH.
    expect(search).toHaveBeenCalledWith("a");
  });
});
