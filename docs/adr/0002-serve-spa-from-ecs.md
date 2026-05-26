# Serve the SPA from the ECS box at /addin, not OSS+CDN

> **Status: accepted.** Supersedes [ADR-0001](0001-cn-edge-gateway-warm-standby.md).

We migrated the SPA off Cloudflare Pages. ADR-0001 planned to host it on Aliyun OSS+CDN and keep the ECS box as a warm-standby Convex proxy. We instead serve the SPA **directly from the ECS box** (`__ADDIN_DOMAIN__`): nginx serves `/var/www/addin` under location `/addin/`, and the SPA is built with base path `/addin/`. Deploys ship `dist/` over SSH as an atomic release (timestamped dir + symlink flip, keep last 3).

## Why we picked ECS-served over OSS+CDN

- **One thing to operate.** A single box to ICP-file, one TLS cert, one host to monitor — instead of an OSS bucket *plus* a CDN domain *plus* their per-service ICP mappings.
- **Avoids OSS custom-domain friction.** Binding a custom `.cn` domain to an OSS bucket in a Mainland region carries its own ICP-per-service gotchas; serving from nginx on the box sidesteps them.
- **Near-zero marginal cost.** The box is being provisioned anyway (it was the warm-standby proxy in ADR-0001). Serving static files from it costs effectively nothing extra.
- **Path-based consolidation.** Co-locating the SPA (`/addin`) and a future Convex reverse-proxy (`/feishu`, `/convex`) under one host enables clean path routing on one domain + one cert.

## Consequences

- **The ECS box is now load-bearing.** It serves the SPA in steady state — ADR-0001's "warm standby, serves zero traffic" framing is superseded. Box uptime now matters: mitigated by a daily snapshot and atomic releases (rollback = repoint the `/var/www/addin` symlink at a prior release).
- **No CDN edge caching** today. Origin is the ECS box directly. If global latency becomes a problem, an Aliyun CDN can be added in front later (origin = ECS) without changing the deploy.
- **GitHub Actions deploy was abandoned.** GH Actions billing is exhausted on this account, so the deploy lives in `scripts/deploy.sh` (run locally or over SSH), not a workflow. If billing is restored, a self-hosted runner on this same box is the natural re-automation path.
- **nginx must provide** the SPA fallback (`try_files … /addin/index.html`), the `Content-Security-Policy` header, and `Cache-Control: no-cache` on `index.html`. The CSP `frame-ancestors` directive is load-bearing for Outlook (an HTTP header, not a `<meta>` tag) and `connect-src` must reach Convex + Feishu; the `no-cache` stops Outlook serving a stale — possibly crashing — bundle after a redeploy. The policy now lives in [`deploy/nginx/`](../../deploy/nginx/) (recovered from the pre-Cloudflare `public/_headers`).
- **The manifest carries `__ADDIN_DOMAIN__`** and must be substituted with the real host before sideloading — the raw token makes Outlook fail with *"server IP address could not be found"*. Deploy + sideload steps and other gotchas are in the [deploy runbook](../DEPLOY.md).
