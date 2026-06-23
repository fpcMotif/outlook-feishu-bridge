// Transport for Feishu Open Platform calls: one place that performs the fetch,
// unwraps the `{ code, msg, data }` envelope, and raises a structured error.
// No token policy here (see call.ts) and no convex imports, so it stays usable
// from both Convex runtimes and unit-testable with a mocked global fetch.

export const FEISHU_BASE = "https://open.feishu.cn/open-apis";

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
}

/**
 * Log the full failure envelope and throw {@link FeishuError}. Dumps everything
 * Feishu sent back — the bare {code, msg} envelope hides the support log id and
 * any nested `data.error` detail that triage needs.
 */
function throwFeishuFailure(
  response: Response,
  parsed: FeishuEnvelope,
  rawText: string,
  label: string | undefined,
): never {
  const logId =
    response.headers.get("X-Tt-Logid") ??
    response.headers.get("x-tt-logid") ??
    response.headers.get("X-Request-Id") ??
    "(none)";
  console.error(
    `[feishu] ${label ?? "call"} FAILED code=${parsed.code} msg=${parsed.msg} logId=${logId} body=${rawText.slice(0, 1000)}`,
  );
  throw new FeishuError(
    parsed.code,
    parsed.msg,
    label ?? "Feishu API",
    rateLimitResetMs((name) => response.headers.get(name)),
  );
}

/**
 * Perform one call to Feishu Open Platform and return the parsed response.
 * Returns the full parsed JSON (callers read `.data` or top-level fields).
 * Throws {@link FeishuError} when the envelope reports failure.
 */
export async function feishuFetch<T = unknown>(
  opts: FeishuFetchOptions,
): Promise<T> {
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
  });

  const rawText = await response.text();
  let parsed: FeishuEnvelope;
  try {
    parsed = JSON.parse(rawText) as FeishuEnvelope;
  } catch {
    console.error(
      `[feishu] ${opts.label ?? "call"} non-JSON response (status=${response.status}): ${rawText.slice(0, 500)}`,
    );
    throw new FeishuError(-1, `non-JSON response (status=${response.status})`, opts.label ?? "Feishu API");
  }
  console.log(`[feishu] ${opts.label ?? "call"} ${Date.now() - t0}ms`);
  const ok =
    parsed.code === 0 ||
    (opts.acceptStatusCode === true && parsed.StatusCode === 0);
  if (!ok) {
    throwFeishuFailure(response, parsed, rawText, opts.label);
  }
  return parsed as T;
}
