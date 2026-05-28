/* eslint-disable max-lines-per-function */
import { useCallback, useMemo, useReducer } from "react";

import type { Contact } from "@/forward/targets";
import type { MailItemData } from "../../office/useMailItem";
import { useRequestSync } from "../../hooks/useRequestSync";
import { Button } from "../ui/button";
import { CoworkerPicker } from "./CoworkerPicker";
import { ConnectCard } from "./ConnectCard";
import { ReceivedScreen } from "./ReceivedScreen";
import { RequestCards } from "./RequestCards";
import { REQUESTS } from "./requests";
import { SubmitDock } from "./SubmitDock";
import { SyncScreen } from "./SyncScreen";

type ForwardScreenName = "build" | "contacts" | "sync" | "received" | "error";

interface ForwardState {
  notes: Record<string, string>;
  clientEmail: string;
  mailFrom: string;
  screen: ForwardScreenName;
  selectedCoworker: Contact | null;
  syncError: string | null;
}

type ForwardAction =
  | { type: "mailFromChanged"; mailFrom: string }
  | { type: "noteChanged"; id: string; value: string }
  | { type: "clientEmailChanged"; value: string }
  | { type: "screenChanged"; screen: ForwardScreenName }
  | { type: "coworkerSelected"; contact: Contact }
  | { type: "syncStarted" }
  | { type: "syncSucceeded" }
  | { type: "syncFailed"; message: string }
  | { type: "startedOver" };

function initialForwardState(mailFrom: string): ForwardState {
  return {
    notes: {},
    clientEmail: mailFrom,
    mailFrom,
    screen: "build",
    selectedCoworker: null,
    syncError: null,
  };
}

function forwardReducer(state: ForwardState, action: ForwardAction): ForwardState {
  switch (action.type) {
    case "mailFromChanged":
      return { ...state, clientEmail: action.mailFrom, mailFrom: action.mailFrom };
    case "noteChanged":
      return { ...state, notes: { ...state.notes, [action.id]: action.value } };
    case "clientEmailChanged":
      return { ...state, clientEmail: action.value };
    case "screenChanged":
      return { ...state, screen: action.screen };
    case "coworkerSelected":
      return { ...state, selectedCoworker: action.contact };
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

export function ForwardScreen({
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
  const [state, dispatch] = useReducer(forwardReducer, mailItem.from, initialForwardState);

  if (state.mailFrom !== mailItem.from) {
    dispatch({ type: "mailFromChanged", mailFrom: mailItem.from });
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

  const selectCoworker = (contact: Contact) => {
    dispatch({ type: "coworkerSelected", contact });
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
      requestSelections: filledRequests.map((r) => ({ requestType: r.title, note: r.note })),
      selectedCoworkers: state.selectedCoworker ? [state.selectedCoworker] : [],
    })
      .then(() => dispatch({ type: "syncSucceeded" }))
      .catch((e: unknown) => {
        dispatch({ type: "syncFailed", message: e instanceof Error ? e.message : "Sync failed" });
      });
  }, [sync, mailItem, state.clientEmail, filledRequests, state.selectedCoworker]);

  const handleSubmit = () => {
    if (state.screen === "build") {
      if (filledCount === 0) return;
      dispatch({ type: "screenChanged", screen: "contacts" });
      return;
    }
    if (selectedCount === 0) return;
    runSync();
  };

  const startOver = () => {
    dispatch({ type: "startedOver" });
  };

  if (state.screen === "received") {
    return <ReceivedScreen coworkerCount={selectedCount} onForwardAnother={startOver} />;
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
          <Button variant="secondary" onClick={() => dispatch({ type: "screenChanged", screen: "contacts" })}>
            Back
          </Button>
        </div>
      </div>
    );
  }

  if (!isLoggedIn) {
    return <LoginScreen onLogin={onLogin} onLoginFallback={onLoginFallback} />;
  }

  if (state.screen === "contacts") {
    return (
      <>
        <CoworkerPicker
          clientEmail={state.clientEmail}
          onClientEmailChange={(value) => dispatch({ type: "clientEmailChanged", value })}
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
