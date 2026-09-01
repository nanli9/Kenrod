#!/bin/bash
# ⚠️ SUPERSEDED, AND CURRENTLY BROKEN ON THIS BRANCH.
#
# next.config.ts sets `output: 'export'`, which makes `next start` refuse to run
# and never produces the build this script's `pm2 start npm -- start` needs. The
# site is now a static bucket in Hong Kong — see docs/DEPLOY-OSS.md and use
# scripts/deploy-oss.sh.
#
# Kept because it documents the pm2 topology the hero-model route was written
# for, and because restoring that path is a real option if the site ever needs a
# server again.
set -e

echo "=== Kenrod Deployment ==="

cd "$(dirname "$0")/.."

echo "Pulling latest code..."
git pull origin master

echo "Installing dependencies..."
npm ci

echo "Building..."
npm run build

echo "Restarting server..."
pm2 restart kenrod 2>/dev/null || pm2 start npm --name kenrod -- start

echo "=== Deployment complete ==="
