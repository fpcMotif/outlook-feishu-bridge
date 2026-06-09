/* eslint-disable require-unicode-regexp */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetSalesDefaultForTests, SALES_DEFAULT_DELAY_MS } from "./scheduleSalesDefault";

let mockExistingSync:
  | {
      recordId: string;
      detailUrl?: string | null;
      coworkerCount?: number;
      syncedAt?: number;
    }
  | null
  | undefined = null;
vi.mock("../../hooks/useRequestSync", () => ({
  useRequestSync: () => ({
    sync: vi.fn(() => Promise.resolve({ recordId: "rec1" })),
    correct: vi.fn(() => Promise.resolve({ recordId: "rec1" })),
    existingSync: mockExistingSync,
  }),
}));

vi.mock("../../hooks/useSelfForward", () => ({
  useSelfForward: () => ({
    sendNote: vi.fn(() => Promise.resolve({ ok: true })),
  }),
}));

vi.mock("../../hooks/useAttachmentStaging", () => ({
  useAttachmentStaging: () => ({
    generateUploadUrl: vi.fn().mockResolvedValue("https://up/test"),
    uploadBytes: vi.fn().mockResolvedValue({ storageId: "st_test" }),
  }),
}));

vi.mock("../../hooks/useCoworkerSearch", () => {
  const coworkers = [
    {
      openId: "ou_jenny",
      name: "Jenny Xu",
      avatarUrl: "https://example.test/jenny.png",
    },
    {
      openId: "ou_michael",
      name: "Michael Chen",
      avatarUrl: "https://example.test/michael.png",
    },
    { openId: "ou_sales_ops", name: "Sales Ops" },
    { openId: "ou_wei", name: "Wei Liang" },
  ];
  return {
    useCoworkerSearch: () =>
      vi.fn((query: string) =>
        Promise.resolve(
          coworkers.filter((c) =>
            c.name.toLowerCase().includes(query.toLowerCase()),
          ),
        ),
      ),
  };
});

const MICROSOFT = {
  recordId: "rec_microsoft",
  name: "Microsoft",
  domain: "microsoft.com",
  owner: null,
};

const FANPC = {
  recordId: "dev_fixture_fanpc_customer",
  name: "fanpc",
  domain: "fenchem.com",
  owner: { openId: "ou_dev", name: "fanpc" },
};

let customerDirectoryRecords = [FANPC, MICROSOFT];

vi.mock("../../hooks/useCustomerSearch", () => ({
  useCustomerSearch: () => ({
    directory: { status: "ready", records: customerDirectoryRecords },
    search: vi.fn(() => Promise.resolve([])),
    matchEmail: vi.fn((email: string) =>
      Promise.resolve(
        email.endsWith("@fenchem.com")
          ? FANPC
          : email.endsWith("@microsoftonline.com") ||
              email.endsWith("@microsoft.com")
            ? MICROSOFT
            : null,
      ),
    ),
    triggerRefresh: vi.fn(),
  }),
}));

vi.mock("./useAttachmentSync", () => ({
  useAttachmentSync: () =>
    vi.fn(() => Promise.resolve({ attachments: [], failed: [] })),
}));

import { RequestIntakeScreen } from "./RequestIntakeScreen";
import { clearIntakeDraftCache } from "./intakeDraftCache";
import type { MailItemData } from "../../office/useMailItem";

const SAMPLE: MailItemData = {
  subject: "Inquiry - bulk pricing",
  from: "m.hoffmann@bayerpharma.de",
  to: ["jenny.xu@fenchem.com"],
  cc: [],
  body: "We need quarterly pricing.",
  dateTimeCreated: new Date("2026-05-27T00:00:00Z"),
  internetMessageId: "<x@bayerpharma.de>",
  itemId: "item-1",
  conversationId: "conv-1",
  userEmail: "jenny.xu@fenchem.com",
  attachments: [],
};

function renderRequestIntakeScreen(
  isLoggedIn: boolean,
  clientEmail = "m.hoffmann@bayerpharma.de",
  isAuthLoading = false,
) {
  render(
    <RequestIntakeScreen
      isLoggedIn={isLoggedIn}
      isAuthLoading={isAuthLoading}
      mailItem={{ ...SAMPLE, from: clientEmail }}
      sessionId="test-session"
      onLogin={vi.fn()}
      onLoginFallback={vi.fn()}
    />,
  );
}

function fillRequestNote() {
  fireEvent.change(screen.getByPlaceholderText(/Describe your requirements/i), {
    target: { value: "Need a quarterly L-Carnitine quote." },
  });
}

async function searchCoworker(name: string) {
  fireEvent.change(screen.getByLabelText("Search Feishu coworkers"), {
    target: { value: name },
  });
  return await screen.findByRole("button", {
    name: new RegExp(`^${name}`, "i"),
  });
}

beforeEach(() => {
  resetSalesDefaultForTests();
  clearIntakeDraftCache();
  localStorage.clear();
  customerDirectoryRecords = [FANPC, MICROSOFT];
  mockExistingSync = null;
  vi.restoreAllMocks();
});

describe("RequestIntakeScreen login gate", () => {
  it("shows login while the existing-sync query is still loading", () => {
    mockExistingSync = undefined;
    renderRequestIntakeScreen(false);

    expect(
      screen.getByRole("button", { name: /Continue with Feishu/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Checking Feishu record/i),
    ).not.toBeInTheDocument();
  });

  it("keeps the login visual shell while the Feishu session is resolving", () => {
    mockExistingSync = undefined;
    renderRequestIntakeScreen(false, "m.hoffmann@bayerpharma.de", true);

    expect(screen.getByRole("status")).toHaveTextContent(/Checking Feishu/i);
    expect(
      screen.getByRole("button", { name: /Checking Feishu/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /Use backup login/i }),
    ).toBeDisabled();
    expect(
      screen.queryByText(/Checking Feishu record/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Start a request above/i }),
    ).not.toBeInTheDocument();
  });

  it("keeps the Feishu login surface separate from the request builder", () => {
    renderRequestIntakeScreen(false);

    expect(
      screen.getByRole("button", { name: /Continue with Feishu/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Quotation.*Sample.*R&D Support/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Start a request above/i }),
    ).not.toBeInTheDocument();
  });

  it("shows the request builder while the existing-sync query is still loading", () => {
    mockExistingSync = undefined;
    renderRequestIntakeScreen(true);

    expect(
      screen.queryByText(/Checking Feishu record/i),
    ).not.toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(/Describe your requirements/i),
    ).toBeInTheDocument();
  });

  it("shows request details and client/coworker controls together after sign-in", () => {
    renderRequestIntakeScreen(true);

    expect(
      screen.queryByRole("button", { name: /Continue with Feishu/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Quotation.*Sample.*R&D Support/i),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Quotation")).not.toBeInTheDocument();
    expect(screen.queryByText("Sample")).not.toBeInTheDocument();
    expect(screen.queryByText("R&D Support")).not.toBeInTheDocument();
    expect(
      document.querySelector('[data-request-note-card="true"]'),
    ).toHaveClass("rounded-2xl", "bg-card-soft");
    expect(
      screen.getByPlaceholderText(/Describe your requirements/i),
    ).toBeInTheDocument();
    const coworkerSection = screen.getByText("Customer, sales & coworker");
    expect(
      coworkerSection.compareDocumentPosition(screen.getByText("New request")),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(screen.queryByText(/Recent & suggested/i)).not.toBeInTheDocument();
    expect(document.querySelector('[data-client-row="true"]')).toBeNull();
    // No customer auto-matches for bayerpharma.de, so the gate's first hint wins (ADR-0020 submitSyncGate).
    expect(
      screen.getByRole("button", { name: /Select a customer/i }),
    ).toBeDisabled();
  });
});

describe("RequestIntakeScreen sales default", () => {
  const rafCallbacks: FrameRequestCallback[] = [];

  beforeEach(() => {
    rafCallbacks.length = 0;
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shows Pick a sale before deferring to the signed-in user", () => {
    render(
      <RequestIntakeScreen
        isLoggedIn
        mailItem={SAMPLE}
        sessionId="test-session"
        user={{
          openId: "ou_jenny",
          userName: "Jenny Xu",
          avatarUrl: "https://example.test/jenny.png",
        }}
        onLogin={vi.fn()}
        onLoginFallback={vi.fn()}
      />,
    );

    expect(screen.getByText("Pick a sale")).toBeInTheDocument();
    expect(document.querySelector('[data-sales-row="true"]')).toBeNull();

    act(() => {
      for (const cb of rafCallbacks) cb(0);
      vi.advanceTimersByTime(SALES_DEFAULT_DELAY_MS - 1);
    });

    expect(screen.getByText("Pick a sale")).toBeInTheDocument();
    expect(document.querySelector('[data-sales-row="true"]')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });

    expect(screen.getByText("Jenny Xu")).toBeInTheDocument();
    expect(document.querySelector('[data-sales-row="true"]')).not.toBeNull();
  });

  it("keeps customer owner out of the default sales pick", () => {
    customerDirectoryRecords = [
      {
        ...FANPC,
        owner: { openId: "ou_owner", name: "Ruhollah Hosseini (Ali)" },
      },
    ];
    render(
      <RequestIntakeScreen
        isLoggedIn
        mailItem={{ ...SAMPLE, from: "sender@fenchem.com" }}
        sessionId="test-session"
        user={{ openId: "ou_nj", userName: "NJ Sales" }}
        onLogin={vi.fn()}
        onLoginFallback={vi.fn()}
      />,
    );

    expect(screen.getByText("Pick a sale")).toBeInTheDocument();
    expect(screen.queryByText("Ruhollah Hosseini (Ali)")).toBeNull();

    act(() => {
      for (const cb of rafCallbacks) cb(0);
      vi.advanceTimersByTime(SALES_DEFAULT_DELAY_MS);
    });

    expect(screen.getByText("NJ Sales")).toBeInTheDocument();
    expect(screen.queryByText("Ruhollah Hosseini (Ali)")).toBeNull();
  });
});

describe("RequestIntakeScreen request details", () => {
  it("accepts a request note without category labels or selected badges", () => {
    renderRequestIntakeScreen(true);

    fillRequestNote();

    expect(
      screen.getByDisplayValue("Need a quarterly L-Carnitine quote."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Selected")).not.toBeInTheDocument();
    expect(screen.queryByText("Ready")).not.toBeInTheDocument();
  });

  it("keeps request details and client/coworker selection on one screen before submit", () => {
    renderRequestIntakeScreen(true);
    fillRequestNote();

    expect(screen.getByText("Customer, sales & coworker")).toBeInTheDocument();
    expect(
      screen.getByDisplayValue("Need a quarterly L-Carnitine quote."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Recent & suggested/i)).not.toBeInTheDocument();
    // bayerpharma.de has no customer match, so the dock asks for a customer first (ADR-0020).
    expect(
      screen.getByRole("button", { name: /Select a customer/i }),
    ).toBeDisabled();
  });

  it("opens the mocked create-customer page in a new browser tab", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    renderRequestIntakeScreen(true);

    fireEvent.change(
      screen.getByRole("combobox", { name: /search customers/i }),
      {
        target: { value: "fff" },
      },
    );
    fireEvent.click(
      screen.getByRole("button", { name: /create customer task "fff"/i }),
    );

    expect(open).toHaveBeenCalledWith(
      "https://example.com/?task=create-customer&name=fff",
      "_blank",
      "noopener,noreferrer",
    );
  });
});

describe("RequestIntakeScreen customer auto-match", () => {
  it("auto-matches Microsoft from microsoft-noreply@microsoft.com", () => {
    renderRequestIntakeScreen(true, "microsoft-noreply@microsoft.com");

    expect(screen.getByText("Microsoft")).toBeInTheDocument();
    expect(screen.queryByText(/No match/i)).not.toBeInTheDocument();
  });

  it("auto-matches Microsoft from microsoftonline.com", () => {
    renderRequestIntakeScreen(true, "alerts@microsoftonline.com");

    expect(screen.getByText("Microsoft")).toBeInTheDocument();
    expect(screen.queryByText(/No match/i)).not.toBeInTheDocument();
  });

  it("auto-matches fanpc from fanpc@fenchem.com", () => {
    renderRequestIntakeScreen(true, "fanpc@fenchem.com");

    expect(screen.getByText("fanpc")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /change/i })).toBeInTheDocument();
    expect(screen.queryByText(/No match/i)).not.toBeInTheDocument();
  });

  it("keeps the async Convex mirror match when the local directory is empty", async () => {
    customerDirectoryRecords = [];

    renderRequestIntakeScreen(true, "fanpc@fenchem.com");

    expect(await screen.findByText("fanpc")).toBeInTheDocument();
    expect(screen.queryByText(/No matched/i)).not.toBeInTheDocument();
  });
});

describe("RequestIntakeScreen coworker selection", () => {
  it("allows exactly one coworker and replaces the selection on the cards", async () => {
    // fenchem.com auto-matches the fanpc customer so the dock can reach the ready state.
    renderRequestIntakeScreen(true, "fanpc@fenchem.com");
    fillRequestNote();

    fireEvent.click(await searchCoworker("Jenny Xu"));
    expect(screen.getByText("Jenny Xu")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Sync with Jenny Xu/i }),
    ).toBeInTheDocument();

    // Replacing the coworker requires re-opening the search via the row's Change
    // action (the picker collapses to the selected row after a pick).
    const coworkerRow = screen
      .getByText("Jenny Xu")
      .closest('[data-coworker-row="true"]') as HTMLElement;
    fireEvent.click(
      within(coworkerRow).getByRole("button", { name: /change/i }),
    );

    fireEvent.click(await searchCoworker("Michael Chen"));
    expect(screen.getByText("Michael Chen")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Sync with Michael Chen/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Remove coworker/i }),
    ).not.toBeInTheDocument();
  });
});

describe("RequestIntakeScreen sync flow", () => {
  it("shows Act IV while syncing, then the success screen once sync resolves", async () => {
    renderRequestIntakeScreen(true, "fanpc@fenchem.com");
    fillRequestNote();

    fireEvent.click(await searchCoworker("Jenny Xu"));
    fireEvent.click(
      screen.getByRole("button", { name: /Sync with Jenny Xu/i }),
    );

    expect(
      screen.getByRole("heading", { name: /Syncing to Feishu Base/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("progressbar", { name: /Sync progress/i }),
    ).toBeInTheDocument();

    expect(
      await screen.findByRole("heading", { name: /^Synced$/i }),
    ).toBeInTheDocument();
  });
});
