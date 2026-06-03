import { describe, expect, it } from "vitest";
import {
  initialIntakeState,
  intakeReducer,
  type IntakeState,
  type UploadedFile,
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

describe("intakeReducer request state", () => {
  const base = initialIntakeState("a@b.com");

  it("noteChanged merges a note without dropping the others", () => {
    const one = intakeReducer(base, {
      type: "noteChanged",
      id: "quote",
      value: "x",
    });
    const two = intakeReducer(one, {
      type: "noteChanged",
      id: "sample",
      value: "y",
    });
    expect(two.notes).toEqual({ quote: "x", sample: "y" });
  });

  it("screenChanged moves to the named one-screen flow state", () => {
    expect(
      intakeReducer(base, { type: "screenChanged", screen: "error" }).screen,
    ).toBe("error");
  });

  it("coworkerSelected stores the chosen coworker", () => {
    expect(
      intakeReducer(base, { type: "coworkerSelected", coworker: COWORKER })
        .selectedCoworker,
    ).toBe(COWORKER);
  });
});

describe("intakeReducer customer auto-match guard", () => {
  const base = initialIntakeState("a@bayer.de");

  it("adopts the auto-match when the salesperson has not touched the picker", () => {
    const next = intakeReducer(base, {
      type: "customerAutoMatched",
      customer: BAYER,
    });
    expect(next.selectedCustomer).toBe(BAYER);
    expect(next.customerTouched).toBe(false);
  });

  it("does not overwrite a user override when customerTouched is set", () => {
    const overridden = intakeReducer(base, {
      type: "customerOverridden",
      customer: STOCK,
    });
    const afterAutoMatch = intakeReducer(overridden, {
      type: "customerAutoMatched",
      customer: BAYER,
    });
    expect(afterAutoMatch).toBe(overridden);
    expect(afterAutoMatch.selectedCustomer).toBe(STOCK);
  });

  it("mailFromChanged resets the client email and match when a new Mail Item is opened", () => {
    const touched = intakeReducer(base, {
      type: "customerOverridden",
      customer: STOCK,
    });
    const next = intakeReducer(touched, {
      type: "mailFromChanged",
      mailFrom: "z@new.com",
    });
    expect(next).toMatchObject({
      clientEmail: "z@new.com",
      mailFrom: "z@new.com",
      selectedCustomer: null,
      customerTouched: false,
    });
  });
});

describe("intakeReducer sync and self-forward state", () => {
  const base = initialIntakeState("a@b.com");

  it("syncStarted shows the sync screen and arms the pending Self-Forward chip", () => {
    const next = intakeReducer(base, { type: "syncStarted" });
    expect(next).toMatchObject({
      screen: "sync",
      syncError: null,
      selfForwardStatus: "pending",
      selfForwardError: null,
    });
  });

  it("syncStarted keeps a prior successful Self-Forward status across sync retries", () => {
    const ok = intakeReducer(base, { type: "selfForwardSucceeded" });
    const next = intakeReducer(ok, { type: "syncStarted" });
    expect(next.selfForwardStatus).toBe("ok");
  });

  it("syncSucceeded captures the bitableRecordId so a retry can correct in place", () => {
    const next = intakeReducer(base, {
      type: "syncSucceeded",
      recordId: "rec_123",
    });
    expect(next.screen).toBe("received");
    expect(next.bitableRecordId).toBe("rec_123");
  });

  it("syncFailed routes to the error screen with the message", () => {
    const next = intakeReducer(base, {
      type: "syncFailed",
      message: "Base down",
    });
    expect(next).toMatchObject({ screen: "error", syncError: "Base down" });
  });

  it("selfForwardStarted re-arms the pending chip", () => {
    const failed = intakeReducer(base, {
      type: "selfForwardFailed",
      code: "x",
      message: "y",
    });
    const next = intakeReducer(failed, { type: "selfForwardStarted" });
    expect(next.selfForwardStatus).toBe("pending");
    expect(next.selfForwardError).toBeNull();
  });

  it("selfForwardSucceeded clears any prior error", () => {
    const failed = intakeReducer(base, {
      type: "selfForwardFailed",
      code: "x",
      message: "y",
    });
    const next = intakeReducer(failed, { type: "selfForwardSucceeded" });
    expect(next.selfForwardStatus).toBe("ok");
    expect(next.selfForwardError).toBeNull();
  });

  it("selfForwardFailed records the code and message for the retry chip", () => {
    const next = intakeReducer(base, {
      type: "selfForwardFailed",
      code: "ErrorAccessDenied",
      message: "no consent",
    });
    expect(next.selfForwardStatus).toBe("failed");
    expect(next.selfForwardError).toEqual({
      code: "ErrorAccessDenied",
      message: "no consent",
    });
  });
});

describe("intakeReducer attachment selection", () => {
  const base = initialIntakeState("a@b.com");
  const file = (name: string): File =>
    new File(["data"], name, { type: "application/pdf" });

  it("seeds empty attachment selections", () => {
    expect(base.selectedAttachmentIds).toEqual([]);
    expect(base.dismissedMailAttachmentIds).toEqual([]);
    expect(base.uploadedFiles).toEqual([]);
  });

  it("mailAttachmentRemoved deselects and dismisses an outlook attachment", () => {
    const selected = intakeReducer(base, {
      type: "attachmentToggled",
      id: "att_1",
    });
    const removed = intakeReducer(selected, {
      type: "mailAttachmentRemoved",
      id: "att_1",
    });
    expect(removed.selectedAttachmentIds).toEqual([]);
    expect(removed.dismissedMailAttachmentIds).toEqual(["att_1"]);
  });

  it("mailAttachmentRemoved dismisses an unselected outlook attachment", () => {
    const removed = intakeReducer(base, {
      type: "mailAttachmentRemoved",
      id: "att_2",
    });
    expect(removed.selectedAttachmentIds).toEqual([]);
    expect(removed.dismissedMailAttachmentIds).toEqual(["att_2"]);
  });

  it("attachmentToggled checks then unchecks a mail attachment id", () => {
    const on = intakeReducer(base, { type: "attachmentToggled", id: "att_1" });
    expect(on.selectedAttachmentIds).toEqual(["att_1"]);
    const off = intakeReducer(on, { type: "attachmentToggled", id: "att_1" });
    expect(off.selectedAttachmentIds).toEqual([]);
  });

  it("attachmentToggled refuses new selections at the 10-file cap", () => {
    const full = {
      ...base,
      selectedAttachmentIds: Array.from({ length: 10 }, (_, i) => `att_${i}`),
    };
    const next = intakeReducer(full, {
      type: "attachmentToggled",
      id: "att_10",
    });
    expect(next.selectedAttachmentIds).toEqual(full.selectedAttachmentIds);
  });

  it("filesAdded appends uploads and uploadedFileRemoved drops one by id", () => {
    const files: UploadedFile[] = [
      { id: "u1", file: file("a.pdf"), rejection: null, selected: true },
      { id: "u2", file: file("b.png"), rejection: null, selected: true },
    ];
    const added = intakeReducer(base, { type: "filesAdded", files });
    expect(added.uploadedFiles.map((f) => f.id)).toEqual(["u1", "u2"]);

    const removed = intakeReducer(added, {
      type: "uploadedFileRemoved",
      id: "u1",
    });
    expect(removed.uploadedFiles.map((f) => f.id)).toEqual(["u2"]);
  });

  it("uploadedFileToggled changes inclusion without removing the file", () => {
    const added = intakeReducer(base, {
      type: "filesAdded",
      files: [
        { id: "u1", file: file("a.pdf"), rejection: null, selected: true },
      ],
    });

    const off = intakeReducer(added, { type: "uploadedFileToggled", id: "u1" });
    expect(off.uploadedFiles).toMatchObject([{ id: "u1", selected: false }]);

    const on = intakeReducer(off, { type: "uploadedFileToggled", id: "u1" });
    expect(on.uploadedFiles).toMatchObject([{ id: "u1", selected: true }]);
  });

  it("uploadedFileToggled refuses to select when all 10 slots are already used", () => {
    const full = {
      ...base,
      selectedAttachmentIds: Array.from({ length: 10 }, (_, i) => `att_${i}`),
      uploadedFiles: [
        { id: "u1", file: file("a.pdf"), rejection: null, selected: false },
      ],
    };
    const next = intakeReducer(full, { type: "uploadedFileToggled", id: "u1" });
    expect(next.uploadedFiles).toMatchObject([{ id: "u1", selected: false }]);
  });

  it("uploadedFilesSelectionChanged selects only the provided valid upload ids", () => {
    const added = intakeReducer(base, {
      type: "filesAdded",
      files: [
        { id: "u1", file: file("a.pdf"), rejection: null, selected: false },
        { id: "u2", file: file("b.pdf"), rejection: null, selected: false },
        {
          id: "u3",
          file: file("bad.exe"),
          rejection: "unsupported type",
          selected: false,
        },
      ],
    });

    const selected = intakeReducer(added, {
      type: "uploadedFilesSelectionChanged",
      ids: ["u1", "u3"],
    });
    expect(
      selected.uploadedFiles.map((f) => ({ id: f.id, selected: f.selected })),
    ).toEqual([
      { id: "u1", selected: true },
      { id: "u2", selected: false },
      { id: "u3", selected: false },
    ]);
  });

  it("uploadedFilesSelectionChanged caps uploaded selections around selected mail", () => {
    const almostFull = {
      ...base,
      selectedAttachmentIds: Array.from({ length: 9 }, (_, i) => `att_${i}`),
      uploadedFiles: [
        { id: "u1", file: file("a.pdf"), rejection: null, selected: false },
        { id: "u2", file: file("b.pdf"), rejection: null, selected: false },
      ],
    };

    const selected = intakeReducer(almostFull, {
      type: "uploadedFilesSelectionChanged",
      ids: ["u1", "u2"],
    });
    expect(
      selected.uploadedFiles.map((f) => ({ id: f.id, selected: f.selected })),
    ).toEqual([
      { id: "u1", selected: true },
      { id: "u2", selected: false },
    ]);
  });

  it("uploadProgressUpdated and uploadStatusChanged update one upload row", () => {
    const added = intakeReducer(base, {
      type: "filesAdded",
      files: [
        {
          id: "u1",
          file: file("a.pdf"),
          rejection: null,
          selected: true,
          status: "pending",
          progress: 0,
        },
      ],
    });
    const uploading = intakeReducer(added, {
      type: "uploadStatusChanged",
      id: "u1",
      status: "uploading",
      progress: 0,
    });
    const mid = intakeReducer(uploading, {
      type: "uploadProgressUpdated",
      id: "u1",
      progress: 42,
    });
    const done = intakeReducer(mid, {
      type: "uploadStatusChanged",
      id: "u1",
      status: "complete",
      progress: 100,
      storageId: "st_1",
    });
    expect(done.uploadedFiles[0]).toMatchObject({
      status: "complete",
      progress: 100,
      storageId: "st_1",
    });
  });

  it("uploadProgressUpdated applies while status is still pending", () => {
    const added = intakeReducer(base, {
      type: "filesAdded",
      files: [
        {
          id: "u1",
          file: file("a.pdf"),
          rejection: null,
          selected: true,
          status: "pending",
          progress: 0,
        },
      ],
    });
    const early = intakeReducer(added, {
      type: "uploadProgressUpdated",
      id: "u1",
      progress: 12,
    });
    expect(early.uploadedFiles[0]).toMatchObject({
      status: "pending",
      progress: 12,
    });
  });

  it("uploadProgressUpdated never decreases progress during one upload", () => {
    const added = intakeReducer(base, {
      type: "filesAdded",
      files: [
        {
          id: "u1",
          file: file("a.pdf"),
          rejection: null,
          selected: true,
          status: "uploading",
          progress: 30,
        },
      ],
    });
    const regressed = intakeReducer(added, {
      type: "uploadProgressUpdated",
      id: "u1",
      progress: 5,
    });
    expect(regressed.uploadedFiles[0]?.progress).toBe(30);
  });

  it("uploadStatusChanged keeps progress when re-entering uploading without a lower value", () => {
    const uploading = intakeReducer(base, {
      type: "filesAdded",
      files: [
        {
          id: "u1",
          file: file("a.pdf"),
          rejection: null,
          selected: true,
          status: "uploading",
          progress: 30,
        },
      ],
    });
    const dup = intakeReducer(uploading, {
      type: "uploadStatusChanged",
      id: "u1",
      status: "uploading",
      progress: 0,
    });
    expect(dup.uploadedFiles[0]?.progress).toBe(30);
  });

  it("uploadRetryRequested resets a failed upload to pending", () => {
    const failed = intakeReducer(base, {
      type: "filesAdded",
      files: [
        {
          id: "u1",
          file: file("a.pdf"),
          rejection: null,
          selected: true,
          status: "error",
          uploadError: "network",
          storageId: "st_old",
        },
      ],
    });
    const retry = intakeReducer(failed, {
      type: "uploadRetryRequested",
      id: "u1",
    });
    expect(retry.uploadedFiles[0]).toMatchObject({
      status: "pending",
      progress: 0,
      uploadError: null,
    });
    expect(retry.uploadedFiles[0]?.storageId).toBeUndefined();
  });

  it("startedOver clears attachment selections", () => {
    let s = intakeReducer(base, { type: "attachmentToggled", id: "att_1" });
    s = intakeReducer(s, {
      type: "filesAdded",
      files: [
        { id: "u1", file: file("a.pdf"), rejection: null, selected: true },
      ],
    });
    const reset = intakeReducer(s, { type: "startedOver" });
    expect(reset.selectedAttachmentIds).toEqual([]);
    expect(reset.dismissedMailAttachmentIds).toEqual([]);
    expect(reset.uploadedFiles).toEqual([]);
  });
});

describe("intakeReducer startedOver reset", () => {
  it("clears every per-flow field back to the build screen", () => {
    let s: IntakeState = initialIntakeState("a@b.com");
    s = intakeReducer(s, { type: "noteChanged", id: "quote", value: "x" });
    s = intakeReducer(s, { type: "coworkerSelected", coworker: COWORKER });
    s = intakeReducer(s, { type: "customerOverridden", customer: STOCK });
    s = intakeReducer(s, { type: "syncSucceeded", recordId: "rec_1" });
    s = intakeReducer(s, {
      type: "selfForwardFailed",
      code: "c",
      message: "m",
    });

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
    expect(reset.mailFrom).toBe("a@b.com");
  });
});
