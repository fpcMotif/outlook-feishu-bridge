// Token policy for Feishu Open Platform calls: pick the tenant or user token,
// build the URL, and delegate transport to feishuFetch. Endpoint actions call
// through here and are left with just their path + body shape.

import type { ActionCtx } from "../_generated/server";
import { getTenantAccessToken } from "./auth";
import { getUserAccessToken } from "./userAuth";
import { feishuFetch, FEISHU_BASE } from "./client";

export interface CallFeishuOptions {
  /** Path under the Feishu open-apis base, e.g. "/im/v1/messages". */
  path: string;
  method?: string;
  /** Which token to acquire. "user" requires sessionId. */
  auth: "tenant" | "user";
  sessionId?: string;
  /** Pre-resolved token — pass it to reuse one token across a burst of calls. */
  token?: string;
  query?: Record<string, string>;
  json?: unknown;
  form?: FormData;
  label?: string;
}

/** Resolve the tenant or user access token for a Feishu call. */
export function resolveFeishuToken(
  ctx: ActionCtx,
  auth: "tenant" | "user",
  sessionId?: string,
): Promise<string> {
  if (auth === "user") {
    if (!sessionId) {
      throw new Error("sessionId is required for user-authenticated Feishu calls");
    }
    return getUserAccessToken(ctx, sessionId);
  }
  return getTenantAccessToken(ctx);
}

/**
 * Authenticated call to Feishu Open Platform. Returns the inner `data` payload,
 * or throws {@link FeishuError} (bad envelope) / Error (success but no data).
 */
export async function callFeishu<T = unknown>(
  ctx: ActionCtx,
  opts: CallFeishuOptions,
): Promise<T> {
  const token = opts.token ?? (await resolveFeishuToken(ctx, opts.auth, opts.sessionId));
  const qs = opts.query
    ? `?${new URLSearchParams(opts.query).toString()}`
    : "";

  const parsed = await feishuFetch<{ data?: T }>({
    url: `${FEISHU_BASE}${opts.path}${qs}`,
    method: opts.method,
    token,
    json: opts.json,
    form: opts.form,
    label: opts.label,
  });
  if (parsed.data === undefined) {
    throw new Error(`${opts.label ?? "Feishu API"} succeeded but returned no data`);
  }
  return parsed.data;
}
