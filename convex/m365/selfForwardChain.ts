// The Self-Forward chain — the four Graph calls that deliver "Note to myself"
// into the Initiator's own mailbox per Bitable Sync (ADR-0017).
//
// All endpoints are taken from the official Microsoft docs (the ONLY source of
// truth for M365 / Graph code, per ADR-0015):
//   OBO exchange:     https://learn.microsoft.com/entra/identity-platform/v2-oauth2-on-behalf-of-flow
//   createForward:    https://learn.microsoft.com/graph/api/message-createforward
//   message-update:   https://learn.microsoft.com/graph/api/message-update
//   message-send:     https://learn.microsoft.com/graph/api/message-send
//
// `fetch` is injected so the chain is unit-testable without the Convex runtime;
// the action wrapper in selfForward.ts supplies the global fetch.

import { buildSelfForwardPatchBody } from "./selfForwardMessage";

export type Fetcher = (
  url: string | URL,
  init?: RequestInit,
) => Promise<Response>;

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const MAIL_SEND_SCOPE = "https://graph.microsoft.com/Mail.Send";

export interface SelfForwardEnv {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

export interface SelfForwardInput {
  /** Office.js SSO bootstrap token — the `access_as_user` JWT for our AAD app. */
  bootstrap: string;
  /** Outlook REST v2 message id — converted via `Office.context.mailbox.convertToRestId`. */
  originalMessageId: string;
  /** The Mail Item's subject. May be empty — the builder substitutes `(no subject)`. */
  originalSubject: string | undefined;
  /** `Office.context.mailbox.userProfile.emailAddress` — the only recipient. */
  selfEmail: string;
}

export type SelfForwardStep = "obo" | "createForward" | "patch" | "send";

export type SelfForwardResult =
  | { ok: true }
  | { ok: false; step: SelfForwardStep; code: string; message: string };

interface GraphErrorEnvelope {
  error?: { code?: string; message?: string };
  // AAD OBO uses the OAuth2-standard `error` / `error_description` envelope.
  error_description?: string;
}

async function readError(
  res: Response,
): Promise<{ code: string; message: string }> {
  let body: GraphErrorEnvelope | string = "";
  try {
    body = (await res.json()) as GraphErrorEnvelope;
  } catch {
    try {
      body = await res.text();
    } catch {
      body = "";
    }
  }
  if (typeof body === "string") {
    return { code: `HTTP_${res.status}`, message: body || res.statusText };
  }
  // AAD shape:    { error: "invalid_grant", error_description: "..." }
  // Graph shape:  { error: { code: "ErrorAccessDenied", message: "..." } }
  if (typeof body.error === "string") {
    return {
      code: body.error,
      message: body.error_description ?? res.statusText,
    };
  }
  const err = body.error ?? {};
  return {
    code: err.code ?? `HTTP_${res.status}`,
    message: err.message ?? res.statusText,
  };
}

type StepFail = { ok: false; step: SelfForwardStep; code: string; message: string };

async function fail(step: SelfForwardStep, res: Response): Promise<StepFail> {
  const e = await readError(res);
  return { ok: false, step, code: e.code, message: e.message };
}

// Step 1 — On-Behalf-Of token exchange. The bootstrap token represents the
// signed-in user against our own AAD app; we exchange it for a delegated Graph
// access token scoped to Mail.Send. Doc:
//   https://learn.microsoft.com/entra/identity-platform/v2-oauth2-on-behalf-of-flow#middle-tier-access-token-request
async function exchangeOBO(
  input: SelfForwardInput,
  env: SelfForwardEnv,
  fetcher: Fetcher,
): Promise<string | StepFail> {
  const res = await fetcher(
    `https://login.microsoftonline.com/${env.tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        client_id: env.clientId,
        client_secret: env.clientSecret,
        assertion: input.bootstrap,
        requested_token_use: "on_behalf_of",
        scope: MAIL_SEND_SCOPE,
      }).toString(),
    },
  );
  if (!res.ok) return fail("obo", res);
  const json = (await res.json()) as { access_token?: string };
  return (
    json.access_token ?? {
      ok: false,
      step: "obo",
      code: "no_access_token",
      message: "OBO succeeded but returned no access_token",
    }
  );
}

// Step 2 — createForward. Returns a draft Message under /me/messages with the
// server-rendered forward body (original From/Sent/To/Subject header + body).
// Doc: https://learn.microsoft.com/graph/api/message-createforward
async function createForwardDraft(
  messageId: string,
  authHeader: Record<string, string>,
  fetcher: Fetcher,
): Promise<string | StepFail> {
  const res = await fetcher(
    `${GRAPH_BASE}/me/messages/${encodeURIComponent(messageId)}/createForward`,
    { method: "POST", headers: authHeader },
  );
  if (!res.ok) return fail("createForward", res);
  const draft = (await res.json()) as { id?: string };
  return (
    draft.id ?? {
      ok: false,
      step: "createForward",
      code: "no_draft_id",
      message: "createForward returned no draft id",
    }
  );
}

// Step 3 — PATCH the draft with the literal subject + the single self-recipient.
// Doc: https://learn.microsoft.com/graph/api/message-update
async function patchDraft(
  draftId: string,
  input: SelfForwardInput,
  authHeader: Record<string, string>,
  fetcher: Fetcher,
): Promise<true | StepFail> {
  const body = buildSelfForwardPatchBody({
    originalSubject: input.originalSubject,
    selfEmail: input.selfEmail,
  });
  const res = await fetcher(`${GRAPH_BASE}/me/messages/${draftId}`, {
    method: "PATCH",
    headers: { ...authHeader, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.ok ? true : fail("patch", res);
}

// Step 4 — send the draft. Returns 202 Accepted with no body.
// Doc: https://learn.microsoft.com/graph/api/message-send
async function sendDraft(
  draftId: string,
  authHeader: Record<string, string>,
  fetcher: Fetcher,
): Promise<true | StepFail> {
  const res = await fetcher(`${GRAPH_BASE}/me/messages/${draftId}/send`, {
    method: "POST",
    headers: authHeader,
  });
  return res.ok ? true : fail("send", res);
}

export async function runSelfForwardChain(
  input: SelfForwardInput,
  env: SelfForwardEnv,
  fetcher: Fetcher,
): Promise<SelfForwardResult> {
  const obo = await exchangeOBO(input, env, fetcher);
  if (typeof obo !== "string") return obo;
  const authHeader = { authorization: `Bearer ${obo}` };

  const draftId = await createForwardDraft(input.originalMessageId, authHeader, fetcher);
  if (typeof draftId !== "string") return draftId;

  const patched = await patchDraft(draftId, input, authHeader, fetcher);
  if (patched !== true) return patched;

  const sent = await sendDraft(draftId, authHeader, fetcher);
  if (sent !== true) return sent;

  return { ok: true };
}
