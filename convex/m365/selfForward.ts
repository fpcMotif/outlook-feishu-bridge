// Public Convex action the taskpane calls to deliver the Self-Forward —
// the "Note to myself" copy of the synced Mail Item into the Initiator's own
// mailbox (ADR-0017). Soft-fail by design: this action returns its own result
// envelope; it never throws. The SPA's runSync fires this in parallel with
// `feishu.requestSync.syncRequest` and surfaces failure as a retry chip.
//
// All Graph endpoints + the OBO exchange are cited in selfForwardChain.ts.
// Secrets live in Convex env, mirroring the Feishu convention (ADR-0017).

import { v } from "convex/values";
import { action } from "../_generated/server";
import { runSelfForwardChain, type SelfForwardResult } from "./selfForwardChain";

function requireM365Env() {
  const tenantId = process.env.M365_TENANT_ID ?? "common";
  const clientId = process.env.M365_CLIENT_ID;
  const clientSecret = process.env.M365_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("M365_CLIENT_ID and M365_CLIENT_SECRET must be set");
  }
  return { tenantId, clientId, clientSecret };
}

export const sendSelfForwardNote = action({
  args: {
    /** Office.js SSO bootstrap token from `OfficeRuntime.auth.getAccessToken`. */
    bootstrap: v.string(),
    /** REST v2 id — `Office.context.mailbox.convertToRestId(item.itemId, v2_0)`. */
    originalMessageId: v.string(),
    /** Mail Item subject — may be empty; builder substitutes `(no subject)`. */
    originalSubject: v.optional(v.string()),
    /** `Office.context.mailbox.userProfile.emailAddress`. */
    selfEmail: v.string(),
  },
  handler: (_ctx, args): Promise<SelfForwardResult> => {
    const env = requireM365Env();
    return runSelfForwardChain(
      {
        bootstrap: args.bootstrap,
        originalMessageId: args.originalMessageId,
        originalSubject: args.originalSubject,
        selfEmail: args.selfEmail,
      },
      env,
      // ActionCtx in Convex runs Node-compatible fetch; bind for testability.
      (url, init) => fetch(url, init),
    );
  },
});
