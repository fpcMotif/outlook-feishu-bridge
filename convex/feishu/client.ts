// Transport for Feishu Open Platform calls: one place that performs the fetch,
// unwraps the `{ code, msg, data }` envelope, and raises a structured error.
// No token policy here (see call.ts) and no convex imports, so it stays usable
// from both Convex runtimes and unit-testable with a mocked global fetch.
//
// The transport is an Effect v4 pipeline (`feishuFetchEffect`, ADR-0030):
// typed failure channel (FeishuError | FeishuTimeoutError) plus a bounded
// whole-exchange budget wired to a real AbortSignal. `feishuFetch` stays the
// thin Promise boundary so existing callers and mocks are unchanged.
/* eslint-disable max-classes-per-file -- the transport owns its complete
   two-error taxonomy (FeishuError | FeishuTimeoutError, ADR-0030); splitting
   the timeout error into its own file would hide half the failure channel. */

import { Effect } from "effect";

export const FEISHU_BASE = "https://open.feishu.cn/open-apis";

/**
 * Whole-exchange budget for one Feishu call (request sent + body read), in ms.
 * Before ADR-0030 there was NO bound: a hung Feishu socket pinned the Convex
 * action until the platform killed it. Override per call via
 * {@link FeishuFetchOptions.timeoutMs} (Drive `upload_all` uses a larger one).
 */
export const DEFAULT_FEISHU_TIMEOUT_MS = 30_000;

/** Thrown when Feishu returns a non-zero `code` (or, for webhooks, StatusCode). */
export class FeishuError extends Error {
  readonly code: number;
  readonly feishuMsg: string;
  /** Server's "wait this long" hint (ms) from a 429, when present (ADR-0027). */
  readonly retryAfterMs?: number;
  constructor(code: number, feishuMsg: string, label: string, retryAfterMs?: number) {
    super(`${label} failed (code ${code}): ${feishuMsg}`);
    this.name = "FeishuError";
    this.code = code;
    this.feishuMsg = feishuMsg;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Raised when one Feishu exchange exceeds its `timeoutMs` budget (ADR-0030).
 * Deliberately NOT a FeishuError: it carries no Feishu business code, so the
 * in-process rate-limit retry never replays it — it fails fast into the
 * durable layers (Request sync outbox / token refresh / Attachment Fill),
 * which already treat a non-FeishuError as transient.
 */
export class FeishuTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = "FeishuTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * The server's rate-limit recovery hint in ms, read from a 429 response. Feishu
 * docs call `x-ogw-ratelimit-reset` (seconds until reset) the best signal for
 * when to retry; we fall back to the standard `Retry-After` (also seconds).
 * Honoring it beats blind exponential backoff (ADR-0027). Returns undefined when
 * neither header is a non-negative number.
 */
export function rateLimitResetMs(
  getHeader: (name: string) => string | null,
): number | undefined {
  const raw = getHeader("x-ogw-ratelimit-reset") ?? getHeader("Retry-After");
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined;
}

interface FeishuEnvelope {
  code: number;
  msg: string;
  // Webhook bot responses carry StatusCode instead of/alongside code.
  StatusCode?: number;
}

export interface FeishuFetchOptions {
  url: string;
  method?: string;
  /** Bearer token; omit for the unauthenticated token-bootstrap and webhook calls. */
  token?: string;
  /** JSON request body (sets Content-Type and stringifies). */
  json?: unknown;
  /** Multipart body (Content-Type/boundary set by the runtime). Mutually exclusive with json. */
  form?: FormData;
  /** Label for the error message, e.g. "Bitable create". */
  label?: string;
  /** Webhook bot also succeeds when StatusCode === 0. */
  acceptStatusCode?: boolean;
  /** Whole-exchange budget in ms; default {@link DEFAULT_FEISHU_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** What one wire exchange hands to the envelope decoder. */
interface RawExchange {
  status: number;
  rawText: string;
  getHeader: (name: string) => string | null;
  elapsedMs: number;
}

/**
 * The raw wire leg: send the request, read the body text. A rejection here
 * (network failure, abort) is an unexpected transport defect, not a typed
 * Feishu failure — it propagates unchanged through the Promise boundary, as it
 * did before ADR-0030. The AbortSignal comes from the Effect runtime: when the
 * timeout interrupts the fiber, the socket is actually torn down.
 */
async function performExchange(
  opts: FeishuFetchOptions,
  signal: AbortSignal,
): Promise<RawExchange> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

  let body: BodyInit | undefined;
  if (opts.form) {
    body = opts.form;
  } else if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.json);
  }

  const t0 = Date.now();
  const response = await fetch(opts.url, {
    method: opts.method ?? "POST",
    headers,
    body,
    signal,
  });
  const rawText = await response.text();
  return {
    status: response.status,
    rawText,
    getHeader: (name) => response.headers.get(name),
    elapsedMs: Date.now() - t0,
  };
}

/** Decode the Feishu envelope; non-JSON keeps the load-bearing `-1` sentinel. */
function decodeEnvelope<T>(
  opts: FeishuFetchOptions,
  raw: RawExchange,
): Effect.Effect<T, FeishuError> {
  let parsed: FeishuEnvelope;
  try {
    parsed = JSON.parse(raw.rawText) as FeishuEnvelope;
  } catch {
    console.error(
      `[feishu] ${opts.label ?? "call"} non-JSON response (status=${raw.status}): ${raw.rawText.slice(0, 500)}`,
    );
    return Effect.fail(
      new FeishuError(-1, `non-JSON response (status=${raw.status})`, opts.label ?? "Feishu API"),
    );
  }
  console.log(`[feishu] ${opts.label ?? "call"} ${raw.elapsedMs}ms`);
  const ok =
    parsed.code === 0 ||
    (opts.acceptStatusCode === true && parsed.StatusCode === 0);
  if (!ok) {
    // Dump everything Feishu sent back — the bare {code, msg} envelope hides
    // the support log id and any nested `data.error` detail that triage needs.
    const logId =
      raw.getHeader("X-Tt-Logid") ??
      raw.getHeader("x-tt-logid") ??
      raw.getHeader("X-Request-Id") ??
      "(none)";
    console.error(
      `[feishu] ${opts.label ?? "call"} FAILED code=${parsed.code} msg=${parsed.msg} logId=${logId} body=${raw.rawText.slice(0, 1000)}`,
    );
    return Effect.fail(
      new FeishuError(
        parsed.code,
        parsed.msg,
        opts.label ?? "Feishu API",
        rateLimitResetMs(raw.getHeader),
      ),
    );
  }
  return Effect.succeed(parsed as T);
}

/**
 * Effect v4 form of {@link feishuFetch} (ADR-0030): one call to Feishu Open
 * Platform as a typed pipeline. Expected failures live in the error channel —
 * {@link FeishuError} (non-zero envelope code, with the `-1` non-JSON sentinel
 * intact) and {@link FeishuTimeoutError} (the whole-exchange budget elapsed).
 * Unexpected transport failures (network/DNS/abort) remain defects and reach
 * Promise callers as the original thrown error. On timeout the in-flight fetch
 * is aborted via its AbortSignal, so the socket is freed, not orphaned.
 */
export function feishuFetchEffect<T = unknown>(
  opts: FeishuFetchOptions,
): Effect.Effect<T, FeishuError | FeishuTimeoutError> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FEISHU_TIMEOUT_MS;
  return Effect.promise((signal) => performExchange(opts, signal)).pipe(
    Effect.flatMap((raw) => decodeEnvelope<T>(opts, raw)),
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () =>
        Effect.fail(new FeishuTimeoutError(opts.label ?? "Feishu API", timeoutMs)),
    }),
  );
}

/**
 * Perform one call to Feishu Open Platform and return the parsed response.
 * Returns the full parsed JSON (callers read `.data` or top-level fields).
 * Throws {@link FeishuError} when the envelope reports failure and
 * {@link FeishuTimeoutError} past the call budget.
 *
 * Thin Promise boundary over {@link feishuFetchEffect} (Effect v4, ADR-0030).
 */
export function feishuFetch<T = unknown>(
  opts: FeishuFetchOptions,
): Promise<T> {
  return Effect.runPromise(feishuFetchEffect<T>(opts));
}
