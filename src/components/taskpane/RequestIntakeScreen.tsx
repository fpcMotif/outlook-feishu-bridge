/* eslint-disable max-lines-per-function */
import { useCallback, useMemo, useReducer, useRef, type ReactNode } from "react";

import type { Coworker } from "./coworkers";
import { initialIntakeState, intakeReducer } from "./intakeReducer";
import type { MailItemData } from "../../office/useMailItem";
import { useCustomerAutoMatch } from "../../hooks/useCustomerAutoMatch";
import { useCustomerSearch } from "../../hooks/useCustomerSearch";
import { useRequestSync } from "../../hooks/useRequestSync";
import { useSelfForward, type SelfForwardResult } from "../../hooks/useSelfForward";
import { CoworkerPicker } from "./CoworkerPicker";
import { CustomerPicker } from "./CustomerPicker";
import { RequestCards } from "./RequestCards";
import { resolveIntakeScreen } from "./RequestIntakeRouter";
import { REQUESTS } from "./requests";
import { TaskpaneSection } from "./TaskpaneSection";
import { SubmitDock } from "./SubmitDock";

const CREATE_CUSTOMER_MOCK_URL = "https://example.com/";

function buildCreateCustomerTaskUrl(customerName: string) {
  const url = new URL(CREATE_CUSTOMER_MOCK_URL);
  url.searchParams.set("task", "create-customer");
  url.searchParams.set("name", customerName);
  return url.toString();
}

function buildFilledRequests(notes: Record<string, string>) {
  return REQUESTS.flatMap((r) => {
    const note = (notes[r.id] ?? "").trim();
    return note ? [{ id: r.id, title: r.title, note }] : [];
  });
}

function Hero() {
  return (
    <header className="px-1 pt-3 pb-5">
      <h1 className="text-[34px] leading-[0.98] tracking-tight">
        Sales Services
      </h1>
    </header>
  );
}

function NewRequestSection({
  values,
  onChange,
}: {
  values: Record<string, string>;
  onChange: (id: string, value: string) => void;
}) {
  return (
    <TaskpaneSection id="new-request-title" title="New request">
      <RequestCards values={values} onChange={onChange} />
    </TaskpaneSection>
  );
}

export function RequestIntakeScreen({
  isLoggedIn,
  isAuthLoading = false,
  mailItem,
  sessionId,
  user,
  userAccessToken,
  usePreviewCoworkers = false,
  profileSlot,
  onLogin,
  onLoginFallback,
}: {
  isLoggedIn: boolean;
  // True while the Convex session query is in flight without a logged-in signal;
  // suppresses the LoginScreen flash for returning users with cached creds.
  isAuthLoading?: boolean;
  mailItem: MailItemData;
  sessionId: string;
  // The signed-in Feishu user (the Initiator, ADR-0014); optional on dev-preview.
  user?: { openId: string; userName?: string; avatarUrl?: string };
  userAccessToken?: string;
  usePreviewCoworkers?: boolean;
  profileSlot?: ReactNode;
  onLogin: () => void;
  onLoginFallback: () => void;
}) {
  const { sync, correct } = useRequestSync();
  const { sendNote: sendSelfForwardNote } = useSelfForward();
  const [state, dispatch] = useReducer(intakeReducer, mailItem.from, initialIntakeState);
  const generationRef = useRef(0);

  if (state.mailFrom !== mailItem.from) {
    dispatch({ type: "mailFromChanged", mailFrom: mailItem.from });
  }

  // Customer Directory preload (ADR-0013). Non-blocking: one hook bundles the
  // directory + per-keystroke server fallback so a single vi.mock covers both.
  const {
    directory: customerDirectory,
    search: searchCustomers,
    matchEmail: matchCustomerEmail,
    triggerRefresh: triggerCustomerRefresh,
  } = useCustomerSearch(isLoggedIn);

  const { emailDomainPart } = useCustomerAutoMatch({
    isLoggedIn,
    clientEmail: state.clientEmail,
    customerTouched: state.customerTouched,
    selectedCustomer: state.selectedCustomer,
    directory: customerDirectory,
    matchEmail: matchCustomerEmail,
    triggerRefresh: triggerCustomerRefresh,
    dispatch,
  });

  const filledRequests = useMemo(() => buildFilledRequests(state.notes), [state.notes]);
  const requestSelections = useMemo(() => filledRequests.map((r) => ({ requestType: r.title, note: r.note })), [filledRequests]);
  const selectedCustomerName = state.selectedCustomer?.name;
  const filledCount = filledRequests.length;
  const selectedCount = state.selectedCoworker ? 1 : 0;
  const selectedOpenId = state.selectedCoworker?.openId;

  const selectCoworker = (coworker: Coworker) => {
    dispatch({ type: "coworkerSelected", coworker });
  };

  const openCreateCustomerMock = useCallback((customerName: string) => {
    window.open(buildCreateCustomerTaskUrl(customerName), "_blank", "noopener,noreferrer");
  }, []);

  // Sync fires (a) the Base write (Service row + Convex Email Record) and (b)
  // the Self-Forward "Note to myself" copy (ADR-0017). Base is authoritative;
  // the Self-Forward soft-fails into a retry chip.
  const fireSelfForward = useCallback(async () => {
    const generation = generationRef.current;
    dispatch({ type: "selfForwardStarted" });
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
    const result: SelfForwardResult = await sendSelfForwardNote({
      originalMessageId: mailItem.itemId,
      selfEmail: mailItem.userEmail,
      customerName: selectedCustomerName,
      clientEmail: state.clientEmail,
      requestSelections,
    });
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
    const write = state.bitableRecordId ? correct({ recordId: state.bitableRecordId, ...payload }) : sync(payload);
    const baseWrite = write
      .then((result) => dispatch({ type: "syncSucceeded", recordId: result.recordId }))
      .catch((e: unknown) => {
        dispatch({ type: "syncFailed", message: e instanceof Error ? e.message : "Sync failed" });
      });
    // Parallel — Self-Forward never blocks the Base result (retry chip on fail).
    if (state.selfForwardStatus !== "ok") void fireSelfForward();
    return baseWrite;
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
    if (filledCount === 0 || selectedCount === 0) return;
    runSync();
  };

  const overlay = resolveIntakeScreen({
    screen: state.screen,
    isLoggedIn,
    isAuthLoading,
    coworkerCount: selectedCount,
    selfForwardStatus: state.selfForwardStatus,
    syncError: state.syncError,
    clientEmail: state.clientEmail,
    filledRequests,
    onRetrySelfForward: fireSelfForward,
    onRetrySync: runSync,
    onBackToBuild: () => dispatch({ type: "screenChanged", screen: "build" }),
    onLogin,
    onLoginFallback,
  });
  if (overlay) return overlay;

  const readyToSync = filledCount > 0 && selectedCount > 0;
  const submitHint = filledCount === 0 ? "Start a request above" : "Choose exactly one Feishu coworker";
  const submitFooter = readyToSync
    ? `${filledCount} request${filledCount > 1 ? "s" : ""} + 1 coworker ready for Base + Convex sync`
    : "";

  return (
    <>
      <div className="no-scrollbar relative flex-1 overflow-y-auto px-5 pt-0 pb-24">
        {profileSlot}
        <Hero />
        <div className="space-y-5">
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
                embedded={true}
                onChange={(customer) => dispatch({ type: "customerOverridden", customer })}
                onCreateCustomer={openCreateCustomerMock}
              />
            }
            sessionId={sessionId}
            userAccessToken={userAccessToken}
            selectedOpenId={selectedOpenId}
            onSelect={selectCoworker}
            usePreviewCoworkers={usePreviewCoworkers}
          />
          <NewRequestSection
            values={state.notes}
            onChange={(id, value) => dispatch({ type: "noteChanged", id, value })}
          />
        </div>
      </div>

      <SubmitDock
        count={readyToSync ? filledCount : 0}
        canSubmit={readyToSync}
        sending={false}
        hint={submitHint}
        label={readyToSync && state.selectedCoworker ? `Sync with ${state.selectedCoworker.name}` : undefined}
        footer={submitFooter}
        onSubmit={handleSubmit}
      />
    </>
  );
}
