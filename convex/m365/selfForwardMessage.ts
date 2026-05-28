// Pure builders for the Self-Forward "Note to myself" message — the PATCH body
// sent against a Microsoft Graph `createForward` draft (ADR-0017). No I/O here;
// every shape this file emits is unit-tested in selfForwardMessage.test.ts and
// the Graph endpoints that consume them are cited in selfForward.ts.
//
// Official refs (the ONLY source of truth, per ADR-0015):
//   createForward: https://learn.microsoft.com/graph/api/message-createforward
//   message-update: https://learn.microsoft.com/graph/api/message-update
//   emailAddress / recipient shape:
//     https://learn.microsoft.com/graph/api/resources/emailaddress
//     https://learn.microsoft.com/graph/api/resources/recipient

const SUBJECT_PREFIX = "Note to myself — ";
const NO_SUBJECT_FALLBACK = "(no subject)";

/**
 * The literal subject we PATCH onto the createForward draft. Em dash (—)
 * separates the prefix from the original to match CONTEXT.md's `Self-Forward`
 * term and ADR-0017's worked example.
 */
export function buildSelfForwardSubject(originalSubject: string | undefined): string {
  const trimmed = (originalSubject ?? "").trim();
  return SUBJECT_PREFIX + (trimmed || NO_SUBJECT_FALLBACK);
}

export interface SelfForwardPatchInput {
  originalSubject: string | undefined;
  selfEmail: string;
}

/**
 * The exact `message-update` PATCH body Graph expects on the createForward
 * draft: a new `subject` plus a single `toRecipients[0]` set to the signed-in
 * salesperson's own mailbox. The Self-Forward is delivered to that one address
 * — never to anyone else.
 */
export function buildSelfForwardPatchBody(
  input: SelfForwardPatchInput,
): { subject: string; toRecipients: { emailAddress: { address: string } }[] } {
  return {
    subject: buildSelfForwardSubject(input.originalSubject),
    toRecipients: [{ emailAddress: { address: input.selfEmail } }],
  };
}
