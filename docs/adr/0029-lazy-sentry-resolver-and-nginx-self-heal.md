# 0029 — Lazy Sentry resolver + nginx self-heal (the 2026-06-12 outage)

> **Status: accepted.** Builds on [ADR-0007](0007-sentry-observability.md) (the
> `/_sentry/` tunnel) and [ADR-0028](0028-reproducible-ecs-provisioning.md)
> (repo-is-source-of-truth provisioning).

On 2026-06-12 the ECS Host was down for **3 days**. The Sentry tunnel
(`deploy/nginx/sentry-tunnel.conf`) used a *bare* upstream hostname in `proxy_pass`,
which nginx resolves once **at config-load**; a failure there is fatal
(`[emerg] host not found in upstream`). The daily `unattended-upgrade` bounced nginx
while `systemd-resolved` (the `127.0.0.53` stub) was momentarily unavailable, so
`ExecStartPre=nginx -t` could not resolve the Sentry host and nginx refused to start —
taking the `/addin/` SPA down with it. Stock Ubuntu 24.04 `nginx.service` has no
`Restart=`, so nothing retried.

We fix it on two independent axes and make both reproducible from the repo via
`scripts/provision-ecs.sh`:

1. **Resolve the Sentry host lazily.** A `resolver` directive (Aliyun VPC DNS
   `100.100.2.136`/`.138` first — independent of the `127.0.0.53` stub that died —
   with public AliDNS `223.5.5.5` as backstop, `ipv6=off`, `valid=300s`,
   `resolver_timeout 5s`) plus a `$variable` in `proxy_pass` defer DNS to **request
   time**, so config-load / `nginx -t` / startup perform **no lookup**. nginx always
   starts; only `/_sentry/` telemetry degrades on a DNS blip. The full
   `/api/.../envelope/` path is spelled out literally because a variable in
   `proxy_pass` suppresses URI appending; SNI (`proxy_ssl_server_name on` +
   `proxy_ssl_name`) and the upstream `Host` both pin the literal ingest host. This is
   the **primary** defense — it makes the startup-fatal DNS mode impossible.
2. **systemd self-heal.** A drop-in
   (`deploy/systemd/nginx.service.d/override.conf`): `Restart=on-failure`,
   `RestartSec=10s` in `[Service]`, and `StartLimitIntervalSec=0` in `[Unit]`.
   `IntervalSec=0` disables the start-rate limiter so nginx retries **indefinitely**
   and self-heals whenever the cause clears. A *bounded* burst (e.g. 30 tries / 5 min)
   was rejected: it latches the unit into a permanent `failed (start-limit-hit)` state
   after ~5 min and would not recover a multi-hour outage. A clean `systemctl stop`
   exits 0 and is still honored.

We deliberately did **not** add `proxy_ssl_verify on` to the tunnel: it converts the
box→Sentry hop into a new silent-502 surface (stale CA bundle / clock skew) with
negligible MITM gain on a box with no telemetry alerting.

## Considered and rejected (verifier-flagged over-engineering)

- **A swapfile** (1.6 GB RAM / 0 swap) — a separate OOM concern, not this DNS-startup
  outage class; the proposed commands were non-idempotent / `ETXTBSY`-prone.
- **An apt maintenance-window drop-in** — its `MinimalSteps`/`needrestart` rationale
  was false (`MinimalSteps` controls batching, not `needrestart`'s prompt mode; stock
  `needrestart` degrades to list-only under unattended-upgrades and does not auto-restart
  nginx). The real protection is axes 1+2 surviving the bounce.
- **`ufw` / `fail2ban`** — the Aliyun security group is the firewall; enabling `ufw`
  on top risks an SSH lockout for no gain on a single low-traffic box.

## Consequences / invariants (future provisioning must not undo)

- Never reduce `sentry-tunnel.conf` to a bare-hostname `proxy_pass`.
- Never bound the self-heal start-limit (keep `StartLimitIntervalSec=0`); never remove
  the `Restart=` drop-in.
- Either axis alone re-opens the 3-day-outage failure mode.
- The trade-off of retry-forever is that a genuinely-broken config (not covered by the
  lazy resolver) loops every 10s with no "park + page" signal — accepted for an
  unmonitored box where availability beats a failure alarm. If on-call/alerting is
  added later, revert to a bounded limit **and** alert on `result=start-limit-hit`.
