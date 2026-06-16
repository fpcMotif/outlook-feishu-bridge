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
import { useIntakeAttachments } from "./useIntakeAttachments";
import { useSyncOrchestration } from "./useSyncOrchestration";
import {
  buildUploadDraftKey,
  clearUploadDraft,
  restoreUploadDraft,
  snapshotUploadDraft,
} from "./uploadDraftCache";
import type { RequestIntakeScreenProps } from "./requestIntakeScreenProps";
import type { RequestIntakeSyncApi } from "./requestIntakeSyncApi";

function salesDefaultForUser(
  user: RequestIntakeScreenProps["user"],
): Coworker | null {
  return user?.openId
    ? {
        openId: user.openId,
        name: user.userName ?? "You",
        avatarUrl: user.avatarUrl,
      }
    : null;
}

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
  const defaultSales = useMemo(
    () => salesDefaultForUser(user),
    [user],
  );

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
      defaultSales,
    },
    ({
      intakeDraftKey: key,
      mailFrom,
      restoredUploads,
      defaultSales: restoredDefaultSales,
    }) => loadIntakeDraft(key, mailFrom, restoredUploads, restoredDefaultSales),
  );
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
  const mailAttachmentIds = useMemo(
    () => mailAttachments.map((attachment) => attachment.id),
    [mailAttachments],
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

  // The full Base Sync pipeline (generation guards, phase milestones, latency
  // spans, draft teardown) lives in its own hook so this one stays an assembly
  // point. It reconciles the authoritative query internally via its own effect.
  const { runSync, draftClearedRef } = useSyncOrchestration({
    dispatch,
    sync,
    stageSelected,
    mailItem,
    state,
    user,
    requestNote,
    uploadDraftKey,
    intakeDraftKey,
    existingSync,
    existingSyncStatus,
  });

  useEffect(() => {
    if (!defaultSales) return;
    dispatch({ type: "salesDefaulted", sales: defaultSales });
  }, [defaultSales]);

  useEffect(() => {
    if (mailAttachmentIds.length === 0) return;
    dispatch({
      type: "mailAttachmentsDiscovered",
      ids: mailAttachmentIds,
    });
  }, [mailAttachmentIds]);

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
    runSync,
    handleSubmit,
  };
}

export type RequestIntakeScreenViewModel = ReturnType<typeof useRequestIntakeScreen>;
