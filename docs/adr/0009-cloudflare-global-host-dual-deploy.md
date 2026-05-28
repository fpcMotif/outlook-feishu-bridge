# Cloudflare returns as the Global Host, alongside the CN ECS Host

> **Status: accepted.** Amends [ADR-0002](0002-serve-spa-from-ecs.md), which migrated *off* Cloudflare. Cloudflare returns — **not** as a replacement for the **ECS Host**, but as a second, parallel host serving the same SPA to the non-Mainland-China audience. Complements [ADR-0008](0008-fallback-login-via-box.md).

ADR-0002 moved the SPA off Cloudflare Pages onto the **ECS Host** (one Aliyun box, nginx, `/addin/`) for Mainland-China reachability and ICP simplicity. But that box is a single CN-resident origin: for users **outside** China it is the wrong default — farther away and a single point of failure — while the US-hosted **Convex Backend** they talk to is directly reachable for them anyway. So we restore Cloudflare Pages as the host for the global / non-CN audience, serving the **same SPA from one codebase**. The ECS Host stays CN-primary.

## Decision

One codebase, two builds, two hosts:

- **ECS Host** — Aliyun, `https://<host>/addin/`, **CN audience**. Built `--base=/addin/`. CSP + SPA fallback via nginx ([deploy/nginx/](../../deploy/nginx/)); **Atomic Release** over SSH; the Bun **Fallback OAuth Callback** ([ADR-0008](0008-fallback-login-via-box.md)); Sentry ingest tunneled through the same-origin `/_sentry/` nginx proxy.
- **Global Host** — Cloudflare Pages, `https://outlook-feishu-bridge.pages.dev/`, **non-CN audience**. Built `--base=/` (root). CSP + SPA fallback via `public/_headers` + `public/_redirects`. Primary **OAuth Callback** only — Pages is static, so no Bun server. Sentry ingest is **direct** to `*.ingest.us.sentry.io` (no tunnel).

Shared by both:

- Same **Convex Backend** (`steady-setter-706`), same Feishu app. The primary **OAuth Callback** is a Convex HTTP route on `*.convex.site` — host-independent — so **no new Feishu redirect URI** is needed for the Global Host.
- The Sentry tunnel is env-driven (`VITE_SENTRY_TUNNEL`): set to `/_sentry/` for the ECS build, left unset for the Global build (direct ingest; CSP `connect-src https://*.sentry.io` already covers the ingest host).
- The **Outlook Manifest** carries two placeholders, `__ADDIN_DOMAIN__` + `__ADDIN_BASE__`; `scripts/manifest.sh <domain> [base]` emits a per-host manifest. CN users sideload the ECS manifest (`<host>` + `addin/`), global users the Pages one (`outlook-feishu-bridge.pages.dev` + empty base).
- `scripts/deploy.sh cloudflare` (`npm run deploy:cf`) builds `--base=/` and runs `wrangler pages deploy dist`. A `wrangler logout && wrangler login` re-auth is required first (interactive OAuth); the project may need a one-time `wrangler pages project create`.

## Why

- **Latency + resilience for non-CN users.** A single CN origin is the wrong default for the rest of the world; Cloudflare's edge is closer and multi-PoP, and Convex (US) is directly reachable from outside China.
- **One codebase, no fork.** App code is identical across hosts; only the build `base`, a few static files, and the deploy target differ.
- **Zero Feishu-console churn.** Primary login redirects to Convex (`*.convex.site`), not the SPA host — so adding the Global Host changes nothing in the Feishu open platform.
- **Cheap to restore.** The wrangler path predates ADR-0002; bringing it back is config, not new infrastructure.

## Consequences

- **No fallback login on the Global Host.** Pages is static-only; the ADR-0008 Bun **Fallback OAuth Callback** cannot run there. If the **Convex Backend**'s action runtime is down (the ADR-0008 incident), Global-Host users cannot log in until it recovers. Accepted: the fallback is a CN-resilience mitigation; non-CN users tolerate the rare Convex-action outage (the pre-ADR-0008 status quo).
- **Two manifests to keep in sync.** A display-name/icon/command/URL change must regenerate both — `scripts/manifest.sh` keeps them from one template.
- **`base` is now host-specific** (`/addin/` vs `/`). A build shipped to the wrong host 404s on assets. The CONTEXT.md invariant "base is `/addin/`, not `/`" is relaxed to per-host.
- **CSP lives in two places** — `deploy/nginx/addin-headers.conf` (ECS) and `public/_headers` (Cloudflare) — and must stay in sync. nginx is the source of truth; `public/_headers` says so.
- **Cloudflare `_headers` matches the original request path, not the `_redirects`-rewritten `/index.html`** (verified against CF docs). SPA-entry cache rules therefore go on `/*`, not `/index.html`.
- The **Global Host domain** must appear in the manifest's `AppDomains`.

## Alternatives rejected

- **Cloudflare for the CN audience too** — already rejected in [ADR-0008](0008-fallback-login-via-box.md) (poor Mainland reachability; needs China Network Enterprise + ICP). Cloudflare is non-CN only.
- **Serve the Global Host under `/addin/` for build symmetry** — Pages serves `dist/` at root; a `/addin/` base needs the output nested and buys nothing for a standalone global URL. Root is the natural Pages path.
- **Cloudflare as same-audience failover for the ECS Host** — would need DNS-level failover, a matching `/addin/` build, and a shared manifest; that is redundancy, not the audience split chosen here. A separate ADR if ever needed.
- **Drop the ECS Host, go Cloudflare-only** — reverts ADR-0002: loses CN reachability and the in-region fallback login.
