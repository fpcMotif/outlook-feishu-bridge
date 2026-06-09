// Token policy for Feishu Open Platform calls: pick the tenant or user token,
// build the URL, and delegate transport to feishuFetch. Endpoint actions call
// through here and are left with just their path + body shape.

import type { ActionCtx } from "../_generated/server";
import { getTenantAccessToken } from "./auth";
import { getUserAccessToken } from "./userAuth";
import { feishuFetch, FEISHU_BASE, FeishuError } from "./client";

/** Feishu Bitable / generic API: too many requests (throttled). */
export const FEISHU_TOO_MANY_REQUEST_CODE = 1254290;

/** Feishu Bitable: same client_token request is still in-flight on the server. */
export const FEISHU_DUPLICATE_REQUEST_CODE = 1254608;

/** Feishu Drive / gateway frequency-limit code (99991400). */
export const FEISHU_RATE_LIMIT_CODE = 99991400;

const RATE_LIMIT_CODES = new Set([
  FEISHU_TOO_MANY_REQUEST_CODE,
  FEISHU_DUPLICATE_REQUEST_CODE,
  FEISHU_RATE_LIMIT_CODE,
]);

/**
 * The single rate-limit classifier for every Feishu call (Bitable records AND
 * Drive uploads). Returns true only for a {@link FeishuError} whose code is one
 * of the retry-with-backoff codes — 1254290 (TooManyRequest), 1254608 (same
 * request still in-flight), 99991400 (Drive/gateway frequency limit). Any other
 * error (including a non-FeishuError) is not a transient throttle: don't retry.
 */
export function isFeishuRateLimited(error: unknown): boolean {
  return error instanceof FeishuError && RATE_LIMIT_CODES.has(error.code);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Run a Feishu API call, retrying ONLY rate-limit / in-flight dedup errors
 * (1254290 TooManyRequest, 1254608 same request still in-flight, 99991400
 * frequency limit) with exponential backoff (500ms · 1s · 2s …). Honors
 * the server's `retryAfterMs` hint (x-ogw-ratelimit-reset / Retry-After)
 * when present. Any other error, or exhausting maxAttempts, rethrows unchanged.
 */
export async function withFeishuRateLimitRetry<T>(
  fn: () => Promise<T>,
  opts: {
    maxAttempts?: number;
    backoffMs?: (attempt: number) => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 4;
  const backoffMs = opts.backoffMs ?? ((attempt) => 500 * 2 ** attempt);
  const doSleep = opts.sleep ?? sleep;
  for (let attempt = 0; ; attempt++) {
    try {
      // eslint-disable-next-line react-doctor/async-await-in-loop -- retry loop is inherently sequential (rate-limit backoff)
      return await fn();
    } catch (e: unknown) {
      if (!isFeishuRateLimited(e) || attempt >= maxAttempts - 1) throw e;
      // Honor the server's reset hint when present; else exp backoff.
      const hinted = e instanceof FeishuError ? e.retryAfterMs : undefined;
      await doSleep(hinted ?? backoffMs(attempt));
    }
  }
}

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
