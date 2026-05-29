import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useFeishuAuth } from "../hooks/useFeishuAuth";
import { useMailItem } from "../office/useMailItem";
import { TaskPane } from "./TaskPane";

vi.mock("../office/useMailItem", () => ({
  useMailItem: vi.fn(),
}));

vi.mock("../hooks/useFeishuAuth", () => ({
  useFeishuAuth: vi.fn(),
}));

vi.mock("../hooks/useRequestSync", () => ({
  useRequestSync: () => ({
    sync: vi.fn(() => Promise.resolve({ recordId: "rec1" })),
    correct: vi.fn(() => Promise.resolve({ recordId: "rec1" })),
  }),
}));

vi.mock("../hooks/useSelfForward", () => ({
  useSelfForward: () => ({ sendNote: vi.fn(() => Promise.resolve({ ok: true })) }),
}));

vi.mock("../hooks/useCoworkerSearch", () => {
  const coworkers = [
    { openId: "ou_jenny", name: "Jenny Xu", avatarUrl: "https://example.test/jenny.png" },
    { openId: "ou_michael", name: "Michael Chen", avatarUrl: "https://example.test/michael.png" },
  ];
  return {
    useCoworkerSearch: () =>
      vi.fn((query: string) =>
        Promise.resolve(coworkers.filter((c) => c.name.toLowerCase().includes(query.toLowerCase()))),
      ),
  };
});

vi.mock("../hooks/useCustomerSearch", () => ({
  useCustomerSearch: () => ({
    directory: { status: "ready", records: [] },
    search: vi.fn(() => Promise.resolve([])),
    matchEmail: vi.fn(() => Promise.resolve(null)),
    triggerRefresh: vi.fn(),
  }),
}));

const mockUseMailItem = vi.mocked(useMailItem);
const mockUseFeishuAuth = vi.mocked(useFeishuAuth);

function mockLoggedOutPreview() {
  mockUseMailItem.mockReturnValue({
    mailItem: null,
    loading: false,
    error: null,
    readCurrentItem: vi.fn(),
  });
  mockUseFeishuAuth.mockReturnValue({
    sessionId: "test-session",
    isLoading: false,
    isLoggedIn: false,
    user: null,
    userAccessToken: undefined,
    login: vi.fn(),
    loginFallback: vi.fn(),
    logout: vi.fn(),
  });
}

function renderPreview() {
  render(<TaskPane host="browser" />);
}

function unlockRequestBuilder() {
  fireEvent.click(screen.getByRole("button", { name: /Continue with Feishu/i }));
}

async function searchCoworker(name: string) {
  fireEvent.change(screen.getByLabelText("Search Feishu coworkers"), {
    target: { value: name },
  });
  return await screen.findByRole("button", { name: new RegExp(`^${name}`, "i") });
}

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, "", "/");
  mockLoggedOutPreview();
});

describe("TaskPane browser preview auth flow", () => {
  it("starts on a standalone login page and unlocks the request builder after dev login", () => {
    renderPreview();

    expect(screen.getByRole("button", { name: /Continue with Feishu/i })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Quotation/i }),
    ).not.toBeInTheDocument();

    unlockRequestBuilder();

    expect(screen.queryByRole("button", { name: /Continue with Feishu/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Quotation/i })).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.queryByText("Search by name to choose a Feishu coworker")).not.toBeInTheDocument();
    expect(screen.queryByText(/Recent & suggested/i)).not.toBeInTheDocument();
  });

  it("does not duplicate the host app title after login", () => {
    renderPreview();

    unlockRequestBuilder();

    expect(screen.queryByText("Feishu Bridge")).not.toBeInTheDocument();
    expect(screen.queryByText("Sync requests in one tap")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Feishu profile/i })).toBeInTheDocument();
  });

  it("renders the account menu in the static request header and signs out", () => {
    renderPreview();

    unlockRequestBuilder();
    const profileHeader = screen.getByRole("region", { name: /Feishu account controls/i });
    expect(profileHeader).toHaveAttribute("data-profile-header", "true");
    expect(profileHeader).toHaveClass("absolute", "top-1", "right-5");
    expect(profileHeader).not.toHaveClass("sticky", "top-0");

    fireEvent.click(screen.getByRole("button", { name: /Feishu profile/i }));

    const accountMenu = screen.getByRole("dialog", { name: /Feishu account/i });
    expect(accountMenu.tagName).toBe("DIALOG");
    expect(accountMenu).toHaveClass("m-0", "left-auto");
    expect(screen.getAllByText("JX")).toHaveLength(1);
    expect(accountMenu).toHaveTextContent("Connected");
    fireEvent.click(screen.getByRole("button", { name: /Sign out of Feishu/i }));

    expect(screen.getByRole("button", { name: /Continue with Feishu/i })).toBeInTheDocument();
  });
});

describe("TaskPane browser preview request flow", () => {
  it("opens the direct dev preview for the sync screen", () => {
    window.history.replaceState({}, "", "/?devScreen=sync");

    renderPreview();

    expect(
      screen.getByRole("heading", { name: /Syncing to Feishu Base/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Base row preview/i)).toBeInTheDocument();
    expect(screen.queryByText(/m\.hoffmann@bayerpharma\.de ->/i)).not.toBeInTheDocument();
  });

  it("opens the direct dev preview for the success screen", () => {
    window.history.replaceState({}, "", "/?devScreen=received");

    renderPreview();

    expect(screen.getByRole("heading", { name: /Synced to Feishu/i })).toBeInTheDocument();
    expect(screen.queryByText(/Note to myself sent/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Route another email/i })).not.toBeInTheDocument();
  });

  it("supports the full browser-preview request path after login", async () => {
    renderPreview();

    unlockRequestBuilder();
    fireEvent.click(screen.getByRole("button", { name: /Quotation/i }));
    fireEvent.change(screen.getByPlaceholderText(/Describe your requirements/i), {
      target: { value: "Need a quarterly L-Carnitine quote." },
    });
    expect(screen.getByDisplayValue("m.hoffmann@bayerpharma.de")).toBeInTheDocument();
    fireEvent.click(await searchCoworker("Jenny Xu"));
    fireEvent.click(screen.getByRole("button", { name: /Sync with Jenny Xu/i }));

    expect(
      screen.getByRole("heading", { name: /Syncing to Feishu Base/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: /Sync progress/i })).toBeInTheDocument();

    expect(
      await screen.findByRole("heading", { name: /Synced to Feishu/i }),
    ).toBeInTheDocument();
  });

  it("does not keep the profile header pinned after leaving the request builder", async () => {
    renderPreview();

    unlockRequestBuilder();
    fireEvent.click(screen.getByRole("button", { name: /Quotation/i }));
    fireEvent.change(screen.getByPlaceholderText(/Describe your requirements/i), {
      target: { value: "Need a quarterly L-Carnitine quote." },
    });
    fireEvent.click(await searchCoworker("Jenny Xu"));
    fireEvent.click(screen.getByRole("button", { name: /Sync with Jenny Xu/i }));

    expect(await screen.findByRole("heading", { name: /Synced to Feishu/i })).toBeInTheDocument();

    expect(screen.queryByRole("region", { name: /Feishu account controls/i })).not.toBeInTheDocument();
  });
});
