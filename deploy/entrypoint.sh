#!/bin/sh
# Writes key files from base64 env vars (never printed), then runs the notifier and the web app.
set -eu
umask 077

network="${NEAR_NETWORK:-testnet}"
export ORVANTRA_KEYS_DIR="${ORVANTRA_KEYS_DIR:-/secrets/keys}"
mkdir -p "$ORVANTRA_KEYS_DIR/$network"

if [ -n "${AGENT_KEY_JSON_B64:-}" ]; then
  echo "$AGENT_KEY_JSON_B64" | base64 -d > "$ORVANTRA_KEYS_DIR/$network/${AGENT_ID:-orvantra-agent.testnet}.json"
  unset AGENT_KEY_JSON_B64
fi
if [ -n "${RELAYER_KEY_JSON_B64:-}" ]; then
  echo "$RELAYER_KEY_JSON_B64" | base64 -d > /secrets/relayer.json
  export RELAYER_KEY_PATH=/secrets/relayer.json
  unset RELAYER_KEY_JSON_B64
fi

# Persistent volume (Railway mounts it at /app/agent/data). It may be mounted as root: make sure we can write.
mkdir -p /app/agent/data/files 2>/dev/null || true

if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
  ( cd /app/agent && while true; do node_modules/.bin/tsx src/notify/run.ts || true; echo "notifier exited; restarting in 10s"; sleep 10; done ) &
fi

cd /app/web
exec node_modules/.bin/next start -p "${PORT:-3000}" -H 0.0.0.0
