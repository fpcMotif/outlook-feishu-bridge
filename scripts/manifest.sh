#!/usr/bin/env bash
# scripts/manifest.sh — emit a sideload-ready Outlook manifest for one host.
#
# The committed public/manifest.xml carries two placeholders:
#   __ADDIN_DOMAIN__  the public host that serves the SPA
#   __ADDIN_BASE__    the URL path prefix the SPA is served under — NO leading
#                     slash, WITH a trailing slash (e.g. "addin/"), or "" at root.
# This substitutes both and writes the result to stdout. See ADR-0009 / DEPLOY.md.
#
# Examples:
#   # ECS Host (CN audience), served under /addin/
#   bash scripts/manifest.sh wmdev.zeuja.com addin/ > manifest-ecs.xml
#   # Global Host (Cloudflare Pages), served at root
#   bash scripts/manifest.sh outlook-feishu-bridge.pages.dev "" > manifest-global.xml

set -euo pipefail

if [[ $# -lt 1 || "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat >&2 <<'USAGE'
Usage: bash scripts/manifest.sh <domain> [base]
  <domain>  host serving the SPA, e.g. wmdev.zeuja.com
  [base]    path prefix, NO leading slash + trailing slash (default: "addin/").
            Pass "" for a root-served host (the Global Host / Cloudflare Pages).
USAGE
  exit 1
fi

domain="$1"
# `${2-default}` (not `${2:-default}`) so an explicit empty "" base is honoured
# (root) rather than falling back to addin/.
base="${2-addin/}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
template="$script_dir/../public/manifest.xml"

# Auto-bump <Version> so every generated manifest is strictly newer than the last
# sideloaded one — Office refuses an update/re-install whose version did not
# increase ("Please update the version number in the manifest file and try
# again"). Keep MAJOR.MINOR from the template; append <days since 2024-01-01>.<minute
# of UTC day>. 10# forces base-10 so a leading-zero hour/minute isn't read as octal.
# Mirrors computeBuildVersion() in manifest.mjs — keep the two in sync.
epoch_days=19723
days=$(( $(date -u +%s) / 86400 - epoch_days ))
minute_of_day=$(( 10#$(date -u +%H) * 60 + 10#$(date -u +%M) ))
major_minor="$(grep -oE '<Version>[0-9]+\.[0-9]+' "$template" | head -1 | grep -oE '[0-9]+\.[0-9]+')"
build_version="${major_minor:-1.0}.${days}.${minute_of_day}"

# `|` delimiter: the base value contains `/`, which would clash with sed's default.
sed -e "s|__ADDIN_DOMAIN__|${domain}|g" \
    -e "s|__ADDIN_BASE__|${base}|g" \
    -e "s|<Version>[^<]*</Version>|<Version>${build_version}</Version>|" \
    "$template"
