#!/bin/bash
set -e
cd /root/story-group-gtm

echo "[deploy] Pulling latest from git..."
git pull origin main

echo "[deploy] Installing backend deps..."
cd backend && npm install --omit=dev
echo "[deploy] Restarting PM2..."
pm2 restart gtm-engine

echo "[deploy] Building frontend..."
cd ../frontend && npm install && ./node_modules/.bin/vite build

echo "[deploy] Deploying to Firebase Hosting..."
cd .. && firebase deploy --only hosting

echo "[deploy] Done!"
