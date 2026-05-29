// SPA-side driver for the Self-Forward copy (ADR-0017). The taskpane passes
// the current Mail Item's REST/Graph message id to a Convex action. Convex owns
// the Microsoft Graph call via app-only native `message: forward`, so the
// browser does not need Office.js SSO, MSAL, or a Graph token.

import { useCallback } from "react";
import { useAction } from "convex/react";

import { api } from "../../convex/_generated/api";

export type SelfForwardResult =
  | { ok: true; requestId?: string }
  | { ok: false; step: string; code: string; message: string };

export interface SelfForwardRequestSelectionArg {
  requestType: string;
  note: string;
}

export interface SelfForwardArgs {
  originalMessageId: string;
  selfEmail: string;
  /** Customer picked in the Customer Picker. */
  customerName?: string;
  /** Sender of the original Mail Item. */
  clientEmail?: string;
  /** Request types + notes that just landed in the Bitable Service row. */
  requestSelections?: SelfForwardRequestSelectionArg[];
}

export function useSelfForward() {
  const send = useAction(api.m365.selfForward.sendSelfForwardNote);

  const sendNote = useCallback(
    async (args: SelfForwardArgs): Promise<SelfForwardResult> => {
      console.log(
        `[selfForward] start self=${args.selfEmail} messageIdLen=${args.originalMessageId.length}`,
      );
      try {
        const result = await send(args);
        console.log(`[selfForward] action result=${JSON.stringify(result)}`);
        return result;
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : "Convex action failed";
        console.error(`[selfForward] action invocation FAILED ${message}`);
        return { ok: false, step: "convex", code: "action_error", message };
      }
    },
    [send],
  );

  return { sendNote };
}
