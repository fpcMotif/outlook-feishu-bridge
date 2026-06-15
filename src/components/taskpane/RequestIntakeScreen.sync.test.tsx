/* eslint-disable max-lines-per-function, require-unicode-regexp */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type SyncResult =
  | { status: "pending"; recordId: null; detailUrl: null }
  | { status: "synced"; recordId: string; detailUrl: string | null };

const mockSync = vi.fn(
  (_payload: unknown): Promise<SyncResult> =>
    Promise.resolve({
      status: "synced",
      recordId: "recTEST",
      detailUrl: "https://feishu.cn/base/app?table=tbl&record=recTEST",
    }),
);
const mockCorrect = vi.fn((_payload: unknown) =>
  Promise.resolve({ recordId: "recTEST" }),
);
let mockExistingSync: {
  status?: "pending" | "synced" | "failed";
  recordId: string | null;
  detailUrl: string | null;
  syncedAt?: number;
  error?: string | null;
} | null = null;
vi.mock("../../hooks/useRequestSync", () => ({
  useRequestSync: () => ({
    sync: mockSync,
    correct: mockCorrect,
    existingSync: mockExistingSync,
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
const BAYER = {
  recordId: "rec_bayer",
  name: "Bayer Pharma",
  domain: "bayerpharma.de",
  owner: null,
};
const STOCKMEIER = {
  recordId: "rec_stock",
  name: "STOCKMEIER Chemie GmbH & Co. KG",
  domain: "stockmeier.com",
  owner: null,
};
vi.mock("../../hooks/useCustomerSearch", () => ({
  useCustomerSearch: () => ({
    directory: { status: "ready", records: [BAYER, STOCKMEIER] },
    search: vi.fn(() => Promise.resolve([])),
    matchEmail: vi.fn((email: string) =>
      Promise.resolve(email.endsWith("@bayerpharma.de") ? BAYER : null),
    ),
    triggerRefresh: vi.fn(),
  }),
}));

import type { AttachmentSyncResult } from "./useAttachmentSync";
const emptyStage: AttachmentSyncResult = { sources: [], failed: [] };
const mockStageAttachments = vi.fn(
  (): Promise<AttachmentSyncResult> => Promise.resolve(emptyStage),
);
vi.mock("./useAttachmentSync", () => ({
  useAttachmentSync: () => mockStageAttachments,
}));

import { RequestIntakeScreen } from "./RequestIntakeScreen";
import { clearIntakeDraftCache } from "./intakeDraftCache";
import type { MailItemData } from "../../office/useMailItem";

const SAMPLE: MailItemData = {
  subject: "Inquiry - bulk L-Carnitine",
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

function renderScreen(user?: {
  openId: string;
  userName?: string;
  avatarUrl?: string;
}) {
  render(
    <RequestIntakeScreen
      isLoggedIn={true}
      mailItem={SAMPLE}
      sessionId="test-session"
      user={user}
      onLogin={vi.fn()}
      onLoginFallback={vi.fn()}
    />,
  );
}

async function searchCoworker(name: string) {
  fireEvent.change(screen.getByLabelText("Search Feishu coworkers"), {
    target: { value: name },
  });
  return await screen.findByRole("button", {
    name: new RegExp(`^${name}`, "i"),
  });
}

async function selectCoworkerAndConfirm(name: string) {
  const coworker = await searchCoworker(name);

  vi.useFakeTimers();
  try {
    fireEvent.click(coworker);
    expect(screen.getByRole("button", { name: /Checking attachments/i })).toBeDisabled();
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
  } finally {
    vi.useRealTimers();
  }
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`Sync with ${name}`, "i") }));
}

describe("RequestIntakeScreen sync wiring", () => {
  beforeEach(() => {
    clearIntakeDraftCache();
    mockSync.mockClear();
    mockCorrect.mockClear();
    mockExistingSync = null;
    mockStageAttachments.mockReset();
    mockStageAttachments.mockResolvedValue({ sources: [], failed: [] });
    localStorage.clear();
  });

  it("calls sync once with the request, coworker, and email on submit", async () => {
    renderScreen();
    fireEvent.change(
      screen.getByPlaceholderText(/Describe your requirements/i),
      {
        target: { value: "Need a quarterly L-Carnitine quote." },
      },
    );
    await selectCoworkerAndConfirm("Jenny Xu");

    await waitFor(() => expect(mockSync).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByRole("link", { name: /Open in Feishu/i }),
    ).toHaveAttribute(
      "href",
      "https://feishu.cn/base/app?table=tbl&record=recTEST",
    );
    expect(mockSync.mock.calls[0][0]).toMatchObject({
      clientEmail: "m.hoffmann@bayerpharma.de",
      subject: "Inquiry - bulk L-Carnitine",
      from: "m.hoffmann@bayerpharma.de",
      requestNote: "Need a quarterly L-Carnitine quote.",
      body: "We need quarterly pricing.",
      selectedCoworkers: [
        {
          openId: "ou_jenny",
          name: "Jenny Xu",
          avatarUrl: "https://example.test/jenny.png",
        },
      ],
    });
  });

  it("links to the existing Feishu Base record instead of syncing the same conversation again", () => {
    const detailUrl =
      "https://feishu.cn/base/app?table=tbl&record=rec_existing";
    mockExistingSync = {
      status: "synced",
      recordId: "rec_existing",
      detailUrl,
      syncedAt: Date.now() - 6 * 24 * 60 * 60 * 1000,
    };

    renderScreen();

    expect(
      screen.getByRole("heading", { name: /^Already synced$/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Open in Feishu/i }),
    ).toHaveAttribute("href", detailUrl);
    expect(screen.getByText("6 days ago")).toBeInTheDocument();
    expect(screen.queryByText("Just now")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Sync with/i }),
    ).not.toBeInTheDocument();
    expect(mockSync).not.toHaveBeenCalled();
  });

  it("keeps the fresh-sync success screen when existingSync loads after submit", async () => {
    const { rerender } = render(
      <RequestIntakeScreen
        isLoggedIn={true}
        mailItem={SAMPLE}
        sessionId="test-session"
        onLogin={vi.fn()}
        onLoginFallback={vi.fn()}
      />,
    );
    fireEvent.change(
      screen.getByPlaceholderText(/Describe your requirements/i),
      {
        target: { value: "Need a quarterly L-Carnitine quote." },
      },
    );
    await selectCoworkerAndConfirm("Jenny Xu");

    await screen.findByRole("heading", { name: /^Synced$/i });

    mockExistingSync = {
      status: "synced",
      recordId: "rec_existing",
      detailUrl: "https://feishu.cn/base/app?table=tbl&record=rec_existing",
    };
    rerender(
      <RequestIntakeScreen
        isLoggedIn={true}
        mailItem={SAMPLE}
        sessionId="test-session"
        onLogin={vi.fn()}
        onLoginFallback={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("heading", { name: /^Synced$/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /^Already synced$/i }),
    ).not.toBeInTheDocument();
  });

  it("stays on the sync screen after a queued sync until Convex reports the Base record", async () => {
    mockSync.mockResolvedValueOnce({
      status: "pending",
      recordId: null,
      detailUrl: null,
    });
    const { rerender } = render(
      <RequestIntakeScreen
        isLoggedIn={true}
        mailItem={SAMPLE}
        sessionId="test-session"
        onLogin={vi.fn()}
        onLoginFallback={vi.fn()}
      />,
    );
    fireEvent.change(
      screen.getByPlaceholderText(/Describe your requirements/i),
      {
        target: { value: "Need a quarterly L-Carnitine quote." },
      },
    );
    await selectCoworkerAndConfirm("Jenny Xu");

    expect(
      await screen.findByRole("heading", { name: /Syncing to Feishu Base/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /^Synced$/i }),
    ).not.toBeInTheDocument();

    mockExistingSync = {
      status: "synced",
      recordId: "rec_async",
      detailUrl: "https://feishu.cn/base/app?table=tbl&record=rec_async",
    };
    rerender(
      <RequestIntakeScreen
        isLoggedIn={true}
        mailItem={SAMPLE}
        sessionId="test-session"
        onLogin={vi.fn()}
        onLoginFallback={vi.fn()}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: /^Synced$/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Open in Feishu/i }),
    ).toHaveAttribute(
      "href",
      "https://feishu.cn/base/app?table=tbl&record=rec_async",
    );
  });

  // Customer-matching wiring (ADR-0013): when the directory contains a row
  // whose 域名 equals the sender's domain, sync rides with selectedCustomer
  // set so the backend writes the right Client DuplexLink instead of falling
  // back to the legacy domain-search-per-write.
  it("passes the auto-matched Customer through to sync when the directory has a domain hit", async () => {
    renderScreen();
    fireEvent.change(
      screen.getByPlaceholderText(/Describe your requirements/i),
      {
        target: { value: "Need a quarterly L-Carnitine quote." },
      },
    );
    await selectCoworkerAndConfirm("Jenny Xu");

    await waitFor(() => expect(mockSync).toHaveBeenCalledTimes(1));
    expect(mockSync.mock.calls[0][0]).toMatchObject({
      selectedCustomer: { recordId: "rec_bayer", name: "Bayer Pharma" },
    });
  });

  // Override wins over auto-match (ADR-0013): tapping Change → typing →
  // picking a different Customer changes which selectedCustomer rides to sync.
  it("uses the user's Customer override instead of the auto-match when one is picked", async () => {
    renderScreen();
    fireEvent.change(
      screen.getByPlaceholderText(/Describe your requirements/i),
      {
        target: { value: "Need a quarterly L-Carnitine quote." },
      },
    );

    fireEvent.click(screen.getByRole("button", { name: /change/i }));
    fireEvent.change(
      screen.getByRole("combobox", { name: /search customers/i }),
      {
        target: { value: "stock" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: /STOCKMEIER Chemie/i }));

    await selectCoworkerAndConfirm("Jenny Xu");

    await waitFor(() => expect(mockSync).toHaveBeenCalledTimes(1));
    expect(mockSync.mock.calls[0][0]).toMatchObject({
      selectedCustomer: { recordId: "rec_stock", name: STOCKMEIER.name },
    });
  });

  // ADR-0017: the Mail Item's Outlook conversationId rides on every sync call
  // so the backend can write it into the Service row's `Email Conversation ID`
  // column as the Base-to-Outlook join key.
  it("passes the Mail Item conversationId on sync", async () => {
    renderScreen();
    fireEvent.change(
      screen.getByPlaceholderText(/Describe your requirements/i),
      {
        target: { value: "Need a quarterly L-Carnitine quote." },
      },
    );
    await selectCoworkerAndConfirm("Jenny Xu");

    await waitFor(() => expect(mockSync).toHaveBeenCalledTimes(1));
    expect(mockSync.mock.calls[0][0]).toMatchObject({
      conversationId: "conv-1",
    });
  });

  // ADR-0014: the signed-in Feishu user (the Initiator) rides on every sync
  // call so the backend can write the `Sales` User column. Distinct from the
  // assignee Coworker — the salesperson who clicked Sync vs the one who'll
  // handle the request.
  it("passes the signed-in user as selectedSales on sync by default", async () => {
    renderScreen({ openId: "ou_jenny_initiator", userName: "Jenny Xu" });
    fireEvent.change(
      screen.getByPlaceholderText(/Describe your requirements/i),
      {
        target: { value: "Need a quarterly L-Carnitine quote." },
      },
    );
    await selectCoworkerAndConfirm("Jenny Xu");

    await waitFor(() => expect(mockSync).toHaveBeenCalledTimes(1));
    expect(mockSync.mock.calls[0][0]).toMatchObject({
      selectedSales: { openId: "ou_jenny_initiator", name: "Jenny Xu" },
      initiator: { openId: "ou_jenny_initiator", name: "Jenny Xu" },
    });
  });

  it("keeps attachment token minting on the sync critical path", async () => {
    let resolveStage!: (value: AttachmentSyncResult) => void;
    mockStageAttachments.mockReturnValueOnce(
      new Promise<AttachmentSyncResult>((resolve) => {
        resolveStage = resolve;
      }),
    );
    render(
      <RequestIntakeScreen
        isLoggedIn={true}
        mailItem={{
          ...SAMPLE,
          attachments: [
            {
              id: "a1",
              name: "rfq.pdf",
              attachmentType: "file",
              size: 2048,
              isInline: false,
            },
          ],
        }}
        sessionId="test-session"
        onLogin={vi.fn()}
        onLoginFallback={vi.fn()}
      />,
    );
    fireEvent.change(
      screen.getByPlaceholderText(/Describe your requirements/i),
      {
        target: { value: "Need a quarterly L-Carnitine quote." },
      },
    );
    await waitFor(() =>
      expect(screen.getByRole("checkbox", { name: /rfq\.pdf/i })).toBeChecked(),
    );
    await selectCoworkerAndConfirm("Jenny Xu");

    // The sync screen shows immediately, but the row write waits on staging.
    expect(
      await screen.findByRole("heading", { name: /Syncing to Feishu Base/i }),
    ).toBeInTheDocument();
    expect(mockSync).not.toHaveBeenCalled();

    resolveStage({ sources: [{ storageId: "stSLOW", fileName: "slow.pdf" }], failed: [] });

    await waitFor(() => expect(mockSync).toHaveBeenCalledTimes(1));
    expect(mockSync.mock.calls[0][0]).toMatchObject({
      attachmentSources: [{ storageId: "stSLOW", fileName: "slow.pdf" }],
    });
  });

  // ADR-0027: a checked mail attachment is staged at submit and its Convex
  // storageId rides into the syncRequest payload's `attachmentSources` (the Drive
  // mint now happens server-side in the deferred Attachment Fill).
  it("stages a checked mail attachment and rides its storageId into the sync payload", async () => {
    mockStageAttachments.mockResolvedValueOnce({
      sources: [{ storageId: "stFILE", fileName: "rfq.pdf" }],
      failed: [],
    });
    render(
      <RequestIntakeScreen
        isLoggedIn={true}
        mailItem={{
          ...SAMPLE,
          attachments: [
            {
              id: "a1",
              name: "rfq.pdf",
              attachmentType: "file",
              size: 2048,
              isInline: false,
            },
          ],
        }}
        sessionId="test-session"
        onLogin={vi.fn()}
        onLoginFallback={vi.fn()}
      />,
    );
    fireEvent.change(
      screen.getByPlaceholderText(/Describe your requirements/i),
      {
        target: { value: "Need a quarterly L-Carnitine quote." },
      },
    );
    await waitFor(() =>
      expect(screen.getByRole("checkbox", { name: /rfq\.pdf/i })).toBeChecked(),
    );
    await selectCoworkerAndConfirm("Jenny Xu");

    await waitFor(() => expect(mockSync).toHaveBeenCalledTimes(1));
    expect(mockStageAttachments).toHaveBeenCalledWith(
      [{ id: "a1", name: "rfq.pdf" }],
      [],
    );
    expect(mockSync.mock.calls[0][0]).toMatchObject({
      attachmentSources: [{ storageId: "stFILE", fileName: "rfq.pdf" }],
    });
  });

  // Regression (rare repro): submit on conversation A, then switch to another
  // conversation BEFORE the Base sync resolves, then return to A. The leaving
  // Core unmounts mid-sync, so its in-flight success dispatch is a no-op; the
  // draft snapshot must NOT persist the transient `screen:"sync"`, or the
  // restored draft resurrects a DEAD sync overlay that never advances even
  // though the server row is already synced. On return we must see the
  // already-synced overlay, never the stuck "Syncing to Feishu Base" screen.
  it("does not strand the sync screen when the user switches conversations mid-sync and returns", async () => {
    // Sync stays pending forever for this submit (the action effectively dies
    // when the Core unmounts on the conversation switch).
    mockSync.mockImplementationOnce(
      () => new Promise<SyncResult>(() => {}),
    );
    const { rerender } = render(
      <RequestIntakeScreen
        isLoggedIn={true}
        mailItem={SAMPLE}
        sessionId="test-session"
        onLogin={vi.fn()}
        onLoginFallback={vi.fn()}
      />,
    );
    fireEvent.change(
      screen.getByPlaceholderText(/Describe your requirements/i),
      { target: { value: "Need a quarterly L-Carnitine quote." } },
    );
    await selectCoworkerAndConfirm("Jenny Xu");

    expect(
      await screen.findByRole("heading", { name: /Syncing to Feishu Base/i }),
    ).toBeInTheDocument();

    // The server completes the row out-of-band (Base sync succeeded).
    mockExistingSync = {
      status: "synced",
      recordId: "rec_recovered",
      detailUrl: "https://feishu.cn/base/app?table=tbl&record=rec_recovered",
      syncedAt: Date.now(),
    };

    // Switch AWAY to a different conversation -> the conv-1 Core unmounts mid-sync.
    rerender(
      <RequestIntakeScreen
        isLoggedIn={true}
        mailItem={{
          ...SAMPLE,
          conversationId: "conv-2",
          internetMessageId: "<y@acme.com>",
          itemId: "item-2",
          from: "buyer@acme.com",
        }}
        sessionId="test-session"
        onLogin={vi.fn()}
        onLoginFallback={vi.fn()}
      />,
    );

    // Return to conv-1 -> remount restores its draft. It must land on the
    // already-synced overlay, NOT a stranded "Syncing" screen.
    rerender(
      <RequestIntakeScreen
        isLoggedIn={true}
        mailItem={SAMPLE}
        sessionId="test-session"
        onLogin={vi.fn()}
        onLoginFallback={vi.fn()}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: /^Already synced$/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /Syncing to Feishu Base/i }),
    ).not.toBeInTheDocument();
  });

  it("shows an error and not the success screen when sync rejects", async () => {
    mockSync.mockImplementationOnce(() =>
      Promise.reject(new Error("Base unavailable")),
    );
    renderScreen();
    fireEvent.change(
      screen.getByPlaceholderText(/Describe your requirements/i),
      {
        target: { value: "Need a quarterly L-Carnitine quote." },
      },
    );
    await selectCoworkerAndConfirm("Jenny Xu");

    expect(
      await screen.findByRole("heading", { name: /Sync failed/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Try again/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /^Synced$/i }),
    ).not.toBeInTheDocument();
  });
});
