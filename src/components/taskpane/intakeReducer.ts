// Testable state machine for the one-screen Base Sync intake.
// RequestIntakeScreen owns effects and rendering; this module owns state
// transitions that must not regress during retry/start-over flows.

import type { Coworker } from "./coworkers";
import type { CustomerRecord } from "./customers";

export type IntakeScreenName = "build" | "sync" | "received" | "error";

export type SelfForwardStatus = "pending" | "ok" | "failed" | null;

// A user-uploaded file staged for the Base Attachment cell (ADR-0022). `id` is a
// local uuid (minted in the picker handler), `rejection` is the inline reason
// from uploadRejectionReason (null = acceptable). The DOM File carries the bytes.
export interface UploadedFile {
  id: string;
  file: File;
  rejection: string | null;
}

export interface IntakeState {
  notes: Record<string, string>;
  clientEmail: string;
  mailFrom: string;
  screen: IntakeScreenName;
  selectedCoworker: Coworker | null;
  selectedCustomer: CustomerRecord | null;
  customerTouched: boolean;
  bitableRecordId: string | null;
  bitableDetailUrl: string | null;
  syncError: string | null;
  selfForwardStatus: SelfForwardStatus;
  selfForwardError: { code: string; message: string } | null;
  // ADR-0022 attachments: checked mail-attachment ids (opt-in, default []) and
  // the user's uploaded files. Sources are gathered + staged at submit time.
  selectedAttachmentIds: string[];
  uploadedFiles: UploadedFile[];
}

export type IntakeAction =
  | { type: "mailFromChanged"; mailFrom: string }
  | { type: "noteChanged"; id: string; value: string }
  | { type: "screenChanged"; screen: IntakeScreenName }
  | { type: "coworkerSelected"; coworker: Coworker }
  | { type: "customerAutoMatched"; customer: CustomerRecord | null }
  | { type: "customerOverridden"; customer: CustomerRecord | null }
  | { type: "syncStarted" }
  | { type: "syncSucceeded"; recordId: string; detailUrl?: string | null }
  | { type: "syncFailed"; message: string }
  | { type: "selfForwardStarted" }
  | { type: "selfForwardSucceeded" }
  | { type: "selfForwardFailed"; code: string; message: string }
  | { type: "attachmentToggled"; id: string }
  | { type: "filesAdded"; files: UploadedFile[] }
  | { type: "uploadedFileRemoved"; id: string }
  | { type: "startedOver" };

export function initialIntakeState(mailFrom: string): IntakeState {
  return {
    notes: {},
    clientEmail: mailFrom,
    mailFrom,
    screen: "build",
    selectedCoworker: null,
    selectedCustomer: null,
    customerTouched: false,
    bitableRecordId: null,
    bitableDetailUrl: null,
    syncError: null,
    selfForwardStatus: null,
    selfForwardError: null,
    selectedAttachmentIds: [],
    uploadedFiles: [],
  };
}

// One exhaustive switch keeps the state machine easy to audit.
// eslint-disable-next-line max-lines-per-function
export function intakeReducer(state: IntakeState, action: IntakeAction): IntakeState {
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
    case "customerAutoMatched":
      if (state.customerTouched) return state;
      return { ...state, selectedCustomer: action.customer };
    case "customerOverridden":
      return { ...state, selectedCustomer: action.customer, customerTouched: true };
    case "syncStarted":
      return {
        ...state,
        screen: "sync",
        syncError: null,
        // Keep a prior successful Note-to-myself across sync retries (ADR-0017).
        selfForwardStatus: state.selfForwardStatus === "ok" ? "ok" : "pending",
        selfForwardError: null,
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
      return {
        ...state,
        selectedAttachmentIds: state.selectedAttachmentIds.includes(action.id)
          ? state.selectedAttachmentIds.filter((id) => id !== action.id)
          : [...state.selectedAttachmentIds, action.id],
      };
    case "filesAdded":
      return { ...state, uploadedFiles: [...state.uploadedFiles, ...action.files] };
    case "uploadedFileRemoved":
      return { ...state, uploadedFiles: state.uploadedFiles.filter((f) => f.id !== action.id) };
    case "startedOver":
      return {
        ...state,
        notes: {},
        screen: "build",
        selectedCoworker: null,
        selectedCustomer: null,
        customerTouched: false,
        bitableRecordId: null,
        bitableDetailUrl: null,
        syncError: null,
        selfForwardStatus: null,
        selfForwardError: null,
        selectedAttachmentIds: [],
        uploadedFiles: [],
      };
  }
}
