# Provision the ECS box reproducibly; retire the OSS/CDN edge config

> **Status: accepted.** Builds on [ADR-0002](0002-serve-spa-from-ecs.md); closes
> dangling config from superseded [ADR-0001](0001-cn-edge-gateway-warm-standby.md).

Standing up a fresh **ECS Host** (e.g. when migrating to a new Aliyun tenant) was an
undocumented mix of console clicks and hand-run shell — `scripts/deploy.sh` only ever
deployed the *app* onto an already-provisioned box. We codify the in-box setup in an
idempotent **`scripts/provision-ecs.sh`**, keep the genuinely account-bound steps as a
short console checklist, and delete the dead OSS/CDN/RAM config that ADR-0001 left behind.

## What we decided

- **In-box bootstrap is scripted; Aliyun-console steps stay manual.** `provision-ecs.sh`
  runs once over SSH on a fresh Ubuntu 24 box and is safe to re-run. The manual prefix is
  three console actions: create the ECS instance, open security-group inbound **80 + 443**,
  point a DNS **A record** at the instance IP. Steps are detailed in [DEPLOY.md §2](../DEPLOY.md).
- **TLS is Let's Encrypt via certbot on the box** (`certbot --nginx`, HTTP-01 on port 80,
  systemd auto-renew). nginx terminates TLS. There is no Aliyun cert API / CAS upload path.
- **The OSS/CDN/RAM env vars are dead and removed** — `ALIBABA_CLOUD_ACCESS_KEY_ID` /
  `_SECRET`, `OSS_BUCKET`, `OSS_ENDPOINT`, `ALIYUN_REGION`, `CDN_DOMAIN`. They were read by
  nothing in the repo and described an OSS+CDN edge that ADR-0002 already replaced with
  plain nginx-on-a-box. CONTEXT.md's glossary already forbids "CDN"; the `.env` files just
  never got cleaned up.
- **One canonical public domain: `ADDIN_ECS_HOST`.** `scripts/deploy.sh` already honours it
  for baking the manifest; `.env.deploy` now sets it, and certbot, nginx `server_name`, the
  manifest host, and the Feishu fallback redirect URI all derive from it. `DEPLOY_HOST` stays
  the **IP** used for SSH (reachable before DNS/cert exist).
- **A dedicated `deploy` user; root SSH disabled.** Provisioning creates `deploy`, installs
  the operator's public key, grants scoped passwordless sudo (nginx, systemctl, `/var/www`),
  then turns off `PermitRootLogin` / `PasswordAuthentication`. This finishes a migration the
  repo was already half-built for: `.env.deploy.example` named a `deploy` user and
  `deploy.sh`'s `sudo` calls assume one, but the live box was still deployed to as root.

## Considered options

- **Full IaC (Terraform / Aliyun CLI)** — rejected. Scripting instance + security-group + DNS
  creation re-introduces a RAM-key credential surface (the one we're deleting) and a whole
  toolchain to maintain, for a **single** box stood up rarely. Not worth it.
- **Tightened manual runbook only** — rejected. The in-box steps (nginx config placement,
  certbot, deploy user, systemd unit) are fiddly and error-prone; a box provisioned ~once a
  year is exactly where an unrun runbook drifts from reality. The console steps, by contrast,
  are few and genuinely one-time, so a checklist suffices for them.
- **In-box bootstrap script + console checklist** — chosen. Scripts the error-prone 90%,
  leaves the irreducibly-manual 10% as three documented clicks.

## Consequences

- Provisioning is reproducible from "fresh Ubuntu box" onward; a tenant migration is the
  console checklist + `provision-ecs.sh` + the existing `deploy.sh` app deploys.
- `provision-ecs.sh` connects with a **one-time bootstrap identity** (`root@<ip>` via Aliyun's
  initial credential), distinct from `deploy.sh`'s `DEPLOY_USER`/`DEPLOY_SSH_KEY` — because the
  `deploy` user it creates doesn't exist yet on first run.
- The sshd-hardening step runs **last**, after the `deploy` user + key are in place and verified,
  so a bad key can't lock the operator out.
- The Convex backend swap stays decoupled from the box: nginx's CSP uses `*.convex.cloud` /
  `*.convex.site` wildcards, so a new Convex team/deployment needs no nginx change.
