/* eslint-disable max-lines, max-lines-per-function */
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";

import type { Coworker } from "./coworkers";
import { intakeReducer } from "./intakeReducer";
import {
  buildIntakeDraftKey,
  clearIntakeDraft,
  loadIntakeDraft,
  rememberIntakeDraft,
} from "./intakeDraftCache";
import { useCustomerAutoMatch } from "../../hooks/useCustomerAutoMatch";
import { useCustomerSearch } from "../../hooks/useCustomerSearch";
import { useSelfForward, type SelfForwardResult } from "../../hooks/useSelfForward";
import { buildCreateCustomerTaskUrl } from "./buildCreateCustomerTaskUrl";
import {
  buildFilledRequests,
  canSubmitSync,
  submitSyncHint,
  uploadGateState,
} from "./submitSyncGate";
import {
  buildSyncPreviewNotes,
  selectedAttachmentsForPreview,
  type SyncPreviewPayload,
} from "./syncPreviewModel";
import { buildSyncPayload } from "./buildSyncPayload";
import { dlog, dtime } from "../../debug";
import { useIntakeAttachments } from "./useIntakeAttachments";
import { scheduleSalesDefault } from "./scheduleSalesDefault";
import {
  buildUploadDraftKey,
  clearUploadDraft,
  restoreUploadDraft,
  snapshotUploadDraft,
} from "./uploadDraftCache";
import type { RequestIntakeScreenProps } from "./requestIntakeScreenProps";
import type { RequestIntakeSyncApi } from "./requestIntakeSyncApi";

export function useRequestIntakeScreen(
  props: RequestIntakeScreenProps & { mailKey: string; syncApi: RequestIntakeSyncApi },
) {
  const {
    isLoggedIn,
    mailItem,
    sessionId,
    user,
    userAccessToken,
    usePreviewCoworkers = false,
    devPreview = false,
    mockUploads,
    mockStagingDeps,
    mailKey,
    syncApi,
  } = props;
  const { sync, existingSync } = syncApi;
  const existingSyncStatus = existingSync?.status ?? null;
  const { sendNote: sendSelfForwardNote } = useSelfForward();

  // Per-conversation draft restore for pinned panes: the Core is keyed by
  // mailKey, so this lazy initializer runs ONCE per conversation mount. The full
  // intake cache restores selections/notes; uploadDraftCache remains the safe
  // fallback for completed storageIds pre-seeded by older snapshots/tests.
  const uploadDraftKey = useMemo(
    () => buildUploadDraftKey(user?.openId, mailItem.userEmail, mailItem.conversationId),
    [user?.openId, mailItem.userEmail, mailItem.conversationId],
  );
  const intakeDraftKey = useMemo(
    () => buildIntakeDraftKey(user?.openId, mailItem.userEmail, mailKey),
    [user?.openId, mailItem.userEmail, mailKey],
  );
  const [state, dispatch] = useReducer(
    intakeReducer,
    {
      intakeDraftKey,
      mailFrom: mailItem.from,
      // DEV-only "constra mode" (?mock=): seed fixture uploads through the same
      // run-once lazy-initializer channel production restore uses, so the failed/
      // retry/re-add UI renders in `bun run dev` with no Office host or network.
      restoredUploads:
        import.meta.env.DEV && mockUploads
          ? mockUploads
          : restoreUploadDraft(uploadDraftKey),
    },
    ({ intakeDraftKey: key, mailFrom, restoredUploads }) =>
      loadIntakeDraft(key, mailFrom, restoredUploads),
  );
  const generationRef = useRef(0);
  const activeSyncGenerationRef = useRef<number | null>(null);
  const draftClearedRef = useRef(false);

  // Kept current each render so the unmount-cleanup effect snapshots the LEAVING
  // conversation's FRESH state. It reads reducer state (including selected
  // Sales/customer/coworker/notes and upload storageIds), NOT completedStorage —
  // the parent already cleared the per-id caches by unmount time.
  const stateForDraftRef = useRef(state);
  stateForDraftRef.current = state;
  const uploadDraftKeyRef = useRef(uploadDraftKey);
  uploadDraftKeyRef.current = uploadDraftKey;
  const intakeDraftKeyRef = useRef(intakeDraftKey);
  intakeDraftKeyRef.current = intakeDraftKey;
  const screenRef = useRef(state.screen);
  screenRef.current = state.screen;

  // An email switch is driven by the per-conversation React key on this component
  // (see deriveMailKey / RequestIntakeScreen): moving to a new conversation
  // remounts and loads that conversation's draft (or a fresh state); returning to
  // a previous conversation restores its memoized selections. This guard is the
  // only within-thread adjustment: a sibling message from a different sender
  // refreshes the customer auto-match to the new domain.
  if (state.mailFrom !== mailItem.from) {
    dispatch({ type: "mailFromChanged", mailFrom: mailItem.from });
  }

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

  const {
    mailAttachments,
    addFiles,
    retryUpload,
    retryAllUploads,
    replaceUpload,
    stageSelected,
  } = useIntakeAttachments(
    mailItem,
    state,
    dispatch,
    import.meta.env.DEV ? mockStagingDeps : undefined,
  );

  const filledRequests = useMemo(() => buildFilledRequests(state.notes), [state.notes]);
  const selectedCustomerName = state.selectedCustomer?.name;
  const selectedAttachmentIds = state.selectedAttachmentIds;
  const uploadedFiles = state.uploadedFiles;
  const syncPreview = useMemo((): SyncPreviewPayload => {
    return {
      customerLabel: selectedCustomerName,
      notes: buildSyncPreviewNotes(filledRequests),
      attachments: selectedAttachmentsForPreview(mailAttachments, {
        selectedAttachmentIds,
        uploadedFiles,
      }),
    };
  }, [selectedCustomerName, selectedAttachmentIds, uploadedFiles, filledRequests, mailAttachments]);
  const requestSelections = useMemo(
    () => filledRequests.map((r) => ({ requestType: r.title, note: r.note })),
    [filledRequests],
  );
  const requestNote = useMemo(() => filledRequests.map((r) => r.note).join("\n\n"), [filledRequests]);
  const filledCount = filledRequests.length;
  const selectedCount = state.selectedCoworker ? 1 : 0;

  const { uploadsInFlight, uploadsParked } = uploadGateState(uploadedFiles);
  const syncGate = {
    hasCustomer: state.selectedCustomer !== null,
    hasCoworker: state.selectedCoworker !== null,
    fulfilledRequestCount: filledCount,
    devPreview,
    selectedCoworkerOpenId: state.selectedCoworker?.openId ?? null,
    uploadsInFlight,
    uploadsParked,
  };

  useEffect(() => {
    if (!user?.openId) return;
    return scheduleSalesDefault(() => {
      dispatch({
        type: "salesDefaulted",
        sales: {
          openId: user.openId,
          name: user.userName ?? "You",
          avatarUrl: user.avatarUrl,
        },
      });
    });
  }, [user?.openId, user?.userName, user?.avatarUrl]);

  // On unmount (conversation switch on a pinned pane) snapshot this conversation
  // so returning restores the Sales/customer/coworker/notes/attachments. If it
  // was already synced ("received"), CLEAR instead — its storageIds are consumed
  // server-side after a successful sync, so a restored draft would point at dead
  // blobs.
  // eslint-disable-next-line react-doctor/exhaustive-deps -- unmount-only cleanup reading stable refs (draft snapshot); refs are intentionally excluded from deps
  useEffect(() => {
    return () => {
      const uploadKey = uploadDraftKeyRef.current;
      const intakeKey = intakeDraftKeyRef.current;
      if (draftClearedRef.current || screenRef.current === "received") {
        clearUploadDraft(uploadKey);
        clearIntakeDraft(intakeKey);
      } else {
        const latestState = stateForDraftRef.current;
        snapshotUploadDraft(uploadKey, latestState.uploadedFiles);
        // A draft restores into the editable build screen only. The overlay
        // screens (sync/error) are transient: an in-flight sync's success
        // dispatch is a no-op once this Core unmounts, so persisting
        // screen:"sync" would resurrect a DEAD sync overlay on return that
        // never advances — and, because the authoritative synced state can only
        // repaint when screen==="build" (resolveExistingSyncOverlay) or when a
        // local sync generation is active (applyExistingSyncUpdate), the pane
        // would be stuck forever. Normalize back to build so return shows the
        // Received overlay (server synced) or the editable build pane.
        rememberIntakeDraft(intakeKey, {
          ...latestState,
          screen: "build",
          syncError: null,
        });
      }
    };
  }, []);

  const selectCoworker = (coworker: Coworker) => {
    dispatch({ type: "coworkerSelected", coworker });
  };

  const selectSales = (sales: Coworker) => {
    dispatch({ type: "salesSelected", sales });
  };

  const openCreateCustomerMock = useCallback((customerName: string) => {
    window.open(buildCreateCustomerTaskUrl(customerName), "_blank", "noopener,noreferrer");
  }, []);

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
    const syncGeneration = generationRef.current + 1;
    generationRef.current = syncGeneration;
    activeSyncGenerationRef.current = syncGeneration;
    dispatch({ type: "syncStarted" });
    // Upload-latency trace: stamp the click (epoch for server correlation, perf
    // for the client span) and mint a trace id threaded through syncRequest so the
    // server [fillTotal] log can join this click to the deferred fill's fence.
    const submitClickedAt = Date.now();
    const syncTraceId = globalThis.crypto.randomUUID();
    const clickPerf = performance.now();
    dlog(`[intake] submit click trace=${syncTraceId}`);
    const payload = buildSyncPayload(mailItem, state, user, requestNote);
    const baseWrite = stageSelected()
      .then((staged) => {
        if (staged.failed.length > 0) {
          console.warn(
            `[intake] skipped ${staged.failed.length} attachment(s): ${staged.failed.map((f) => f.name).join(", ")}`,
          );
        }
        // Hand the staged Convex storageIds straight to syncRequest; the row is
        // created with an empty Sales Files cell and the deferred Attachment Fill
        // writes the files server-side (ADR-0027), so submit never blocks on the
        // serial Drive uploads. Staging already finished above — the only wait.
        return sync({
          ...payload,
          attachmentSources: staged.sources,
          syncTraceId,
          submitClickedAt,
        });
      })
      .then((result) => {
        if (activeSyncGenerationRef.current !== syncGeneration || !result.recordId) return;
        activeSyncGenerationRef.current = null;
        // Client-observed leg: click → row created/visible. The attachment-fill
        // tail runs server-side after this; the server [fillTotal] log closes the
        // full click→fully-written span under the same trace id.
        dtime(`intake submit→row (trace ${syncTraceId})`, clickPerf);
        dispatch({
          type: "syncSucceeded",
          recordId: result.recordId,
          detailUrl: result.detailUrl ?? null,
        });
        // The staged blobs are deleted server-side after a successful Drive mint,
        // so this conversation's cached storageIds are now dead — drop the draft.
        draftClearedRef.current = true;
        clearUploadDraft(uploadDraftKey);
        clearIntakeDraft(intakeDraftKey);
      })
      .catch((e: unknown) => {
        if (activeSyncGenerationRef.current !== syncGeneration) return;
        activeSyncGenerationRef.current = null;
        dispatch({ type: "syncFailed", message: e instanceof Error ? e.message : "Sync failed" });
      });
    if (state.selfForwardStatus !== "ok") void fireSelfForward();
    return baseWrite;
  }, [
    sync,
    mailItem,
    state,
    user,
    requestNote,
    fireSelfForward,
    stageSelected,
    uploadDraftKey,
    intakeDraftKey,
  ]);

  const applyExistingSyncUpdate = useCallback(() => {
    if (activeSyncGenerationRef.current === null) return;
    if (existingSyncStatus === "synced" && existingSync?.recordId) {
      activeSyncGenerationRef.current = null;
      dispatch({
        type: "syncSucceeded",
        recordId: existingSync.recordId,
        detailUrl: existingSync.detailUrl ?? null,
      });
      return;
    }
    if (existingSyncStatus === "failed") {
      activeSyncGenerationRef.current = null;
      dispatch({
        type: "syncFailed",
        message: existingSync?.error ?? "Could not sync to Feishu Base.",
      });
    }
  }, [
    existingSync?.detailUrl,
    existingSync?.error,
    existingSync?.recordId,
    existingSyncStatus,
  ]);

  useEffect(() => {
    applyExistingSyncUpdate();
  }, [
    applyExistingSyncUpdate,
  ]);

  useEffect(() => {
    if (existingSyncStatus !== "synced" || !existingSync?.recordId) return;
    draftClearedRef.current = true;
    clearUploadDraft(uploadDraftKey);
    clearIntakeDraft(intakeDraftKey);
  }, [existingSync?.recordId, existingSyncStatus, uploadDraftKey, intakeDraftKey]);

  const handleSubmit = () => {
    if (!canSubmitSync(syncGate)) return;
    runSync();
  };

  const readyToSync = canSubmitSync(syncGate);
  const submitHint = submitSyncHint(syncGate);

  return {
    props,
    state,
    dispatch,
    sessionId,
    user,
    userAccessToken,
    usePreviewCoworkers,
    devPreview,
    customerDirectory,
    searchCustomers,
    triggerCustomerRefresh,
    emailDomainPart,
    mailAttachments,
    addFiles,
    retryUpload,
    retryAllUploads,
    replaceUpload,
    filledRequests,
    syncPreview,
    filledCount,
    selectedCount,
    existingSync,
    existingSyncStatus,
    syncGate,
    readyToSync,
    submitHint,
    selectCoworker,
    selectSales,
    openCreateCustomerMock,
    fireSelfForward,
    runSync,
    handleSubmit,
  };
}

export type RequestIntakeScreenViewModel = ReturnType<typeof useRequestIntakeScreen>;
