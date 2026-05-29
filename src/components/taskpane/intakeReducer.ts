// Testable state machine for the one-screen Base Sync intake.
// RequestIntakeScreen owns effects and rendering; this module owns state
// transitions that must not regress during retry/start-over flows.

import type { Coworker } from "./coworkers";
import type { CustomerRecord } from "./customers";

export type IntakeScreenName = "build" | "sync" | "received" | "error";

export type SelfForwardStatus = "pending" | "ok" | "failed" | null;

export interface IntakeState {
  notes: Record<string, string>;
  clientEmail: string;
  mailFrom: string;
  screen: IntakeScreenName;
  selectedCoworker: Coworker | null;
  selectedCustomer: CustomerRecord | null;
  customerTouched: boolean;
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
    case "clientEmailChanged":
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
