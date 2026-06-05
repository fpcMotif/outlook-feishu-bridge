import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";

import type { Id } from "../../../convex/_generated/dataModel";
import type { Coworker } from "./coworkers";
import { intakeReducer } from "./intakeReducer";
import { loadIntakeDraft, rememberIntakeDraft } from "./intakeDraftCache";
import { useCustomerAutoMatch } from "../../hooks/useCustomerAutoMatch";
import { useCustomerSearch } from "../../hooks/useCustomerSearch";
import { useSelfForward, type SelfForwardResult } from "../../hooks/useSelfForward";
import { dtime } from "../../debug";
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
import type { RequestIntakeScreenProps } from "./requestIntakeScreenProps";
import type { RequestIntakeSyncApi } from "./requestIntakeSyncApi";
import type { UploadedFile } from "./intakeReducer";

function hasPendingSelectedUploads(uploadedFiles: UploadedFile[]): boolean {
  return uploadedFiles.some((file) => {
    if (file.rejection !== null || !file.selected || file.status === "error") {
      return false;
    }
    return file.status !== "complete" || !file.storageId;
  });
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
    mailKey,
    syncApi,
  } = props;
  const { sync, existingSync } = syncApi;
  const existingSyncStatus = existingSync?.status ?? null;
  const { sendNote: sendSelfForwardNote } = useSelfForward();
  const [state, dispatch] = useReducer(
    intakeReducer,
    { mailKey, mailFrom: mailItem.from },
    ({ mailKey: key, mailFrom }) => loadIntakeDraft(key, mailFrom),
  );
  const generationRef = useRef(0);
  const activeSyncGenerationRef = useRef<number | null>(null);
  const submitToReceivedStartedRef = useRef<number | null>(null);

  if (state.mailFrom !== mailItem.from) {
    dispatch({ type: "mailFromChanged", mailFrom: mailItem.from });
  }

  useEffect(() => {
    rememberIntakeDraft(mailKey, state);
  }, [mailKey, state]);

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
    hasPendingSelectedUploads: hasPendingSelectedUploads(state.uploadedFiles),
    bodyPending: mailItem.bodyPending === true,
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
    submitToReceivedStartedRef.current = performance.now();
    dispatch({ type: "syncStarted" });
    const payload = buildSyncPayload(mailItem, state, user, requestNote);
    const baseWrite = stageSelected()
      .then((staged) => {
        if (staged.failed.length > 0) {
          // Count only — names would leak to Sentry breadcrumbs (debug.ts → sentry.ts).
          console.warn(`[intake] skipped ${staged.failed.length} attachment(s) that failed to stage`);
        }
        // Hand the staged Convex storageIds straight to syncRequest; the deferred
        // Base-write worker runs the Drive upload_all end-to-end (ADR-0022), so the
        // submit returns "pending" fast instead of blocking on serial Drive uploads.
        const attachmentSources = staged.sources.map((source) => ({
          storageId: source.storageId as Id<"_storage">,
          fileName: source.fileName,
        }));
        return sync({ ...payload, attachmentSources });
      })
      .then((result) => {
        if (activeSyncGenerationRef.current !== syncGeneration) return;
        if (!result.recordId) {
          dispatch({ type: "syncQueued" });
          return;
        }
        activeSyncGenerationRef.current = null;
        dispatch({
          type: "syncSucceeded",
          recordId: result.recordId,
          detailUrl: result.detailUrl ?? null,
        });
      })
      .catch((e: unknown) => {
        if (activeSyncGenerationRef.current !== syncGeneration) return;
        activeSyncGenerationRef.current = null;
        dispatch({ type: "syncFailed", message: e instanceof Error ? e.message : "Sync failed" });
      });
    if (state.selfForwardStatus !== "ok") void fireSelfForward();
    return baseWrite;
  }, [sync, mailItem, state, user, requestNote, fireSelfForward, stageSelected]);

  useEffect(() => {
    if (state.screen !== "received" || submitToReceivedStartedRef.current === null) {
      return;
    }
    dtime("submit click to received screen", submitToReceivedStartedRef.current);
    submitToReceivedStartedRef.current = null;
  }, [state.screen]);

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
