import * as Sentry from "@sentry/react";
import { subscribeDebug, getDebugEntries, dlog } from "./debug";
import type { ForwardOutcome } from "./forward/forwardEmail";

// Error + performance monitoring. The DSN is a build-time public value
// (VITE_SENTRY_DSN, set in .env.deploy); without it this is a no-op, so dev and
// un-keyed builds are unaffected. Ingest defaults to DIRECT to Sentry's SaaS; the
// ECS Host build sets VITE_SENTRY_TUNNEL=/_sentry/ to route envelopes through its
// in-region nginx proxy instead (ADR-0007 / ADR-0009). The Global Host (Cloudflare)
// build leaves it unset — non-CN users reach *.ingest.sentry.io directly.
const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
const tunnel = import.meta.env.VITE_SENTRY_TUNNEL as string | undefined;

export function initSentry(): void {
  if (!dsn) return;

  Sentry.init({
    dsn,
    // tunnel is set only on the ECS Host build (VITE_SENTRY_TUNNEL=/_sentry/) so CN
    // users' telemetry reaches Sentry via the same-origin nginx proxy; unset on the
    // Global Host build = direct ingest. See ADR-0007 (observability) + ADR-0009.
    ...(tunnel ? { tunnel } : {}),
    environment: import.meta.env.MODE,
    // Capture every forward — this is a low-volume internal add-in.
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
  });

  // Mirror the on-screen DebugPanel timeline into Sentry breadcrumbs, so any
  // captured error carries the full load + forward timing (dload/dtime/dlog).
  let lastId = -1;
  subscribeDebug(() => {
    const entries = getDebugEntries();
    const e = entries.at(-1);
    if (!e || e.id <= lastId) return;
    lastId = e.id;
    Sentry.addBreadcrumb({
      category: "dbg",
      message: e.msg,
      level: e.level === "warn" ? "warning" : e.level === "log" ? "info" : e.level,
    });
  });
}

/** Report a forward's requested-vs-delivered outcome. Always logs a summary;
 *  raises a Sentry warning when something the user asked for was silently
 *  dropped (no exception thrown) — the "missing behavior" signal. */
export function reportForwardOutcome(o: ForwardOutcome): void {
  const inlineEligible = o.attachments.requested - o.attachments.oversize;
  const gaps: string[] = [];
  if (o.pdf.requested && !o.pdf.delivered) gaps.push("PDF missing");
  if (o.doc.requested && !o.doc.delivered) gaps.push("Doc missing");
  if (o.attachments.delivered < inlineEligible) {
    gaps.push(`attachments ${o.attachments.delivered}/${inlineEligible} sent`);
  }
  if (o.attachments.oversize > 0) gaps.push(`${o.attachments.oversize} attachment(s) >30MB not inline`);

  const summary =
    `forward outcome — pdf ${Number(o.pdf.delivered)}/${Number(o.pdf.requested)}, ` +
    `attachments ${o.attachments.delivered}/${o.attachments.requested} (${o.attachments.oversize} oversize), ` +
    `doc ${Number(o.doc.delivered)}/${Number(o.doc.requested)}`;
  dlog(`✔ ${summary}${gaps.length > 0 ? ` — GAPS: ${gaps.join("; ")}` : ""}`);

  if (gaps.length > 0) {
    Sentry.captureMessage(`Forward delivered with gaps: ${gaps.join("; ")}`, {
      level: "warning",
      extra: { outcome: o },
    });
  }
}

/** Report a forward failure — a thrown error OR the watchdog "stall" (a forward
 *  that never resolves). Caught exceptions aren't auto-captured by Sentry, so
 *  the click handler funnels them here, carrying the DebugPanel breadcrumbs. */
export function reportForwardError(err: unknown): void {
  Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
    tags: { feature: "forward" },
  });
}


