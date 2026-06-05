import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";

import type { Coworker } from "./coworkers";
import { initialIntakeState, intakeReducer } from "./intakeReducer";
import { useCustomerAutoMatch } from "../../hooks/useCustomerAutoMatch";
import { useCustomerSearch } from "../../hooks/useCustomerSearch";
import { useSelfForward, type SelfForwardResult } from "../../hooks/useSelfForward";
import { buildCreateCustomerTaskUrl } from "./buildCreateCustomerTaskUrl";
import { buildFilledRequests, canSubmitSync, submitSyncHint } from "./submitSyncGate";
import {
  buildSyncPreviewNotes,
  selectedAttachmentsForPreview,
  type SyncPreviewPayload,
} from "./syncPreviewModel";
import { buildSyncPayload } from "./buildSyncPayload";
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
  props: RequestIntakeScreenProps & { syncApi: RequestIntakeSyncApi },
) {
  const {
    isLoggedIn,
    mailItem,
    sessionId,
    user,
    userAccessToken,
    usePreviewCoworkers = false,
    devPreview = false,
    syncApi,
  } = props;
  const { sync, existingSync } = syncApi;
  const existingSyncStatus = existingSync?.status ?? null;
  const { sendNote: sendSelfForwardNote } = useSelfForward();

  // Per-conversation upload-draft restore (ADR-0022): keyed by Feishu openId +
  // Outlook userEmail + conversationId. The Core is keyed by mailKey, so this lazy
  // initializer runs ONCE per conversation mount and rehydrates that
  // conversation's previously-cached completed uploads — StrictMode-safe (a
  // dispatch would double-append).
  const draftKey = useMemo(
    () => buildUploadDraftKey(user?.openId, mailItem.userEmail, mailItem.conversationId),
    [user?.openId, mailItem.userEmail, mailItem.conversationId],
  );
  const [state, dispatch] = useReducer(intakeReducer, draftKey, (key) =>
    initialIntakeState({ mailFrom: mailItem.from, restoredUploads: restoreUploadDraft(key) }),
  );
  const generationRef = useRef(0);
  const activeSyncGenerationRef = useRef<number | null>(null);

  // Kept current each render so the unmount-cleanup effect snapshots the LEAVING
  // conversation's FRESH state. It reads reducer state (which carries storageId on
  // completed uploads), NOT completedStorage — the parent already cleared the
  // per-id caches by unmount time.
  const uploadsForDraftRef = useRef(state.uploadedFiles);
  uploadsForDraftRef.current = state.uploadedFiles;
  const draftKeyRef = useRef(draftKey);
  draftKeyRef.current = draftKey;
  const screenRef = useRef(state.screen);
  screenRef.current = state.screen;

  // A clean-slate reset on an email switch is driven by the per-conversation React
  // key on this component (see deriveMailKey / RequestIntakeScreen): moving to a
  // different conversation remounts and re-seeds this reducer, resetting notes,
  // Sales, customer, attachments, and the sync screen. Sales is conversation-scoped
  // like the rest of the request — within one thread there is no remount, so a
  // reassigned Sales survives reading sibling replies before sync (ADR-0025). This
  // guard is the only within-thread adjustment: a sibling message from a different
  // sender refreshes the customer auto-match to the new domain. After a remount it
  // is a harmless no-op (fresh state already seeds mailFrom).
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

  const { mailAttachments, addFiles, retryUpload, stageSelected } =
    useIntakeAttachments(mailItem, state, dispatch);

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

  const syncGate = {
    hasCustomer: state.selectedCustomer !== null,
    hasCoworker: state.selectedCoworker !== null,
    fulfilledRequestCount: filledCount,
    devPreview,
    selectedCoworkerOpenId: state.selectedCoworker?.openId ?? null,
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

  // On unmount (conversation switch on a pinned pane) snapshot this conversation's
  // completed uploads so returning restores them. If it was already synced
  // ("received"), CLEAR instead — its storageIds are consumed/deleted server-side
  // after a successful sync, so a restored draft would point at dead blobs.
  useEffect(() => {
    return () => {
      const key = draftKeyRef.current;
      if (screenRef.current === "received") {
        clearUploadDraft(key);
      } else {
        snapshotUploadDraft(key, uploadsForDraftRef.current);
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
    const payload = buildSyncPayload(mailItem, state, user, requestNote);
    const baseWrite = stageSelected()
      .then((staged) => {
        if (staged.failed.length > 0) {
          console.warn(
            `[intake] skipped ${staged.failed.length} attachment(s): ${staged.failed.map((f) => f.name).join(", ")}`,
          );
        }
        return sync({ ...payload, attachments: staged.attachments });
      })
      .then((result) => {
        if (activeSyncGenerationRef.current !== syncGeneration || !result.recordId) return;
        activeSyncGenerationRef.current = null;
        dispatch({
          type: "syncSucceeded",
          recordId: result.recordId,
          detailUrl: result.detailUrl ?? null,
        });
        // The staged blobs are deleted server-side after a successful Drive mint,
        // so this conversation's cached storageIds are now dead — drop the draft.
        clearUploadDraft(draftKey);
      })
      .catch((e: unknown) => {
        if (activeSyncGenerationRef.current !== syncGeneration) return;
        activeSyncGenerationRef.current = null;
        dispatch({ type: "syncFailed", message: e instanceof Error ? e.message : "Sync failed" });
      });
    if (state.selfForwardStatus !== "ok") void fireSelfForward();
    return baseWrite;
  }, [sync, mailItem, state, user, requestNote, fireSelfForward, stageSelected, draftKey]);

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
