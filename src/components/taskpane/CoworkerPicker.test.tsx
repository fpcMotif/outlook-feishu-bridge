// CoworkerPicker behavior — the contacts screen that lets the salesperson edit
// the client email and pick the single Feishu coworker written to the Bitable
// row (ADR-0003). Live directory search runs through useCoworkerSearch (a real
// Feishu user search under the hood); we mock that hook here so the component's
// debounce / fallback / selection logic is exercised in isolation. Recent picks
// are persisted to localStorage under "feishu_recent_coworkers".

/* eslint-disable max-lines-per-function */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The picker calls useCoworkerSearch(sessionId, userAccessToken) and gets back a
// single async search callback. We replace the hook with a controllable spy so
// we can drive the resolve / reject branches without a live Convex session.
const searchCallback = vi.fn<(query: string) => Promise<unknown>>();
const useCoworkerSearch = vi.fn(
  (_sessionId?: string, _userAccessToken?: string) => searchCallback,
);
vi.mock("../../hooks/useCoworkerSearch", () => ({
  useCoworkerSearch: (sessionId: string, userAccessToken?: string) =>
    useCoworkerSearch(sessionId, userAccessToken),
}));

import { CoworkerPicker } from "./CoworkerPicker";

const RECENTS_KEY = "feishu_recent_coworkers";

function renderPicker(overrides: Partial<React.ComponentProps<typeof CoworkerPicker>> = {}) {
  const props = {
    clientEmail: "client@acme.com",
    onClientEmailChange: vi.fn(),
    sessionId: "sess_1",
    onSelect: vi.fn(),
    onBack: vi.fn(),
    ...overrides,
  };
  const utils = render(<CoworkerPicker {...props} />);
  return { ...utils, props };
}

beforeEach(() => {
  localStorage.clear();
  searchCallback.mockReset();
  useCoworkerSearch.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("CoworkerPicker layout", () => {
  it("wires the live search hook with the passed sessionId and userAccessToken", () => {
    renderPicker({ sessionId: "sess_xyz", userAccessToken: "u_tok" });
    expect(useCoworkerSearch).toHaveBeenCalledWith("sess_xyz", "u_tok");
  });

  it("shows the 'Suggested' label and a prompt before any search runs", () => {
    renderPicker();
    expect(screen.getByText("Suggested")).toBeInTheDocument();
    // Suggested view seeds from the preview directory (first 4 entries).
    expect(screen.getByRole("button", { name: /Jenny Xu/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Michael Chen/ })).toBeInTheDocument();
  });

  it("renders the customerSlot when provided and omits it otherwise", () => {
    const { unmount } = renderPicker({ customerSlot: <div>SLOT_CONTENT</div> });
    expect(screen.getByText("SLOT_CONTENT")).toBeInTheDocument();
    unmount();

    renderPicker();
    expect(screen.queryByText("SLOT_CONTENT")).not.toBeInTheDocument();
  });
});

describe("CoworkerPicker back + client email", () => {
  it("invokes onBack when the Back button is clicked", () => {
    const onBack = vi.fn();
    renderPicker({ onBack });
    fireEvent.click(screen.getByRole("button", { name: /^Back$/i }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("reflects the controlled clientEmail value and reports edits via onClientEmailChange", () => {
    const onClientEmailChange = vi.fn();
    renderPicker({ clientEmail: "old@x.com", onClientEmailChange });

    const input = screen.getByLabelText("Client email") as HTMLInputElement;
    expect(input.value).toBe("old@x.com");

    fireEvent.change(input, { target: { value: "new@y.com" } });
    expect(onClientEmailChange).toHaveBeenCalledWith("new@y.com");
  });
});

describe("CoworkerPicker search input", () => {
  it("toggles focus styling on focus/blur of the search box", () => {
    renderPicker();
    const search = screen.getByLabelText("Search Feishu coworkers");
    // Focus then blur should round-trip without throwing (covers onFocus/onBlur).
    fireEvent.focus(search);
    fireEvent.blur(search);
    expect(search).toBeInTheDocument();
  });

  it("shows a Clear button only while the query is non-empty and clears the query", () => {
    renderPicker();
    expect(screen.queryByRole("button", { name: /clear search/i })).not.toBeInTheDocument();

    const search = screen.getByLabelText("Search Feishu coworkers");
    fireEvent.change(search, { target: { value: "jen" } });

    const clear = screen.getByRole("button", { name: /clear search/i });
    fireEvent.click(clear);
    expect((search as HTMLInputElement).value).toBe("");
    expect(screen.queryByRole("button", { name: /clear search/i })).not.toBeInTheDocument();
  });
});

describe("CoworkerPicker live search (debounced)", () => {
  it("debounces the query and feeds the trimmed term to the search hook, listing the resolved results", async () => {
    vi.useFakeTimers();
    searchCallback.mockResolvedValue([{ openId: "ou_real", name: "Real Person" }]);
    renderPicker();

    const search = screen.getByLabelText("Search Feishu coworkers");
    fireEvent.change(search, { target: { value: "  real  " } });

    // Nothing fires before the 250ms debounce window elapses.
    expect(searchCallback).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(250);
    });

    expect(searchCallback).toHaveBeenCalledWith("real");

    // Switch to real timers so findBy* can flush the resolved promise + re-render.
    vi.useRealTimers();
    expect(await screen.findByRole("button", { name: /Real Person/ })).toBeInTheDocument();
    expect(screen.getByText("Results")).toBeInTheDocument();
  });

  it("falls back to the preview directory (filtered by name) when the live search rejects", async () => {
    searchCallback.mockRejectedValue(new Error("no session"));
    renderPicker();

    fireEvent.change(screen.getByLabelText("Search Feishu coworkers"), {
      target: { value: "michael" },
    });

    // On failure the picker filters PREVIEW_COWORKERS by a case-insensitive name match.
    expect(await screen.findByRole("button", { name: /Michael Chen/ })).toBeInTheDocument();
    // A name that does not match "michael" must not appear.
    expect(screen.queryByRole("button", { name: /Jenny Xu/ })).not.toBeInTheDocument();
  });

  it("shows the no-match copy (with the raw query) when a search returns no results", async () => {
    searchCallback.mockResolvedValue([]);
    renderPicker();

    fireEvent.change(screen.getByLabelText("Search Feishu coworkers"), {
      target: { value: "zzz" },
    });

    expect(await screen.findByText('No coworkers match "zzz"')).toBeInTheDocument();
  });

  it("does not call the search hook for a whitespace-only query and clears results", async () => {
    searchCallback.mockResolvedValue([{ openId: "ou_real", name: "Real Person" }]);
    renderPicker();

    const search = screen.getByLabelText("Search Feishu coworkers");
    // First a real query so results populate.
    fireEvent.change(search, { target: { value: "real" } });
    expect(await screen.findByRole("button", { name: /Real Person/ })).toBeInTheDocument();

    // Now blank it out: the q guard returns early, dispatching []. The view falls
    // back to the suggested list (searching becomes false).
    fireEvent.change(search, { target: { value: "   " } });
    await waitFor(() => expect(screen.getByText("Suggested")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /Real Person/ })).not.toBeInTheDocument();
  });

  it("does not surface stale results when the query changes before the debounce fires (cancellation)", async () => {
    vi.useFakeTimers();
    let resolveFirst: (v: unknown) => void = () => {};
    searchCallback.mockImplementationOnce(
      () => new Promise((res) => (resolveFirst = res)),
    );
    renderPicker();

    const search = screen.getByLabelText("Search Feishu coworkers");
    fireEvent.change(search, { target: { value: "first" } });
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    expect(searchCallback).toHaveBeenCalledWith("first");

    // Clear the query, which cancels the effect (cancelled=true) before resolve.
    searchCallback.mockResolvedValueOnce([]);
    fireEvent.change(search, { target: { value: "" } });

    // Resolve the now-cancelled first search; its results must be ignored.
    await act(async () => {
      resolveFirst([{ openId: "ou_stale", name: "Stale Person" }]);
    });

    vi.useRealTimers();
    expect(screen.queryByRole("button", { name: /Stale Person/ })).not.toBeInTheDocument();
  });
});

describe("CoworkerPicker selection + recents", () => {
  it("calls onSelect and persists the pick to recents in localStorage", () => {
    const onSelect = vi.fn();
    renderPicker({ onSelect });

    fireEvent.click(screen.getByRole("button", { name: /Jenny Xu/ }));

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ openId: "ou_jenny", name: "Jenny Xu" }),
    );
    const stored = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]");
    expect(stored[0]).toMatchObject({ openId: "ou_jenny" });
  });

  it("dedupes a re-selected coworker so it stays at the front of recents (no duplicate row)", () => {
    renderPicker();
    // Pick Jenny twice; recents must keep a single Jenny entry at the head.
    fireEvent.click(screen.getByRole("button", { name: /Jenny Xu/ }));
    fireEvent.click(screen.getByRole("button", { name: /Jenny Xu/ }));

    const stored = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]") as Array<{ openId: string }>;
    expect(stored.filter((c) => c.openId === "ou_jenny")).toHaveLength(1);
  });

  it("marks the selected coworker as pressed via aria-pressed", () => {
    renderPicker({ selectedOpenId: "ou_jenny" });
    const jenny = screen.getByRole("button", { name: /Jenny Xu/ });
    expect(jenny).toHaveAttribute("aria-pressed", "true");

    const michael = screen.getByRole("button", { name: /Michael Chen/ });
    expect(michael).toHaveAttribute("aria-pressed", "false");
  });

  it("shows 'Recent & suggested' and lists a previously stored recent ahead of suggestions", () => {
    localStorage.setItem(
      RECENTS_KEY,
      JSON.stringify([{ openId: "ou_recent", name: "Past Pick" }]),
    );
    renderPicker();

    expect(screen.getByText("Recent & suggested")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Past Pick/ })).toBeInTheDocument();
  });
});

describe("CoworkerPicker resilient recents loading", () => {
  it("treats malformed stored recents as empty (does not crash on bad JSON)", () => {
    localStorage.setItem(RECENTS_KEY, "{not json");
    // loadRecents swallows the parse error and returns []; component renders cleanly.
    expect(() => renderPicker()).not.toThrow();
    expect(screen.getByText("Suggested")).toBeInTheDocument();
  });
});
