# Reproducible ECS provisioning via scripts/provision-ecs.sh

> **Status: accepted.** Complements [ADR-0002](0002-serve-spa-from-ecs.md) (serve the SPA from the ECS box), [ADR-0008](0008-fallback-login-via-box.md) (the box's fallback OAuth server), and [ADR-0009](0009-cloudflare-global-host-dual-deploy.md) (dual-host). Captures the box's *initial* setup as code, so `scripts/deploy.sh` has a host to deploy to.

`scripts/deploy.sh` deploys onto a box that already has nginx, TLS, the `deploy` user, Bun, and the systemd unit in place. Until now those one-time steps lived only in prose (the deploy runbook's "one-time setup" list + the `deploy.sh` usage notes). Rebuilding the **ECS Host** — or standing up a second one — meant hand-running a dozen commands from memory, in the right order, with no idempotency. That is the same hardcode/manual anti-pattern the rest of the deploy tooling has been moving away from.

## Decision

A single idempotent script, `scripts/provision-ecs.sh`, provisions a fresh Aliyun Ubuntu 24 box end to end. It is run **once**, over SSH, from a workstation, **before** `deploy.sh` can reach the box.

- **Bootstrap identity.** It connects as `PROVISION_SSH_TARGET=root@<ip>` — Aliyun's initial root over the box IP — **not** `deploy.sh`'s `DEPLOY_USER`/`DEPLOY_SSH_KEY`. The `deploy` user does not exist yet on a fresh box; the script creates it. After provisioning, that bootstrap identity is gone (step 7 disables root + password SSH).
- **Config from `.env.deploy`.** Same sourcing pattern as `deploy.sh`. New vars: `ADDIN_ECS_HOST` (the public host — now the single source of truth), `CERTBOT_EMAIL`, `DEPLOY_PUBKEY` (the public half of `DEPLOY_SSH_KEY`), `PROVISION_SSH_TARGET`.
- **Steps, in order, each guarded so a re-run is a no-op:**
  1. create the `deploy` user, install `DEPLOY_PUBKEY` into `~deploy/.ssh/authorized_keys`, write a **scoped** passwordless sudoers (only the `systemctl`/`nginx` and fallback-auth-shipment commands `deploy.sh` actually runs — `visudo -cf`-validated);
  2. `apt install nginx certbot python3-certbot-nginx`, install **Bun** as a real binary **copy** at `/usr/local/bin/bun` (not a symlink into a home dir — systemd's `ExecStart` must stay reachable);
  3. render `deploy/nginx/wmdev.conf` (`__ADDIN_DOMAIN__` → `ADDIN_ECS_HOST`) into `sites-available/<host>` + the `sites-enabled` symlink, copy the `{addin-headers,addin-assets-cache,feishu-auth,sentry-tunnel}` snippets to `/etc/nginx/snippets/`, enable gzip for JS/CSS, reload nginx;
  4. `certbot --nginx -d $ADDIN_ECS_HOST -m $CERTBOT_EMAIL --agree-tos -n` (skipped if the cert already exists);
  5. install `deploy/feishu-auth.service` and `systemctl enable` it — **not** started: its `/etc/feishu-auth.env` (holding `FEISHU_APP_SECRET`) is written later by `deploy.sh auth`;
  6. `mkdir -p /var/www` + `chown deploy` (the Atomic Release writes here without sudo);
  7. **last:** `sshd` `PermitRootLogin no` + `PasswordAuthentication no`, reload `sshd`.

`ADDIN_ECS_HOST` becomes the single source of truth for the host across the tooling: `provision-ecs.sh` renders nginx's `server_name` from it, `deploy.sh frontend` requires it and reports the deployed URL from it, and `scripts/manifest.mjs --ecs` bakes it into the sideload manifest (the old hardcoded `wmdev.zeuja.com` literal survives only as a last-resort default).

## Why

- **Reproducible, not remembered.** The box's setup is code, ordered and idempotent — rebuilding or cloning it is one command, not a prose checklist run from memory.
- **Least-privilege boundary.** The bootstrap root identity does the privileged install, then locks itself out; steady-state access is the key-only `deploy` user with sudo scoped to the exact commands `deploy.sh` runs.
- **One host variable.** Removing the `wmdev.zeuja.com` hardcode (mirroring the earlier `convex.site` cleanup) means the host is set once in `.env.deploy` and flows to nginx, the deploy URL, and the manifest.
- **No new moving parts.** It renders the *same* reference configs (`deploy/nginx/*.conf`, `deploy/feishu-auth.service`) that `deploy.sh` already ships against — provisioning and deploy share one source of truth.

## Consequences

- **Step 7 ends the bootstrap login.** After a successful run, `root@<ip>` can no longer SSH in — you reconnect as `deploy`. "Safe to re-run" therefore means a re-run is a no-op *while the box is still reachable* (e.g. after a mid-script failure, before step 7 lands); a fully provisioned box is finished with the bootstrap identity.
- **Two external prereqs remain manual.** A DNS A record for `ADDIN_ECS_HOST` and a security-group inbound rule for ports 80/443 must exist before step 4 — certbot needs both. The script does not touch Aliyun's control plane (no RAM/OSS/CDN credentials; those dead vars are dropped from `.env.deploy.example`).
- **The deploy user's sudoers is coupled to `deploy.sh`.** It grants exactly the commands `deploy.sh auth` runs (ship into `/opt/feishu-auth`, write `/etc/feishu-auth.env`, `systemctl restart feishu-auth`) plus nginx reload/test. Adding a new privileged step to `deploy.sh` means widening the sudoers here.
- **`wmdev.conf` now includes all four snippets.** The reference server block previously `include`d only `addin-headers`; provisioning copies four snippets, so the block now includes the asset-cache, fallback-auth, and Sentry-tunnel locations too (they were documented as "add to the server block" in each snippet's header).
- **The runbook is now a pointer.** `docs/DEPLOY.md` §2 and the `deploy.sh` usage notes describe *running the script*, not the manual steps it replaced.

## Alternatives rejected

- **A config-management tool (Ansible/cloud-init).** Overkill for a single box: a new runtime + inventory to learn and pin, for ~40 lines of guarded shell. A plain idempotent script matches the existing `deploy.sh` style and dependency set (ssh + tar).
- **Fold provisioning into `deploy.sh`.** Different identity (bootstrap root vs the `deploy` user), different cadence (once vs every release), and a different blast radius (it disables root SSH). Keeping it a separate script keeps `deploy.sh` a pure deploy path.
- **Bake an image (custom AMI/snapshot).** Faster boot, but the image drifts from the configs in git and hides the setup. Rendering the in-repo reference configs keeps one source of truth; an image can still be snapshotted *after* provisioning if boot time ever matters.
- **Keep root SSH enabled for easy re-provisioning.** Rejected: a CN-resident, internet-facing box should be key-only with no root login. Re-provisioning is rare and done as `deploy` with sudo, or against a fresh box.
