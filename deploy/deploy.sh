#!/bin/sh
# Deploy the latest main on the game server: run as the account that owns /opt/daydream (not as daydream).
#   /opt/daydream/deploy/deploy.sh
# Restarting is safe: the server saves games on stop, and the worker pauses jobs that resume from checkpoints.
set -eu
# The services run the TypeScript sources directly, so Node must strip types (24.12 or newer).
node -e 'process.exit(process.features.typescript ? 0 : 1)' || { echo "Node $(node --version) cannot run TypeScript: install Node 24.12 or newer" >&2; exit 1; }
cd /opt/daydream
git fetch --quiet origin
git merge --ff-only origin/main
npm ci --no-audit --no-fund
npm run build
sudo systemctl restart daydream-worker daydream-server
sleep 2
systemctl --no-pager --lines=0 status daydream-server daydream-worker | grep -E '●|Active:'
