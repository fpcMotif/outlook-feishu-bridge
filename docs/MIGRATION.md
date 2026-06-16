# Migration runbook — new Aliyun box + new Convex project

Step-by-step for moving the live add-in when **either or both** of these change:

- **A — ECS Host** moves to a **new Aliyun instance** (new public IP, new bootstrap
  PEM, re-issued TLS cert). Covers your *"download a new PEM, get the new IP, re-run
  the Let's Encrypt script"* case.
- **C — Convex backend** moves from your **personal** project to the **company**
  project (new deployment URL, new deploy key, env vars re-set, Feishu redirect
  re-whitelisted).

The two are **independent** — do one, the other, or both. Most of it is already
scripted; the irreducibly-manual parts are **[CONSOLE]** web-UI clicks (Aliyun /
Convex dashboard / Feishu). Background: [DEPLOY.md](DEPLOY.md),
[ADR-0028](adr/0028-reproducible-ecs-provisioning.md),
[ADR-0029](adr/0029-lazy-sentry-resolver-and-nginx-self-heal.md),
[ADR-0009](adr/0009-cloudflare-global-host-dual-deploy.md).

Legend: **[CONSOLE]** = manual web UI (not scriptable) · **[CLI]** = local terminal.

---

## What changes, and where

| Thing | Old | New | Touched by |
|---|---|---|---|
| ECS public IP (SSH) | old IP | **new IP** | `.env.deploy` → `DEPLOY_HOST`, `PROVISION_SSH_TARGET` |
| Bootstrap PEM (Aliyun root login) | old | **new, one-time** | ssh-agent / `~/.ssh/config` for the bootstrap host |
| Operator deploy keypair (`~/.ssh/addin_deploy*`) | — | **unchanged** (reused) | reinstalled on the new box by the provisioner |
| TLS cert | old | **re-issued by certbot** | `provision-ecs.sh` step 4 (automatic) |
| Public domain `ADDIN_ECS_HOST` | e.g. `wmdev.zeuja.com` | usually **same** (re-point DNS) | `.env.deploy` |
| Convex deployment URL | `steady-setter-706.convex.*` | **new** company deployment | `.env.deploy`/`.env.local` `VITE_CONVEX_URL`/`_SITE_URL` |
| Convex deploy key | personal prod key | **new** company prod key | `.env.deploy` → `CONVEX_DEPLOY_KEY` |
| Convex backend env vars | on old deployment | **re-set on new** (do NOT migrate) | `bunx convex env set` / `scripts/convex-env-sync.sh` |
| Feishu OAuth redirect whitelist | old `.convex.site` | **add new** `.site` URL | Feishu console (only if Convex URL changed) |

> **Key clarification (the PEM confusion).** There are **two** keypairs:
> - **Aliyun bootstrap PEM** = the box's *initial root* credential. New per instance,
>   used **once** by `provision-ecs.sh`. Provisioning then **disables root + password
>   login**, so this PEM is dead after the first run.
> - **Operator deploy keypair** (`~/.ssh/addin_deploy` + `.pub`) = **yours**. The
>   provisioner installs its public half into the new box's `deploy` user. You **reuse
>   the same keypair** across box migrations — it does *not* change.

---

## Before you start

- `git pull` so you have `scripts/provision-ecs.sh`, `scripts/deploy.sh`,
  `scripts/convex-env-sync.sh`.
- Have `.env.deploy` (copy from `.env.deploy.example`) and `.env.convex`
  (copy from `.env.convex.example`) ready. Both are gitignored.
- Run everything from **Git Bash / WSL** on Windows (`bash scripts/...`, not
  `bun run` — DEPLOY.md §1).

---

## A — Migrate the ECS Host to a new Aliyun instance

### A1. [CONSOLE] Aliyun — create the box (3 clicks, ADR-0028 §2a)

1. **Create an ECS instance — Ubuntu 24.04.** When creating it, for the login
   credential you have two options:
   - **Recommended:** upload/bind **your operator public key**
     (`~/.ssh/addin_deploy.pub`) as the instance key pair → root login uses your key,
     **no PEM to download**, and step A2's bootstrap "just works".
   - **Aliyun-generated key pair:** let Aliyun create one and **download the `.pem`**
     (you only get it once). This is the PEM that "changes" per box. `chmod 600` it.
2. **Security group:** open inbound **80 and 443** (80 is required for certbot's
   HTTP-01 challenge — without it TLS issuance fails).
3. **DNS A record:** point `ADDIN_ECS_HOST` (e.g. `wmdev.zeuja.com`) at the **new IP**.
   Wait for it to resolve (`nslookup <domain>`) before A3 — certbot validates over the
   real domain.

### A2. [CLI] Point `.env.deploy` at the new box

```bash
# the box's initial root identity for the ONE-TIME bootstrap
PROVISION_SSH_TARGET=root@<new-ip>
ADDIN_ECS_HOST=wmdev.zeuja.com          # usually unchanged (you re-pointed DNS in A1)
CERTBOT_EMAIL=you@example.com
DEPLOY_PUBKEY=~/.ssh/addin_deploy.pub   # your operator PUBLIC key (reused)

# the steady-state deploy identity (used by deploy.sh AFTER provisioning)
DEPLOY_HOST=<new-ip>                    # SSH target; IP is fine
DEPLOY_USER=deploy
DEPLOY_SSH_KEY=~/.ssh/addin_deploy      # your operator PRIVATE key (reused)
```

If you used the **Aliyun-generated PEM** (not the recommended path), make plain `ssh`
pick it up for the bootstrap host — `provision-ecs.sh` calls `ssh` **without** `-i`:

```bash
ssh-add ~/.ssh/aliyun-bootstrap.pem        # simplest; or add to ~/.ssh/config:
#   Host <new-ip>
#     User root
#     IdentityFile ~/.ssh/aliyun-bootstrap.pem
#     IdentitiesOnly yes
```

### A3. [CLI] Provision the box (nginx + TLS + hardening, idempotent)

```bash
bash scripts/provision-ecs.sh
```

This one script does **everything in-box** ([ADR-0028](adr/0028-reproducible-ecs-provisioning.md)/[ADR-0029](adr/0029-lazy-sentry-resolver-and-nginx-self-heal.md)),
including **your "re-run the Let's Encrypt script" step** — there is **no separate
Python script**, `certbot` *is* the Let's Encrypt client:

- creates the `deploy` user + installs your pubkey + scoped passwordless sudo;
- `apt install nginx certbot python3-certbot-nginx` + Bun;
- renders the nginx config (CSP, SPA fallback, Sentry tunnel with the **lazy
  resolver**, self-heal systemd drop-in);
- **`certbot --nginx -d $ADDIN_ECS_HOST -m $CERTBOT_EMAIL --agree-tos -n --redirect`**
  → issues the cert, adds the `listen 443` block, the **HTTP→HTTPS redirect**, and the
  90-day **auto-renew** timer + reload hook;
- installs the `feishu-auth` unit (start deferred to A5);
- **last:** disables root SSH + password auth, then runs blocking smoke checks
  (`/addin/` → 200, `/_sentry/` → 401/403).

Re-running on an already-provisioned box is refused unless `PROVISION_FORCE=1` (it
won't clobber a hand-built snowflake). Standalone cert reissue on an existing box:
`sudo certbot --nginx -d <domain> -m <email> --agree-tos -n --redirect` (or
`sudo certbot renew`).

### A4. [CLI] Ship the SPA to the new box

```bash
bash scripts/deploy.sh frontend
```

Builds `base=/addin/`, atomic-releases into `/var/www/releases/<ts>/`, flips the
`/var/www/addin` symlink.

### A5. [CLI] Ship the fallback auth server (ADR-0008)

```bash
# .env.deploy needs FEISHU_APP_SECRET and the box-hosted redirect (NOT the IP):
#   FEISHU_FALLBACK_REDIRECT_URI=https://wmdev.zeuja.com/feishu/oauth/callback
bash scripts/deploy.sh auth
```

> The fallback-login redirect is **box-hosted** and independent of Convex — if it's a
> brand-new domain, re-register it in the Feishu console (DEPLOY.md §4). If the domain
> is unchanged, no Feishu change is needed for the fallback.

### A6. No re-sideload needed (unless the domain changed)

The manifest is keyed to `ADDIN_ECS_HOST`. If you re-pointed the **same domain** at the
new IP, the installed add-in keeps working. Only if the **domain itself changed** do you
bump + regenerate + re-sideload the manifest (DEPLOY.md §3).

---

## C — Migrate Convex from the personal project to the company project

Today the repo points at **`dev:steady-setter-706`** (team `fpcmotif-gmail-com`, project
`feishu-route`) — see `.env.local`. Moving to the company project means: re-link locally,
deploy the backend, **re-set every env var** (they do **not** carry over), and re-point
the SPA + Feishu redirect at the new URL.

### C1. [CONSOLE] Convex — be an admin on the company team

In the [Convex dashboard](https://dashboard.convex.dev), confirm you're a member/admin of
the **company team**. Note its **team slug** (URL: `dashboard.convex.dev/t/<team-slug>`).
You can create the project here, or let C2 create it.

### C2. [CLI] Re-link this repo to the company project

```bash
# interactive — choose the company team, then create/select the project:
bunx convex dev --configure --once

# or fully flagged (creates the project if new):
bunx convex dev --configure=new --team <company-team-slug> --project feishu-route --once
```

This rewrites `.env.local` (`CONVEX_DEPLOYMENT` + `VITE_CONVEX_URL`/`_SITE_URL`) to the
**new dev** deployment and pushes the schema to it.

### C3. [CONSOLE] Convex — prod URL + deploy key

In the **new** project's dashboard:

1. **Settings → URL & Deploy Key** → copy the **Production** deployment URL
   (`https://<name>.convex.cloud`). The site URL is the same name with `.site`.
2. Generate a **Production Deploy Key**.

### C4. [CLI] Update build vars + deploy key in `.env.deploy`

```bash
CONVEX_DEPLOY_KEY=<new prod deploy key from C3>
VITE_CONVEX_URL=https://<new-name>.convex.cloud
VITE_CONVEX_SITE_URL=https://<new-name>.convex.site
```

### C5. [CLI] Deploy the backend to the new prod deployment

```bash
bash scripts/deploy.sh backend          # runs: bunx convex deploy (uses CONVEX_DEPLOY_KEY)
```

Pushes schema, functions, **and crons** (the reconcile/outbox crons register
automatically — ADR-0018). Tables start **empty**.

### C6. [CLI] Re-set ALL backend env vars (they do NOT migrate)

```bash
cp .env.convex.example .env.convex      # then fill it in (Feishu app id/secret + Base ids)
bash scripts/convex-env-sync.sh --prod  # confirms the target, then sets them on prod
# equivalently: bunx convex env set --from-file .env.convex --prod
```

Required: `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `FEISHU_BITABLE_APP_TOKEN`,
`FEISHU_BITABLE_TABLE_ID`. Optional tuning: `FEISHU_BITABLE_WEB_BASE_URL`,
`FEISHU_DRIVE_UPLOAD_CONCURRENCY`, `BITABLE_OWNED_ROW_UPDATE_WINDOW_MS`,
`ATTACHMENT_CAP`, `BITABLE_DIAG_LOG`. To also run locally, sync to dev too (drop
`--prod`). Verify: `bunx convex env list --prod`.

### C7. [CONSOLE] Feishu — whitelist the new redirect URL

The OAuth redirect is **`<VITE_CONVEX_SITE_URL>/feishu/oauth/callback`** (DEPLOY.md §4).
Because the `.site` host changed, this URL is new. In the Feishu Developer Console →
**安全设置 / Security Settings → Redirect URL**, add:

```
https://<new-name>.convex.site/feishu/oauth/callback
```

Without it, login fails with **`20029 Invalid redirect URL`**. (The ECS fallback-login
redirect from A5 is separate and box-hosted.)

> If the company also uses a **different Feishu app / Base** (not just a different Convex
> project): also update the four Feishu vars in C6, re-import permissions + release a new
> app version + have users re-authorize (DEPLOY.md §4 / ADR-0011), and add the app as a
> **Base collaborator with edit rights**.

### C8. [CLI] Rebuild + redeploy the SPA to BOTH hosts

`VITE_CONVEX_URL` is **baked into the bundle**, so the frontend must be rebuilt:

```bash
bash scripts/deploy.sh frontend                     # ECS Host (CN)
bunx wrangler logout && bunx wrangler login         # then:
bash scripts/deploy.sh cloudflare                   # Global Host (ADR-0009)
```

### C9. Data (optional)

Env vars and **table data do not copy** between Convex projects. The Customers and
Contacts tables are **Feishu mirrors** ([ADR-0021](adr/0021-customer-mirror-prune-and-event-sync.md)/[ADR-0023](adr/0023-feishu-contacts-mirror.md))
and **rebuild from their sync crons** ([ADR-0018](adr/0018-request-sync-outbox-and-reconcile.md)) — give them a cycle, or trigger the
directory/contacts sync, instead of copying rows. If you must carry raw data across,
`bunx convex export` from the old project + `bunx convex import` into the new (the old
personal project must still be reachable).

---

## Final smoke test (run after A and/or C)

```bash
# 1. SPA serves over HTTPS (cert valid) and http -> https redirects
curl -sI  http://<domain>/addin/  | head -1     # expect 301/308 -> https
curl -sI https://<domain>/addin/  | head -1     # expect 200

# 2. Sentry tunnel reaches upstream (resolver + include wired)
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<domain>/_sentry/ --data '{}'  # 401/403 = OK

# 3. nginx self-heal drop-in present (ADR-0029)
ssh deploy@<new-ip> "systemctl show nginx -p Restart --value"   # expect: on-failure

# 4. Convex prod env complete
bunx convex env list --prod                     # all required keys present
```

Then in Outlook: open the taskpane → **Feishu login round-trips** (no `20029`) → submit
a test intake → confirm a **row lands in the Base** with its attachments. If login throws
`20029`, the C7 redirect whitelist is missing or mistyped.

---

## TL;DR — the fast path

```bash
# A) new Aliyun box  (after the 3 console clicks in A1)
#    .env.deploy: PROVISION_SSH_TARGET=root@<new-ip>, DEPLOY_HOST=<new-ip>
bash scripts/provision-ecs.sh        # deploy user + nginx + Let's Encrypt (http->https) + hardening
bash scripts/deploy.sh frontend
bash scripts/deploy.sh auth

# C) new company Convex project
bunx convex dev --configure --once   # pick company team/project
#    .env.deploy: CONVEX_DEPLOY_KEY + VITE_CONVEX_URL/_SITE_URL from the new dashboard
bash scripts/deploy.sh backend
cp .env.convex.example .env.convex   # fill it
bash scripts/convex-env-sync.sh --prod
#    [CONSOLE] Feishu: whitelist https://<new>.convex.site/feishu/oauth/callback
bash scripts/deploy.sh frontend && bash scripts/deploy.sh cloudflare
```
