#!/usr/bin/env bash
# scripts/deploy.sh — deploy pipeline (frontend / backend / all)
#
# Frontend: vite build (base=/addin/) -> tar over SSH -> atomic release on the
#           ECS box (timestamped dir + /var/www/addin symlink, keep last 3).
# Backend:  bunx convex deploy (asks confirmation; prod is not trivially reversible)
#
# Replaces the GitHub Actions workflow (GH Actions billing is exhausted on this
# account). Runs from a local terminal (Git Bash / WSL on Windows, bash on
# macOS/Linux) OR from inside the ECS box. Reads env from .env.deploy
# (gitignored) — see .env.deploy.example.

set -euo pipefail

cmd="${1:-help}"
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

deploy_frontend() {
  require_vars \
    DEPLOY_HOST DEPLOY_USER DEPLOY_SSH_KEY \
    VITE_CONVEX_URL VITE_CONVEX_SITE_URL VITE_FEISHU_APP_ID
  require_tool ssh "ssh is part of OpenSSH — install Git for Windows or enable the OpenSSH client."
  require_tool tar "tar ships with Git Bash / WSL / macOS / Linux."

  echo "==> vite build (base=/addin/, Sentry tunneled via /_sentry/)"
  # MSYS_NO_PATHCONV stops Git Bash rewriting /addin/ into a Windows path.
  # VITE_SENTRY_TUNNEL routes Sentry through the box's same-origin nginx proxy
  # (ADR-0009); the `cloudflare` build omits it and ingests direct.
  MSYS_NO_PATHCONV=1 VITE_SENTRY_TUNNEL=/_sentry/ bun run build -- --base=/addin/

  # Atomic release: unpack into a timestamped dir, flip the /var/www/addin
  # symlink, prune all but the newest 3 releases. Rollback = repoint the
  # symlink at an older release dir. Mirrors the deploy step that used to live
  # in .github/workflows/deploy.yml.
  echo "==> deploy dist/ to $DEPLOY_USER@$DEPLOY_HOST:/var/www/addin"
  tar -czf - -C dist . | ssh -i "$DEPLOY_SSH_KEY" \
    -o StrictHostKeyChecking=accept-new \
    "$DEPLOY_USER@$DEPLOY_HOST" '
      set -e
      TS=$(date +%Y%m%d-%H%M%S)
      mkdir -p "/var/www/releases/$TS"
      tar -xzf - -C "/var/www/releases/$TS"
      if [ -e /var/www/addin ] && [ ! -L /var/www/addin ]; then rm -rf /var/www/addin; fi
      ln -sfn "/var/www/releases/$TS" /var/www/addin
      ls -1dt /var/www/releases/*/ | tail -n +4 | xargs -r rm -rf
      echo "deployed $TS"
    '

  echo "OK frontend -> https://$DEPLOY_HOST/addin/"
}

deploy_backend() {
  require_vars CONVEX_DEPLOY_KEY
  read -r -p "Deploy Convex backend to PRODUCTION? [y/N] " ans
  if [[ "$ans" != "y" && "$ans" != "Y" ]]; then
    echo "Aborted."
    exit 1
  fi
  echo "==> bunx convex deploy"
  CONVEX_DEPLOY_KEY="$CONVEX_DEPLOY_KEY" bunx convex deploy
  echo "OK backend deployed"
}

# Fallback Feishu auth server (ADR-0008): ship server/feishu-auth, write the
# systemd EnvironmentFile, restart the service. Requires the one-time setup in
# the usage notes (Bun + the systemd unit + the nginx include) and passwordless
# sudo for the deploy user.
deploy_auth() {
  # FEISHU_FALLBACK_REDIRECT_URI is REQUIRED (not derived from DEPLOY_HOST): the
  # box is reached over SSH by IP, but the redirect URI must be the public HTTPS
  # DOMAIN the SPA is served from (and that Feishu has whitelisted).
  require_vars DEPLOY_HOST DEPLOY_USER DEPLOY_SSH_KEY FEISHU_APP_SECRET FEISHU_FALLBACK_REDIRECT_URI
  require_tool ssh "ssh is part of OpenSSH — install Git for Windows or enable the OpenSSH client."
  require_tool tar "tar ships with Git Bash / WSL / macOS / Linux."

  local app_id="${FEISHU_APP_ID:-${VITE_FEISHU_APP_ID:-}}"
  if [[ -z "$app_id" ]]; then
    echo "Set FEISHU_APP_ID (or VITE_FEISHU_APP_ID) in .env.deploy." >&2
    exit 1
  fi
  local redirect_uri="$FEISHU_FALLBACK_REDIRECT_URI"
  local scope="${FEISHU_FALLBACK_SCOPE:-contact:user:search offline_access}"
  local port="${FEISHU_AUTH_PORT:-8788}"

  echo "==> ship server/feishu-auth to $DEPLOY_USER@$DEPLOY_HOST:/opt/feishu-auth"
  tar -czf - -C server/feishu-auth . | ssh -i "$DEPLOY_SSH_KEY" \
    -o StrictHostKeyChecking=accept-new "$DEPLOY_USER@$DEPLOY_HOST" '
      set -e
      sudo mkdir -p /opt/feishu-auth
      sudo tar -xzf - -C /opt/feishu-auth
      sudo chown -R "$(id -un)":"$(id -gn)" /opt/feishu-auth
    '

  # The SECRET travels over the SSH channel via stdin into `tee` — never on a
  # command line (so it can't leak via `ps`) and never echoed locally.
  echo "==> write /etc/feishu-auth.env (chmod 600) + restart feishu-auth"
  {
    printf 'FEISHU_APP_ID=%s\n' "$app_id"
    printf 'FEISHU_APP_SECRET=%s\n' "$FEISHU_APP_SECRET"
    printf 'FEISHU_FALLBACK_REDIRECT_URI=%s\n' "$redirect_uri"
    printf 'FEISHU_FALLBACK_SCOPE=%s\n' "$scope"
    printf 'PORT=%s\n' "$port"
  } | ssh -i "$DEPLOY_SSH_KEY" -o StrictHostKeyChecking=accept-new \
    "$DEPLOY_USER@$DEPLOY_HOST" '
      set -e
      umask 077
      sudo tee /etc/feishu-auth.env >/dev/null
      sudo chmod 600 /etc/feishu-auth.env
      sudo systemctl restart feishu-auth
      sleep 1
      curl -fsS "http://127.0.0.1:'"$port"'/healthz" >/dev/null && echo "feishu-auth healthy"
    '
  echo "OK feishu-auth -> $redirect_uri"
}

# Global Host (ADR-0009): build the SPA at root base and publish to Cloudflare
# Pages (the non-CN audience). Sentry is NOT tunneled here — there is no /_sentry/
# proxy on Pages — so it ingests direct to *.ingest.sentry.io, which the CSP in
# public/_headers allows. Reads the same VITE_* build vars from .env.deploy.
deploy_cloudflare() {
  require_vars VITE_CONVEX_URL VITE_CONVEX_SITE_URL VITE_FEISHU_APP_ID
  require_tool bunx "bunx ships with Bun."

  # wrangler needs an authenticated session. A CLOUDFLARE_API_TOKEN works
  # unattended; otherwise an interactive `wrangler login` must have run first.
  if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]] && ! bunx wrangler whoami >/dev/null 2>&1; then
    echo "Not authenticated to Cloudflare. Re-auth first:" >&2
    echo "  bunx wrangler logout && bunx wrangler login" >&2
    echo "(or set CLOUDFLARE_API_TOKEN). See docs/DEPLOY.md." >&2
    exit 1
  fi

  echo "==> vite build (base=/, direct Sentry ingest)"
  # MSYS_NO_PATHCONV stops Git Bash rewriting the bare / base into a Windows path.
  MSYS_NO_PATHCONV=1 bun run build -- --base=/
  echo "==> wrangler pages deploy dist (project: outlook-feishu-bridge, --branch=main)"
  # --branch=main pins the PRODUCTION Global Host deployment (matching CI in
  # .github/workflows/deploy.yml). Without it wrangler infers the current git
  # branch and, off main, publishes a *preview* (feat-xyz.<project>.pages.dev) —
  # so the hardcoded "OK Global Host" below would lie. --commit-dirty=true skips
  # wrangler's interactive prompt when the local tree has uncommitted changes
  # (CI runs on a clean checkout, so it doesn't need this).
  bunx wrangler pages deploy dist --branch=main --commit-dirty=true
  echo "OK Global Host -> https://outlook-feishu-bridge.pages.dev/"
}

case "$cmd" in
  frontend)   deploy_frontend ;;
  backend)    deploy_backend ;;
  auth)       deploy_auth ;;
  cloudflare) deploy_cloudflare ;;
  all)
    deploy_frontend
    echo ""
    deploy_backend
    ;;
  *)
    cat <<'USAGE'
Usage: bash scripts/deploy.sh <frontend|backend|auth|cloudflare|all>

  frontend   build SPA (base=/addin/), ship to ECS Host via SSH atomic release (CN)
  backend    deploy convex/ to prod (confirmation prompt)
  auth       ship the fallback Feishu auth server (ADR-0008) + write its env file
  cloudflare build SPA (base=/), publish to Cloudflare Pages — Global Host (ADR-0009)
  all        frontend then backend (still confirms backend; NOT auth/cloudflare)

Reads .env.deploy (gitignored). Copy .env.deploy.example to start.

One-time setup NOT done by this script:
  - ECS box: nginx serving /var/www/addin under location /addin/ ; the SPA is
    built with base=/addin/ so all asset paths are /addin/-prefixed.
  - Fallback auth server (for `auth`): install Bun on the box
    (curl -fsSL https://bun.sh/install | bash ; sudo cp "$HOME/.bun/bin/bun"
    /usr/local/bin/bun  # COPY, not symlink-into-home), install the systemd unit
    (deploy/feishu-auth.service ->
    /etc/systemd/system/, then `sudo systemctl enable --now feishu-auth`), and add
    `include snippets/feishu-auth.conf;` to the wmdev server block (deploy/nginx/).
    Register https://$DEPLOY_HOST/feishu/oauth/callback as a Feishu redirect URL.
    Assumes the deploy user has passwordless sudo.
  - nginx response headers: Content-Security-Policy. The frame-ancestors
    directive is load-bearing for Outlook (it must be an HTTP header, not a
    <meta> tag). Copy the policy from git history (public/_headers, pre-refactor).
  - nginx SPA fallback: try_files ... /addin/index.html; (client-side routing).
  - TLS: cert for DEPLOY_HOST (Aliyun free SSL or certbot on the box).
  - SSH: DEPLOY_SSH_KEY is a path to a private key whose public half is in the
    deploy user's ~/.ssh/authorized_keys on the ECS box.
  - Convex: generate prod deploy key (Dashboard -> Settings -> Deploy Keys).
  - Cloudflare (for `cloudflare`): re-auth before deploying with
    `bunx wrangler logout && bunx wrangler login` (interactive). The first deploy may
    need `bunx wrangler pages project create outlook-feishu-bridge`. The Global Host's
    CSP + SPA fallback live in public/_headers + public/_redirects (CF equivalents
    of deploy/nginx/). No new Feishu redirect URI is needed (primary login lands on
    *.convex.site, host-independent).
USAGE
    exit 1
    ;;
esac
