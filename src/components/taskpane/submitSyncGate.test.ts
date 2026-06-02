import { describe, expect, it } from "vitest";

import { canSubmitSync, submitSyncHint, type SubmitSyncGateInput } from "./submitSyncGate";

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
];

describe("submitSyncGate", () => {
  it.each(cases)("$name → can=$can", ({ input, can, hint }) => {
    expect(canSubmitSync(input)).toBe(can);
    expect(submitSyncHint(input)).toBe(hint);
  });
});
