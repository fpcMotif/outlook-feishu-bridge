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
    existingSync: null,
  }),
}));

vi.mock("../hooks/useSelfForward", () => ({
  useSelfForward: () => ({ sendNote: vi.fn(() => Promise.resolve({ ok: true })) }),
}));

vi.mock("../hooks/useAttachmentStaging", () => ({
  useAttachmentStaging: () => ({
    generateUploadUrl: vi.fn().mockResolvedValue("https://up/test"),
    uploadBytes: vi.fn().mockResolvedValue({ storageId: "st_test" }),
  }),
}));

vi.mock("../hooks/useCoworkerSearch", () => {
  // Real Feishu directory search returns real openIds. The browser-preview flow
  // runs with devPreview=true, where canSubmitSync blocks the fixture openIds
  // (ou_jenny/ou_michael, etc. — isPreviewCoworkerOpenId) so preview fixtures
  // cannot sync to Base. To exercise the happy path to a successful sync, these
  // mock results must use non-fixture openIds, mirroring a live Feishu search.
  const coworkers = [
    { openId: "ou_real_jenny", name: "Jenny Xu", avatarUrl: "https://example.test/jenny.png" },
    { openId: "ou_real_michael", name: "Michael Chen", avatarUrl: "https://example.test/michael.png" },
  ];
  return {
    useCoworkerSearch: () =>
      vi.fn((query: string) =>
        Promise.resolve(coworkers.filter((c) => c.name.toLowerCase().includes(query.toLowerCase()))),
      ),
  };
});

vi.mock("../hooks/useCustomerSearch", () => {
  const BAYER = { recordId: "rec_bayer", name: "Bayer Pharma", domain: "bayerpharma.de", owner: null };
  return {
    useCustomerSearch: () => ({
      directory: { status: "ready", records: [BAYER] },
      search: vi.fn(() => Promise.resolve([])),
      // The dev sample is from bayerpharma.de, so it auto-matches a customer and
      // the submit gate (ADR-0020) can reach the ready state.
      matchEmail: vi.fn((email: string) => Promise.resolve(email.endsWith("@bayerpharma.de") ? BAYER : null)),
      triggerRefresh: vi.fn(),
    }),
  };
});

vi.mock("./taskpane/useAttachmentSync", () => ({
  useAttachmentSync: () => vi.fn(() => Promise.resolve({ attachments: [], failed: [] })),
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

function mockMailLoading() {
  mockUseMailItem.mockReturnValue({
    mailItem: null,
    loading: true,
    error: null,
    readCurrentItem: vi.fn(),
  });
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
  it("shows login instead of the read-email loading screen while Outlook auto-read is pending", () => {
    mockMailLoading();

    render(<TaskPane host="Outlook" />);

    expect(screen.getByRole("button", { name: /Continue with Feishu/i })).toBeInTheDocument();
    expect(screen.queryByText(/Reading your email/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/No message open/i)).not.toBeInTheDocument();
  });

  it("does not render a read-email page while logged-in Outlook auto-read is pending", () => {
    mockMailLoading();
    mockUseFeishuAuth.mockReturnValue({
      sessionId: "test-session",
      isLoading: false,
      isLoggedIn: true,
      user: { openId: "ou_dev", userName: "Jenny Xu" },
      userAccessToken: undefined,
      login: vi.fn(),
      loginFallback: vi.fn(),
      logout: vi.fn(),
    });

    render(<TaskPane host="Outlook" />);

    expect(screen.queryByText(/Reading your email/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/No message open/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Continue with Feishu/i })).not.toBeInTheDocument();
  });

  it("starts on a standalone login page and unlocks the request builder after dev login", () => {
    renderPreview();

    expect(screen.getByRole("button", { name: /Continue with Feishu/i })).toBeInTheDocument();
    expect(
      screen.queryByText(/Quotation.*Sample.*R&D Support/i),
    ).not.toBeInTheDocument();

    unlockRequestBuilder();

    expect(screen.queryByRole("button", { name: /Continue with Feishu/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/Quotation.*Sample.*R&D Support/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Quotation")).not.toBeInTheDocument();
    expect(screen.queryByText("Sample")).not.toBeInTheDocument();
    expect(screen.queryByText("R&D Support")).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Describe your requirements/i)).toBeInTheDocument();
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
    // ADR-0020: the header now rides inline in IntakeHeader (flex row hosting the
    // theme toggle + account menu), not an absolute overlay.
    expect(profileHeader).toHaveClass("flex", "items-center", "gap-1");
    expect(profileHeader).not.toHaveClass("absolute", "sticky");

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
  it.each(["sync", "send"])("opens the direct dev preview for the sync screen (?devScreen=%s)", (devScreen) => {
    window.history.replaceState({}, "", `/?devScreen=${devScreen}`);

    renderPreview();

    expect(
      screen.getByRole("heading", { name: /Syncing to Feishu Base/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Base row preview/i)).toBeInTheDocument();
    expect(screen.queryByText(/m\.hoffmann@bayerpharma\.de ->/i)).not.toBeInTheDocument();
  });

  it("accepts the misspelled devSceen query param for the sync preview", () => {
    window.history.replaceState({}, "", "/?devSceen=sync");

    renderPreview();

    expect(
      screen.getByRole("heading", { name: /Syncing to Feishu Base/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Base row preview/i)).toBeInTheDocument();
  });

  it("opens the direct dev preview for the login checking screen", () => {
    window.history.replaceState({}, "", "/?devSceen=login");

    renderPreview();

    expect(screen.queryByText(/Restoring session/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Jenny Xu")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/Checking Feishu/i);
    expect(screen.getByRole("button", { name: /Checking Feishu/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Use backup login/i })).toBeDisabled();
  });

  it("opens the direct dev preview for the success screen", () => {
    window.history.replaceState({}, "", "/?devScreen=received");

    renderPreview();

    expect(screen.getByRole("heading", { name: /^Synced$/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open in Feishu/i })).toHaveAttribute(
      "href",
      expect.stringContaining("dev_fixture_email_sync_fresh"),
    );
    expect(screen.queryByText(/Note to myself sent/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Route another email/i })).not.toBeInTheDocument();
  });

  it("opens an older dev Convex fixture for checking submitted timestamp copy", () => {
    window.history.replaceState({}, "", "/?devScreen=received&devFixture=week-old");

    renderPreview();

    expect(screen.getByText("[DEV] Week-old Convex email record")).toBeInTheDocument();
    expect(screen.getByText("1 week ago")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open in Feishu/i })).toHaveAttribute(
      "href",
      expect.stringContaining("dev_fixture_email_sync_week_old"),
    );
  });

  it("supports the full browser-preview request path after login", async () => {
    renderPreview();

    unlockRequestBuilder();
    fireEvent.change(screen.getByPlaceholderText(/Describe your requirements/i), {
      target: { value: "Need a quarterly L-Carnitine quote." },
    });
    expect(screen.getByDisplayValue("Need a quarterly L-Carnitine quote.")).toBeInTheDocument();
    fireEvent.click(await searchCoworker("Jenny Xu"));
    fireEvent.click(screen.getByRole("button", { name: /Sync with Jenny Xu/i }));

    expect(
      screen.getByRole("heading", { name: /Syncing to Feishu Base/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: /Sync progress/i })).toBeInTheDocument();

    expect(
      await screen.findByRole("heading", { name: /^Synced$/i }),
    ).toBeInTheDocument();
  });

  it("does not keep the profile header pinned after leaving the request builder", async () => {
    renderPreview();

    unlockRequestBuilder();
    fireEvent.change(screen.getByPlaceholderText(/Describe your requirements/i), {
      target: { value: "Need a quarterly L-Carnitine quote." },
    });
    fireEvent.click(await searchCoworker("Jenny Xu"));
    fireEvent.click(screen.getByRole("button", { name: /Sync with Jenny Xu/i }));

    expect(await screen.findByRole("heading", { name: /^Synced$/i })).toBeInTheDocument();

    expect(screen.queryByRole("region", { name: /Feishu account controls/i })).not.toBeInTheDocument();
  });
});
