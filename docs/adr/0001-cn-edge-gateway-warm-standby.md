# CN Edge Gateway is a warm standby, not a steady-state component

> **Status: superseded by [ADR-0002](0002-serve-spa-from-ecs.md).** This ADR described the ECS box as a warm-standby Convex proxy with the SPA on OSS+CDN. We later pivoted to serving the SPA directly from the ECS box at `/addin`, which makes the box load-bearing. The "warm standby only" framing below no longer holds; kept for the record of why the box was originally provisioned.

We provisioned an Aliyun ECS Ubuntu 24 instance at `api.__ADDIN_DOMAIN__` to live alongside the OSS-hosted SPA after migrating off Cloudflare Pages. Convex remains the backend; from Mainland China, the SPA calls Convex directly under normal conditions. The gateway is a reverse proxy to `*.convex.{cloud,site}` that exists only as a failover path — it serves zero traffic in steady state.

We considered five roles for the box: (i) OAuth callback proxy; (ii) Feishu event-subscription receiver with signature validation; (iii) deterministic egress IP for outbound calls to Feishu; (iv) standby reverse proxy for SPA→Convex; (v) skip entirely. We picked **(iv) only**.

- **(i) rejected** because we don't want to re-register the Feishu OAuth redirect URI; keeping it pointed at `*.convex.site` avoids touching the Feishu open-platform console.
- **(ii) rejected** because there is no Feishu event subscription in the codebase today and building a receiver in advance of need is speculative work.
- **(iii) rejected** because Convex's outbound IP is multi-tenant and routing every `convex/feishu/*.ts` call through our box is a larger refactor than this iteration warrants.
- **(v) rejected** because Convex is US-hosted and we want a CN-resident fallback we can flip to without buying a new VM mid-incident.

## Consequences

- The box has near-zero CPU/RAM load in steady state. It doubles as the deploy script host (`scripts/deploy.sh` runs from local terminal *or* over SSH on the box) so the spare capacity isn't wasted.
- Switchover is currently **manual env flip + redeploy** (`VITE_CONVEX_URL` / `VITE_CONVEX_SITE_URL` point at proxy hostnames; rebuild SPA; push). Phase 2 promotes to DNS-level switchover via CNAMEs once nginx + certs are wired.
- If we ever subscribe to Feishu events, the gateway becomes load-bearing — that's the upgrade path, and revisiting (ii) is the trigger for a new ADR.
