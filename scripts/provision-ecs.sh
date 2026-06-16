#!/usr/bin/env bash
# scripts/provision-ecs.sh — idempotent in-box bootstrap for the ECS Host (ADR-0028,
# ADR-0029). Runs ONCE over SSH on a fresh Ubuntu 24.04 box and is safe to re-run.
#
# Connects with a one-time bootstrap identity (PROVISION_SSH_TARGET=root@<ip>,
# Aliyun's initial credential) because the `deploy` user it creates doesn't exist
# yet on the first run. Pairs with scripts/deploy.sh, which ships the app onto an
# already-provisioned box.
#
# Reads .env.deploy (gitignored) — see .env.deploy.example. Required vars:
#   ADDIN_ECS_HOST       public domain (certbot -d, nginx server_name, manifest host)
#   CERTBOT_EMAIL        Let's Encrypt account / renewal notices
#   DEPLOY_PUBKEY        path to the operator PUBLIC key, installed for the deploy user
#   PROVISION_SSH_TARGET one-time bootstrap identity, e.g. root@47.80.18.84
#
# Re-rendering a box that is ALREADY provisioned refuses to clobber the live config
# unless PROVISION_FORCE=1 is set (the live box is a hand-built snowflake until the
# first scripted run — guard against silently overwriting hand-tuned files).
#
# Usage:  bash scripts/provision-ecs.sh
set -euo pipefail

script_source="${BASH_SOURCE[0]}"
script_dir="${script_source%/*}"
[[ "$script_dir" == "$script_source" ]] && script_dir="."
script_dir="$(cd -- "$script_dir" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
cd "$repo_root"

if [[ -f .env.deploy ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env.deploy
  set +a
fi

require_vars() {
  local missing=()
  for v in "$@"; do [[ -z "${!v:-}" ]] && missing+=("$v"); done
  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "Missing env vars: ${missing[*]}" >&2
    echo "Set them in .env.deploy (see .env.deploy.example)." >&2
    exit 1
  fi
}
require_vars ADDIN_ECS_HOST CERTBOT_EMAIL DEPLOY_PUBKEY PROVISION_SSH_TARGET

command -v ssh >/dev/null || { echo 'ssh not on PATH' >&2; exit 1; }
command -v tar >/dev/null || { echo 'tar not on PATH' >&2; exit 1; }
pubkey_path="${DEPLOY_PUBKEY/#\~/$HOME}"
[[ -f "$pubkey_path" ]] || { echo "DEPLOY_PUBKEY not found: $DEPLOY_PUBKEY" >&2; exit 1; }

SSH=(ssh -o StrictHostKeyChecking=accept-new "$PROVISION_SSH_TARGET")
PUBKEY_CONTENT="$(cat "$pubkey_path")"

echo "==> ship deploy/ (nginx config + systemd units) to the box"
tar -czf - deploy | "${SSH[@]}" 'set -e; rm -rf /tmp/provision && mkdir -p /tmp/provision && tar -xzf - -C /tmp/provision'

echo "==> run in-box bootstrap (idempotent)"
"${SSH[@]}" \
  "ADDIN_ECS_HOST='$ADDIN_ECS_HOST' CERTBOT_EMAIL='$CERTBOT_EMAIL' DEPLOY_PUBKEY_CONTENT='$PUBKEY_CONTENT' PROVISION_FORCE='${PROVISION_FORCE:-}' bash -s" <<'REMOTE'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
SRC=/tmp/provision/deploy
SITE=/etc/nginx/sites-available/"$ADDIN_ECS_HOST"

# Fresh-box guard: refuse to clobber a hand-built live config unless forced. The
# live box is a snowflake until the first scripted run; a blind re-render could
# overwrite hand-tuned files.
if [[ -f "$SITE" && -z "${PROVISION_FORCE:-}" ]]; then
  echo "ERROR: $SITE already exists (box already provisioned)." >&2
  echo "       Re-render is DESTRUCTIVE on a hand-built box. Set PROVISION_FORCE=1 to proceed," >&2
  echo "       or apply the two resilience artifacts surgically (see DEPLOY.md §2 Resilience)." >&2
  exit 1
fi

# 1) deploy user + key + scoped passwordless sudo. /usr/bin/tar IS required:
#    deploy.sh `auth` runs `sudo tar -xzf - -C /opt/feishu-auth`.
if ! id deploy >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash deploy
fi
install -d -m700 -o deploy -g deploy /home/deploy/.ssh
if ! grep -qxF "$DEPLOY_PUBKEY_CONTENT" /home/deploy/.ssh/authorized_keys 2>/dev/null; then
  printf '%s\n' "$DEPLOY_PUBKEY_CONTENT" >>/home/deploy/.ssh/authorized_keys
fi
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys
cat >/etc/sudoers.d/deploy <<'SUDO'
deploy ALL=(root) NOPASSWD: /usr/bin/systemctl, /usr/sbin/nginx, /usr/bin/tee, /usr/bin/install, /usr/bin/chown, /usr/bin/chmod, /usr/bin/mkdir, /usr/bin/rm, /usr/bin/tar
SUDO
chmod 440 /etc/sudoers.d/deploy
visudo -cf /etc/sudoers.d/deploy

# 2) packages + Bun (copy to a system path, not a ~/.bun symlink).
apt-get update -y
apt-get install -y nginx certbot python3-certbot-nginx curl ca-certificates dos2unix
if ! command -v /usr/local/bin/bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
  cp "$HOME/.bun/bin/bun" /usr/local/bin/bun
fi

# 3) nginx config. The repo files have CRLF line endings (Windows authoring);
#    strip them on the box before nginx/grep/sed touch the files. Snippets are
#    copied verbatim (sentry-tunnel.conf carries the lazy resolver + the fixed
#    single-project DSN; no placeholder). wmdev.conf is the ONLY file with a
#    placeholder (__ADDIN_DOMAIN__ -> ADDIN_ECS_HOST) and already carries the
#    snippet `include` lines, so no injection is needed.
install -d /etc/nginx/snippets
for s in addin-headers addin-assets-cache feishu-auth sentry-tunnel; do
  install -m644 "$SRC/nginx/$s.conf" "/etc/nginx/snippets/$s.conf"
  sed -i 's/\r$//' "/etc/nginx/snippets/$s.conf"
done

sed "s/__ADDIN_DOMAIN__/$ADDIN_ECS_HOST/g" "$SRC/nginx/wmdev.conf" >"$SITE"
sed -i 's/\r$//' "$SITE"
ln -sfn "$SITE" "/etc/nginx/sites-enabled/$ADDIN_ECS_HOST"
# Assert the tunnel include is actually wired (fail loudly rather than ship a box
# with the resolver snippet present-but-unreferenced).
grep -q 'snippets/sentry-tunnel.conf' "$SITE" || { echo 'FAIL: sentry-tunnel include missing from server block' >&2; exit 1; }

# gzip for JS/CSS via an idempotent drop-in (never sed -i the stock nginx.conf).
cat >/etc/nginx/conf.d/gzip.conf <<'GZIP'
gzip on;
gzip_types text/plain text/css application/json application/javascript application/x-javascript text/xml application/xml application/xml+rss text/javascript;
GZIP

# 3b) systemd nginx self-heal drop-in (Restart=on-failure, retry forever) + reload.
#     Restart/RestartSec live in [Service]; StartLimit* in [Unit] (correct for
#     systemd 255; the file is shipped LF so no CRLF strip needed, but harmless).
install -D -m644 "$SRC/systemd/nginx.service.d/override.conf" \
  /etc/systemd/system/nginx.service.d/override.conf
systemctl daemon-reload
# Clear any latched start-limit state BEFORE starting (daemon-reload does not).
systemctl reset-failed nginx 2>/dev/null || true

# Validate config BEFORE certbot touches it; this passes even if Sentry DNS is
# down (the whole point of the lazy resolver).
nginx -t
systemctl enable nginx
systemctl restart nginx

# 4) TLS via certbot (HTTP-01 on :80). Idempotent: re-runs are a no-op once issued.
certbot --nginx -d "$ADDIN_ECS_HOST" -m "$CERTBOT_EMAIL" --agree-tos -n --redirect
# Renewal deploy-hook: a 90-day auto-renew must validate + graceful-reload, never
# leave the box on a broken config.
install -d /etc/letsencrypt/renewal-hooks/deploy
cat >/etc/letsencrypt/renewal-hooks/deploy/00-nginx-reload.sh <<'HOOK'
#!/usr/bin/env bash
set -e
/usr/sbin/nginx -t
/usr/bin/systemctl reload nginx
HOOK
chmod +x /etc/letsencrypt/renewal-hooks/deploy/00-nginx-reload.sh

# 5) feishu-auth unit (start deferred — deploy.sh `auth` writes /etc/feishu-auth.env).
install -m644 "$SRC/feishu-auth.service" /etc/systemd/system/feishu-auth.service
systemctl daemon-reload
systemctl enable feishu-auth || true

# 6) web root owned by deploy.
mkdir -p /var/www
chown deploy /var/www

# 7) LAST: harden sshd (so a bad key can't lock the operator out before this point).
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl reload ssh 2>/dev/null || systemctl reload sshd

# 8) BLOCKING smoke checks — fail the run if the hardened state didn't come up.
nginx -t
systemctl is-active --quiet nginx || { echo 'nginx not active after provision' >&2; exit 1; }
[[ "$(systemctl show nginx -p Restart --value)" == 'on-failure' ]] || { echo 'FAIL: Restart= drop-in not active' >&2; exit 1; }

# /addin/ must serve (retry a few times for DNS/cert settle).
addin_ok=""
for i in 1 2 3 4 5 6; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "https://$ADDIN_ECS_HOST/addin/" || true)
  if [[ "$code" == 200 || "$code" == 304 ]]; then addin_ok=1; break; fi
  sleep 5
done
[[ -n "$addin_ok" ]] || { echo "FAIL: /addin/ did not return 200/304" >&2; exit 1; }

# POST /_sentry/ must reach Sentry (401/403 = tunnel+resolver OK; 404 = include
# missing; 502 = resolver/DNS).
scode=$(curl -s -o /dev/null -w '%{http_code}' -X POST "https://$ADDIN_ECS_HOST/_sentry/" --data '{}' || true)
case "$scode" in
  401|403) echo "OK /_sentry/ -> $scode (tunnel reaches Sentry)" ;;
  *) echo "FAIL /_sentry/ -> $scode (404=include missing, 502=resolver/DNS)" >&2; exit 1 ;;
esac

rm -rf /tmp/provision
echo 'OK provision-ecs complete'
REMOTE

echo ""
echo "OK provisioned $ADDIN_ECS_HOST. Next: set DEPLOY_USER=deploy + DEPLOY_SSH_KEY in"
echo ".env.deploy, then 'bash scripts/deploy.sh frontend' and 'bash scripts/deploy.sh auth'."
