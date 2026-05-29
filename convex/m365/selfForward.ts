// Public Convex action the taskpane calls to deliver the Self-Forward:
// a native Outlook forward of the synced Mail Item into the Initiator's own
// mailbox (ADR-0017). Soft-fail by design: this action returns its own result
// envelope; it never throws. The SPA fires this in parallel with the Bitable
// sync and surfaces failure as a retry chip.
//
// All Graph endpoints and the client_credentials exchange are cited in
// selfForwardChain.ts. Secrets live in Convex env, mirroring the Feishu
// convention (ADR-0017).

import { v } from "convex/values";
import { action, internalAction } from "../_generated/server";
import { runSelfForwardChain, type SelfForwardResult } from "./selfForwardChain";

const FENCHEM_TENANT_ID = "93b47f6a-5661-4677-a047-ab4fee1cad47";

export function requireM365Env() {
  const tenantId = process.env.M365_TENANT_ID ?? FENCHEM_TENANT_ID;
  const clientId = process.env.M365_CLIENT_ID;
  const clientSecret = process.env.M365_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("M365_CLIENT_ID and M365_CLIENT_SECRET must be set");
  }
  return { tenantId, clientId, clientSecret };
}

export const diagAadClientCredentials = internalAction({
  args: {},
  handler: async (): Promise<{
    ok: boolean;
    tenantId?: string;
    aadError?: string;
    aadErrorDescription?: string;
    tokenScope?: string;
  }> => {
    const tenantId = process.env.M365_TENANT_ID ?? FENCHEM_TENANT_ID;
    const clientId = process.env.M365_CLIENT_ID;
    const clientSecret = process.env.M365_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return {
        ok: false,
        tenantId,
        aadError: "env_missing",
        aadErrorDescription: "M365_CLIENT_ID / M365_CLIENT_SECRET unset",
      };
    }
    const res = await fetch(
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: clientId,
          client_secret: clientSecret,
          scope: "https://graph.microsoft.com/.default",
        }).toString(),
      },
    );
    const json = (await res.json()) as {
      access_token?: string;
      error?: string;
      error_description?: string;
      scope?: string;
    };
    console.log(
      `[m365] diagAadClientCredentials status=${res.status} tenant=${tenantId} aadError=${json.error ?? "(none)"}`,
    );
    if (json.access_token) {
      return { ok: true, tenantId, tokenScope: json.scope };
    }
    return {
      ok: false,
      tenantId,
      aadError: json.error,
      aadErrorDescription: json.error_description,
    };
  },
});

export const sendSelfForwardNote = action({
  args: {
    /** REST/Graph message id converted from Office.js `itemId`. */
    originalMessageId: v.string(),
    /** Outlook user's mailbox; this is the sending mailbox and primary recipient. */
    selfEmail: v.string(),
    /** Customer picked in the Customer Picker (ADR-0013). Optional. */
    customerName: v.optional(v.string()),
    /** Sender of the original Mail Item — surfaces in the forward preamble. */
    clientEmail: v.optional(v.string()),
    /**
     * Request types + notes the salesperson just synced to the Bitable Service
     * row. The Self-Forward preamble lists them so the salesperson's inbox copy
     * carries the same context the Feishu row does.
     */
    requestSelections: v.optional(
      v.array(v.object({ requestType: v.string(), note: v.string() })),
    ),
  },
  handler: async (_ctx, args): Promise<SelfForwardResult> => {
    console.log(
      `[m365] sendSelfForwardNote entry self=${args.selfEmail} msgIdLen=${args.originalMessageId.length} customer=${args.customerName ?? "(none)"} requests=${args.requestSelections?.length ?? 0}`,
    );
    const env = requireM365Env();
    console.log(
      `[m365] env ok tenant=${env.tenantId} clientId=${env.clientId.slice(0, 8)}...`,
    );
    const result = await runSelfForwardChain(
      {
        originalMessageId: args.originalMessageId,
        selfEmail: args.selfEmail,
        customerName: args.customerName,
        clientEmail: args.clientEmail,
        requestSelections: args.requestSelections,
      },
      env,
      (url, init) => fetch(url, init),
    );
    console.log(`[m365] sendSelfForwardNote result=${JSON.stringify(result)}`);
    return result;
  },
});
