/* eslint-disable max-lines-per-function */
import { useCallback, useMemo, useReducer } from "react";

import type { Coworker } from "./coworkers";
import { findCustomerByEmail, type CustomerRecord } from "./customers";
import type { MailItemData } from "../../office/useMailItem";
import { useCustomerSearch } from "../../hooks/useCustomerSearch";
import { useRequestSync } from "../../hooks/useRequestSync";
import { Button } from "../ui/button";
import { CoworkerPicker } from "./CoworkerPicker";
import { ConnectCard } from "./ConnectCard";
import { CustomerPicker } from "./CustomerPicker";
import { ReceivedScreen } from "./ReceivedScreen";
import { RequestCards } from "./RequestCards";
import { REQUESTS } from "./requests";
import { SubmitDock } from "./SubmitDock";
import { SyncScreen } from "./SyncScreen";

type IntakeScreenName = "build" | "coworker" | "sync" | "received" | "error";

interface IntakeState {
  notes: Record<string, string>;
  clientEmail: string;
  mailFrom: string;
  screen: IntakeScreenName;
  selectedCoworker: Coworker | null;
  // The Customer picked or auto-matched in the Customer Picker (ADR-0013).
  // `customerTouched` flips true once the salesperson interacts with the picker
  // — after that we stop overwriting their choice when the directory loads.
  selectedCustomer: CustomerRecord | null;
  customerTouched: boolean;
  syncError: string | null;
}

type IntakeAction =
  | { type: "mailFromChanged"; mailFrom: string }
  | { type: "noteChanged"; id: string; value: string }
  | { type: "clientEmailChanged"; value: string }
  | { type: "screenChanged"; screen: IntakeScreenName }
  | { type: "coworkerSelected"; coworker: Coworker }
  | { type: "customerAutoMatched"; customer: CustomerRecord | null }
  | { type: "customerOverridden"; customer: CustomerRecord | null }
  | { type: "syncStarted" }
  | { type: "syncSucceeded" }
  | { type: "syncFailed"; message: string }
  | { type: "startedOver" };

function initialIntakeState(mailFrom: string): IntakeState {
  return {
    notes: {},
    clientEmail: mailFrom,
    mailFrom,
    screen: "build",
    selectedCoworker: null,
    selectedCustomer: null,
    customerTouched: false,
    syncError: null,
  };
}

function intakeReducer(state: IntakeState, action: IntakeAction): IntakeState {
  switch (action.type) {
    case "mailFromChanged":
      return {
        ...state,
        clientEmail: action.mailFrom,
        mailFrom: action.mailFrom,
        selectedCustomer: null,
        customerTouched: false,
      };
    case "noteChanged":
      return { ...state, notes: { ...state.notes, [action.id]: action.value } };
    case "clientEmailChanged":
      // The salesperson is re-resolving the client → the previous auto-match
      // is stale. Clear it; the next auto-match effect will re-fire.
      return {
        ...state,
        clientEmail: action.value,
        selectedCustomer: null,
        customerTouched: false,
      };
    case "screenChanged":
      return { ...state, screen: action.screen };
    case "coworkerSelected":
      return { ...state, selectedCoworker: action.coworker };
    case "customerAutoMatched":
      // Only adopt the auto-match if the salesperson hasn't already picked.
      if (state.customerTouched) return state;
      return { ...state, selectedCustomer: action.customer };
    case "customerOverridden":
      return { ...state, selectedCustomer: action.customer, customerTouched: true };
    case "syncStarted":
      return { ...state, screen: "sync", syncError: null };
    case "syncSucceeded":
      return { ...state, screen: "received" };
    case "syncFailed":
      return { ...state, screen: "error", syncError: action.message };
    case "startedOver":
      return {
        ...state,
        notes: {},
        screen: "build",
        selectedCoworker: null,
        selectedCustomer: null,
        customerTouched: false,
        syncError: null,
      };
  }
}

function Hero() {
  return (
    <header className="px-1 pt-3 pb-5">
      <div className="text-accent-foreground mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase">
        <span className="bg-muted-foreground inline-block h-px w-3.5" />
        New request
      </div>
      <h1 className="font-serif text-[34px] leading-[0.98] tracking-tight">
        How can we
        <br />
        help today?
      </h1>
      <p className="text-foreground/70 mt-2 max-w-[32ch] text-sm leading-relaxed">
        Route it to the right coworker in seconds.
      </p>
    </header>
  );
}

function LoginScreen({
  onLogin,
  onLoginFallback,
}: {
  onLogin: () => void;
  onLoginFallback: () => void;
}) {
  return (
    <div className="no-scrollbar flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 pt-8 pb-6">
      <header className="px-1">
        <div className="text-accent-foreground mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase">
          <span className="bg-muted-foreground inline-block h-px w-3.5" />
          Outlook handoff
        </div>
        <h1 className="font-serif text-[34px] leading-[0.98]">
          Sign in before
          <br />
          routing the email
        </h1>
        <p className="text-foreground/70 mt-2 max-w-[32ch] text-sm leading-relaxed">
          Keep account connection separate from the request cards, then continue cleanly.
        </p>
      </header>
      <ConnectCard onLogin={onLogin} onLoginFallback={onLoginFallback} />
    </div>
  );
}

export function RequestIntakeScreen({
  isLoggedIn,
  mailItem,
  sessionId,
  userAccessToken,
  onLogin,
  onLoginFallback,
}: {
  isLoggedIn: boolean;
  mailItem: MailItemData;
  sessionId: string;
  userAccessToken?: string;
  onLogin: () => void;
  onLoginFallback: () => void;
}) {
  const { sync } = useRequestSync();
  const [state, dispatch] = useReducer(intakeReducer, mailItem.from, initialIntakeState);

  if (state.mailFrom !== mailItem.from) {
    dispatch({ type: "mailFromChanged", mailFrom: mailItem.from });
  }

  // Customer Directory preload (ADR-0013). Non-blocking: while loading the
  // CustomerPicker shows "Resolving customer for …" and the rest of the
  // screen stays interactive. One hook bundles the directory + the per-
  // keystroke server fallback so a single vi.mock replaces both in tests.
  const { directory: customerDirectory, search: searchCustomers } =
    useCustomerSearch(isLoggedIn);

  // Re-run the local auto-match whenever the directory finishes loading or
  // the client email changes. The reducer guards against clobbering a user
  // override (customerTouched).
  const autoMatch = useMemo(
    () =>
      customerDirectory.status === "ready"
        ? findCustomerByEmail(customerDirectory.records, state.clientEmail)
        : null,
    [customerDirectory.status, customerDirectory.records, state.clientEmail],
  );
  const autoMatchId = autoMatch?.recordId ?? null;
  const currentMatchId = state.selectedCustomer?.recordId ?? null;
  if (
    !state.customerTouched &&
    customerDirectory.status === "ready" &&
    autoMatchId !== currentMatchId
  ) {
    dispatch({ type: "customerAutoMatched", customer: autoMatch });
  }

  const filledRequests = useMemo(
    () =>
      REQUESTS.flatMap((r) => {
        const note = (state.notes[r.id] ?? "").trim();
        return note ? [{ id: r.id, title: r.title, note }] : [];
      }),
    [state.notes],
  );
  const filledCount = filledRequests.length;
  const selectedCount = state.selectedCoworker ? 1 : 0;
  const selectedOpenId = state.selectedCoworker?.openId;

  const selectCoworker = (coworker: Coworker) => {
    dispatch({ type: "coworkerSelected", coworker });
  };

  // First write: hand the intake to the Bitable sync. Email subject/body ride to
  // the Convex Email Record only; the Bitable row gets the structured request.
  const runSync = useCallback(() => {
    dispatch({ type: "syncStarted" });
    sync({
      subject: mailItem.subject,
      from: mailItem.from,
      to: mailItem.to,
      cc: mailItem.cc,
      body: mailItem.body,
      internetMessageId: mailItem.internetMessageId,
      itemId: mailItem.itemId || undefined,
      conversationId: mailItem.conversationId || undefined,
      userEmail: mailItem.userEmail || undefined,
      dateTimeCreated: mailItem.dateTimeCreated?.getTime(),
      clientEmail: state.clientEmail,
      selectedCustomer: state.selectedCustomer
        ? { recordId: state.selectedCustomer.recordId, name: state.selectedCustomer.name }
        : undefined,
      requestSelections: filledRequests.map((r) => ({ requestType: r.title, note: r.note })),
      selectedCoworkers: state.selectedCoworker ? [state.selectedCoworker] : [],
    })
      .then(() => dispatch({ type: "syncSucceeded" }))
      .catch((e: unknown) => {
        dispatch({ type: "syncFailed", message: e instanceof Error ? e.message : "Sync failed" });
      });
  }, [sync, mailItem, state.clientEmail, state.selectedCustomer, filledRequests, state.selectedCoworker]);

  const handleSubmit = () => {
    if (state.screen === "build") {
      if (filledCount === 0) return;
      dispatch({ type: "screenChanged", screen: "coworker" });
      return;
    }
    if (selectedCount === 0) return;
    runSync();
  };

  const startOver = () => {
    dispatch({ type: "startedOver" });
  };

  if (state.screen === "received") {
    return <ReceivedScreen coworkerCount={selectedCount} onSyncAnother={startOver} />;
  }

  if (state.screen === "sync") {
    return (
      <SyncScreen
        requests={filledRequests}
        clientEmail={state.clientEmail}
        coworkerCount={selectedCount}
      />
    );
  }

  if (state.screen === "error") {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
        <h1 className="font-serif text-2xl">Sync failed</h1>
        <p className="text-muted-foreground max-w-[34ch] text-sm leading-relaxed">
          {state.syncError ?? "Could not sync to Feishu Bitable."}
        </p>
        <div className="flex gap-2">
          <Button onClick={runSync}>Try again</Button>
          <Button variant="secondary" onClick={() => dispatch({ type: "screenChanged", screen: "coworker" })}>
            Back
          </Button>
        </div>
      </div>
    );
  }

  if (!isLoggedIn) {
    return <LoginScreen onLogin={onLogin} onLoginFallback={onLoginFallback} />;
  }

  if (state.screen === "coworker") {
    const emailDomainPart = state.clientEmail.includes("@")
      ? state.clientEmail.split("@").pop() ?? state.clientEmail
      : state.clientEmail;
    return (
      <>
        <CoworkerPicker
          clientEmail={state.clientEmail}
          onClientEmailChange={(value) => dispatch({ type: "clientEmailChanged", value })}
          customerSlot={
            <CustomerPicker
              directory={customerDirectory}
              searchCustomers={searchCustomers}
              emailDomain={emailDomainPart}
              selectedCustomer={state.selectedCustomer}
              onChange={(customer) => dispatch({ type: "customerOverridden", customer })}
            />
          }
          sessionId={sessionId}
          userAccessToken={userAccessToken}
          selectedOpenId={selectedOpenId}
          onSelect={selectCoworker}
          onBack={() => dispatch({ type: "screenChanged", screen: "build" })}
        />
        <SubmitDock
          count={selectedCount}
          canSubmit={selectedCount > 0}
          sending={false}
          hint="Choose exactly one Feishu coworker"
          label={state.selectedCoworker ? `Sync with ${state.selectedCoworker.name}` : undefined}
          footer={`${filledCount} request${filledCount > 1 ? "s" : ""} + 1 coworker ready for Bitable + Convex sync`}
          onSubmit={handleSubmit}
        />
      </>
    );
  }

  return (
    <>
      <div className="no-scrollbar flex-1 overflow-y-auto px-5 pt-1 pb-2">
        <Hero />
        <div className="space-y-3">
          <RequestCards
            values={state.notes}
            onChange={(id, value) => dispatch({ type: "noteChanged", id, value })}
          />
        </div>
      </div>

      <SubmitDock
        count={filledCount}
        canSubmit={filledCount > 0}
        sending={false}
        hint="Start a request above"
        label={filledCount > 0 ? "Continue" : undefined}
        footer="Request Types & Details"
        onSubmit={handleSubmit}
      />
    </>
  );
}
