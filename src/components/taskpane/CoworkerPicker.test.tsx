import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CoworkerPicker, type SearchCoworkers } from "./CoworkerPicker";
import type { Contact } from "@/forward/targets";

function renderPicker(searchCoworkers: SearchCoworkers, onToggle = vi.fn()) {
  render(
    <CoworkerPicker
      clientEmail="client@example.com"
      onClientEmailChange={vi.fn()}
      selectedOpenIds={[]}
      searchCoworkers={searchCoworkers}
      onToggle={onToggle}
      onBack={vi.fn()}
    />,
  );
  return onToggle;
}

describe("CoworkerPicker live search", () => {
  const storage = new Map<string, string>();

  beforeEach(() => {
    storage.clear();
    vi.stubGlobal("localStorage", {
      clear: vi.fn(() => storage.clear()),
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      removeItem: vi.fn((key: string) => {
        storage.delete(key);
      }),
      setItem: vi.fn((key: string, value: string) => {
        storage.set(key, value);
      }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("searches Feishu coworkers and toggles the returned real open_id", async () => {
    const jenny: Contact = { openId: "ou_real_jenny", name: "Jenny Xu" };
    const searchCoworkers = vi.fn<SearchCoworkers>((query) =>
      Promise.resolve(query === "Jenny" ? [jenny] : []),
    );
    const onToggle = renderPicker(searchCoworkers);

    fireEvent.change(screen.getByPlaceholderText("Search Feishu coworkers..."), {
      target: { value: "Jenny" },
    });

    await waitFor(() => {
      expect(searchCoworkers).toHaveBeenCalledWith("Jenny");
    });
    fireEvent.click(await screen.findByRole("button", { name: /Jenny Xu/i }));

    expect(onToggle).toHaveBeenCalledWith(jenny);
    expect(storage.get("feishu_recent_coworkers")).toContain("ou_real_jenny");
  });
});
