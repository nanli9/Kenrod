#!/bin/bash
set -e

echo "=== Kenrod Deployment ==="

cd "$(dirname "$0")/.."

echo "Pulling latest code..."
git pull origin main

echo "Installing dependencies..."
npm ci

echo "Building..."
npm run build

echo "Restarting server..."
pm2 restart kenrod 2>/dev/null || pm2 start npm --name kenrod -- start

echo "=== Deployment complete ==="
