/* eslint-disable max-lines-per-function, require-unicode-regexp */
import { fireEvent, render, screen } from "@testing-library/react";
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

vi.mock("../../hooks/useSelfForward", () => ({
  useSelfForward: () => ({ sendNote: vi.fn(() => Promise.resolve({ ok: true })) }),
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
import { resetSalesDefaultForTests } from "./scheduleSalesDefault";
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
// the only remaining gate is the uploads.
async function reachReadyToSync() {
  renderScreen();
  fireEvent.change(screen.getByPlaceholderText(/Describe your requirements/i), {
    target: { value: "Need a quarterly L-Carnitine quote." },
  });
  fireEvent.change(screen.getByLabelText("Search Feishu coworkers"), {
    target: { value: "Jenny Xu" },
  });
  fireEvent.click(await screen.findByRole("button", { name: /^Jenny Xu/i }));
  return await screen.findByRole("button", { name: /Sync with Jenny Xu/i });
}

function pickFile(name = "report.pdf") {
  const input = screen.getByTestId("attachment-upload-input") as HTMLInputElement;
  const file = new File([new Uint8Array(8)], name, { type: "application/pdf" });
  fireEvent.change(input, { target: { files: [file] } });
}

beforeEach(() => {
  resetSalesDefaultForTests();
  clearIntakeDraftCache();
  resetUploadDrafts();
  resetIntakeUploadCaches();
  localStorage.clear();
  vi.clearAllMocks();
});

describe("RequestIntakeScreen — submit dock upload gate", () => {
  it("is live once the content prerequisites are met (baseline)", async () => {
    expect(await reachReadyToSync()).toBeEnabled();
  });

  it("grays the dock while a picked attachment is still uploading", async () => {
    await reachReadyToSync();
    pickFile();

    const waiting = await screen.findByRole("button", {
      name: /Waiting for attachments to finish uploading/i,
    });
    expect(waiting).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: /Sync with Jenny Xu/i }),
    ).not.toBeInTheDocument();
  });

  it("re-enables the dock once the unfinished upload is removed (cancel)", async () => {
    await reachReadyToSync();
    pickFile("report.pdf");
    await screen.findByRole("button", {
      name: /Waiting for attachments to finish uploading/i,
    });

    fireEvent.click(screen.getByRole("button", { name: /Remove report\.pdf/i }));

    expect(
      await screen.findByRole("button", { name: /Sync with Jenny Xu/i }),
    ).toBeEnabled();
  });
});
