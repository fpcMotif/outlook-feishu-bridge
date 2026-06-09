import * as Sentry from "@sentry/react";
import { subscribeDebug, getDebugEntries, type DebugEntry } from "./debug";
import {
  isRetryableUploadError,
  isUnreadableFileError,
} from "./office/attachmentUpload";

// Error + performance monitoring. The DSN is a build-time public value
// (VITE_SENTRY_DSN, set in .env.deploy); without it this is a no-op, so dev and
// un-keyed builds are unaffected. Ingest defaults to DIRECT to Sentry's SaaS; the
// ECS Host build sets VITE_SENTRY_TUNNEL=/_sentry/ to route envelopes through its
// in-region nginx proxy instead (ADR-0007 / ADR-0009). The Global Host (Cloudflare)
// build leaves it unset — non-CN users reach *.ingest.sentry.io directly.
const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
const tunnel = import.meta.env.VITE_SENTRY_TUNNEL as string | undefined;

export function toBreadcrumbLevel(level: DebugEntry["level"]): "warning" | "info" | "error" {
  return level === "warn" ? "warning" : level === "log" ? "info" : "error";
}

export function buildSentryOptions(
  dsnValue: string,
  tunnelValue: string | undefined,
  mode: string,
): Sentry.BrowserOptions {
  return {
    dsn: dsnValue,
    // tunnel is set only on the ECS Host build (VITE_SENTRY_TUNNEL=/_sentry/) so CN
    // users' telemetry reaches Sentry via the same-origin nginx proxy; unset on the
    // Global Host build = direct ingest. See ADR-0007 (observability) + ADR-0009.
    ...(tunnelValue ? { tunnel: tunnelValue } : {}),
    environment: mode,
    // Capture every sync — this is a low-volume internal add-in.
    tracesSampleRate: 1,
    // Auto pageload/navigation + fetch/xhr timing spans (the load cycle, the
    // Convex calls). Trace headers are NOT propagated cross-origin by default,
    // so Convex/Feishu requests are timed without injecting headers they'd reject.
    // Disable Sentry's own console breadcrumbs — our debug mirror below already
    // forwards the (F12-captured) console + dload/dtime marks, so this avoids
    // duplicate breadcrumbs.
    integrations: [
      Sentry.browserTracingIntegration(),
      Sentry.breadcrumbsIntegration({ console: false }),
    ],
  };
}

export function forwardLatestBreadcrumb(
  entries: DebugEntry[],
  lastId: number,
  addBreadcrumb: (b: { category: string; message: string; level: "warning" | "info" | "error" }) => void,
): number {
  const e = entries.at(-1);
  if (!e || e.id <= lastId) return lastId;
  addBreadcrumb({
    category: "dbg",
    message: e.msg,
    level: toBreadcrumbLevel(e.level),
  });
  return e.id;
}

export function initSentry(): void {
  if (!dsn) return;

  Sentry.init(buildSentryOptions(dsn, tunnel, import.meta.env.MODE));

  // Mirror the on-screen DebugPanel timeline into Sentry breadcrumbs, so any
  // captured error carries the full load + sync timing (dload/dtime/dlog).
  let lastId = -1;
  subscribeDebug(() => {
    lastId = forwardLatestBreadcrumb(getDebugEntries(), lastId, (b) =>
      Sentry.addBreadcrumb(b),
    );
  });
}

export function reportSyncError(err: unknown): void {
  Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
    tags: { feature: "base-sync" },
  });
}

export type UploadErrorKind =
  | "unreadable"
  | "transport"
  | "server"
  | "malformed"
  | "unknown";

export function classifyUploadError(err: unknown): UploadErrorKind {
  if (isUnreadableFileError(err)) return "unreadable";
  if (isRetryableUploadError(err)) return "transport";
  const message = err instanceof Error ? err.message : String(err);
  if (/\((4\d\d|5\d\d)\)/.test(message)) return "server";
  if (/invalid JSON/i.test(message)) return "malformed";
  return "unknown";
}

// Report a TERMINAL attachment-upload failure (after uploadBlobWithRetry's
// in-flight retries are exhausted) as a HANDLED Sentry event — so it stops
// surfacing as an unhandled rejection and carries the size/type/kind needed to
// chart failures (by file size, type, and Sentry's own geo) WITHOUT leaking the
// filename (which can carry customer info). An unreadable cloud-file pick is a
// client-environment issue the user fixes with Re-add, so it logs at "warning";
// genuine upload failures log at "error".
export function reportUploadError(
  err: unknown,
  context: { bytes: number; ext: string; attempts: number },
): void {
  const kind = classifyUploadError(err);
  Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
    level: kind === "unreadable" ? "warning" : "error",
    tags: {
      feature: "attachment-upload",
      uploadErrorKind: kind,
      ext: context.ext || "(none)",
    },
    extra: { bytes: context.bytes, attempts: context.attempts },
  });
}


