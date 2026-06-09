#!/usr/bin/env bash
# Deploy pipeline: Convex dev sync -> Aliyun (ECS) -> Cloudflare Pages.
# No lint, no tests, no prompts beyond what deploy.sh already asks.
# Run from repo root in Git Bash / WSL: bash scripts/deploy-dual.sh

set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> [1/3] Syncing Convex dev..."
bunx convex dev --once

echo ""
echo "==> [2/3] Deploying SPA to Aliyun (frontend /addin/)..."
bash scripts/deploy.sh frontend

echo ""
echo "==> [3/3] Deploying SPA to Cloudflare Pages..."
bash scripts/deploy.sh cloudflare

echo ""
echo "==> All done!"
