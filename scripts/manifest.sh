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
version="${MANIFEST_VERSION:-1.0.0.0}"
# `${2-default}` (not `${2:-default}`) so an explicit empty "" base is honoured
# (root) rather than falling back to addin/.
base="${2-addin/}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# `|` delimiter: the base value contains `/`, which would clash with sed's default.
sed -e "s|__ADDIN_DOMAIN__|${domain}|g" \
    -e "s|__ADDIN_BASE__|${base}|g" \
    -e "s|__ADDIN_VERSION__|${version}|g" \
    "$script_dir/../public/manifest.xml"
