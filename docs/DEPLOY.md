# Deploy & sideload runbook

How the SPA reaches its two hosts and how the Outlook add-in is sideloaded.
Background: [CONTEXT.md](../CONTEXT.md), [ADR-0002](adr/0002-serve-spa-from-ecs.md),
[ADR-0009](adr/0009-cloudflare-global-host-dual-deploy.md).

One codebase, two hosts (ADR-0009):
- **ECS Host** (Aliyun, CN audience) — SPA at `https://<host>/addin/` (§1), plus the
  fallback login server (ADR-0008) and the Sentry `/_sentry/` tunnel.
- **Global Host** (Cloudflare Pages, non-CN audience) — SPA at
  `https://outlook-feishu-bridge.pages.dev/` (§5), primary Convex login only.

The backend is the same Convex deployment for both, called directly (not proxied).

## 1. Deploy the SPA to the ECS Host (CN)

`.env.deploy` (gitignored) must define `DEPLOY_HOST`, `DEPLOY_USER`,
`DEPLOY_SSH_KEY` (path to the private key), and the build vars `VITE_CONVEX_URL`,
`VITE_CONVEX_SITE_URL`, `VITE_FEISHU_APP_ID`.

```bash
bash scripts/deploy.sh frontend
```

- **Run `bash scripts/deploy.sh frontend`, not `bun run deploy:fe`, on Windows.**
  Direct `bash` keeps the deploy shell explicit and avoids package-runner shell
  differences on Windows.
- The script builds with `base=/addin/`, tars `dist/`, streams it over SSH, and
  does an **atomic release**: unpack into `/var/www/releases/<ts>/`, flip the
  `/var/www/addin` symlink, keep the last 3.
- **Rollback**: on the box, repoint `/var/www/addin` at an older release dir.

## 2. One-time ECS setup — `scripts/provision-ecs.sh` (ADR-0028)

`deploy.sh` assumes a box that already has nginx, TLS, the `deploy` user, Bun, and
the systemd unit. `scripts/provision-ecs.sh` puts all of that in place **once**, over
SSH, on a fresh Aliyun Ubuntu 24 box — idempotent, so a re-run is a no-op.

```bash
bash scripts/provision-ecs.sh
```

- **Bootstrap identity.** It connects as `PROVISION_SSH_TARGET=root@<ip>` — Aliyun's
  initial root over the box IP — **not** `deploy.sh`'s `DEPLOY_USER`/`DEPLOY_SSH_KEY`:
  the `deploy` user does not exist yet (the script creates it). `.env.deploy` adds
  `ADDIN_ECS_HOST`, `CERTBOT_EMAIL`, `DEPLOY_PUBKEY` (the public half of
  `DEPLOY_SSH_KEY`), and `PROVISION_SSH_TARGET`.
- **What it does, in order** (each step guarded): (1) create the `deploy` user +
  `authorized_keys` + scoped passwordless sudoers; (2) `apt install` nginx + certbot,
  install Bun as a binary **copy** at `/usr/local/bin/bun`; (3) render
  `deploy/nginx/wmdev.conf` (`__ADDIN_DOMAIN__` → `ADDIN_ECS_HOST`) into
  `sites-available`/`sites-enabled`, copy the `{addin-headers,addin-assets-cache,`
  `feishu-auth,sentry-tunnel}` snippets, enable gzip for JS/CSS; (4) `certbot --nginx`
  for the cert (Let's Encrypt, auto-renews); (5) install + **enable** the
  `feishu-auth` unit (not started — its env file is written by `deploy.sh auth`);
  (6) `mkdir /var/www` + `chown deploy`; (7) **last**, harden `sshd`
  (`PermitRootLogin no`, `PasswordAuthentication no`). After step 7, root@<ip> can no
  longer log in — reconnect as `deploy`.
- **Two prereqs it does NOT do** — both needed before certbot (step 4): a **DNS A
  record** for `ADDIN_ECS_HOST`, and a security-group inbound rule for ports **80 and
  443**.

The reference configs it renders live in [`deploy/nginx/`](../deploy/nginx/) +
[`deploy/feishu-auth.service`](../deploy/feishu-auth.service). The load-bearing pieces
they encode: the SPA fallback (`try_files $uri $uri/ /addin/index.html;`), the **CSP
header** (`addin-headers.conf` — its `frame-ancestors` must allow `*.office.com
*.office365.com *.outlook.com *.microsoft.com *.cloud.microsoft` or Outlook refuses to
frame the taskpane; `connect-src` must reach `*.convex.cloud` + `wss://*.convex.cloud`
+ `*.convex.site` + `open.feishu.cn`), and `index.html` → `Cache-Control: no-cache`
(without it Outlook serves a stale, possibly crashing, bundle after a redeploy).

## 3. Sideload the Outlook add-in

`public/manifest.xml` ships with two placeholders — **`__ADDIN_DOMAIN__`** (host)
and **`__ADDIN_BASE__`** (path prefix) — which you **must** substitute before
sideloading. `scripts/manifest.sh <domain> [base]` does both. There are two
manifests, one per host (ADR-0009):

```bash
# Global Host (everyone outside Mainland China) — served at root
bun run manifest:global > manifest-sideload.xml
# ECS Host (Mainland China) — served under /addin/
bun run manifest:ecs > manifest-sideload-cn.xml

# The Bash helper is equivalent when you already have Bash:
# ECS Host (CN) — served under /addin/
bash scripts/manifest.sh <host> addin/ > manifest-sideload.xml
# Global Host (Cloudflare Pages) — served at root (empty base)
bash scripts/manifest.sh outlook-feishu-bridge.pages.dev "" > manifest-sideload.xml
```

Then Outlook → **Get Add-ins → My add-ins → Custom Addins → Add from file** →
pick `manifest-sideload.xml`. CN users get the ECS manifest; everyone else the
Global one.

> Sideloading the raw manifest (tokens not replaced) makes Outlook try to resolve
> the literal host `__addin_domain__` → *"server IP address could not be found."*

If DevTools shows the taskpane frame at `chrome-error://chromewebdata/` and an
unsafe-load message for `https://wmdev.zeuja.com/addin/?et=`, Outlook failed to
navigate to the ECS Host before the SPA JavaScript ran. For non-Mainland-China
users, regenerate and sideload the Global Host manifest with
`bun run manifest:global > manifest-sideload.xml`; do not debug React, Office.js,
or Base first. The nearby Microsoft CDN, PeopleGraph photo 404s, and
`ERR_NETWORK_CHANGED` Graph requests are Outlook/web-network noise unless the
taskpane URL itself loads successfully.

## 4. Feishu OAuth

The SPA opens `…/authorize?...&redirect_uri=<VITE_CONVEX_SITE_URL>/feishu/oauth/callback`.
That **exact** URL must be whitelisted in the Feishu app (Developer Console →
安全设置 / Security Settings → Redirect URL), or login fails with
`20029 Invalid redirect URL`.

The backend (Convex deployment) needs four Feishu env vars — the app credentials
plus the target Base identifiers ([ADR-0010](adr/0010-pivot-to-bitable-intake.md)):

```bash
bunx convex env set FEISHU_APP_ID <app-id>
bunx convex env set FEISHU_APP_SECRET <secret>
bunx convex env set FEISHU_BITABLE_APP_TOKEN <token>   # the base/<…> segment of the Base URL
bunx convex env set FEISHU_BITABLE_TABLE_ID <id>       # the ?table=<…> param
bunx convex env set FEISHU_BITABLE_WEB_BASE_URL https://<tenant>.feishu.cn/base/<token> # optional detail-link host
```

Permissions ([ADR-0011](adr/0011-feishu-permission-set.md)) — batch-import in 权限管理 →
开通权限 (JSON), then **release a new app version** and have users **re-authorize**:

```json
{ "scopes": { "tenant": ["bitable:app"], "user": ["contact:user:search"] } }
```

`offline_access` is sent in the authorize URL (not a console permission). The app must
also be a **collaborator with edit rights** on the target Base.

The **app secret is backend-only** — never put it in a `VITE_*` var (those ship
to every browser in plain text). Only the public `VITE_FEISHU_APP_ID` is baked
into the SPA.

Because that redirect URI lives on `*.convex.site` (not on the SPA host), it is
**host-independent**: the **Global Host** reuses it unchanged — adding Cloudflare
needs **no new Feishu redirect URL**. Only the ECS Host's *fallback* login
(ADR-0008) has its own box-hosted redirect URI; the Global Host has no fallback.

## 5. Deploy the SPA to the Global Host (Cloudflare Pages)

For the non-CN audience (ADR-0009). Same `.env.deploy` build vars as §1
(`VITE_CONVEX_URL`, `VITE_CONVEX_SITE_URL`, `VITE_FEISHU_APP_ID`; `VITE_SENTRY_DSN`
optional). **Re-auth first** — the stored wrangler session is often stale or tied
to the wrong Cloudflare account:

```bash
bunx wrangler logout && bunx wrangler login # interactive (opens a browser)
bash scripts/deploy.sh cloudflare           # build base=/ + wrangler pages deploy
```

- Builds with `base=/` (root) and runs `wrangler pages deploy dist` to the
  `outlook-feishu-bridge` Pages project (from `wrangler.toml` `name`). First time
  only, the project may need `bunx wrangler pages project create outlook-feishu-bridge`.
- **No Sentry tunnel here** — the Global Host has no `/_sentry/` proxy, so the build
  omits `VITE_SENTRY_TUNNEL` and Sentry ingests direct to `*.sentry.io` (allowed by
  `public/_headers`). The ECS build keeps the tunnel.
- CSP + SPA fallback come from `public/_headers` + `public/_redirects` (the
  Cloudflare equivalents of `deploy/nginx/`). Keep the CSP in `public/_headers` in
  sync with `deploy/nginx/addin-headers.conf` — **nginx is the source of truth**.
- **No fallback login** on the Global Host (Pages is static; the ADR-0008 Bun server
  can't run there). If Convex's action runtime is down, Global-Host users can't log
  in until it recovers — accepted for non-CN users.

## 6. Gotchas (hard-won)

- **Never read `Office.*` at module load.** A top-level
  `Office.MailboxEnums.CategoryColor` crashes the SPA — `Office.MailboxEnums` is
  undefined in a plain browser *and* before office.js initializes inside the
  taskpane. Read Office enums lazily, inside the function that uses them.
- **Quote `.env.deploy` values containing `|`.** `CONVEX_DEPLOY_KEY=dev:…|…`
  unquoted makes `source` treat `|` as a pipe → the variable comes out empty.
- **GitHub over SSH may be blocked** (e.g. from Mainland China) → `git push`
  hangs. Push over HTTPS: `git push https://github.com/<org>/<repo>.git HEAD:<branch>`.
- **GitHub Actions** deploy is unavailable when the account's Actions billing is
  exhausted; `scripts/deploy.sh` is the fallback (a self-hosted runner on the
  ECS box would re-automate it for free).
