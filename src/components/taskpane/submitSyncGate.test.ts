import { describe, expect, it } from "vitest";

import {
  canSubmitSync,
  submitSyncHint,
  uploadGateState,
  type SubmitSyncGateInput,
} from "./submitSyncGate";
import type { UploadedFile } from "./intakeTypes";

const cases: { name: string; input: SubmitSyncGateInput; can: boolean; hint: string }[] = [
  {
    name: "none",
    input: { hasCustomer: false, hasCoworker: false, fulfilledRequestCount: 0 },
    can: false,
    hint: "Select a customer",
  },
  {
    name: "request only",
    input: { hasCustomer: false, hasCoworker: false, fulfilledRequestCount: 1 },
    can: false,
    hint: "Select a customer",
  },
  {
    name: "customer only",
    input: { hasCustomer: true, hasCoworker: false, fulfilledRequestCount: 0 },
    can: false,
    hint: "Choose exactly one Feishu coworker",
  },
  {
    name: "coworker only",
    input: { hasCustomer: false, hasCoworker: true, fulfilledRequestCount: 0 },
    can: false,
    hint: "Select a customer",
  },
  {
    name: "customer + coworker",
    input: { hasCustomer: true, hasCoworker: true, fulfilledRequestCount: 0 },
    can: false,
    hint: "Start a request below",
  },
  {
    name: "customer + request",
    input: { hasCustomer: true, hasCoworker: false, fulfilledRequestCount: 1 },
    can: false,
    hint: "Choose exactly one Feishu coworker",
  },
  {
    name: "coworker + request",
    input: { hasCustomer: false, hasCoworker: true, fulfilledRequestCount: 1 },
    can: false,
    hint: "Select a customer",
  },
  {
    name: "all three",
    input: { hasCustomer: true, hasCoworker: true, fulfilledRequestCount: 2 },
    can: true,
    hint: "Ready to sync",
  },
  {
    name: "dev preview fixture coworker",
    input: {
      hasCustomer: true,
      hasCoworker: true,
      fulfilledRequestCount: 1,
      devPreview: true,
      selectedCoworkerOpenId: "ou_maria",
    },
    can: false,
    hint: "Pick a real Feishu colleague (preview fixtures cannot sync to Base)",
  },
  {
    name: "all three but an upload is in flight",
    input: {
      hasCustomer: true,
      hasCoworker: true,
      fulfilledRequestCount: 1,
      uploadsInFlight: true,
    },
    can: false,
    hint: "Waiting for attachments to finish uploading",
  },
  {
    name: "all three but an upload failed (parked, syncs without it)",
    input: {
      hasCustomer: true,
      hasCoworker: true,
      fulfilledRequestCount: 1,
      uploadsParked: true,
    },
    can: true,
    hint: "Ready to sync",
  },
  {
    name: "in-flight still blocks even with a parked failure",
    input: {
      hasCustomer: true,
      hasCoworker: true,
      fulfilledRequestCount: 1,
      uploadsInFlight: true,
      uploadsParked: true,
    },
    can: false,
    hint: "Waiting for attachments to finish uploading",
  },
  {
    name: "a missing content prereq still wins over the upload hint",
    input: {
      hasCustomer: false,
      hasCoworker: true,
      fulfilledRequestCount: 1,
      uploadsInFlight: true,
    },
    can: false,
    hint: "Select a customer",
  },
];

describe("submitSyncGate", () => {
  it.each(cases)("$name → can=$can", ({ input, can, hint }) => {
    expect(canSubmitSync(input)).toBe(can);
    expect(submitSyncHint(input)).toBe(hint);
  });
});

const upload = (over: Partial<UploadedFile>): UploadedFile => ({
  id: over.id ?? "u1",
  file: new File(["x"], over.file?.name ?? "report.pdf"),
  rejection: null,
  selected: true,
  status: "complete",
  ...over,
});

describe("uploadGateState", () => {
  it("treats no uploads as settled", () => {
    expect(uploadGateState([])).toEqual({
      uploadsInFlight: false,
      uploadsParked: false,
    });
  });

  it.each(["pending", "uploading", "processing"] as const)(
    "flags a selected %s upload as in flight",
    (status) => {
      expect(uploadGateState([upload({ status })])).toEqual({
        uploadsInFlight: true,
        uploadsParked: false,
      });
    },
  );

  it("parks a selected errored upload (not in flight, not blocking)", () => {
    expect(uploadGateState([upload({ status: "error" })])).toEqual({
      uploadsInFlight: false,
      uploadsParked: true,
    });
  });

  it("treats a valid upload with no status yet as in flight", () => {
    expect(uploadGateState([upload({ status: undefined })])).toEqual({
      uploadsInFlight: true,
      uploadsParked: false,
    });
  });

  it("ignores deselected and rejected rows", () => {
    const rows = [
      upload({ id: "a", selected: false, status: "uploading" }),
      upload({ id: "b", rejection: "Too large", selected: true, status: undefined }),
      upload({ id: "c", status: "complete" }),
    ];
    expect(uploadGateState(rows)).toEqual({
      uploadsInFlight: false,
      uploadsParked: false,
    });
  });

  it("reports both flags when a mix is in flight and parked", () => {
    const rows = [
      upload({ id: "a", status: "uploading" }),
      upload({ id: "b", status: "error" }),
      upload({ id: "c", status: "complete" }),
    ];
    expect(uploadGateState(rows)).toEqual({
      uploadsInFlight: true,
      uploadsParked: true,
    });
  });
});
