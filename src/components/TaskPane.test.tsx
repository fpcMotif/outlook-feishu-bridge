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

describe("TaskPane browser preview auth flow", () => {
  beforeEach(() => {
    vi.useRealTimers();
    window.history.replaceState({}, "", "/");
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
  });

  it("starts on a standalone login page and unlocks the request builder after dev login", () => {
    render(<TaskPane host="browser" />);

    expect(screen.getByText("Connect your Feishu account")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Quotation/i }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Log in to Feishu/i }));

    expect(screen.queryByText("Connect your Feishu account")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Quotation/i })).toBeInTheDocument();
  });

  it("supports the full browser-preview request path after login", async () => {
    vi.useFakeTimers();
    render(<TaskPane host="browser" />);

    fireEvent.click(screen.getByRole("button", { name: /Log in to Feishu/i }));
    fireEvent.click(screen.getByRole("button", { name: /Quotation/i }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Need a quarterly L-Carnitine quote." },
    });
    fireEvent.click(screen.getByRole("button", { name: /Submit 1 request/i }));

    expect(screen.getByRole("button", { name: /Submitting/i })).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(900);
    });

    expect(
      screen.getByRole("heading", { name: /Forwarded to Feishu/i }),
    ).toBeInTheDocument();
  });
});
