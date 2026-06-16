#!/usr/bin/env bash
# scripts/convex-env-sync.sh — push the Convex BACKEND env vars onto a deployment.
#
# Convex env vars do NOT migrate between projects/deployments. After a personal ->
# company project swap (docs/MIGRATION.md §C) the new prod deployment starts with an
# empty env, so login + Bitable intake break until these are re-set. This wraps
# `convex env set --from-file` with two guards: the required keys are present, and you
# confirm WHICH deployment is being written before any secret is sent.
#
# Reads a gitignored env file (default .env.convex; see .env.convex.example). Any extra
# args are passed straight through to `convex env` as the deployment selector:
#
#   bash scripts/convex-env-sync.sh                 # -> dev (the configured deployment)
#   bash scripts/convex-env-sync.sh --prod          # -> project's production deployment
#   bash scripts/convex-env-sync.sh --deployment prod
#   CONVEX_ENV_FILE=.env.convex.staging bash scripts/convex-env-sync.sh --prod
#
# bun/bunx only (project rule) — never npm/npx.
set -euo pipefail

# Resolve repo root without external `dirname` (some Windows bash shells lack coreutils).
script_source="${BASH_SOURCE[0]}"
script_dir="${script_source%/*}"
[[ "$script_dir" == "$script_source" ]] && script_dir="."
script_dir="$(cd -- "$script_dir" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
cd "$repo_root"

env_file="${CONVEX_ENV_FILE:-.env.convex}"
if [[ ! -f "$env_file" ]]; then
  echo "Env file not found: $env_file" >&2
  echo "Copy .env.convex.example to .env.convex and fill it in." >&2
  exit 1
fi

command -v bunx >/dev/null 2>&1 || { echo 'bunx not on PATH (install Bun).' >&2; exit 1; }

# Keys actually present in the file (LHS of `NAME=...`, ignoring comments/blanks).
present_keys="$(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$env_file" | cut -d= -f1 || true)"
[[ -n "$present_keys" ]] || { echo "No NAME=value lines in $env_file." >&2; exit 1; }

# Fail loudly if a login/intake-critical var is missing — these have no safe default.
required=(FEISHU_APP_ID FEISHU_APP_SECRET FEISHU_BITABLE_APP_TOKEN FEISHU_BITABLE_TABLE_ID)
missing=()
for k in "${required[@]}"; do
  grep -qE "^$k=" "$env_file" || missing+=("$k")
done
if [[ ${#missing[@]} -gt 0 ]]; then
  echo "Missing required keys in $env_file: ${missing[*]}" >&2
  exit 1
fi

# Confirm the target BEFORE sending secrets. With no extra args the target is the
# configured dev deployment; `--prod` / `--deployment ...` redirect it.
target_desc="dev (configured deployment)"
[[ $# -gt 0 ]] && target_desc="$*"
echo "About to set these Convex env vars on: $target_desc"
echo "  file: $env_file"
echo "  keys: $(echo "$present_keys" | tr '\n' ' ')"
read -r -p "Proceed? [y/N] " ans
[[ "$ans" == "y" || "$ans" == "Y" ]] || { echo "Aborted."; exit 1; }

echo "==> bunx convex env set --from-file $env_file $*"
bunx convex env set --from-file "$env_file" "$@"

echo "==> bunx convex env list $*"
bunx convex env list "$@"
echo "OK convex env synced to: $target_desc"
