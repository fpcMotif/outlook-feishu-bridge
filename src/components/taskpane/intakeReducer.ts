// Testable state machine for the one-screen Base Sync intake.
// RequestIntakeScreen owns effects and rendering; this module owns state
// transitions that must not regress during retry/start-over flows.

import { MAX_ATTACHMENT_COUNT } from "../../office/attachments";
import type { IntakeAction, IntakeState, UploadedFile } from "./intakeTypes";

export type {
  IntakeScreenName,
  SelfForwardStatus,
  UploadStatus,
  UploadedFile,
  IntakeState,
  IntakeAction,
} from "./intakeTypes";

function selectedUploadCount(uploadedFiles: UploadedFile[]): number {
  return uploadedFiles.filter(
    (file) => file.rejection === null && file.selected,
  ).length;
}

function selectedAttachmentCount(state: IntakeState): number {
  return (
    state.selectedAttachmentIds.length +
    selectedUploadCount(state.uploadedFiles)
  );
}

export function initialIntakeState(mailFrom: string): IntakeState {
  return {
    notes: {},
    clientEmail: mailFrom,
    mailFrom,
    screen: "build",
    selectedCoworker: null,
    selectedSales: null,
    salesTouched: false,
    selectedCustomer: null,
    customerTouched: false,
    bitableRecordId: null,
    bitableDetailUrl: null,
    syncError: null,
    selfForwardStatus: null,
    selfForwardError: null,
    selectedAttachmentIds: [],
    dismissedMailAttachmentIds: [],
    uploadedFiles: [],
  };
}

// One exhaustive switch keeps the state machine easy to audit.
// eslint-disable-next-line max-lines-per-function
export function intakeReducer(
  state: IntakeState,
  action: IntakeAction,
): IntakeState {
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
    case "screenChanged":
      return { ...state, screen: action.screen };
    case "coworkerSelected":
      return { ...state, selectedCoworker: action.coworker };
    case "salesSelected":
      return { ...state, selectedSales: action.sales, salesTouched: true };
    case "salesDefaulted":
      if (state.salesTouched) return state;
      if (
        state.selectedSales?.openId === action.sales.openId &&
        state.selectedSales.name === action.sales.name &&
        state.selectedSales.avatarUrl === action.sales.avatarUrl
      ) {
        return state;
      }
      return { ...state, selectedSales: action.sales };
    case "customerAutoMatched":
      if (state.customerTouched) return state;
      return { ...state, selectedCustomer: action.customer };
    case "customerOverridden":
      return {
        ...state,
        selectedCustomer: action.customer,
        customerTouched: true,
      };
    case "syncStarted":
      return {
        ...state,
        screen: "sync",
        syncError: null,
        // Keep a prior successful Note-to-myself across sync retries (ADR-0017).
        selfForwardStatus: state.selfForwardStatus === "ok" ? "ok" : "pending",
        selfForwardError: null,
      };
    case "syncQueued":
      return {
        ...state,
        screen: "received",
        bitableRecordId: null,
        bitableDetailUrl: null,
      };
    case "syncSucceeded":
      return {
        ...state,
        screen: "received",
        bitableRecordId: action.recordId,
        bitableDetailUrl: action.detailUrl ?? null,
      };
    case "syncFailed":
      return { ...state, screen: "error", syncError: action.message };
    case "selfForwardStarted":
      return { ...state, selfForwardStatus: "pending", selfForwardError: null };
    case "selfForwardSucceeded":
      return { ...state, selfForwardStatus: "ok", selfForwardError: null };
    case "selfForwardFailed":
      return {
        ...state,
        selfForwardStatus: "failed",
        selfForwardError: { code: action.code, message: action.message },
      };
    case "attachmentToggled":
      if (
        !state.selectedAttachmentIds.includes(action.id) &&
        selectedAttachmentCount(state) >= MAX_ATTACHMENT_COUNT
      ) {
        return state;
      }
      return {
        ...state,
        selectedAttachmentIds: state.selectedAttachmentIds.includes(action.id)
          ? state.selectedAttachmentIds.filter((id) => id !== action.id)
          : [...state.selectedAttachmentIds, action.id],
      };
    case "mailAttachmentRemoved": {
      const dismissed = state.dismissedMailAttachmentIds.includes(action.id)
        ? state.dismissedMailAttachmentIds
        : [...state.dismissedMailAttachmentIds, action.id];
      return {
        ...state,
        selectedAttachmentIds: state.selectedAttachmentIds.filter(
          (id) => id !== action.id,
        ),
        dismissedMailAttachmentIds: dismissed,
      };
    }
    case "filesAdded":
      return {
        ...state,
        uploadedFiles: [...state.uploadedFiles, ...action.files],
      };
    case "uploadedFileToggled": {
      const target = state.uploadedFiles.find((file) => file.id === action.id);
      if (!target || target.rejection !== null) return state;
      if (
        !target.selected &&
        selectedAttachmentCount(state) >= MAX_ATTACHMENT_COUNT
      )
        return state;
      return {
        ...state,
        uploadedFiles: state.uploadedFiles.map((file) =>
          file.id === action.id ? { ...file, selected: !file.selected } : file,
        ),
      };
    }
    case "uploadedFilesSelectionChanged": {
      const requested = new Set(action.ids);
      let slots = MAX_ATTACHMENT_COUNT - state.selectedAttachmentIds.length;
      return {
        ...state,
        uploadedFiles: state.uploadedFiles.map((file) => {
          if (
            file.rejection !== null ||
            !requested.has(file.id) ||
            slots <= 0
          ) {
            return { ...file, selected: false };
          }
          slots -= 1;
          return { ...file, selected: true };
        }),
      };
    }
    case "uploadedFileRemoved":
      return {
        ...state,
        uploadedFiles: state.uploadedFiles.filter((f) => f.id !== action.id),
      };
    case "uploadProgressUpdated":
      return {
        ...state,
        uploadedFiles: state.uploadedFiles.map((file) =>
          file.id === action.id &&
          file.rejection === null &&
          (file.status === "uploading" || file.status === "pending")
            ? {
                ...file,
                progress: Math.max(file.progress ?? 0, action.progress),
              }
            : file,
        ),
      };
    case "uploadStatusChanged":
      return {
        ...state,
        uploadedFiles: state.uploadedFiles.map((file) =>
          file.id === action.id
            ? {
                ...file,
                status: action.status,
                progress:
                  action.progress === undefined
                    ? file.progress
                    : action.status === "uploading" &&
                        (file.status === "uploading" || file.status === "pending")
                      ? Math.max(file.progress ?? 0, action.progress)
                      : action.progress,
                storageId:
                  action.storageId === undefined
                    ? file.storageId
                    : action.storageId,
                uploadError:
                  action.uploadError === undefined
                    ? file.uploadError
                    : action.uploadError,
              }
            : file,
        ),
      };
    case "uploadRetryRequested": {
      const target = state.uploadedFiles.find((file) => file.id === action.id);
      if (!target || target.rejection !== null) return state;
      return {
        ...state,
        uploadedFiles: state.uploadedFiles.map((file) =>
          file.id === action.id
            ? {
                ...file,
                status: "pending",
                progress: 0,
                storageId: undefined,
                uploadError: null,
              }
            : file,
        ),
      };
    }
    case "startedOver":
      return {
        ...state,
        notes: {},
        screen: "build",
        selectedCoworker: null,
        selectedSales: null,
        salesTouched: false,
        selectedCustomer: null,
        customerTouched: false,
        bitableRecordId: null,
        bitableDetailUrl: null,
        syncError: null,
        selfForwardStatus: null,
        selfForwardError: null,
        selectedAttachmentIds: [],
        dismissedMailAttachmentIds: [],
        uploadedFiles: [],
      };
  }
}
