// Token policy for Feishu Open Platform calls: pick the tenant or user token,
// build the URL, and delegate transport to feishuFetch. Endpoint actions call
// through here and are left with just their path + body shape.

import { Effect } from "effect";
import type { ActionCtx } from "../_generated/server";
import { getTenantAccessToken } from "./auth";
import { getUserAccessToken } from "./userAuth";
import { feishuFetchEffect, FEISHU_BASE, FeishuError } from "./client";

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
 * Effect-native rate-limit retry (ADR-0029/0030): re-run `self` while its
 * failure is a rate-limit / in-flight dedup FeishuError (1254290 / 1254608 /
 * 99991400) and attempt budget remains, with exponential backoff honoring the
 * server's `retryAfterMs` hint. `Effect.catchIf` re-raises every non-matching
 * error — and a matching one once `maxAttempts` is spent — unchanged through
 * the failure channel, so `Effect.runPromise` rejects with the ORIGINAL
 * FeishuError (Cause.squash keeps the same instance). A FeishuTimeoutError is
 * deliberately NOT matched: a blown call budget fails fast to the durable
 * layers instead of replaying in-process. Because an Effect is a re-runnable
 * description, every attempt re-executes ALL of `self` — including token
 * resolution when composed inside {@link callFeishuEffect}.
 */
export function retryFeishuRateLimit<A, E>(
  self: Effect.Effect<A, E>,
  opts: FeishuRetryOptions = {},
): Effect.Effect<A, E> {
  const maxAttempts = opts.maxAttempts ?? 4;
  const backoffMs = opts.backoffMs ?? ((attempt) => 500 * 2 ** attempt);
  const doSleep = opts.sleep ?? sleep;

  const attempt = (n: number): Effect.Effect<A, E> =>
    self.pipe(
      Effect.catchIf(
        // Retryable iff it's a rate-limit FeishuError AND budget remains; any
        // other error (or the last attempt) flows through catchIf untouched.
        (cause): cause is E & FeishuError =>
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
 * Effect v4 form of {@link withFeishuRateLimitRetry} (ADR-0029 pilot): the
 * Promise-thunk seam over {@link retryFeishuRateLimit}. `fn` and `sleep` stay
 * injected (same DI seam as before) so this is unit-tested with plain vitest
 * at the Effect boundary (ADR-0019), no Convex runtime needed.
 */
export function withFeishuRateLimitRetryEffect<T>(
  fn: () => Promise<T>,
  opts: FeishuRetryOptions = {},
): Effect.Effect<T, unknown> {
  return retryFeishuRateLimit(
    Effect.tryPromise({ try: fn, catch: (cause) => cause }),
    opts,
  );
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
  /** Whole-exchange budget in ms; default DEFAULT_FEISHU_TIMEOUT_MS (client.ts). */
  timeoutMs?: number;
  /**
   * Compose the rate-limit retry INTO the call pipeline (ADR-0030): each
   * attempt re-resolves the token (unless pre-resolved) and re-runs the fetch,
   * exactly like the old call-site `withFeishuRateLimitRetry(() => callFeishu(…))`
   * wrap, but as one Effect with a single runtime entry. `true` = default
   * policy; pass FeishuRetryOptions to tune attempts/backoff.
   */
  retry?: true | FeishuRetryOptions;
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
 * Effect v4 form of {@link callFeishu} (ADR-0030): one authenticated Feishu
 * call as a single pipeline — token resolve → transport (typed errors +
 * call budget, see feishuFetchEffect) → `data` unwrap — with the rate-limit
 * retry composed around the WHOLE sequence when `opts.retry` is set, so a
 * retried attempt re-resolves its token just like the old call-site wrap.
 * The error channel stays `unknown`: token resolution can raise anything
 * (Convex/db errors), and preserving the original instances through the
 * boundary is the contract callers' `instanceof` checks rely on.
 */
export function callFeishuEffect<T = unknown>(
  ctx: ActionCtx,
  opts: CallFeishuOptions,
): Effect.Effect<T, unknown> {
  const label = opts.label ?? "Feishu API";
  const qs = opts.query
    ? `?${new URLSearchParams(opts.query).toString()}`
    : "";

  const token =
    opts.token === undefined
      ? Effect.tryPromise({
          try: () => resolveFeishuToken(ctx, opts.auth, opts.sessionId),
          catch: (cause) => cause,
        })
      : Effect.succeed(opts.token);

  const once: Effect.Effect<T, unknown> = token.pipe(
    Effect.flatMap((resolved) =>
      feishuFetchEffect<{ data?: T }>({
        url: `${FEISHU_BASE}${opts.path}${qs}`,
        method: opts.method,
        token: resolved,
        json: opts.json,
        form: opts.form,
        label: opts.label,
        timeoutMs: opts.timeoutMs,
      }),
    ),
    Effect.flatMap((parsed) =>
      parsed.data === undefined
        ? Effect.fail(new Error(`${label} succeeded but returned no data`))
        : Effect.succeed(parsed.data),
    ),
  );

  return opts.retry
    ? retryFeishuRateLimit(once, opts.retry === true ? {} : opts.retry)
    : once;
}

/**
 * Authenticated call to Feishu Open Platform. Returns the inner `data` payload,
 * or throws {@link FeishuError} (bad envelope) / FeishuTimeoutError (budget) /
 * Error (success but no data).
 *
 * Thin Promise boundary over {@link callFeishuEffect} (Effect v4, ADR-0030).
 */
export function callFeishu<T = unknown>(
  ctx: ActionCtx,
  opts: CallFeishuOptions,
): Promise<T> {
  return Effect.runPromise(callFeishuEffect<T>(ctx, opts));
}
