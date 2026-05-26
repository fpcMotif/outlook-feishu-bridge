# Sentry for observability, tunneled through the ECS Host for CN reach

> **Status: accepted.** Stands alone — no deploy-topology dependency. Later refined by [ADR-0009](0009-cloudflare-global-host-dual-deploy.md), which made the ingest tunnel env-driven (`VITE_SENTRY_TUNNEL`): only the **ECS Host** build tunnels, the **Global Host** build ingests direct.

The add-in had no production telemetry. A forward that silently dropped a PDF, skipped an oversize attachment, or hung on a stalled request was invisible unless a user complained — and the only in-pane insight was an on-screen **DebugPanel** timeline that vanishes when the taskpane closes. We want crash + performance visibility, and in particular a signal for *silent degradation*: the add-in reports success but delivers less than the user asked for — something no off-the-shelf error tracker infers. Two constraints shape the how: the **SPA** runs inside the Outlook taskpane iframe (no devtools for most users), and much of the audience is in **Mainland China**, where the browser→`*.ingest.us.sentry.io` (US) hop is unreliable.

## Decision

Adopt **@sentry/react** ([src/sentry.ts](../../src/sentry.ts)), initialized from **`VITE_SENTRY_DSN`** — a build-time *public* value. No DSN → `Sentry.init` is skipped, so dev and un-keyed builds are a no-op.

- **Errors.** Auto-capture of uncaught errors + unhandled rejections; the App is wrapped in `Sentry.ErrorBoundary` so a render crash shows a message, not a blank pane. Caught failures aren't auto-captured, so `reportForwardError` funnels them — including a 60 s **hang watchdog** that fires when a forward never resolves (a dead spinner the outcome event below can't catch).
- **Performance.** `browserTracingIntegration` times pageload/navigation + fetch/xhr spans (the load cycle, the Convex calls) at **`tracesSampleRate: 1`** — every forward, justified by the low volume of an internal add-in. Trace headers are deliberately *not* propagated cross-origin, so Convex/Feishu requests are timed without injecting headers they'd reject.
- **Silent-degradation signal.** `reportForwardOutcome` diffs requested-vs-delivered per forward and raises a Sentry **warning** when something was dropped without an exception (PDF/Doc missing, not all attachments sent, oversize attachments) — the "missing behavior" signal Sentry can't infer on its own.
- **Breadcrumbs.** The **DebugPanel** timeline (`dload`/`dtime`/`dlog` + the mirrored F12 console) is forwarded into Sentry breadcrumbs, so every captured event carries the full load + forward timing. Sentry's own console breadcrumbs are disabled (`breadcrumbsIntegration({ console: false })`) to avoid duplicating that mirror.
- **CN reach.** Ingest is routed same-origin through `/_sentry/`, an nginx `location` on the **ECS Host** ([deploy/nginx/sentry-tunnel.conf](../../deploy/nginx/sentry-tunnel.conf)) that proxies envelopes to the single project endpoint (`o4511431447478272.ingest.us.sentry.io/api/4511431758839808/envelope/`). The box sits in China: client→box is in-region, box→Sentry(US) is server-side, so CN users' telemetry actually arrives. Same-origin also drops the third-party `connect-src`.

## Why

- **Silent degradation is the headline.** The most common real failure isn't a crash — it's a forward that "succeeds" while quietly delivering less. A plain error tracker would never see it; `reportForwardOutcome` exists for exactly that.
- **Tunnel because direct ingest was blind to CN.** The first build ingested direct (it assumed outside-CN use) and reported nothing from the core Mainland audience. A probe envelope through the tunnel returned HTTP 200 + an event id, confirming the fix.
- **DSN-gated dormancy.** A build-time public DSN keeps config out of code and lets every dev / un-keyed build stay silent with no flag to manage.
- **Reuse the DebugPanel.** Mirroring the existing on-screen timeline into breadcrumbs beats a second instrumentation layer and gives crashes the same timing the user sees.

## Consequences

- **Content reaches Sentry as-is.** Forward metadata in breadcrumbs and outcome `extra` is sent unredacted — acceptable for an internal tool; revisit if the add-in ever holds higher-value scopes.
- **The DSN ships in the bundle.** Public by design, but readable by anyone; Sentry's rate limits / inbound filters are the only abuse control.
- **nginx gains a `location`.** `/_sentry/` must be applied to the box (`nginx -t` gated) before the DSN goes live, and its upstream path hard-codes the one project's DSN id — a second project would need a second `location`.
- **CSP `connect-src https://*.sentry.io` is now redundant under the tunnel** but kept: it's a harmless fallback on the **ECS Host** and load-bearing for the **Global Host**'s direct ingest ([ADR-0009](0009-cloudflare-global-host-dual-deploy.md)).
- **`tracesSampleRate: 1` won't scale.** Fine at this volume; a busier deployment would need sampling.

## Alternatives rejected

- **Direct ingest everywhere** — the initial build; left Mainland-China users (the core audience) unreported. Replaced by tunnel-by-default on the box.
- **Uncaught-error capture only** — misses silent degradation and a forward that stalls forever; the outcome event + hang watchdog cover what auto-capture can't.
- **DebugPanel / console logging without Sentry** — no off-device aggregation or alerting, and the in-pane timeline is gone the moment the taskpane closes.
- **Sample below 100 %** — would drop the very forwards worth inspecting, at a volume where keeping all of them is free.
