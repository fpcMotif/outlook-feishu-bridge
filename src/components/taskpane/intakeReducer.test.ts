// Unit tests for the extracted Bitable-Sync state machine (ADR-0018). The
// reducer is the orchestration brain of a sync, so it earns direct coverage
// without rendering React: auto-match clobber-guard, the Self-Forward status
// transitions, the bitableRecordId capture that prevents duplicate rows on
// retry, and the started-over / mail-from resets.

import { describe, it, expect } from "vitest";
import {
  initialIntakeState,
  intakeReducer,
  type IntakeState,
} from "./intakeReducer";
import type { Coworker } from "./coworkers";
import type { CustomerRecord } from "./customers";

const COWORKER: Coworker = { openId: "ou_jenny", name: "Jenny Xu" };
const BAYER: CustomerRecord = {
  recordId: "rec_bayer",
  name: "Bayer Pharma",
  domain: "bayer.de",
  owner: null,
};
const STOCK: CustomerRecord = {
  recordId: "rec_stock",
  name: "STOCKMEIER",
  domain: "stockmeier.com",
  owner: null,
};

describe("initialIntakeState", () => {
  it("seeds clientEmail and mailFrom from the sender and starts on the build screen", () => {
    const s = initialIntakeState("a@b.com");
    expect(s).toMatchObject({
      clientEmail: "a@b.com",
      mailFrom: "a@b.com",
      screen: "build",
      selectedCoworker: null,
      selectedCustomer: null,
      customerTouched: false,
      bitableRecordId: null,
      syncError: null,
      selfForwardStatus: null,
      selfForwardError: null,
    });
    expect(s.notes).toEqual({});
  });
});

describe("intakeReducer — request + navigation", () => {
  const base = initialIntakeState("a@b.com");

  it("noteChanged merges a note without dropping the others", () => {
    const one = intakeReducer(base, { type: "noteChanged", id: "quote", value: "x" });
    const two = intakeReducer(one, { type: "noteChanged", id: "sample", value: "y" });
    expect(two.notes).toEqual({ quote: "x", sample: "y" });
  });

  it("screenChanged moves to the named screen", () => {
    expect(intakeReducer(base, { type: "screenChanged", screen: "coworker" }).screen).toBe("coworker");
  });

  it("coworkerSelected stores the chosen coworker", () => {
    expect(intakeReducer(base, { type: "coworkerSelected", coworker: COWORKER }).selectedCoworker).toBe(COWORKER);
  });
});

describe("intakeReducer — customer auto-match clobber guard", () => {
  const base = initialIntakeState("a@bayer.de");

  it("adopts the auto-match when the salesperson has not touched the picker", () => {
    const next = intakeReducer(base, { type: "customerAutoMatched", customer: BAYER });
    expect(next.selectedCustomer).toBe(BAYER);
    expect(next.customerTouched).toBe(false);
  });

  it("does NOT overwrite a user override when customerTouched is set", () => {
    const overridden = intakeReducer(base, { type: "customerOverridden", customer: STOCK });
    expect(overridden.customerTouched).toBe(true);
    const afterAutoMatch = intakeReducer(overridden, { type: "customerAutoMatched", customer: BAYER });
    expect(afterAutoMatch).toBe(overridden); // unchanged reference — guard short-circuits
    expect(afterAutoMatch.selectedCustomer).toBe(STOCK);
  });

  it("clientEmailChanged clears the stale match and re-arms auto-match", () => {
    const overridden = intakeReducer(base, { type: "customerOverridden", customer: STOCK });
    const next = intakeReducer(overridden, { type: "clientEmailChanged", value: "new@acme.com" });
    expect(next.clientEmail).toBe("new@acme.com");
    expect(next.selectedCustomer).toBeNull();
    expect(next.customerTouched).toBe(false);
  });

  it("mailFromChanged resets the client email + match when a new Mail Item is opened", () => {
    const touched = intakeReducer(base, { type: "customerOverridden", customer: STOCK });
    const next = intakeReducer(touched, { type: "mailFromChanged", mailFrom: "z@new.com" });
    expect(next).toMatchObject({
      clientEmail: "z@new.com",
      mailFrom: "z@new.com",
      selectedCustomer: null,
      customerTouched: false,
    });
  });
});

describe("intakeReducer — sync + self-forward state machine", () => {
  const base = initialIntakeState("a@b.com");

  it("syncStarted shows the sync screen and arms the pending Self-Forward chip", () => {
    const next = intakeReducer(base, { type: "syncStarted" });
    expect(next).toMatchObject({ screen: "sync", syncError: null, selfForwardStatus: "pending", selfForwardError: null });
  });

  it("syncSucceeded captures the bitableRecordId so a retry can correct in place", () => {
    const next = intakeReducer(base, { type: "syncSucceeded", recordId: "rec_123" });
    expect(next.screen).toBe("received");
    expect(next.bitableRecordId).toBe("rec_123");
  });

  it("syncFailed routes to the error screen with the message", () => {
    const next = intakeReducer(base, { type: "syncFailed", message: "Bitable down" });
    expect(next).toMatchObject({ screen: "error", syncError: "Bitable down" });
  });

  it("selfForwardStarted re-arms the pending chip (the retry feedback path)", () => {
    const failed = intakeReducer(base, { type: "selfForwardFailed", code: "x", message: "y" });
    const next = intakeReducer(failed, { type: "selfForwardStarted" });
    expect(next.selfForwardStatus).toBe("pending");
    expect(next.selfForwardError).toBeNull();
  });

  it("selfForwardSucceeded clears any prior error", () => {
    const failed = intakeReducer(base, { type: "selfForwardFailed", code: "x", message: "y" });
    const next = intakeReducer(failed, { type: "selfForwardSucceeded" });
    expect(next.selfForwardStatus).toBe("ok");
    expect(next.selfForwardError).toBeNull();
  });

  it("selfForwardFailed records the code + message for the retry chip", () => {
    const next = intakeReducer(base, { type: "selfForwardFailed", code: "ErrorAccessDenied", message: "no consent" });
    expect(next.selfForwardStatus).toBe("failed");
    expect(next.selfForwardError).toEqual({ code: "ErrorAccessDenied", message: "no consent" });
  });
});

describe("intakeReducer — startedOver reset", () => {
  it("clears every per-flow field (notes, coworker, customer, recordId, statuses) back to the build screen", () => {
    let s: IntakeState = initialIntakeState("a@b.com");
    s = intakeReducer(s, { type: "noteChanged", id: "quote", value: "x" });
    s = intakeReducer(s, { type: "coworkerSelected", coworker: COWORKER });
    s = intakeReducer(s, { type: "customerOverridden", customer: STOCK });
    s = intakeReducer(s, { type: "syncSucceeded", recordId: "rec_1" });
    s = intakeReducer(s, { type: "selfForwardFailed", code: "c", message: "m" });

    const reset = intakeReducer(s, { type: "startedOver" });
    expect(reset).toMatchObject({
      notes: {},
      screen: "build",
      selectedCoworker: null,
      selectedCustomer: null,
      customerTouched: false,
      bitableRecordId: null,
      syncError: null,
      selfForwardStatus: null,
      selfForwardError: null,
    });
    // mailFrom/clientEmail are NOT reset by startedOver — they track the open item.
    expect(reset.mailFrom).toBe("a@b.com");
  });
});
