// Testable state machine for the one-screen Base Sync intake.
// RequestIntakeScreen owns effects and rendering; this module owns state
// transitions that must not regress during retry/start-over flows.

import { MAX_ATTACHMENT_COUNT } from "../../office/attachments";
import { occupiesSlot } from "./attachmentSelection";
import type { IntakeAction, IntakeState, UploadedFile } from "./intakeTypes";

export type {
  IntakeScreenName,
  SyncPhase,
  UploadStatus,
  UploadedFile,
  IntakeState,
  IntakeAction,
} from "./intakeTypes";

function selectedUploadCount(uploadedFiles: UploadedFile[]): number {
  return uploadedFiles.filter((f) => occupiesSlot(f)).length;
}

function selectedAttachmentCount(state: IntakeState): number {
  return (
    state.selectedAttachmentIds.length +
    selectedUploadCount(state.uploadedFiles)
  );
}

// Accepts a bare sender string (the ~dozen existing call sites) or an object that
// also seeds restored upload drafts — the StrictMode-safe restore vehicle, since a
// useReducer lazy initializer runs exactly once per mount (a dispatch would
// double-append). See uploadDraftCache / useRequestIntakeScreen.
type InitialIntakeArg =
  | string
  | {
      mailFrom: string;
      restoredUploads?: UploadedFile[];
      defaultSales?: IntakeState["selectedSales"];
    };

export function initialIntakeState(arg: InitialIntakeArg): IntakeState {
  const mailFrom = typeof arg === "string" ? arg : arg.mailFrom;
  const restoredUploads =
    typeof arg === "string" ? [] : (arg.restoredUploads ?? []);
  const defaultSales = typeof arg === "string" ? null : (arg.defaultSales ?? null);
  return {
    notes: {},
    clientEmail: mailFrom,
    mailFrom,
    screen: "build",
    syncPhase: "staging",
    selectedCoworker: null,
    selectedSales: defaultSales,
    salesTouched: false,
    selectedCustomer: null,
    customerTouched: false,
    bitableRecordId: null,
    bitableDetailUrl: null,
    syncError: null,
    selectedAttachmentIds: [],
    seenMailAttachmentIds: [],
    dismissedMailAttachmentIds: [],
    uploadedFiles: restoredUploads,
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
      if (state.salesTouched || state.selectedSales) return state;
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
      return { ...state, screen: "sync", syncPhase: "staging", syncError: null };
    case "syncPhaseChanged":
      return { ...state, syncPhase: action.phase };
    case "syncSucceeded":
      return {
        ...state,
        screen: "received",
        bitableRecordId: action.recordId,
        bitableDetailUrl: action.detailUrl ?? null,
      };
    case "syncFailed":
      return { ...state, screen: "error", syncError: action.message };
    case "mailAttachmentsDiscovered": {
      const seen = state.seenMailAttachmentIds ?? [];
      const unseen = action.ids.filter((id) => !seen.includes(id));
      if (unseen.length === 0) return state;

      const selected = new Set(state.selectedAttachmentIds);
      let slots = MAX_ATTACHMENT_COUNT - selectedAttachmentCount(state);
      for (const id of unseen) {
        if (selected.has(id) || slots <= 0) continue;
        selected.add(id);
        slots -= 1;
      }

      return {
        ...state,
        selectedAttachmentIds: [...selected],
        seenMailAttachmentIds: [...seen, ...unseen],
      };
    }
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
    case "uploadsRestored":
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
    case "uploadFileReplaced": {
      // A valid re-pick re-queues (pending); a rejected one parks as blocked.
      const reset =
        action.rejection === null
          ? { rejection: null, status: "pending" as const, progress: 0 }
          : { rejection: action.rejection, selected: false, status: undefined, progress: undefined };
      return {
        ...state,
        uploadedFiles: state.uploadedFiles.map((file) =>
          file.id === action.id
            ? { ...file, file: action.file, storageId: undefined, uploadError: null, ...reset }
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
        selectedAttachmentIds: [],
        seenMailAttachmentIds: [],
        dismissedMailAttachmentIds: [],
        uploadedFiles: [],
      };
  }
}
