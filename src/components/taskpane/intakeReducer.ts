// The orchestration brain of a Bitable Sync, extracted from RequestIntakeScreen
// (ADR-0018) so the state machine — auto-match clobber-guard, Self-Forward
// status transitions, the started-over reset, and the bitableRecordId capture
// that lets a retry correct-in-place instead of creating a duplicate row — is
// unit-testable without rendering React.

import type { Coworker } from "./coworkers";
import type { CustomerRecord } from "./customers";

export type IntakeScreenName = "build" | "coworker" | "sync" | "received" | "error";

// Status of the parallel Self-Forward (ADR-0017). `pending` while the chain
// runs; `ok` once the Note-to-myself sends; `failed` on any non-2xx so the
// ReceivedScreen renders the retry chip. `null` before the first attempt.
export type SelfForwardStatus = "pending" | "ok" | "failed" | null;

export interface IntakeState {
  notes: Record<string, string>;
  clientEmail: string;
  mailFrom: string;
  screen: IntakeScreenName;
  selectedCoworker: Coworker | null;
  // The Customer picked or auto-matched in the Customer Picker (ADR-0013).
  // `customerTouched` flips true once the salesperson interacts with the picker
  // — after that we stop overwriting their choice when the directory loads.
  selectedCustomer: CustomerRecord | null;
  customerTouched: boolean;
  // The Bitable record id returned by a successful create. Once set, a retry
  // corrects THIS row (ADR-0012) instead of calling create again and orphaning
  // a duplicate Service row (the no-touch rule, ADR-0018).
  bitableRecordId: string | null;
  syncError: string | null;
  selfForwardStatus: SelfForwardStatus;
  selfForwardError: { code: string; message: string } | null;
}

export type IntakeAction =
  | { type: "mailFromChanged"; mailFrom: string }
  | { type: "noteChanged"; id: string; value: string }
  | { type: "clientEmailChanged"; value: string }
  | { type: "screenChanged"; screen: IntakeScreenName }
  | { type: "coworkerSelected"; coworker: Coworker }
  | { type: "customerAutoMatched"; customer: CustomerRecord | null }
  | { type: "customerOverridden"; customer: CustomerRecord | null }
  | { type: "syncStarted" }
  | { type: "syncSucceeded"; recordId: string }
  | { type: "syncFailed"; message: string }
  | { type: "selfForwardStarted" }
  | { type: "selfForwardSucceeded" }
  | { type: "selfForwardFailed"; code: string; message: string }
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
    syncError: null,
    selfForwardStatus: null,
    selfForwardError: null,
  };
}

// One exhaustive switch over the IntakeAction union; splitting the arms would
// obscure the state machine, so the per-function line cap is waived here.
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
    case "clientEmailChanged":
      // The salesperson is re-resolving the client → the previous auto-match
      // is stale. Clear it; the next auto-match effect will re-fire.
      return {
        ...state,
        clientEmail: action.value,
        selectedCustomer: null,
        customerTouched: false,
      };
    case "screenChanged":
      return { ...state, screen: action.screen };
    case "coworkerSelected":
      return { ...state, selectedCoworker: action.coworker };
    case "customerAutoMatched":
      // Only adopt the auto-match if the salesperson hasn't already picked.
      if (state.customerTouched) return state;
      return { ...state, selectedCustomer: action.customer };
    case "customerOverridden":
      return { ...state, selectedCustomer: action.customer, customerTouched: true };
    case "syncStarted":
      return {
        ...state,
        screen: "sync",
        syncError: null,
        selfForwardStatus: "pending",
        selfForwardError: null,
      };
    case "syncSucceeded":
      // Capture the created row's id so a later correction targets it.
      return { ...state, screen: "received", bitableRecordId: action.recordId };
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
    case "startedOver":
      return {
        ...state,
        notes: {},
        screen: "build",
        selectedCoworker: null,
        selectedCustomer: null,
        customerTouched: false,
        bitableRecordId: null,
        syncError: null,
        selfForwardStatus: null,
        selfForwardError: null,
      };
  }
}
