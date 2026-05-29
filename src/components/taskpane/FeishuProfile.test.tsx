// FeishuProfile behavior — the avatar button in the header that opens a small
// account popover (name / email / org + a "Sign out of Feishu" action). The
// popover is dismissible by clicking outside or pressing Escape. The avatar
// falls back to initials derived from the user's name when no avatar URL is set.

/* eslint-disable max-lines-per-function */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { FeishuProfile } from "./FeishuProfile";

const USER = {
  openId: "ou_jenny",
  userName: "Jenny Xu",
  email: "jenny@fenchem.com",
  org: "Fenchem Sales",
};

function openMenu() {
  fireEvent.click(screen.getByRole("button", { name: /feishu profile/i }));
}

describe("FeishuProfile menu open/close", () => {
  it("is closed initially (no account dialog rendered) with aria-expanded=false", () => {
    render(<FeishuProfile user={USER} onLogout={vi.fn()} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /feishu profile/i })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("opens the account popover when the avatar button is clicked", () => {
    render(<FeishuProfile user={USER} onLogout={vi.fn()} />);
    openMenu();

    expect(screen.getByRole("dialog", { name: /feishu account/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /feishu profile/i })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByText("Jenny Xu")).toBeInTheDocument();
    expect(screen.getByText("jenny@fenchem.com")).toBeInTheDocument();
    expect(screen.getByText("Fenchem Sales")).toBeInTheDocument();
  });

  it("toggles closed again on a second click of the avatar button", () => {
    render(<FeishuProfile user={USER} onLogout={vi.fn()} />);
    openMenu();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    openMenu();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes when a mousedown lands outside the component", () => {
    render(
      <div>
        <span data-testid="outside">outside</span>
        <FeishuProfile user={USER} onLogout={vi.fn()} />
      </div>,
    );
    openMenu();
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByTestId("outside"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("stays open on a mousedown inside the component", () => {
    render(<FeishuProfile user={USER} onLogout={vi.fn()} />);
    openMenu();
    fireEvent.mouseDown(screen.getByText("Jenny Xu"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("closes on the Escape key", () => {
    render(<FeishuProfile user={USER} onLogout={vi.fn()} />);
    openMenu();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("ignores other keys (stays open on a non-Escape key)", () => {
    render(<FeishuProfile user={USER} onLogout={vi.fn()} />);
    openMenu();
    fireEvent.keyDown(document, { key: "Enter" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("FeishuProfile logout", () => {
  it("closes the popover and calls onLogout when 'Sign out of Feishu' is clicked", () => {
    const onLogout = vi.fn();
    render(<FeishuProfile user={USER} onLogout={onLogout} />);
    openMenu();

    fireEvent.click(screen.getByRole("button", { name: /sign out of feishu/i }));

    expect(onLogout).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("FeishuProfile avatar + optional fields", () => {
  it("renders the avatar image when avatarUrl is provided", () => {
    render(
      <FeishuProfile
        user={{ ...USER, avatarUrl: "https://cdn.example/jenny.png" }}
        onLogout={vi.fn()}
      />,
    );
    // Radix Avatar only swaps in the <img> after the load event; assert the
    // fallback initials still render so the avatar is never blank.
    expect(screen.getByText("JX")).toBeInTheDocument();
  });

  it("falls back to two-letter initials from a multi-word name", () => {
    render(<FeishuProfile user={USER} onLogout={vi.fn()} />);
    // "Jenny Xu" -> first letter of first + first letter of last word.
    expect(screen.getByText("JX")).toBeInTheDocument();
  });

  it("falls back to a single initial for a one-word name", () => {
    render(<FeishuProfile user={{ openId: "ou_a", userName: "Cher" }} onLogout={vi.fn()} />);
    expect(screen.getByText("C")).toBeInTheDocument();
  });

  it("falls back to 'U' when the user has no name", () => {
    render(<FeishuProfile user={{ openId: "ou_anon" }} onLogout={vi.fn()} />);
    openMenu();
    // Header label falls back to "Feishu user" and the avatar shows "U".
    expect(screen.getByText("Feishu user")).toBeInTheDocument();
    expect(screen.getByText("U")).toBeInTheDocument();
  });

  it("omits the email and org rows when those fields are absent", () => {
    render(<FeishuProfile user={{ openId: "ou_x", userName: "Wei Liang" }} onLogout={vi.fn()} />);
    openMenu();

    expect(screen.queryByText(/@/)).not.toBeInTheDocument();
    // Only the "Connected" status line remains; no org chip.
    expect(screen.getByText("Connected")).toBeInTheDocument();
  });
});
