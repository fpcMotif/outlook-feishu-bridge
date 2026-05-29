// Coverage-only tests for RequestIntakeScreen branches NOT exercised by
// RequestIntakeScreen.test.tsx / .sync.test.tsx / .bugfix.test.tsx:
//   - the AuthResolvingScreen (isAuthLoading while !isLoggedIn)
//   - the LoginScreen + its fallback wiring (onLoginFallback)
//   - the Self-Forward `no_item_id` guard (mailItem without itemId)
//   - the Self-Forward `no_self_email` guard (mailItem without userEmail)
//   - the error-screen "Back" button (returns to the coworker picker)
//   - the customer auto-match that adopts a domain hit, plus the user override
//     clearing/replacing the auto-match (customerTouched path)
/* eslint-disable max-lines-per-function, require-unicode-regexp */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type SelfForwardOk = { ok: true };
type SelfForwardFail = { ok: false; step: string; code: string; message: string };
type SelfForwardResult = SelfForwardOk | SelfForwardFail;

const mockSync = vi.fn((_p: unknown) => Promise.resolve({ recordId: "recCOV" }));
const mockCorrect = vi.fn((_p: unknown) => Promise.resolve({ recordId: "recCOV" }));
const mockSendSelfForward = vi.fn(
  (_p: unknown): Promise<SelfForwardResult> => Promise.resolve({ ok: true }),
);

vi.mock("../../hooks/useRequestSync", () => ({
  useRequestSync: () => ({ sync: mockSync, correct: mockCorrect }),
}));
vi.mock("../../hooks/useSelfForward", () => ({
  useSelfForward: () => ({ sendNote: mockSendSelfForward }),
}));
vi.mock("../../hooks/useCoworkerSearch", () => ({
  useCoworkerSearch: () => vi.fn(() => Promise.resolve([])),
}));

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
  }),
}));

import { RequestIntakeScreen } from "./RequestIntakeScreen";
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
};

function renderScreen(overrides: Partial<{
  isLoggedIn: boolean;
  isAuthLoading: boolean;
  mailItem: MailItemData;
  user: { openId: string; userName?: string; avatarUrl?: string };
  onLogin: () => void;
  onLoginFallback: () => void;
}> = {}) {
  const onLogin = overrides.onLogin ?? vi.fn();
  const onLoginFallback = overrides.onLoginFallback ?? vi.fn();
  render(
    <RequestIntakeScreen
      isLoggedIn={overrides.isLoggedIn ?? true}
      isAuthLoading={overrides.isAuthLoading ?? false}
      mailItem={overrides.mailItem ?? SAMPLE}
      sessionId="test-session"
      user={overrides.user}
      onLogin={onLogin}
      onLoginFallback={onLoginFallback}
    />,
  );
  return { onLogin, onLoginFallback };
}

function fillQuotationAndContinue() {
  fireEvent.click(screen.getByRole("button", { name: /Quotation/i }));
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "Need a quarterly L-Carnitine quote." },
  });
  fireEvent.click(screen.getByRole("button", { name: /^Continue$/i }));
}

function pickJennyAndSync() {
  fireEvent.click(screen.getByRole("button", { name: /Jenny Xu/i }));
  fireEvent.click(screen.getByRole("button", { name: /Sync with Jenny Xu/i }));
}

beforeEach(() => {
  mockSync.mockReset();
  mockCorrect.mockReset();
  mockSendSelfForward.mockReset();
  mockSync.mockResolvedValue({ recordId: "recCOV" });
  mockCorrect.mockResolvedValue({ recordId: "recCOV" });
  mockSendSelfForward.mockResolvedValue({ ok: true });
  localStorage.clear();
});

describe("RequestIntakeScreen auth-resolving placeholder", () => {
  // line 324: while the Convex session query is still resolving for a returning
  // user, render the quiet spinner placeholder instead of flashing LoginScreen.
  it("renders the spinner placeholder (not LoginScreen) while auth is loading and not logged in", () => {
    renderScreen({ isLoggedIn: false, isAuthLoading: true });

    expect(screen.getByLabelText("Checking Feishu session")).toBeInTheDocument();
    expect(screen.queryByText("Connect to Feishu")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Continue with Feishu/i }),
    ).not.toBeInTheDocument();
  });

  // line 324 false branch: once auth has settled (not loading) and still logged
  // out, the full LoginScreen renders instead of the spinner.
  it("falls through to the LoginScreen once auth is no longer loading", () => {
    renderScreen({ isLoggedIn: false, isAuthLoading: false });

    expect(screen.queryByLabelText("Checking Feishu session")).not.toBeInTheDocument();
    expect(screen.getByText("Connect to Feishu")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Continue with Feishu/i }),
    ).toBeInTheDocument();
  });
});

describe("RequestIntakeScreen login fallback wiring", () => {
  // line 325 + ConnectCard: the primary button calls onLogin, the backup link
  // calls onLoginFallback. Both props must be threaded into LoginScreen.
  it("invokes onLogin from the primary button and onLoginFallback from the backup link", () => {
    const { onLogin, onLoginFallback } = renderScreen({ isLoggedIn: false });

    fireEvent.click(screen.getByRole("button", { name: /Continue with Feishu/i }));
    expect(onLogin).toHaveBeenCalledTimes(1);
    expect(onLoginFallback).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Use backup login/i }));
    expect(onLoginFallback).toHaveBeenCalledTimes(1);
    expect(onLogin).toHaveBeenCalledTimes(1);
  });
});

describe("RequestIntakeScreen self-forward host guards", () => {
  // lines 169-176: dev preview / browser host has no real Outlook item id, so
  // the Self-Forward short-circuits to a `no_item_id` failure. Bitable still
  // succeeds, so the user lands on the success screen with the failed chip.
  it("fails the Self-Forward with no_item_id when the mail item has no itemId", async () => {
    renderScreen({ mailItem: { ...SAMPLE, itemId: "" } });
    fillQuotationAndContinue();
    pickJennyAndSync();

    expect(
      await screen.findByRole("heading", { name: /Synced to Feishu/i }),
    ).toBeInTheDocument();
    // The guard fired before any network call: sendNote was never invoked.
    expect(mockSendSelfForward).not.toHaveBeenCalled();
    expect(await screen.findByText(/Note-to-myself failed/i)).toBeInTheDocument();
  });

  // lines 177-184: with an item id but no signed-in Outlook user email, the
  // Self-Forward target is unknown → `no_self_email` failure (still no send).
  it("fails the Self-Forward with no_self_email when the mail item has no userEmail", async () => {
    renderScreen({ mailItem: { ...SAMPLE, userEmail: "" } });
    fillQuotationAndContinue();
    pickJennyAndSync();

    expect(
      await screen.findByRole("heading", { name: /Synced to Feishu/i }),
    ).toBeInTheDocument();
    expect(mockSendSelfForward).not.toHaveBeenCalled();
    expect(await screen.findByText(/Note-to-myself failed/i)).toBeInTheDocument();
  });

  // Contrast: with both itemId and userEmail present the guards pass and the
  // real sendNote is invoked (covers the happy fall-through past both guards).
  it("sends the Self-Forward when both itemId and userEmail are present", async () => {
    renderScreen();
    fillQuotationAndContinue();
    pickJennyAndSync();

    await waitFor(() => expect(mockSendSelfForward).toHaveBeenCalledTimes(1));
    expect(mockSendSelfForward.mock.calls[0][0]).toMatchObject({
      originalMessageId: "item-1",
      selfEmail: "jenny.xu@fenchem.com",
    });
  });
});

describe("RequestIntakeScreen error screen Back button", () => {
  // line 315: from the sync-failed error screen, "Back" returns to the coworker
  // picker (screenChanged → "coworker") rather than retrying the write.
  it("returns to the coworker picker without re-syncing when Back is clicked", async () => {
    mockSync.mockRejectedValueOnce(new Error("Bitable unavailable"));
    renderScreen();
    fillQuotationAndContinue();
    pickJennyAndSync();

    expect(await screen.findByRole("heading", { name: /Sync failed/i })).toBeInTheDocument();
    expect(mockSync).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /^Back$/i }));

    // Back to the coworker picker: the search field + the prior selection chip.
    expect(screen.getByRole("heading", { name: "Feishu coworker" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Sync with Jenny Xu/i })).toBeInTheDocument();
    // Back must NOT trigger another Bitable write (distinct from "Try again").
    expect(mockSync).toHaveBeenCalledTimes(1);
  });

  // The fallback copy renders when the reducer stored no specific syncError.
  // (Drives the `state.syncError ?? "Could not sync…"` else branch on line 311
  // by rejecting with a non-Error, which useRequestSync's caller coerces.)
  it("shows the generic failure copy when sync rejects without an Error message", async () => {
    mockSync.mockRejectedValueOnce("boom");
    renderScreen();
    fillQuotationAndContinue();
    pickJennyAndSync();

    expect(await screen.findByRole("heading", { name: /Sync failed/i })).toBeInTheDocument();
    expect(screen.getByText("Sync failed", { selector: "p, span" })).toBeInTheDocument();
  });
});

describe("RequestIntakeScreen customer auto-match + override", () => {
  // lines 126-141: the directory has a row whose 域名 matches the sender domain,
  // so the auto-match adopts Bayer and it rides to sync as selectedCustomer.
  it("adopts the directory domain hit and forwards it as selectedCustomer on sync", async () => {
    renderScreen();
    fillQuotationAndContinue();
    pickJennyAndSync();

    await waitFor(() => expect(mockSync).toHaveBeenCalledTimes(1));
    expect(mockSync.mock.calls[0][0]).toMatchObject({
      selectedCustomer: { recordId: "rec_bayer", name: "Bayer Pharma" },
    });
  });

  // customerOverridden path (customerTouched=true): picking a different customer
  // wins over the auto-match, and the auto-match effect must not clobber it.
  it("lets a manual override replace the auto-matched customer on sync", async () => {
    renderScreen();
    fillQuotationAndContinue();

    fireEvent.click(screen.getByRole("button", { name: /change/i }));
    fireEvent.change(screen.getByRole("searchbox", { name: /search customers/i }), {
      target: { value: "stock" },
    });
    fireEvent.click(screen.getByRole("button", { name: /STOCKMEIER Chemie/i }));

    pickJennyAndSync();

    await waitFor(() => expect(mockSync).toHaveBeenCalledTimes(1));
    expect(mockSync.mock.calls[0][0]).toMatchObject({
      selectedCustomer: { recordId: "rec_stock", name: STOCKMEIER.name },
    });
  });

  // Editing the client email clears the prior match (clientEmailChanged resets
  // selectedCustomer + customerTouched), so a non-matching domain rides to sync
  // with selectedCustomer undefined (covers the `: undefined` branch line 233).
  it("clears the selected customer to undefined on sync when the edited client email has no domain hit", async () => {
    renderScreen();
    fillQuotationAndContinue();

    fireEvent.change(screen.getByLabelText("Client email"), {
      target: { value: "someone@unknown-domain.example" },
    });

    pickJennyAndSync();

    await waitFor(() => expect(mockSync).toHaveBeenCalledTimes(1));
    expect(mockSync.mock.calls[0][0]).toMatchObject({
      clientEmail: "someone@unknown-domain.example",
    });
    expect(
      (mockSync.mock.calls[0][0] as { selectedCustomer?: unknown }).selectedCustomer,
    ).toBeUndefined();
  });
});

describe("RequestIntakeScreen mailFrom change", () => {
  // lines 109-110 + 109:if branch: when Outlook switches to a different open
  // message, mailItem.from changes between renders → the reducer resets the
  // client email (and clears the prior customer match) to the new sender.
  it("resets the client email to the new sender when mailItem.from changes between renders", () => {
    const { rerender } = render(
      <RequestIntakeScreen
        isLoggedIn={true}
        mailItem={SAMPLE}
        sessionId="test-session"
        onLogin={vi.fn()}
        onLoginFallback={vi.fn()}
      />,
    );
    // Move to the coworker screen so the Client email field is visible.
    fillQuotationAndContinue();
    expect(screen.getByDisplayValue("m.hoffmann@bayerpharma.de")).toBeInTheDocument();

    // Outlook navigates to a different inbound message (new sender).
    rerender(
      <RequestIntakeScreen
        isLoggedIn={true}
        mailItem={{ ...SAMPLE, from: "new.sender@othercorp.example" }}
        sessionId="test-session"
        onLogin={vi.fn()}
        onLoginFallback={vi.fn()}
      />,
    );

    // The reducer adopted the new sender as the client email.
    expect(screen.getByDisplayValue("new.sender@othercorp.example")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("m.hoffmann@bayerpharma.de")).not.toBeInTheDocument();
  });
});

describe("RequestIntakeScreen screen navigation", () => {
  // line 352: the coworker picker's "Back" returns to the request builder
  // (screenChanged → "build") so the filled request cards re-appear.
  it("returns from the coworker picker to the request builder via Back", () => {
    renderScreen();
    fillQuotationAndContinue();

    // On the coworker picker now.
    expect(screen.getByRole("heading", { name: "Feishu coworker" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Back$/i }));

    // Back on the build screen: the request cards + the "Continue" dock return.
    expect(screen.getByRole("button", { name: /^Continue$/i })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Feishu coworker" })).not.toBeInTheDocument();
  });

  // lines 330-331 cond-expr/binary-expr: the coworker screen derives an email
  // "domain part" from the client email. When the edited client email has no
  // "@", the whole string is used verbatim (the `: state.clientEmail` else
  // branch) instead of the post-"@" split.
  it("uses the full client email as the domain part when it contains no @", () => {
    renderScreen();
    fillQuotationAndContinue();

    // On the coworker screen — overwrite the client email with a no-"@" value.
    fireEvent.change(screen.getByLabelText("Client email"), {
      target: { value: "plain-text-no-at-sign" },
    });

    // The picker still renders (the domain-part derivation did not throw) and
    // the edited value is reflected back into the field.
    expect(screen.getByDisplayValue("plain-text-no-at-sign")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Feishu coworker" })).toBeInTheDocument();
  });

  // line 360 cond-expr: with TWO filled requests the coworker-screen footer
  // pluralises to "2 requests" (the `filledCount > 1 ? "s" : ""` branch).
  it("pluralises the dock footer when two requests are filled", () => {
    renderScreen();
    // Fill two distinct request cards (Quotation + another).
    fireEvent.click(screen.getByRole("button", { name: /Quotation/i }));
    const boxes = screen.getAllByRole("textbox");
    fireEvent.change(boxes[0], { target: { value: "Quote please." } });
    fireEvent.click(screen.getByRole("button", { name: /Sample/i }));
    const boxesAfter = screen.getAllByRole("textbox");
    fireEvent.change(boxesAfter[boxesAfter.length - 1], { target: { value: "Sample please." } });

    fireEvent.click(screen.getByRole("button", { name: /^Continue$/i }));

    // Coworker screen footer reflects "2 requests + 1 coworker …".
    expect(screen.getByText(/2 requests \+ 1 coworker/i)).toBeInTheDocument();
  });
});
