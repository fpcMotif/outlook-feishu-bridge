// Regression tests for the Bitable-Sync / Self-Forward orchestration bugs fixed
// in ADR-0018:
//   #3  the Self-Forward is NOT re-fired on a Bitable "Try again" once it has
//       already succeeded (the Graph forward is non-idempotent).
//   #6  retrying the Self-Forward shows the in-flight "Sending Note to myself…"
//       chip (the pending reducer branch used to be dead).
//   #4  a Self-Forward resolving late from a previous flow does not clobber a
//       fresh flow's chip (generation guard).
/* eslint-disable max-lines-per-function, require-unicode-regexp */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type SelfForwardOk = { ok: true };
type SelfForwardFail = { ok: false; step: string; code: string; message: string };
type SelfForwardResult = SelfForwardOk | SelfForwardFail;

const mockSync = vi.fn((_p: unknown) => Promise.resolve({ recordId: "rec1" }));
const mockCorrect = vi.fn((_p: unknown) => Promise.resolve({ recordId: "rec1" }));
const mockSendSelfForward = vi.fn((_p: unknown): Promise<SelfForwardResult> => Promise.resolve({ ok: true }));

vi.mock("../../hooks/useRequestSync", () => ({
  useRequestSync: () => ({ sync: mockSync, correct: mockCorrect }),
}));
vi.mock("../../hooks/useSelfForward", () => ({
  useSelfForward: () => ({ sendNote: mockSendSelfForward }),
}));
vi.mock("../../hooks/useCoworkerSearch", () => ({
  useCoworkerSearch: () => vi.fn(() => Promise.resolve([])),
}));
const BAYER = { recordId: "rec_bayer", name: "Bayer Pharma", domain: "bayerpharma.de", owner: null };
vi.mock("../../hooks/useCustomerSearch", () => ({
  useCustomerSearch: () => ({
    directory: { status: "ready", records: [BAYER] },
    search: vi.fn(() => Promise.resolve([])),
  }),
}));

import { RequestIntakeScreen } from "./RequestIntakeScreen";
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
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function renderScreen() {
  render(
    <RequestIntakeScreen
      isLoggedIn={true}
      mailItem={SAMPLE}
      sessionId="test-session"
      user={{ openId: "ou_jenny", userName: "Jenny Xu" }}
      onLogin={vi.fn()}
      onLoginFallback={vi.fn()}
    />,
  );
}

function fillAndSubmit() {
  fireEvent.click(screen.getByRole("button", { name: /Quotation/i }));
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "Need a quarterly L-Carnitine quote." },
  });
  fireEvent.click(screen.getByRole("button", { name: /^Continue$/i }));
  fireEvent.click(screen.getByRole("button", { name: /Jenny Xu/i }));
  fireEvent.click(screen.getByRole("button", { name: /Sync with Jenny Xu/i }));
}

beforeEach(() => {
  mockSync.mockReset();
  mockCorrect.mockReset();
  mockSendSelfForward.mockReset();
  mockSync.mockResolvedValue({ recordId: "rec1" });
  mockCorrect.mockResolvedValue({ recordId: "rec1" });
  mockSendSelfForward.mockResolvedValue({ ok: true });
  localStorage.clear();
});

describe("bug #3 — Self-Forward is not duplicated on Bitable retry", () => {
  it("does NOT re-fire the Note-to-myself on 'Try again' when it already succeeded", async () => {
    // First Bitable write fails, the parallel Self-Forward succeeds.
    mockSync.mockRejectedValueOnce(new Error("Bitable unavailable"));
    mockSendSelfForward.mockResolvedValue({ ok: true });

    renderScreen();
    fillAndSubmit();

    expect(await screen.findByRole("heading", { name: /Sync failed/i })).toBeInTheDocument();
    await waitFor(() => expect(mockSendSelfForward).toHaveBeenCalledTimes(1));

    // Retry the Bitable write — it now succeeds. The already-sent Note-to-myself
    // must NOT be sent a second time (the Graph forward is non-idempotent).
    fireEvent.click(screen.getByRole("button", { name: /Try again/i }));

    expect(await screen.findByRole("heading", { name: /Synced to Feishu/i })).toBeInTheDocument();
    expect(mockSync).toHaveBeenCalledTimes(2);
    expect(mockSendSelfForward).toHaveBeenCalledTimes(1);
  });
});

describe("bug #6 — Self-Forward retry shows the pending chip", () => {
  it("shows 'Sending Note to myself…' while a retried forward is in flight", async () => {
    // Sync succeeds; the first Self-Forward fails so the retry chip appears.
    mockSendSelfForward.mockResolvedValueOnce({
      ok: false,
      step: "send",
      code: "ErrorAccessDenied",
      message: "no consent",
    });
    // The retried forward hangs so we can observe the in-flight chip.
    const pending = deferred<SelfForwardResult>();
    mockSendSelfForward.mockReturnValueOnce(pending.promise);

    renderScreen();
    fillAndSubmit();

    expect(await screen.findByRole("heading", { name: /Synced to Feishu/i })).toBeInTheDocument();
    const retry = await screen.findByRole("button", { name: /Retry note-to-myself/i });

    fireEvent.click(retry);

    expect(await screen.findByText(/Sending Note to myself/i)).toBeInTheDocument();
    pending.resolve({ ok: true });
    expect(await screen.findByText(/Note to myself sent/i)).toBeInTheDocument();
  });
});

describe("bug #4 — a stale Self-Forward does not clobber a fresh flow", () => {
  it("ignores a previous flow's late forward resolution after Start Over + a new sync", async () => {
    // Flow #1's Self-Forward hangs; flow #2's succeeds.
    const stale = deferred<SelfForwardResult>();
    mockSendSelfForward.mockReturnValueOnce(stale.promise); // flow #1
    mockSendSelfForward.mockResolvedValueOnce({ ok: true }); // flow #2

    renderScreen();
    fillAndSubmit();
    expect(await screen.findByRole("heading", { name: /Synced to Feishu/i })).toBeInTheDocument();
    expect(await screen.findByText(/Sending Note to myself/i)).toBeInTheDocument();

    // Start a brand-new flow and complete it; its forward succeeds.
    fireEvent.click(screen.getByRole("button", { name: /Route another email/i }));
    fillAndSubmit();
    expect(await screen.findByText(/Note to myself sent/i)).toBeInTheDocument();

    // The first flow's forward resolves LATE as a failure — it must not flip the
    // fresh flow's "sent" chip to "failed".
    stale.resolve({ ok: false, step: "send", code: "x", message: "stale" });
    await Promise.resolve();

    expect(screen.getByText(/Note to myself sent/i)).toBeInTheDocument();
    expect(screen.queryByText(/Note-to-myself failed/i)).not.toBeInTheDocument();
  });
});
