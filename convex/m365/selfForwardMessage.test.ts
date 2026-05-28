// Pure unit tests for the Self-Forward message builders. Every shape these
// helpers produce is sent verbatim to Microsoft Graph, so the field names and
// nesting must match the official docs exactly (ADR-0017):
//   PATCH /me/messages/{id}     https://learn.microsoft.com/graph/api/message-update
//   POST  /me/messages/{id}/send https://learn.microsoft.com/graph/api/message-send

import { describe, expect, it } from "vitest";

import {
  buildSelfForwardSubject,
  buildSelfForwardPatchBody,
} from "./selfForwardMessage";

describe("buildSelfForwardSubject", () => {
  // ADR-0017: the literal subject template. Em dash (—) separates the prefix
  // from the original — matches CONTEXT.md's `Self-Forward` term and the ADR.
  it("prepends `Note to myself — ` to the original subject", () => {
    expect(buildSelfForwardSubject("Inquiry - bulk L-Carnitine")).toBe(
      "Note to myself — Inquiry - bulk L-Carnitine",
    );
  });

  // Outlook lets users send a message with an empty subject; Graph accepts it.
  // We mirror Outlook's own UI fallback `(no subject)` so the Note-to-myself
  // copy still reads as a real subject in the inbox list.
  it("falls back to `Note to myself — (no subject)` when the original is blank", () => {
    expect(buildSelfForwardSubject("")).toBe("Note to myself — (no subject)");
    expect(buildSelfForwardSubject("   ")).toBe("Note to myself — (no subject)");
  });

  // Defensive against an upstream call passing undefined (e.g. Office.js
  // returning before the Mail Item has fully loaded — `item.subject` typed as
  // `string` in read mode per ADR-0015, but treat as optional at this boundary).
  it("falls back when the original subject is undefined", () => {
    // eslint-disable-next-line unicorn/no-useless-undefined -- `undefined` is the test point.
    expect(buildSelfForwardSubject(undefined)).toBe(
      "Note to myself — (no subject)",
    );
  });
});

describe("buildSelfForwardPatchBody", () => {
  // ADR-0017: the PATCH on the createForward draft sets subject + the single
  // self-recipient. Body matches the official `message-update` schema —
  // `toRecipients[].emailAddress.address`. Doc:
  //   https://learn.microsoft.com/graph/api/resources/emailaddress
  it("produces the exact `message-update` PATCH body Graph expects", () => {
    const body = buildSelfForwardPatchBody({
      originalSubject: "Inquiry - bulk L-Carnitine",
      selfEmail: "jenny.xu@fenchem.com",
    });
    expect(body).toEqual({
      subject: "Note to myself — Inquiry - bulk L-Carnitine",
      toRecipients: [{ emailAddress: { address: "jenny.xu@fenchem.com" } }],
    });
  });
});
