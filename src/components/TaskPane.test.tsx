import { act, fireEvent, render, screen } from "@testing-library/react";
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

vi.mock("convex/react", () => ({
  useAction: vi.fn(() => vi.fn(() => Promise.resolve([]))),
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

async function searchJennyWithFakeTimers() {
  fireEvent.change(screen.getByPlaceholderText("Search Feishu coworkers..."), {
    target: { value: "Jenny" },
  });
  await act(async () => {
    vi.advanceTimersByTime(300);
    await Promise.resolve();
    await Promise.resolve();
  });
  return screen.getByRole("button", { name: /Jenny Xu/i });
}

function resetPreviewTestState() {
  vi.useRealTimers();
  window.history.replaceState({}, "", "/");
  mockLoggedOutPreview();
}

describe("TaskPane browser preview auth flow", () => {
  beforeEach(() => {
    resetPreviewTestState();
  });

  it("starts on a standalone login page and unlocks the request builder after dev login", () => {
    renderPreview();

    expect(screen.getByText("Connect to Feishu")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Quotation/i }),
    ).not.toBeInTheDocument();

    unlockRequestBuilder();

    expect(screen.queryByText("Connect to Feishu")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Quotation/i })).toBeInTheDocument();
  });
});

describe("TaskPane browser preview request path", () => {
  beforeEach(() => {
    resetPreviewTestState();
  });

  it("supports the full browser-preview request path after login", async () => {
    vi.useFakeTimers();
    renderPreview();

    unlockRequestBuilder();
    fireEvent.click(screen.getByRole("button", { name: /Quotation/i }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Need a quarterly L-Carnitine quote." },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Continue$/i }));
    expect(screen.getByDisplayValue("m.hoffmann@bayerpharma.de")).toBeInTheDocument();
    fireEvent.click(await searchJennyWithFakeTimers());
    fireEvent.click(screen.getByRole("button", { name: /Submit to 1 coworker/i }));

    expect(
      screen.getByRole("heading", { name: /Syncing to Feishu Bitable/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: /Sync progress/i })).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(3600);
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(250);
      await Promise.resolve();
    });

    expect(
      screen.getByRole("heading", { name: /Synced to Feishu/i }),
    ).toBeInTheDocument();
    vi.useRealTimers();
  });
});
