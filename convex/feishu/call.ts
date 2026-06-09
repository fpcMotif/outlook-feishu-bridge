// Token policy for Feishu Open Platform calls: pick the tenant or user token,
// build the URL, and delegate transport to feishuFetch. Endpoint actions call
// through here and are left with just their path + body shape.

import { Effect } from "effect";
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export interface FeishuRetryOptions {
  maxAttempts?: number;
  backoffMs?: (attempt: number) => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Effect v4 form of {@link withFeishuRateLimitRetry} (ADR-0029 pilot). Retry
 * ONLY rate-limit / in-flight dedup FeishuErrors (1254290 / 1254608 / 99991400)
 * with exponential backoff, honoring the server's `retryAfterMs` hint when
 * present. `Effect.catchIf` re-raises every non-matching error — and a matching
 * one once `maxAttempts` is spent — unchanged through the failure channel, so
 * `Effect.runPromise` rejects with the ORIGINAL FeishuError (Cause.squash keeps
 * the same instance). Callers' `instanceof FeishuError` / `.code` checks hold.
 *
 * `fn` and `sleep` stay injected (same DI seam as before) so this is unit-tested
 * with plain vitest at the Effect boundary (ADR-0019), no Convex runtime needed.
 */
export function withFeishuRateLimitRetryEffect<T>(
  fn: () => Promise<T>,
  opts: FeishuRetryOptions = {},
): Effect.Effect<T, unknown> {
  const maxAttempts = opts.maxAttempts ?? 4;
  const backoffMs = opts.backoffMs ?? ((attempt) => 500 * 2 ** attempt);
  const doSleep = opts.sleep ?? sleep;

  const attempt = (n: number): Effect.Effect<T, unknown> =>
    Effect.tryPromise({ try: fn, catch: (cause) => cause }).pipe(
      Effect.catchIf(
        // Retryable iff it's a rate-limit FeishuError AND budget remains; any
        // other error (or the last attempt) flows through catchIf untouched.
        (cause): cause is FeishuError =>
          cause instanceof FeishuError &&
          RATE_LIMIT_CODES.has(cause.code) &&
          n < maxAttempts - 1,
        // Honor the server's reset hint when present; else exp backoff.
        (cause) =>
          Effect.promise(() => doSleep(cause.retryAfterMs ?? backoffMs(n))).pipe(
            Effect.flatMap(() => attempt(n + 1)),
          ),
      ),
    );

  return attempt(0);
}

/**
 * Run a Feishu API call, retrying ONLY rate-limit / in-flight dedup errors
 * (1254290 TooManyRequest, 1254608 same request still in-flight, 99991400
 * frequency limit) with exponential backoff (500ms · 1s · 2s …). Honors
 * the server's `retryAfterMs` hint (x-ogw-ratelimit-reset / Retry-After)
 * when present. Any other error, or exhausting maxAttempts, rethrows unchanged.
 *
 * Thin Promise boundary over {@link withFeishuRateLimitRetryEffect} (Effect v4,
 * ADR-0029) so Convex action callers keep awaiting a plain `Promise<T>`.
 */
export function withFeishuRateLimitRetry<T>(
  fn: () => Promise<T>,
  opts: FeishuRetryOptions = {},
): Promise<T> {
  return Effect.runPromise(withFeishuRateLimitRetryEffect(fn, opts));
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
