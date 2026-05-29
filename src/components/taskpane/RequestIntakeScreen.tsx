/* eslint-disable max-lines-per-function, max-lines */
import { useCallback, useMemo, useReducer, useRef } from "react";
import { Loader2 } from "lucide-react";

import type { Coworker } from "./coworkers";
import { emailDomain, findCustomerByEmail } from "./customers";
import { initialIntakeState, intakeReducer } from "./intakeReducer";
import type { FeishuUser } from "./feishuUser";
import type { MailItemData } from "../../office/useMailItem";
import { useCustomerSearch } from "../../hooks/useCustomerSearch";
import { useRequestSync } from "../../hooks/useRequestSync";
import { useSelfForward, type SelfForwardResult } from "../../hooks/useSelfForward";
import { Button } from "../ui/button";
import { CoworkerPicker } from "./CoworkerPicker";
import { ConnectCard } from "./ConnectCard";
import { CustomerPicker } from "./CustomerPicker";
import { ReceivedScreen } from "./ReceivedScreen";
import { RequestCards } from "./RequestCards";
import { REQUESTS } from "./requests";
import { SubmitDock } from "./SubmitDock";
import { SyncScreen } from "./SyncScreen";

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

function AuthResolvingScreen() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center">
      <Loader2 className="text-muted-foreground size-6 animate-spin" aria-label="Checking Feishu session" />
    </div>
  );
}

// Terminal error screen for a failed Bitable write. "Try again" re-runs the sync
// (which corrects-in-place once a row exists, ADR-0018); "Back" returns to the
// coworker step.
function SyncErrorScreen({
  message,
  onRetry,
  onBack,
}: {
  message: string | null;
  onRetry: () => void;
  onBack: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
      <h1 className="font-serif text-2xl">Sync failed</h1>
      <p className="text-muted-foreground max-w-[34ch] text-sm leading-relaxed">
        {message ?? "Could not sync to Feishu Bitable."}
      </p>
      <div className="flex gap-2">
        <Button onClick={onRetry}>Try again</Button>
        <Button variant="secondary" onClick={onBack}>
          Back
        </Button>
      </div>
    </div>
  );
}

// The opening "build" step: the request cards + the continue dock.
function RequestBuildStep({
  notes,
  onNoteChange,
  filledCount,
  onSubmit,
}: {
  notes: Record<string, string>;
  onNoteChange: (id: string, value: string) => void;
  filledCount: number;
  onSubmit: () => void;
}) {
  return (
    <>
      <div className="no-scrollbar flex-1 overflow-y-auto px-5 pt-1 pb-2">
        <Hero />
        <div className="space-y-3">
          <RequestCards values={notes} onChange={onNoteChange} />
        </div>
      </div>
      <SubmitDock
        count={filledCount}
        canSubmit={filledCount > 0}
        sending={false}
        hint="Start a request above"
        label={filledCount > 0 ? "Continue" : undefined}
        footer="Request Types & Details"
        onSubmit={onSubmit}
      />
    </>
  );
}

export function RequestIntakeScreen({
  isLoggedIn,
  isAuthLoading = false,
  mailItem,
  sessionId,
  user,
  userAccessToken,
  onLogin,
  onLoginFallback,
}: {
  isLoggedIn: boolean;
  // True only while the Convex session query is still in flight AND we don't
  // already have a logged-in signal (real Feishu session or dev preview user).
  // Used to suppress the LoginScreen flash on returning users with cached creds.
  isAuthLoading?: boolean;
  mailItem: MailItemData;
  sessionId: string;
  // The signed-in Feishu user (the Initiator, ADR-0014). Optional because the
  // dev-preview / browser path can render the screen without a real session.
  user?: FeishuUser;
  userAccessToken?: string;
  onLogin: () => void;
  onLoginFallback: () => void;
}) {
  const { sync, correct } = useRequestSync();
  const { sendNote: sendSelfForwardNote } = useSelfForward();
  const [state, dispatch] = useReducer(intakeReducer, mailItem.from, initialIntakeState);
  // Monotonic flow id: bumped on each sync and on Start Over so a Self-Forward
  // resolving late from a previous flow can detect it is stale and skip its
  // dispatch instead of clobbering a freshly-reset chip (ADR-0018).
  const generationRef = useRef(0);

  if (state.mailFrom !== mailItem.from) {
    dispatch({ type: "mailFromChanged", mailFrom: mailItem.from });
  }

  // Customer Directory preload (ADR-0013). Non-blocking: while loading the
  // CustomerPicker shows "Resolving customer for …" and the rest of the
  // screen stays interactive. One hook bundles the directory + the per-
  // keystroke server fallback so a single vi.mock replaces both in tests.
  const {
    directory: customerDirectory,
    search: searchCustomers,
    triggerRefresh: triggerCustomerRefresh,
  } = useCustomerSearch(isLoggedIn);

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
  const requestSelections = useMemo(
    () => filledRequests.map((r) => ({ requestType: r.title, note: r.note })),
    [filledRequests],
  );
  const selectedCustomerName = state.selectedCustomer?.name;
  const filledCount = filledRequests.length;
  const selectedCount = state.selectedCoworker ? 1 : 0;
  const selectedOpenId = state.selectedCoworker?.openId;

  const selectCoworker = (coworker: Coworker) => {
    dispatch({ type: "coworkerSelected", coworker });
  };

  // Sync = (a) the Bitable write that creates the Service row + the Convex
  // Email Record, AND (b) the Self-Forward "Note to myself" copy into the
  // Initiator's own mailbox (ADR-0017). Both fire on submit; Bitable is
  // authoritative, the Self-Forward soft-fails into a retry chip.
  const fireSelfForward = useCallback(async () => {
    if (!mailItem.itemId) {
      dispatch({
        type: "selfForwardFailed",
        code: "no_item_id",
        message: "Mail Item id is unavailable (dev preview / browser host).",
      });
      return;
    }
    if (!mailItem.userEmail) {
      dispatch({
        type: "selfForwardFailed",
        code: "no_self_email",
        message: "Outlook user email is unavailable (dev preview / browser host).",
      });
      return;
    }
    // Capture the flow generation before awaiting; a late resolution from a
    // previous flow must not dispatch onto a fresh one (bug fix, ADR-0018).
    const generation = generationRef.current;
    // Activate the in-flight 'pending' chip so a retry shows "Sending Note to
    // myself…" feedback instead of staying on the failed state for the whole
    // network round-trip (previously this reducer branch was never dispatched).
    dispatch({ type: "selfForwardStarted" });
    const result: SelfForwardResult = await sendSelfForwardNote({
      originalMessageId: mailItem.itemId,
      selfEmail: mailItem.userEmail,
      customerName: selectedCustomerName,
      clientEmail: state.clientEmail,
      requestSelections,
    });
    // Ignore a resolution from a superseded flow — Start Over or a new sync bumped
    // the generation while this forward was in flight (bug fix, ADR-0018).
    if (generation === generationRef.current) {
      if (result.ok) {
        dispatch({ type: "selfForwardSucceeded" });
      } else {
        dispatch({ type: "selfForwardFailed", code: result.code, message: result.message });
      }
    }
  }, [
    sendSelfForwardNote,
    mailItem.itemId,
    mailItem.userEmail,
    selectedCustomerName,
    state.clientEmail,
    requestSelections,
  ]);

  const runSync = useCallback(() => {
    // New flow generation — invalidates any Self-Forward still in flight from a
    // prior attempt so its late resolution cannot land on this flow (ADR-0018).
    generationRef.current += 1;
    dispatch({ type: "syncStarted" });
    const payload = {
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
      initiator: user?.openId ? { openId: user.openId, name: user.userName } : undefined,
      requestSelections,
      selectedCoworkers: state.selectedCoworker ? [state.selectedCoworker] : [],
    };
    // Once this flow already created a row, a retry CORRECTS that row in place
    // (ADR-0012) rather than calling create again and orphaning a duplicate
    // Service row (the no-touch rule, bug fix ADR-0018).
    const write = state.bitableRecordId
      ? correct({ recordId: state.bitableRecordId, ...payload })
      : sync(payload);
    const bitable = write
      .then((res) => dispatch({ type: "syncSucceeded", recordId: res.recordId }))
      .catch((e: unknown) => {
        dispatch({ type: "syncFailed", message: e instanceof Error ? e.message : "Sync failed" });
      });
    // Parallel — Self-Forward never blocks the Bitable result. Don't re-send a
    // Note-to-myself that already succeeded on a previous attempt (the Graph
    // forward is non-idempotent; the ReceivedScreen chip is the re-fire path).
    if (state.selfForwardStatus !== "ok") void fireSelfForward();
    return bitable;
  }, [
    sync,
    correct,
    mailItem,
    state.clientEmail,
    state.selectedCustomer,
    state.bitableRecordId,
    state.selfForwardStatus,
    user,
    requestSelections,
    state.selectedCoworker,
    fireSelfForward,
  ]);

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
    // Bump the generation so a Self-Forward still resolving from the finished
    // flow cannot flip the fresh build screen's chip (ADR-0018).
    generationRef.current += 1;
    dispatch({ type: "startedOver" });
  };

  if (state.screen === "received") {
    return (
      <ReceivedScreen
        coworkerCount={selectedCount}
        onSyncAnother={startOver}
        selfForwardStatus={state.selfForwardStatus}
        onRetrySelfForward={fireSelfForward}
      />
    );
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
      <SyncErrorScreen
        message={state.syncError}
        onRetry={runSync}
        onBack={() => dispatch({ type: "screenChanged", screen: "coworker" })}
      />
    );
  }

  if (!isLoggedIn) {
    if (isAuthLoading) return <AuthResolvingScreen />;
    return <LoginScreen onLogin={onLogin} onLoginFallback={onLoginFallback} />;
  }

  if (state.screen === "coworker") {
    const emailDomainPart = emailDomain(state.clientEmail) ?? state.clientEmail;
    return (
      <>
        <CoworkerPicker
          clientEmail={state.clientEmail}
          onClientEmailChange={(value) => dispatch({ type: "clientEmailChanged", value })}
          customerSlot={
            <CustomerPicker
              directory={customerDirectory}
              searchCustomers={searchCustomers}
              triggerRefresh={triggerCustomerRefresh}
              emailDomain={emailDomainPart}
              selectedCustomer={state.selectedCustomer}
              currentUserOpenId={user?.openId}
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
    <RequestBuildStep
      notes={state.notes}
      onNoteChange={(id, value) => dispatch({ type: "noteChanged", id, value })}
      filledCount={filledCount}
      onSubmit={handleSubmit}
    />
  );
}
