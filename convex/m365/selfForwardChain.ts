// The Self-Forward chain: app-only Graph token, then native Outlook forward.
//
// We intentionally call `message: forward` instead of composing a synthetic
// `sendMail` body. Outlook/Exchange owns the forwarded header and original
// message rendering, which avoids mangling the original email body.
//
// Official refs (the source of truth per ADR-0015):
//   client_credentials: https://learn.microsoft.com/entra/identity-platform/v2-oauth2-client-creds-grant-flow
//   message-forward:    https://learn.microsoft.com/graph/api/message-forward

import {
  buildSelfForwardForwardBody,
  type SelfForwardRequestSelection,
} from "./selfForwardMessage";

export type Fetcher = (
  url: string | URL,
  init?: RequestInit,
) => Promise<Response>;

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const GRAPH_APP_ONLY_SCOPE = "https://graph.microsoft.com/.default";

export interface SelfForwardEnv {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

export interface SelfForwardInput {
  /** REST/Graph message id converted from Office.js itemId with convertToRestId. */
  originalMessageId: string;
  /** Outlook user's mailbox; it is the sending mailbox and primary recipient. */
  selfEmail: string;
  /** Customer picked in the Customer Picker — surfaced in the forward preamble. */
  customerName?: string;
  /** Original sender's email; surfaced in the forward preamble. */
  clientEmail?: string;
  /** Request types + notes that just landed in the Bitable Service row. */
  requestSelections?: SelfForwardRequestSelection[];
}

export type SelfForwardStep = "token" | "forward";

export type SelfForwardResult =
  | { ok: true; requestId?: string }
  | { ok: false; step: SelfForwardStep; code: string; message: string };

interface AadErrorEnvelope {
  error?: string | { code?: string; message?: string };
  error_description?: string;
  error_codes?: number[];
}

async function readError(
  res: Response,
): Promise<{ code: string; message: string }> {
  let body: AadErrorEnvelope | string = "";
  try {
    body = (await res.json()) as AadErrorEnvelope;
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
  const logId =
    res.headers.get("request-id") ??
    res.headers.get("x-ms-request-id") ??
    res.headers.get("client-request-id") ??
    "(none)";
  console.error(
    `[m365] step=${step} FAILED status=${res.status} code=${e.code} msg=${e.message} ms-request-id=${logId}`,
  );
  return { ok: false, step, code: e.code, message: e.message };
}

async function acquireAppToken(
  env: SelfForwardEnv,
  fetcher: Fetcher,
): Promise<string | StepFail> {
  const res = await fetcher(
    `https://login.microsoftonline.com/${env.tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: env.clientId,
        client_secret: env.clientSecret,
        scope: GRAPH_APP_ONLY_SCOPE,
      }).toString(),
    },
  );
  if (!res.ok) return fail("token", res);
  const json = (await res.json()) as { access_token?: string };
  return (
    json.access_token ?? {
      ok: false,
      step: "token",
      code: "no_access_token",
      message: "client_credentials succeeded but returned no access_token",
    }
  );
}

async function forwardOriginalMessage(
  token: string,
  input: SelfForwardInput,
  fetcher: Fetcher,
): Promise<{ ok: true; requestId?: string } | StepFail> {
  const body = buildSelfForwardForwardBody({
    selfEmail: input.selfEmail,
    customerName: input.customerName,
    clientEmail: input.clientEmail,
    requestSelections: input.requestSelections,
  });
  const res = await fetcher(
    `${GRAPH_BASE}/users/${encodeURIComponent(input.selfEmail)}/messages/${encodeURIComponent(input.originalMessageId)}/forward`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  if (res.status === 202) {
    const requestId =
      res.headers.get("request-id") ??
      res.headers.get("x-ms-request-id") ??
      undefined;
    return { ok: true, requestId };
  }
  return fail("forward", res);
}

export async function runSelfForwardChain(
  input: SelfForwardInput,
  env: SelfForwardEnv,
  fetcher: Fetcher,
): Promise<SelfForwardResult> {
  console.log(
    `[m365] chain step=token start tenant=${env.tenantId} clientId=${env.clientId.slice(0, 8)}...`,
  );
  const token = await acquireAppToken(env, fetcher);
  if (typeof token !== "string") return token;
  console.log(`[m365] chain step=token OK tokenLen=${token.length}`);

  console.log(
    `[m365] chain step=forward start self=${input.selfEmail} messageIdLen=${input.originalMessageId.length}`,
  );
  const result = await forwardOriginalMessage(token, input, fetcher);
  if ("step" in result) return result;
  console.log(`[m365] chain step=forward OK requestId=${result.requestId ?? "(none)"}`);

  return result;
}
