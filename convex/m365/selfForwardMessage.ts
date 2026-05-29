// Pure request-body builder for Graph's native `message: forward` action.
//
// Official refs (the source of truth per ADR-0015):
//   message-forward: https://learn.microsoft.com/graph/api/message-forward
//   recipient:       https://learn.microsoft.com/graph/api/resources/recipient

export interface SelfForwardRequestSelection {
  requestType: string;
  note: string;
}

export interface SelfForwardMessageForwardInput {
  selfEmail: string;
  /** Customer picked in the Customer Picker, if any. */
  customerName?: string;
  /** Sender of the original Mail Item, surfaced for context in the comment. */
  clientEmail?: string;
  /** Request types + notes that just landed in the Bitable Service row. */
  requestSelections?: SelfForwardRequestSelection[];
}

const SELF_FORWARD_COPY_RECIPIENT = "bourbakii@icloud.com";

function recipient(address: string): { emailAddress: { address: string } } {
  return { emailAddress: { address } };
}

export function buildSelfForwardComment(
  input: SelfForwardMessageForwardInput,
): string {
  const lines: string[] = ["Synced to Feishu Bitable"];
  const customerName = input.customerName?.trim();
  if (customerName) lines.push(`Client: ${customerName}`);
  const clientEmail = input.clientEmail?.trim();
  if (clientEmail) lines.push(`Client email: ${clientEmail}`);
  if (input.requestSelections && input.requestSelections.length > 0) {
    lines.push(
      `Request types: ${input.requestSelections.map((r) => r.requestType).join(", ")}`,
    );
    for (const r of input.requestSelections) {
      const note = r.note.trim();
      if (note) lines.push(`${r.requestType} note: ${note}`);
    }
  }
  lines.push("------------------");
  return lines.join("\n");
}

export function buildSelfForwardForwardBody(input: SelfForwardMessageForwardInput): {
  comment: string;
  toRecipients: { emailAddress: { address: string } }[];
} {
  return {
    comment: buildSelfForwardComment(input),
    toRecipients: [recipient(input.selfEmail), recipient(SELF_FORWARD_COPY_RECIPIENT)],
  };
}
