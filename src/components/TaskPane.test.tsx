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

describe("TaskPane browser preview auth flow", () => {
  beforeEach(() => {
    vi.useRealTimers();
    window.history.replaceState({}, "", "/");
    mockLoggedOutPreview();
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

  it("supports the full browser-preview request path after login", () => {
    vi.useFakeTimers();
    renderPreview();

    unlockRequestBuilder();
    fireEvent.click(screen.getByRole("button", { name: /Quotation/i }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Need a quarterly L-Carnitine quote." },
    });
    expect(screen.queryByText("Bitable preview")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Continue$/i }));
    fireEvent.click(screen.getByRole("button", { name: /Jenny Xu/i }));
    expect(screen.getByText("Bitable preview")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Submit to 1 coworker/i }));

    expect(screen.getByRole("button", { name: /Submitting/i })).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(900);
    });

    expect(
      screen.getByRole("heading", { name: /Forwarded to Feishu/i }),
    ).toBeInTheDocument();
  });
});
