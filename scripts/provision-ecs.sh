#!/usr/bin/env bash
# scripts/provision-ecs.sh — one-time, idempotent provisioning of a fresh ECS Host
# (Aliyun Ubuntu 24, nginx serving the SPA from /var/www/addin under /addin/).
#
# Run ONCE over SSH against a brand-new box, BEFORE scripts/deploy.sh can reach it.
# It connects as the box's initial root (PROVISION_SSH_TARGET=root@<ip>) — a
# ONE-TIME bootstrap identity distinct from deploy.sh's DEPLOY_USER/DEPLOY_SSH_KEY,
# because the `deploy` user does not exist yet on a fresh box. After this runs,
# scripts/deploy.sh (frontend / auth) takes over as the `deploy` user.
#
# Steps, IN ORDER (each guarded so a re-run is a no-op):
#   1. create the `deploy` user + authorized_keys (DEPLOY_PUBKEY) + scoped sudoers
#   2. apt install nginx + certbot + Bun (Bun COPIED to /usr/local/bin, not symlinked)
#   3. render deploy/nginx/wmdev.conf -> sites-available/<host> (+ enabled symlink),
#      copy the snippets, enable gzip for JS/CSS, reload nginx
#   4. certbot --nginx (Let's Encrypt; needs DNS A record + security-group 80/443)
#   5. install + enable feishu-auth.service (NOT started — its env file is written
#      later by `deploy.sh auth`)
#   6. mkdir /var/www, chown to deploy (the Atomic Release writes here without sudo)
#   7. LAST: harden sshd (PermitRootLogin no, PasswordAuthentication no) + reload
#
# Step 7 intentionally ends the root bootstrap login: after a successful run you
# reconnect as `deploy` with the key. "Safe to re-run" therefore means a re-run is
# a no-op while the box is still reachable (e.g. after a mid-script failure); once
# step 7 lands, the box is provisioned and you no longer use root@<ip>.
#
# Reads env from .env.deploy (gitignored) — see .env.deploy.example. Mirrors the
# style of scripts/deploy.sh (set -euo pipefail, require_vars/require_tool, the
# .env.deploy sourcing pattern). bun/bunx only — never npm/npx.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
cd "$repo_root"

if [[ -f .env.deploy ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env.deploy
  set +a
fi

require_vars() {
  local missing=()
  for var in "$@"; do
    if [[ -z "${!var:-}" ]]; then missing+=("$var"); fi
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "Missing env vars: ${missing[*]}" >&2
    echo "Set them in .env.deploy (see .env.deploy.example)." >&2
    exit 1
  fi
}

require_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required tool not found on PATH: $1" >&2
    echo "$2" >&2
    exit 1
  fi
}

provision_ecs() {
  # PROVISION_SSH_TARGET is the bootstrap identity (root@<ip>), NOT DEPLOY_USER:
  # the deploy user is created by step 1, so it cannot exist on a fresh box.
  require_vars PROVISION_SSH_TARGET ADDIN_ECS_HOST CERTBOT_EMAIL DEPLOY_PUBKEY
  require_tool ssh "ssh is part of OpenSSH — install Git for Windows or enable the OpenSSH client."
  require_tool tar "tar ships with Git Bash / WSL / macOS / Linux."

  echo "==> provision $PROVISION_SSH_TARGET as the ECS Host for https://$ADDIN_ECS_HOST/addin/"
  echo "    (DNS A record for $ADDIN_ECS_HOST + security-group inbound 80/443 must already be open for certbot)"

  # Phase A: ship the reference configs (deploy/) to a temp dir on the box. Kept
  # separate from the script stream so the binary tar payload and the bash text
  # never interleave (same two-call shape as deploy.sh auth).
  echo "==> ship deploy/ reference configs to /tmp/provision-deploy"
  tar -czf - -C "$repo_root/deploy" . | ssh -o StrictHostKeyChecking=accept-new \
    "$PROVISION_SSH_TARGET" '
      set -e
      rm -rf /tmp/provision-deploy
      mkdir -p /tmp/provision-deploy
      tar -xzf - -C /tmp/provision-deploy
    '

  # Phase B: run the provisioning script. The three non-secret values
  # (ADDIN_ECS_HOST, CERTBOT_EMAIL, DEPLOY_PUBKEY — the pubkey contains spaces)
  # are injected as shell-safe assignments via printf %q, then the heredoc body
  # (unexpanded locally) references them as remote env. DEPLOY_PUBKEY is a PUBLIC
  # key, so passing it through the command stream leaks nothing.
  local remote_vars
  remote_vars="$(printf 'ADDIN_ECS_HOST=%q\nCERTBOT_EMAIL=%q\nDEPLOY_PUBKEY=%q\nexport ADDIN_ECS_HOST CERTBOT_EMAIL DEPLOY_PUBKEY\n' \
    "$ADDIN_ECS_HOST" "$CERTBOT_EMAIL" "$DEPLOY_PUBKEY")"

  echo "==> run provisioning steps on $PROVISION_SSH_TARGET"
  # printf '%s\n' (not '%s'): $(...) stripped remote_vars' trailing newline, so
  # without this the `export` line would glue onto the heredoc's first line.
  { printf '%s\n' "$remote_vars"; cat <<'REMOTE'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
DEPLOY_SRC=/tmp/provision-deploy

# ---------------------------------------------------------------------------
echo "==> [1/7] deploy user + authorized_keys + scoped sudoers"
# ---------------------------------------------------------------------------
if ! id deploy >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash deploy
fi
deploy_home="$(getent passwd deploy | cut -d: -f6)"
install -d -m 700 -o deploy -g deploy "$deploy_home/.ssh"
auth_keys="$deploy_home/.ssh/authorized_keys"
touch "$auth_keys"
# Append the deploy pubkey only if it is not already present (idempotent).
if ! grep -qxF "$DEPLOY_PUBKEY" "$auth_keys"; then
  printf '%s\n' "$DEPLOY_PUBKEY" >> "$auth_keys"
fi
chown deploy:deploy "$auth_keys"
chmod 600 "$auth_keys"

# Passwordless sudo for the deploy user, scoped to EXACTLY the commands
# scripts/deploy.sh runs (the frontend Atomic Release needs no sudo — /var/www is
# owned by deploy, step 6). `deploy.sh auth` ships the fallback server into /opt
# and writes /etc/feishu-auth.env (a fixed path). visudo -cf validates before it
# can take effect, so a syntax slip can never lock the user out of sudo.
cat > /etc/sudoers.d/deploy <<'SUDOERS'
# Managed by scripts/provision-ecs.sh — scoped passwordless sudo for the deploy user.
# Service control: nginx (reload/test) + the feishu-auth unit lifecycle.
deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart feishu-auth, /usr/bin/systemctl status feishu-auth, /usr/bin/systemctl reload nginx, /usr/sbin/nginx -t
# Fallback-auth shipment (deploy.sh auth): code into /opt/feishu-auth, env at a FIXED path.
deploy ALL=(root) NOPASSWD: /usr/bin/mkdir -p /opt/feishu-auth, /usr/bin/tar -xzf - -C /opt/feishu-auth, /usr/bin/chown -R deploy\:deploy /opt/feishu-auth, /usr/bin/tee /etc/feishu-auth.env, /usr/bin/chmod 600 /etc/feishu-auth.env
SUDOERS
chmod 440 /etc/sudoers.d/deploy
visudo -cf /etc/sudoers.d/deploy

# ---------------------------------------------------------------------------
echo "==> [2/7] apt packages (nginx, certbot) + Bun"
# ---------------------------------------------------------------------------
apt-get update -y
apt-get install -y nginx certbot python3-certbot-nginx curl unzip
# Install Bun as a real binary COPY in a system path (not a symlink into a home
# dir) so systemd's ExecStart=/usr/local/bin/bun stays reachable regardless of
# any user's $HOME. Guard on the destination so re-runs are no-ops.
if [ ! -x /usr/local/bin/bun ]; then
  curl -fsSL https://bun.sh/install | bash
  install -m 755 "$HOME/.bun/bin/bun" /usr/local/bin/bun
fi

# ---------------------------------------------------------------------------
echo "==> [3/7] nginx site ($ADDIN_ECS_HOST) + snippets + gzip"
# ---------------------------------------------------------------------------
# Render the reference server block, substituting the host placeholder.
sed "s|__ADDIN_DOMAIN__|$ADDIN_ECS_HOST|g" "$DEPLOY_SRC/nginx/wmdev.conf" \
  > "/etc/nginx/sites-available/$ADDIN_ECS_HOST"
ln -sfn "/etc/nginx/sites-available/$ADDIN_ECS_HOST" "/etc/nginx/sites-enabled/$ADDIN_ECS_HOST"
# Snippets the server block includes (addin headers, immutable asset cache, the
# fallback-auth proxy, the Sentry tunnel).
install -d /etc/nginx/snippets
for s in addin-headers addin-assets-cache feishu-auth sentry-tunnel; do
  install -m 644 "$DEPLOY_SRC/nginx/$s.conf" "/etc/nginx/snippets/$s.conf"
done
# Enable gzip for JS/CSS via a drop-in (idempotent overwrite) rather than editing
# the stock nginx.conf in place. conf.d/*.conf is included in the http context.
cat > /etc/nginx/conf.d/addin-gzip.conf <<'GZIP'
# Managed by scripts/provision-ecs.sh — gzip hashed JS/CSS so the taskpane bundle
# ships compressed (index.html is no-cache; hashed assets are immutable+cacheable).
gzip on;
gzip_vary on;
gzip_proxied any;
gzip_comp_level 6;
gzip_types text/plain text/css application/javascript application/json image/svg+xml;
GZIP
nginx -t
systemctl reload nginx

# ---------------------------------------------------------------------------
echo "==> [4/7] certbot TLS for $ADDIN_ECS_HOST"
# ---------------------------------------------------------------------------
if [ -d "/etc/letsencrypt/live/$ADDIN_ECS_HOST" ]; then
  echo "    cert for $ADDIN_ECS_HOST already present — skipping"
else
  certbot --nginx -d "$ADDIN_ECS_HOST" -m "$CERTBOT_EMAIL" --agree-tos -n
fi

# ---------------------------------------------------------------------------
echo "==> [5/7] feishu-auth.service (install + enable, NOT started)"
# ---------------------------------------------------------------------------
# Dedicated unprivileged system user the unit runs as.
if ! id feishu-auth >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin feishu-auth
fi
# WorkingDirectory for the unit; deploy.sh auth ships the code here (owned by
# deploy, world-readable so the feishu-auth user can execute it).
install -d -o deploy -g deploy /opt/feishu-auth
install -m 644 "$DEPLOY_SRC/feishu-auth.service" /etc/systemd/system/feishu-auth.service
systemctl daemon-reload
# Enable only. Do NOT start: /etc/feishu-auth.env (holding FEISHU_APP_SECRET) is
# written by `deploy.sh auth`, which then starts/restarts the service.
systemctl enable feishu-auth

# ---------------------------------------------------------------------------
echo "==> [6/7] /var/www owned by deploy (Atomic Release target)"
# ---------------------------------------------------------------------------
install -d -o deploy -g deploy /var/www

# ---------------------------------------------------------------------------
echo "==> [7/7] harden sshd (PermitRootLogin no, PasswordAuthentication no)"
# ---------------------------------------------------------------------------
# Drop-in (idempotent overwrite); /etc/ssh/sshd_config.d/*.conf is Included by the
# stock Ubuntu sshd_config. Validate before reloading so a typo can't break SSH.
cat > /etc/ssh/sshd_config.d/10-provision-hardening.conf <<'SSHD'
# Managed by scripts/provision-ecs.sh — key-only login; no root, no passwords.
PermitRootLogin no
PasswordAuthentication no
SSHD
chmod 644 /etc/ssh/sshd_config.d/10-provision-hardening.conf
sshd -t
# The unit is `ssh` on Ubuntu (older systems use `sshd`); reloading does not drop
# the current connection, so this script finishes over it.
systemctl reload ssh 2>/dev/null || systemctl reload sshd

rm -rf /tmp/provision-deploy
echo "==> provisioned. Reconnect as the deploy user with the DEPLOY_SSH_KEY, then:"
echo "    bash scripts/deploy.sh frontend   # ship the SPA"
echo "    bash scripts/deploy.sh auth       # ship + start the fallback auth server"
REMOTE
  } | ssh -o StrictHostKeyChecking=accept-new "$PROVISION_SSH_TARGET" bash -s

  echo "OK provisioned $ADDIN_ECS_HOST — root SSH + password auth are now disabled."
}

usage() {
  cat <<'USAGE'
Usage: bash scripts/provision-ecs.sh [provision]

One-time, idempotent provisioning of a fresh ECS Host (Aliyun Ubuntu 24). Connects
as the box's initial root (PROVISION_SSH_TARGET=root@<ip>) and installs everything
scripts/deploy.sh assumes: the deploy user + key + scoped sudo, nginx + the rendered
site + snippets + gzip, a Let's Encrypt cert, the feishu-auth unit (enabled, not
started), /var/www owned by deploy, and finally sshd hardening (key-only, no root).

Reads .env.deploy (gitignored) — see .env.deploy.example. Requires:
  PROVISION_SSH_TARGET   root@<ip> bootstrap identity (NOT DEPLOY_USER — it does
                         not exist yet on a fresh box)
  ADDIN_ECS_HOST         the public host the SPA is served from (e.g. wmdev.zeuja.com)
  CERTBOT_EMAIL          Let's Encrypt registration / renewal-notice email
  DEPLOY_PUBKEY          the deploy key's PUBLIC half (added to ~deploy/authorized_keys)

Prerequisites the script does NOT do: a DNS A record for ADDIN_ECS_HOST and an
inbound security-group rule for ports 80 and 443 (both needed before certbot).

After it finishes, root@<ip> can no longer log in — reconnect as the deploy user:
  bash scripts/deploy.sh frontend
  bash scripts/deploy.sh auth
USAGE
}

case "${1:-provision}" in
  provision)        provision_ecs ;;
  -h|--help|help)   usage ;;
  *)                usage; exit 1 ;;
esac
