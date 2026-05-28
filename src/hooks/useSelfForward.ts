// SPA-side driver for the Self-Forward "Note to myself" copy (ADR-0017).
// Gets an Office.js SSO bootstrap token, hands it to the Convex action that
// runs the OBO exchange + the createForward → PATCH → send chain against
// Microsoft Graph. Soft-fail: any failure returns an `ok: false` envelope, never
// throws — the intake screen surfaces the retry chip without disturbing the
// authoritative Bitable row.
//
// Officially-cited references:
//   OfficeRuntime.auth.getAccessToken
//     https://learn.microsoft.com/javascript/api/office-runtime/officeruntime.auth#office-runtime-officeruntime-auth-getaccesstoken-member(1)
//   SSO concept + manifest WebApplicationInfo
//     https://learn.microsoft.com/office/dev/add-ins/develop/sso-in-office-add-ins
//   SSO error codes
//     https://learn.microsoft.com/office/dev/add-ins/develop/troubleshoot-sso-in-office-add-ins

import { useCallback } from "react";
import { useAction } from "convex/react";

import { api } from "../../convex/_generated/api";

export type SelfForwardResult =
  | { ok: true }
  | { ok: false; step: string; code: string; message: string };

export interface SelfForwardArgs {
  originalMessageId: string;
  originalSubject?: string;
  selfEmail: string;
}

async function getBootstrapToken(): Promise<string> {
  // SSO is only available when Office.js is fully loaded; in dev preview /
  // browser there is no OfficeRuntime and this throws early. The caller catches
  // and surfaces it as a soft-fail with a recognisable code.
  if (typeof OfficeRuntime === "undefined" || !OfficeRuntime?.auth?.getAccessToken) {
    throw new Error("OfficeRuntime.auth.getAccessToken is not available in this host");
  }
  return await OfficeRuntime.auth.getAccessToken({
    allowSignInPrompt: true,
    allowConsentPrompt: true,
    forMSGraphAccess: true,
  });
}

export function useSelfForward() {
  const send = useAction(api.m365.selfForward.sendSelfForwardNote);

  const sendNote = useCallback(
    async (args: SelfForwardArgs): Promise<SelfForwardResult> => {
      let bootstrap: string;
      try {
        bootstrap = await getBootstrapToken();
      } catch (e: unknown) {
        // Office.js SSO error codes (13000-series) carry the failure mode; we
        // pass them through unchanged so the UI / logs read the same error
        // surface as MS Learn documents.
        const code =
          typeof e === "object" && e !== null && "code" in e
            ? String((e as { code: unknown }).code)
            : "sso_unavailable";
        const message = e instanceof Error ? e.message : "SSO bootstrap failed";
        return { ok: false, step: "sso", code, message };
      }
      try {
        return await send({
          bootstrap,
          originalMessageId: args.originalMessageId,
          originalSubject: args.originalSubject,
          selfEmail: args.selfEmail,
        });
      } catch (e: unknown) {
        return {
          ok: false,
          step: "convex",
          code: "action_error",
          message: e instanceof Error ? e.message : "Convex action failed",
        };
      }
    },
    [send],
  );

  return { sendNote };
}
