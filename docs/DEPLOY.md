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

`.env.deploy` (gitignored) must define `DEPLOY_HOST` (the SSH target — an IP is fine),
`DEPLOY_USER` (`deploy`), `DEPLOY_SSH_KEY` (path to the private key), `ADDIN_ECS_HOST`
(the public domain baked into the manifest — e.g. `wmdev.zeuja.com`), and the build vars
`VITE_CONVEX_URL`, `VITE_CONVEX_SITE_URL`, `VITE_FEISHU_APP_ID`.

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

## 2. Provision a fresh ECS box (reproducible)

Standing up the **ECS Host** (e.g. migrating to a new Aliyun tenant) splits into a short
account-bound console prefix and an idempotent in-box bootstrap codified in
`scripts/provision-ecs.sh` ([ADR-0028](adr/0028-reproducible-ecs-provisioning.md)). The
script is safe to re-run on an existing box.

> Migrating the **whole** project at once — new Aliyun box **and/or** a Convex
> personal→company project swap (new IP, new PEM, re-issued cert, re-set env vars,
> Feishu redirect re-whitelist) — has a single cross-cutting runbook:
> [MIGRATION.md](MIGRATION.md).

**2a. Aliyun console (manual — 3 steps, not scriptable):**

1. Create an ECS instance (**Ubuntu 24**).
2. Open the security group for inbound **80 and 443** (80 is required for certbot HTTP-01).
3. Point a DNS **A record** for `ADDIN_ECS_HOST` (e.g. `wmdev.zeuja.com`) at the instance IP.

**2b. Bootstrap the box.** Set these in `.env.deploy`, then run the provisioner:

```bash
ADDIN_ECS_HOST=wmdev.zeuja.com          # public domain: certbot -d, nginx server_name, manifest host
CERTBOT_EMAIL=you@example.com           # Let's Encrypt account / renewal notices
DEPLOY_PUBKEY=~/.ssh/addin_deploy.pub   # operator PUBLIC key, installed for the deploy user
PROVISION_SSH_TARGET=root@<instance-ip> # ONE-TIME bootstrap identity (Aliyun's initial root),
                                        # distinct from deploy.sh's DEPLOY_USER / DEPLOY_SSH_KEY
```

`provision-ecs.sh` then runs, idempotently and **in this order**:

1. Creates the **`deploy`** user, installs `DEPLOY_PUBKEY` into its `authorized_keys`, and grants
   scoped passwordless sudo (nginx, `systemctl`, `/var/www`). Set `DEPLOY_USER=deploy` afterward —
   this is the account `deploy.sh` SSHes in as, and what its `sudo` calls (§4 fallback) assume.
2. `apt install nginx certbot python3-certbot-nginx`; installs Bun → `/usr/local/bin` (copy, not
   a symlink into `$HOME`).
3. Lays down the nginx config from [`deploy/nginx/`](../deploy/nginx/): renders the `wmdev.conf`
   server block (`__ADDIN_DOMAIN__` → `ADDIN_ECS_HOST`) into `sites-available` + a `sites-enabled`
   symlink, copies the snippets (`addin-headers`, `addin-assets-cache`, `feishu-auth`,
   `sentry-tunnel`) into `/etc/nginx/snippets/` (stripping the repo files' CRLF line endings),
   enables gzip for JS/CSS via an idempotent `/etc/nginx/conf.d/gzip.conf` drop-in, **installs the
   systemd nginx self-heal drop-in + `systemctl daemon-reload` + `reset-failed`**, and runs
   `nginx -t`. The `wmdev.conf` server block now carries the `include` lines for all four snippets
   directly, so the tunnel + fallback auth + assets cache are wired on a verbatim render.
4. `certbot --nginx -d $ADDIN_ECS_HOST -m $CERTBOT_EMAIL --agree-tos -n` — adds the `listen 443`
   block, the http→https redirect, and a systemd auto-renew timer.
5. Installs the [`feishu-auth.service`](../deploy/feishu-auth.service) unit and `systemctl enable`s
   it. The **start is deferred** — `deploy.sh auth` writes `/etc/feishu-auth.env` first (§4 / ADR-0008).
6. `mkdir -p /var/www && chown deploy /var/www`.
7. **Last** (so a bad key can't lock you out): disables root SSH and password auth
   (`PermitRootLogin no`, `PasswordAuthentication no`) and reloads sshd.

What the nginx config provides: the SPA fallback `try_files $uri $uri/ /addin/index.html`;
the **CSP header** — *load-bearing for Outlook* (`frame-ancestors` must allow
`*.office.com *.office365.com *.outlook.com *.microsoft.com *.cloud.microsoft` or Outlook
refuses to frame the taskpane; `connect-src` must reach `*.convex.cloud` +
`wss://*.convex.cloud` + `*.convex.site` + `open.feishu.cn`); and `Cache-Control: no-cache`
on `index.html` so Outlook never serves a stale — possibly crashing — bundle after a redeploy.

**Resilience (added after the 2026-06-12 outage).** Two repo-tracked artifacts that
`provision-ecs.sh` lays down automatically (no hand steps) — see [ADR-0029](adr/0029-lazy-sentry-resolver-and-nginx-self-heal.md):

- The Sentry tunnel ([`sentry-tunnel.conf`](../deploy/nginx/sentry-tunnel.conf))
  resolves its upstream **lazily** — a `resolver` directive + a `$variable` in
  `proxy_pass`. A *bare* hostname there is resolved at config-load and a transient DNS
  failure is **fatal** (`[emerg] host not found in upstream`); on 2026-06-12 a DNS blip
  during the daily `unattended-upgrade` made `nginx -t` (the unit's `ExecStartPre`) fail
  on restart and the whole box stayed down for 3 days. The variable form defers
  resolution to request time, so nginx **always starts**; only `/_sentry/` telemetry
  degrades if Sentry DNS is briefly unreachable. (With a variable in `proxy_pass`, nginx
  does **not** append the matched URI — the full `/api/.../envelope/` path stays spelled
  out in the snippet.) This is the **primary** defense.
- The **systemd self-heal drop-in**
  ([`deploy/systemd/nginx.service.d/override.conf`](../deploy/systemd/nginx.service.d/override.conf),
  `Restart=on-failure`, `RestartSec=10s`, `StartLimitIntervalSec=0`) so a failed start
  retries — **indefinitely** — instead of staying dead. Stock Ubuntu 24.04 ships
  `nginx.service` with **no** `Restart=`. `StartLimitIntervalSec=0` disables the
  start-rate limiter; a *bounded* burst (e.g. 30 tries / 5 min) would latch the unit into
  a permanent `failed (start-limit-hit)` state and would **not** self-heal a multi-hour
  outage. A deliberate `systemctl stop` exits 0 and is still honored.

Both are installed by `provision-ecs.sh` (step 3 above). To apply them to a box that
is **already** hand-built (the live box) without a full re-render, install the two files
surgically and reload — do **not** re-run the provisioner against a live snowflake
(it refuses unless `PROVISION_FORCE=1`):

```bash
sudo install -D -m644 deploy/systemd/nginx.service.d/override.conf \
  /etc/systemd/system/nginx.service.d/override.conf
sudo systemctl daemon-reload && sudo systemctl reset-failed nginx
sudo install -m644 deploy/nginx/sentry-tunnel.conf /etc/nginx/snippets/sentry-tunnel.conf
sudo nginx -t && sudo systemctl reload nginx
```

> The `*.convex.*` CSP wildcards mean a Convex team/deployment swap needs **no nginx change**.
> See [ADR-0028](adr/0028-reproducible-ecs-provisioning.md) for why the box is bootstrapped
> this way (not Terraform) and why the OSS/CDN/RAM env vars were retired.

## 3. Sideload the Outlook add-in

`public/manifest.xml` ships with three placeholders — **`__ADDIN_DOMAIN__`** (host),
**`__ADDIN_BASE__`** (path prefix), and **`__ADDIN_VERSION__`** — which you **must**
substitute before sideloading. The `bun` scripts do all three and **write the file
themselves** (don't redirect stdout — `> file` would capture the log lines instead
of the manifest). There are two manifests, one per host (ADR-0009):

```bash
# Global Host (everyone outside Mainland China) — served at root
bun run manifest:global   # -> manifest-sideload.xml
# ECS Host (Mainland China) — served under /addin/
bun run manifest:ecs      # -> manifest-sideload-cn.xml
```

Each run **auto-bumps the 4th version segment** from the git-tracked
[`manifest.version`](../manifest.version) and writes the new baseline back —
**commit `manifest.version`**. The baseline is shared across both host manifests, so
versions only ever increase (never reset to `1.0.0.0` on a fresh checkout). Pin an
exact value with `MANIFEST_VERSION=1.2.3.4 bun run manifest:global` when needed.

> The legacy `bash scripts/manifest.sh <domain> [base]` writes to stdout but does
> **not** track or bump the version — it emits `1.0.0.0` unless you pass
> `MANIFEST_VERSION`. Prefer the `bun` scripts above for anything you'll re-sideload.

Then Outlook → **Get Add-ins → My add-ins → Custom Addins → Add from file** →
pick `manifest-sideload.xml`. CN users get the ECS manifest; everyone else the
Global one.

> Sideloading the raw manifest (tokens not replaced) makes Outlook try to resolve
> the literal host `__addin_domain__` → *"server IP address could not be found."*

### Updating a sideloaded add-in (the "update the version number" failure)

Outlook keys an add-in by its **`<Id>` GUID** ([Id element](https://learn.microsoft.com/javascript/api/manifest/id)
— *"the unique ID of your Office Add-in"*). **Every manifest in this repo shares one
Id**, so to Outlook the Global, ECS, and localhost manifests are the **same add-in**:
you can't install two of them on one mailbox, and a second upload is treated as an
*update*. That's fine in production (CN and non-CN audiences are different mailboxes),
but a developer testing both on one mailbox will collide.

An update is accepted **only if `<Version>` is strictly greater** than the installed
one ([Version element](https://learn.microsoft.com/javascript/api/manifest/version):
1–4 parts, each ≤5 digits / 0–99999). A same-or-lower version fails with
**"Failed. Please update the version number in the manifest file and try again."**
The auto-bump + shared `manifest.version` baseline prevents this — but only if you
**regenerate** (don't hand-edit the version down, as a 1.0.1.0 CN file below an
installed 1.0.1.1 global will be rejected).

If a correctly-bumped manifest *still* fails, Outlook has cached the old one. Outlook
supports **manual cache-clear only** ([Clear the Office cache](https://learn.microsoft.com/office/dev/add-ins/testing/clear-cache)):

1. **Remove** the installed add-in: Get Add-ins → My add-ins → (the add-in) → Remove.
2. **Clear the cache**:
   - **Classic Outlook (Windows):** delete the *contents* of
     `%LOCALAPPDATA%\Microsoft\Office\16.0\Wef\` (clear it completely — don't delete
     individual manifest files).
   - **New Outlook (Windows):** close Outlook, run `olk.exe --devtools`, then in the
     Edge DevTools **Network** tab right-click → **Clear browser cache**.
   - **Outlook on the web:** remove the add-in (step 1), then hard-reload the page.
3. **Re-add** the freshly generated manifest (now at a higher version).

#### Hosted manifest vs. add-from-file

There are two ways the add-in's manifest reaches Outlook, and they fail differently:

- **Add from file** — you upload `manifest-sideload.xml` / `-cn.xml` directly. This
  is the fastest unblock: it ignores anything hosted. Remove → clear cache → re-add
  the file.
- **Hosted URL / update** — Outlook re-fetches `https://<host>/manifest.xml` (the
  *"Update failed — Please update the version number"* dialog is this path). The
  catch: `public/manifest.xml` is a **template**, and Vite copies it verbatim into
  `dist/`, so a plain build serves the raw `__ADDIN_DOMAIN__` placeholders at version
  `1.0.0.0` — an invalid manifest Outlook can never update to. **`scripts/deploy.sh`
  now bakes a valid, host-specific `dist/manifest.xml` at the tracked
  `manifest.version`** (`bake_manifest`), replacing that template. So a hosted update
  only works **after a redeploy** with a higher version.

**To push a hosted update:** `bun run manifest:ecs` (or `manifest:global`) to bump +
commit `manifest.version`, then `bash scripts/deploy.sh frontend` (or `cloudflare`) —
the deploy bakes the bumped version into the hosted `/manifest.xml`. Until you
redeploy, use **add-from-file** with the freshly generated sideload manifest.

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
