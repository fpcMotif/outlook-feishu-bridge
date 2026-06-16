/* eslint-disable max-lines-per-function, require-unicode-regexp */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Proves the submit-dock upload gate end-to-end (gate logic: submitSyncGate.ts,
// wiring: useRequestIntakeScreen.ts). Once the three content prerequisites are
// met the dock is live; picking a file that is still uploading grays it again,
// and the only two ways back to live are letting the upload finish or removing
// it (the "cancel"). Closes the race where a tap mid-upload synced the row with
// an empty Sales Files cell, i.e. "without any attachments" (ADR-0027).

vi.mock("../../hooks/useRequestSync", () => ({
  useRequestSync: () => ({
    sync: vi.fn(() =>
      Promise.resolve({ status: "synced", recordId: "rec1", detailUrl: null }),
    ),
    correct: vi.fn(() => Promise.resolve({ recordId: "rec1" })),
    existingSync: null,
  }),
}));

// generateUploadUrl never resolves, so a picked file is parked mid-upload and
// the dock can be observed in its grayed in-flight state.
const hangingUploadUrl = vi.fn(() => new Promise<string>(() => {}));
vi.mock("../../hooks/useAttachmentStaging", () => ({
  useAttachmentStaging: () => ({
    generateUploadUrl: hangingUploadUrl,
    uploadBytes: vi.fn(),
  }),
}));

vi.mock("../../hooks/useCoworkerSearch", () => {
  const coworkers = [
    {
      openId: "ou_jenny",
      name: "Jenny Xu",
      avatarUrl: "https://example.test/jenny.png",
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
vi.mock("../../hooks/useCustomerSearch", () => ({
  useCustomerSearch: () => ({
    directory: { status: "ready", records: [BAYER] },
    search: vi.fn(() => Promise.resolve([])),
    matchEmail: vi.fn((email: string) =>
      Promise.resolve(email.endsWith("@bayerpharma.de") ? BAYER : null),
    ),
    triggerRefresh: vi.fn(),
  }),
}));

import { RequestIntakeScreen } from "./RequestIntakeScreen";
import { clearIntakeDraftCache } from "./intakeDraftCache";
import { resetUploadDrafts } from "./uploadDraftCache";
import { resetIntakeUploadCaches } from "./uploadIntakeFile";
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

function renderScreen() {
  render(
    <RequestIntakeScreen
      isLoggedIn
      mailItem={SAMPLE}
      sessionId="test-session"
      user={{ openId: "ou_rep", userName: "Rep", avatarUrl: "https://example.test/rep.png" }}
      onLogin={vi.fn()}
      onLoginFallback={vi.fn()}
    />,
  );
}

// Customer auto-matches from the sender domain; add a request note + coworker so
// the only remaining gate is the attachment confirmation countdown.
async function reachReadyCoworker() {
  renderScreen();
  fireEvent.change(screen.getByPlaceholderText(/Describe your requirements/i), {
    target: { value: "Need a quarterly L-Carnitine quote." },
  });
  fireEvent.change(screen.getByLabelText("Search Feishu coworkers"), {
    target: { value: "Jenny Xu" },
  });
  return await screen.findByRole("button", { name: /^Jenny Xu/i });
}

async function startReadyCountdown() {
  fireEvent.click(await reachReadyCoworker());
  return screen.getByRole("button", { name: /Checking attachments/i });
}

function pickFile(name = "report.pdf") {
  const input = screen.getByTestId("attachment-upload-input") as HTMLInputElement;
  const file = new File([new Uint8Array(8)], name, { type: "application/pdf" });
  fireEvent.change(input, { target: { files: [file] } });
}

beforeEach(() => {
  clearIntakeDraftCache();
  resetUploadDrafts();
  resetIntakeUploadCaches();
  localStorage.clear();
  vi.clearAllMocks();
});

describe("RequestIntakeScreen — submit dock upload gate", () => {
  it("starts the attachment countdown once the content prerequisites are met (baseline)", async () => {
    const coworker = await reachReadyCoworker();

    vi.useFakeTimers();
    try {
      fireEvent.click(coworker);
      const checking = screen.getByRole("button", { name: /Checking attachments/i });
      expect(checking).toBeDisabled();
      expect(within(checking).getByText("3")).toBeInTheDocument();

      await act(async () => {
        vi.advanceTimersByTime(3000);
      });
    } finally {
      vi.useRealTimers();
    }

    expect(screen.getByRole("button", { name: /Sync with Jenny Xu/i })).toBeEnabled();
  });

  it("grays the dock while a picked attachment is still uploading", async () => {
    await startReadyCountdown();
    pickFile();

    const waiting = await screen.findByRole("button", {
      name: /Waiting for attachments to finish uploading/i,
    });
    expect(waiting).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: /Check attachments/i }),
    ).not.toBeInTheDocument();
  });

  it("re-enables the dock once the unfinished upload is removed (cancel)", async () => {
    await startReadyCountdown();
    pickFile("report.pdf");
    await screen.findByRole("button", {
      name: /Waiting for attachments to finish uploading/i,
    });

    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole("button", { name: /Remove report\.pdf/i }));
      expect(screen.getByRole("button", { name: /Checking attachments/i })).toBeDisabled();

      await act(async () => {
        vi.advanceTimersByTime(3000);
      });
    } finally {
      vi.useRealTimers();
    }

    expect(screen.getByRole("button", { name: /Sync with Jenny Xu/i })).toBeEnabled();
  });

  it("resets attachment confirmation when attachment selection changes", async () => {
    const coworker = await reachReadyCoworker();

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
    expect(screen.getByRole("button", { name: /Sync with Jenny Xu/i })).toBeEnabled();

    pickFile("report.pdf");
    await screen.findByRole("button", {
      name: /Waiting for attachments to finish uploading/i,
    });

    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole("button", { name: /Remove report\.pdf/i }));
      expect(screen.getByRole("button", { name: /Checking attachments/i })).toBeDisabled();
      expect(
        screen.queryByRole("button", { name: /Sync with Jenny Xu/i }),
      ).not.toBeInTheDocument();

      await act(async () => {
        vi.advanceTimersByTime(3000);
      });
    } finally {
      vi.useRealTimers();
    }

    expect(screen.getByRole("button", { name: /Sync with Jenny Xu/i })).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: /Confirm sync/i }),
    ).not.toBeInTheDocument();
  });

  it("counts down before confirming an empty-attachment sync", async () => {
    const coworker = await reachReadyCoworker();

    vi.useFakeTimers();
    try {
      fireEvent.click(coworker);
      const checking = screen.getByRole("button", { name: /Checking attachments/i });
      expect(checking).toBeDisabled();
      expect(checking).toHaveClass("bg-muted/36", "text-muted-foreground/72");
      expect(checking).not.toHaveAttribute("data-live");
      expect(checking).not.toHaveAttribute("data-busy");
      expect(checking.querySelector(".submit-dock-loading-dot")).not.toBeInTheDocument();
      expect(checking).toHaveAccessibleName("Checking attachments");
      expect(checking.querySelector(".submit-dock-busy-dots")).toHaveAttribute(
        "aria-hidden",
        "true",
      );
      expect(checking.querySelectorAll(".submit-dock-busy-dot")).toHaveLength(3);
      const countdown = within(checking).getByText("3");
      expect(countdown).toHaveClass(
        "animate-pop-in",
        "[color:var(--submit-dock-countdown-color)]",
      );
      expect(countdown).not.toHaveClass("submit-dock-countdown-spark");
      expect(checking.firstElementChild).toContainElement(countdown);
      expect(checking.querySelector(".submit-dock-countdown-ring")).toHaveClass(
        "[stroke:var(--submit-dock-countdown-color)]",
      );

      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      const two = within(checking).getByText("2");
      expect(two).toBeInTheDocument();
      expect(two).toHaveClass("animate-pop-in");
      expect(two).not.toHaveClass("submit-dock-countdown-spark");

      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      expect(within(checking).getByText("1")).toBeInTheDocument();

      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
    } finally {
      vi.useRealTimers();
    }

    const ready = screen.getByRole("button", { name: /Sync with Jenny Xu/i });
    expect(ready).toBeEnabled();
    expect(ready).toHaveClass("bg-primary", "text-primary-foreground");
    expect(ready).toHaveAttribute("data-live");
    expect(screen.queryByRole("button", { name: /Check attachments/i })).not.toBeInTheDocument();
    expect(ready.querySelector("svg.submit-dock-arrow")).toBeInTheDocument();
  });
});
