// Coverage-only tests for TaskPane branches NOT exercised by TaskPane.test.tsx
// (which covers browser-preview dev login, the profile menu, logout, and the
// full request path). Here we cover:
//   - the DEV_SAMPLE preview item (subject/recipients render with no mailbox)
//   - ?devUser=1 starting logged-in without clicking (auto dev user)
//   - EmptyState: loading spinner, error copy, and the "Read current email" path
//   - the real Outlook host path (devPreview=false): BootReadyMilestone fires,
//     the real Feishu user profile renders, and logout calls feishuAuth.logout
//   - the isAuthLoading suppression (no BootReadyMilestone while auth is loading)
/* eslint-disable max-lines-per-function, require-unicode-regexp */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getDebugEntries } from "../debug";
import { useFeishuAuth } from "../hooks/useFeishuAuth";
import { useMailItem, type MailItemData } from "../office/useMailItem";
import { TaskPane } from "./TaskPane";

vi.mock("../office/useMailItem", () => ({ useMailItem: vi.fn() }));
vi.mock("../hooks/useFeishuAuth", () => ({ useFeishuAuth: vi.fn() }));
vi.mock("../hooks/useRequestSync", () => ({
  useRequestSync: () => ({
    sync: vi.fn(() => Promise.resolve({ recordId: "rec1" })),
    correct: vi.fn(() => Promise.resolve({ recordId: "rec1" })),
  }),
}));
vi.mock("../hooks/useSelfForward", () => ({
  useSelfForward: () => ({ sendNote: vi.fn(() => Promise.resolve({ ok: true })) }),
}));
vi.mock("../hooks/useCoworkerSearch", () => ({
  useCoworkerSearch: () => vi.fn(() => Promise.resolve([])),
}));
vi.mock("../hooks/useCustomerSearch", () => ({
  useCustomerSearch: () => ({
    directory: { status: "ready", records: [] },
    search: vi.fn(() => Promise.resolve([])),
  }),
}));

const mockUseMailItem = vi.mocked(useMailItem);
const mockUseFeishuAuth = vi.mocked(useFeishuAuth);

type MailItemHook = ReturnType<typeof useMailItem>;
type FeishuAuthHook = ReturnType<typeof useFeishuAuth>;

function setMailItem(overrides: Partial<MailItemHook> = {}) {
  mockUseMailItem.mockReturnValue({
    mailItem: null,
    loading: false,
    error: null,
    readCurrentItem: vi.fn(),
    ...overrides,
  } as MailItemHook);
}

function setFeishuAuth(overrides: Partial<FeishuAuthHook> = {}) {
  mockUseFeishuAuth.mockReturnValue({
    sessionId: "test-session",
    isLoading: false,
    isLoggedIn: false,
    user: null,
    userAccessToken: undefined,
    login: vi.fn(),
    loginFallback: vi.fn(),
    logout: vi.fn(),
    ...overrides,
  } as FeishuAuthHook);
}

const REAL_ITEM: MailItemData = {
  subject: "Real inbound - sample request",
  from: "buyer@acme.example",
  to: ["sales@fenchem.com"],
  cc: [],
  body: "Please quote.",
  dateTimeCreated: new Date("2026-05-27T00:00:00Z"),
  internetMessageId: "<real@acme.example>",
  itemId: "AAMk-real",
  conversationId: "conv-real",
  userEmail: "sales@fenchem.com",
};

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, "", "/");
  setMailItem();
  setFeishuAuth();
});

describe("TaskPane dev-preview sample item", () => {
  // line 79: in DEV with host !== "Outlook" and no real mailbox item, the
  // DEV_SAMPLE is substituted so the full drawer flow can be previewed.
  it("renders the DEV_SAMPLE request when no mail item is available in browser preview", () => {
    render(<TaskPane host="browser" />);

    // Logged out → LoginScreen, but the sample item already drives the screen
    // (RequestIntakeScreen receives DEV_SAMPLE, not the EmptyState).
    expect(screen.getByText("Connect to Feishu")).toBeInTheDocument();
    expect(screen.queryByText("No message open")).not.toBeInTheDocument();
  });

  // line 79 with host null behaves the same way (host !== "Outlook").
  it("treats a null host as browser preview and still substitutes the sample item", () => {
    render(<TaskPane host={null} />);

    expect(screen.getByText("Connect to Feishu")).toBeInTheDocument();
    expect(screen.queryByText("No message open")).not.toBeInTheDocument();
  });
});

describe("TaskPane ?devUser auto-login", () => {
  // line 84: ?devUser in the query string starts the preview already logged in
  // (showDevUser true without clicking), so the request builder renders and the
  // dev user "Jenny Xu" profile shows immediately.
  it("starts logged in and shows the request builder when ?devUser is present", () => {
    window.history.replaceState({}, "", "/?devUser=1");
    render(<TaskPane host="browser" />);

    expect(screen.queryByText("Connect to Feishu")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Quotation/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Feishu profile/i })).toBeInTheDocument();
  });

  // The devUser carries email "jenny.xu@fenchem.com" + org "Branch Sales",
  // surfaced in the account menu (lines 85-87 object literal).
  it("exposes the dev user's email and org in the account menu under ?devUser", () => {
    window.history.replaceState({}, "", "/?devUser=1");
    render(<TaskPane host="browser" />);

    fireEvent.click(screen.getByRole("button", { name: /Feishu profile/i }));
    const menu = screen.getByRole("dialog", { name: /Feishu account/i });
    expect(menu).toHaveTextContent("jenny.xu@fenchem.com");
    expect(menu).toHaveTextContent("Branch Sales");
  });
});

describe("TaskPane EmptyState", () => {
  // EmptyState loading branch (lines 44,46,50): no item, loading=true → the
  // spinner + "Reading your email..." and NO "Read current email" button.
  it("shows the reading spinner with no read button while loading and not in dev preview", () => {
    setMailItem({ loading: true });
    render(<TaskPane host="Outlook" />);

    expect(screen.getByText("Reading your email...")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Read current email/i }),
    ).not.toBeInTheDocument();
  });

  // EmptyState error branch (line 48): the read error message is surfaced in
  // place of the default empty-inbox copy, with the read button available.
  it("renders the read error message and a Read button when a read failed", () => {
    setMailItem({ error: "No mail item selected (not inside Outlook...)." });
    render(<TaskPane host="Outlook" />);

    expect(screen.getByText("No message open")).toBeInTheDocument();
    expect(
      screen.getByText("No mail item selected (not inside Outlook...)."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Read current email/i })).toBeInTheDocument();
  });

  // EmptyState default copy (line 48 ?? fallback): no item, no error, not
  // loading → the default invitation copy renders.
  it("shows the default empty-inbox copy when there is no item, error, or loading", () => {
    render(<TaskPane host="Outlook" />);

    expect(screen.getByText("No message open")).toBeInTheDocument();
    expect(
      screen.getByText(/Open a received message in Outlook/i),
    ).toBeInTheDocument();
  });

  // EmptyState onRead (line 51-53): clicking "Read current email" delegates to
  // useMailItem.readCurrentItem.
  it("calls readCurrentItem when the Read current email button is clicked", () => {
    const readCurrentItem = vi.fn();
    setMailItem({ readCurrentItem });
    render(<TaskPane host="Outlook" />);

    fireEvent.click(screen.getByRole("button", { name: /Read current email/i }));
    expect(readCurrentItem).toHaveBeenCalledTimes(1);
  });
});

describe("TaskPane real Outlook host", () => {
  // Real host (devPreview=false): a real mail item drives RequestIntakeScreen,
  // the real Feishu user renders the profile, and BootReadyMilestone fires once
  // (host !== null && !feishuAuth.isLoading, line 100-101). logout wires to the
  // real feishuAuth.logout (line 96).
  it("renders the request builder, profile, and logs out via feishuAuth.logout in real Outlook", () => {
    const logout = vi.fn();
    setMailItem({ mailItem: REAL_ITEM });
    setFeishuAuth({
      isLoggedIn: true,
      user: { openId: "ou_real", userName: "Real Sales", avatarUrl: undefined },
      logout,
    });
    render(<TaskPane host="Outlook" />);

    // Real item drives the request builder (no LoginScreen, no EmptyState).
    expect(screen.getByRole("button", { name: /Quotation/i })).toBeInTheDocument();
    expect(screen.queryByText("Connect to Feishu")).not.toBeInTheDocument();
    expect(screen.queryByText("No message open")).not.toBeInTheDocument();

    // The real user's profile is anchored top-right; logout calls the real hook.
    fireEvent.click(screen.getByRole("button", { name: /Feishu profile/i }));
    fireEvent.click(screen.getByRole("button", { name: /Sign out of Feishu/i }));
    expect(logout).toHaveBeenCalledTimes(1);
  });

  // isAuthLoading suppression (lines 100-102): while the Convex session query is
  // still in flight (feishuAuth.isLoading=true), BootReadyMilestone is NOT
  // rendered yet, and the logged-out, still-loading screen shows the auth
  // spinner placeholder rather than the LoginScreen.
  it("suppresses the login flash with the auth spinner while the session query is loading", () => {
    setMailItem({ mailItem: REAL_ITEM });
    setFeishuAuth({ isLoading: true, isLoggedIn: false });
    render(<TaskPane host="Outlook" />);

    expect(screen.getByLabelText("Checking Feishu session")).toBeInTheDocument();
    expect(screen.queryByText("Connect to Feishu")).not.toBeInTheDocument();
    // No profile chip while logged out.
    expect(
      screen.queryByRole("button", { name: /Feishu profile/i }),
    ).not.toBeInTheDocument();
  });

  // BootReadyMilestone guard (line 64): the milestone logs exactly once per
  // pane even when its deps change. On a re-render with a toggled isLoggedIn,
  // the effect re-runs but the marked.current guard short-circuits the second
  // dload (the milestone is logged once, not twice).
  it("logs the boot-ready milestone only once even after isLoggedIn changes", () => {
    const before = getDebugEntries().filter((e) => e.msg.includes("Feishu SPA ready")).length;

    setMailItem({ mailItem: REAL_ITEM });
    setFeishuAuth({ isLoggedIn: false });
    const { rerender } = render(<TaskPane host="Outlook" />);

    // Re-render with the auth state flipped to logged in (changes the
    // BootReadyMilestone dep), which re-runs its effect.
    setFeishuAuth({
      isLoggedIn: true,
      user: { openId: "ou_real", userName: "Real Sales", avatarUrl: undefined },
    });
    act(() => {
      rerender(<TaskPane host="Outlook" />);
    });

    const after = getDebugEntries().filter((e) => e.msg.includes("Feishu SPA ready")).length;
    // Exactly one new milestone entry across both renders — the guard fired.
    expect(after - before).toBe(1);
  });

  // host === null (Office not yet ready) AND not loading: BootReadyMilestone is
  // gated off by the host !== null guard, and the LoginScreen renders (devPreview
  // false because import.meta.env.DEV may be true but host null is still !==
  // "Outlook" → in DEV this is preview; assert the non-crashing render at minimum).
  it("renders without crashing when host is null and auth is settled", () => {
    setFeishuAuth({ isLoading: false, isLoggedIn: false });
    render(<TaskPane host={null} />);

    // No throw; the surface is either preview login or empty-state depending on
    // DEV. Either way the pane root mounts.
    expect(document.querySelector("main")).toBeInTheDocument();
  });
});

describe("TaskPane dev-preview login + logout toggling", () => {
  // handleLogin / handleLogout in dev preview (lines 94-96): clicking dev login
  // flips devLoggedIn true (request builder appears) and signing out flips it
  // back to false (LoginScreen returns) — the dev path, not the real hooks.
  it("toggles the dev session on login and back off on sign out without calling the real auth hooks", async () => {
    const login = vi.fn();
    const logout = vi.fn();
    setFeishuAuth({ login, logout });
    render(<TaskPane host="browser" />);

    fireEvent.click(screen.getByRole("button", { name: /Continue with Feishu/i }));
    expect(login).not.toHaveBeenCalled(); // dev path uses setDevLoggedIn, not the hook
    expect(screen.getByRole("button", { name: /Quotation/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Feishu profile/i }));
    fireEvent.click(screen.getByRole("button", { name: /Sign out of Feishu/i }));
    expect(logout).not.toHaveBeenCalled(); // dev path uses setDevLoggedIn(false)
    await waitFor(() =>
      expect(screen.getByText("Connect to Feishu")).toBeInTheDocument(),
    );
  });

  // Dev preview backup-login link also routes through the dev setDevLoggedIn
  // path (handleLoginFallback, line 95).
  it("unlocks the dev session via the backup login link too", () => {
    setFeishuAuth({ loginFallback: vi.fn() });
    render(<TaskPane host="browser" />);

    fireEvent.click(screen.getByRole("button", { name: /Use backup login/i }));
    expect(screen.getByRole("button", { name: /Quotation/i })).toBeInTheDocument();
  });
});
