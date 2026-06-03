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
import { ReceivedScreen } from "./ReceivedScreen";
import { buildCreateCustomerTaskUrl } from "./buildCreateCustomerTaskUrl";
import { ExistingSyncCheckingScreen } from "./ExistingSyncCheckingScreen";
import { IntakeHeader } from "./RequestIntakeScaffold";
import { NewRequestSection } from "./NewRequestSection";
import { resolveIntakeScreen } from "./RequestIntakeRouter";
import { SubmitDock } from "./SubmitDock";
import { buildFilledRequests, canSubmitSync, submitSyncHint } from "./submitSyncGate";
import { AttachmentSection } from "./AttachmentSection";
import { buildSyncPayload } from "./buildSyncPayload";
import { useIntakeAttachments } from "./useIntakeAttachments";
import { clearIntakeUploadCache } from "./uploadIntakeFile";

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
  const { sync, existingSync } = useRequestSync({
    userEmail: mailItem.userEmail,
    conversationId: mailItem.conversationId,
    enabled: isLoggedIn,
  });
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
  } = useCustomerSearch(isLoggedIn, usePreviewCoworkers);

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

  const { mailAttachments, addFiles, retryUpload, stageSelected } =
    useIntakeAttachments(mailItem, state, dispatch);

  const filledRequests = useMemo(() => buildFilledRequests(state.notes), [state.notes]);
  const requestSelections = useMemo(() => filledRequests.map((r) => ({ requestType: r.title, note: r.note })), [filledRequests]);
  // ADR-0022: the Base sync now takes ONE consolidated note. (requestSelections
  // above is retained only for the Self-Forward "note to myself" preamble.)
  const requestNote = useMemo(() => filledRequests.map((r) => r.note).join("\n\n"), [filledRequests]);
  const selectedCustomerName = state.selectedCustomer?.name;
  const filledCount = filledRequests.length;
  const selectedCount = state.selectedCoworker ? 1 : 0;

  // Submit dock enablement: customer ∧ coworker ∧ ≥1 fulfilled request (ADR-0020).
  const syncGate = {
    hasCustomer: state.selectedCustomer !== null,
    hasCoworker: state.selectedCoworker !== null,
    fulfilledRequestCount: filledCount,
  };

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
    const payload = buildSyncPayload(mailItem, state, user, requestNote);
    // ADR-0022: stage the selected mail attachments + uploads to Feishu Drive and
    // ride the minted file_tokens into the create. Best-effort — failed files are
    // logged and skipped, never blocking the authoritative Base write.
    const baseWrite = stageSelected()
      .then((staged) => {
        if (staged.failed.length > 0) {
          console.warn(
            `[intake] skipped ${staged.failed.length} attachment(s): ${staged.failed.map((f) => f.name).join(", ")}`,
          );
        }
        return sync({ ...payload, attachments: staged.attachments });
      })
      .then((result) =>
        dispatch({
          type: "syncSucceeded",
          recordId: result.recordId,
          detailUrl: result.detailUrl ?? null,
        }),
      )
      .catch((e: unknown) => {
        dispatch({ type: "syncFailed", message: e instanceof Error ? e.message : "Sync failed" });
      });
    // Parallel — Self-Forward never blocks the Base result (retry chip on fail).
    if (state.selfForwardStatus !== "ok") void fireSelfForward();
    return baseWrite;
  }, [sync, mailItem, state, user, requestNote, fireSelfForward, stageSelected]);

  const handleSubmit = () => {
    if (!canSubmitSync(syncGate)) return;
    runSync();
  };

  const overlay = resolveIntakeScreen({
    screen: state.screen,
    isLoggedIn,
    isAuthLoading,
    coworkerCount: selectedCount,
    selfForwardStatus: state.selfForwardStatus,
    syncError: state.syncError,
    bitableRecordId: state.bitableRecordId,
    bitableDetailUrl: state.bitableDetailUrl,
    filledRequests,
    onRetrySelfForward: fireSelfForward,
    onRetrySync: runSync,
    onBackToBuild: () => dispatch({ type: "screenChanged", screen: "build" }),
    onLogin,
    onLoginFallback,
  });
  // Auth + flow overlays (login, sync, received, error) win over Convex lookups so
  // a loading existing-sync query never masks the login surface or sync progress.
  if (overlay) return overlay;
  // Only short-circuit the builder when Convex already has a row for this
  // conversation. A fresh sync sets screen to "received" — keep the overlay so
  // the success copy and Self-Forward chip do not flash to "Already synced".
  if (existingSync?.recordId && state.screen === "build") {
    return (
      <ReceivedScreen
        coworkerCount={existingSync.coworkerCount ?? 1}
        recordId={existingSync.recordId}
        detailUrl={existingSync.detailUrl}
        submittedAt={existingSync.syncedAt}
        alreadySynced={true}
      />
    );
  }
  if (
    isLoggedIn &&
    existingSync === undefined &&
    mailItem.userEmail &&
    mailItem.conversationId
  ) {
    return <ExistingSyncCheckingScreen />;
  }

  const readyToSync = canSubmitSync(syncGate);
  const submitHint = submitSyncHint(syncGate);

  return (
    <>
      <div className="no-scrollbar relative flex-1 overflow-y-auto px-5 pt-1 pb-[calc(8rem+1.5rem)]">
        <IntakeHeader profileSlot={profileSlot} />
        <div className="space-y-7">
          <CoworkerPicker
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
            selectedCoworker={state.selectedCoworker}
            onSelect={selectCoworker}
            usePreviewCoworkers={usePreviewCoworkers}
          />
          <NewRequestSection
            values={state.notes}
            onChange={(id, value) => dispatch({ type: "noteChanged", id, value })}
          />
          <AttachmentSection
            mailAttachments={mailAttachments}
            selectedIds={state.selectedAttachmentIds}
            uploadedFiles={state.uploadedFiles}
            onToggleMail={(id) => dispatch({ type: "attachmentToggled", id })}
            onRemoveMail={(id) =>
              dispatch({ type: "mailAttachmentRemoved", id })
            }
            onToggleUpload={(id) => dispatch({ type: "uploadedFileToggled", id })}
            onSetUploadedSelection={(ids) =>
              dispatch({ type: "uploadedFilesSelectionChanged", ids })
            }
            onAddFiles={addFiles}
            onRetryUpload={retryUpload}
            onRemoveUpload={(id) => {
              clearIntakeUploadCache(id);
              dispatch({ type: "uploadedFileRemoved", id });
            }}
          />
        </div>
      </div>

      <SubmitDock
        count={readyToSync ? filledCount : 0}
        canSubmit={readyToSync}
        sending={false}
        hint={submitHint}
        label={readyToSync && state.selectedCoworker ? `Sync with ${state.selectedCoworker.name}` : undefined}
        onSubmit={handleSubmit}
      />
    </>
  );
}
