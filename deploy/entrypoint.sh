#!/bin/sh
# Starts as root only to prepare the volume and write the key files (from base64 env vars, never printed), then runs
# the notifier and the web app as the unprivileged user `orvantra` (setpriv, no new privileges).
# Each process gets only the secrets it needs: the notifier no relayer key, the web app no Telegram token.
set -eu
umask 077

APP_USER=orvantra
network="${NEAR_NETWORK:-testnet}"
export ORVANTRA_KEYS_DIR="${ORVANTRA_KEYS_DIR:-/secrets/keys}"
export HOME=/home/$APP_USER

drop() { setpriv --reuid="$APP_USER" --regid="$APP_USER" --init-groups --no-new-privs "$@"; }

# ---- secrets: written as root, readable only by the app user (dirs 700, files 600)
mkdir -p "$ORVANTRA_KEYS_DIR/$network" /secrets
if [ -n "${AGENT_KEY_JSON_B64:-}" ]; then
  echo "$AGENT_KEY_JSON_B64" | base64 -d > "$ORVANTRA_KEYS_DIR/$network/${AGENT_ID:-orvantra-agent.testnet}.json"
  unset AGENT_KEY_JSON_B64
fi
if [ -n "${RELAYER_KEY_JSON_B64:-}" ]; then
  echo "$RELAYER_KEY_JSON_B64" | base64 -d > /secrets/relayer.json
  export RELAYER_KEY_PATH=/secrets/relayer.json
  unset RELAYER_KEY_JSON_B64
fi
chown -R "$APP_USER:$APP_USER" /secrets "$ORVANTRA_KEYS_DIR"
chmod 700 /secrets "$ORVANTRA_KEYS_DIR" "$ORVANTRA_KEYS_DIR/$network"
find /secrets "$ORVANTRA_KEYS_DIR" -type f -exec chmod 600 {} +

# ---- persistent volume (Railway mounts it at /app/agent/data, root-owned): the app user must be able to write it
mkdir -p /app/agent/data/files
chown -R "$APP_USER:$APP_USER" /app/agent/data

echo "starting as: $(drop id)"

if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
  # the notifier needs neither the relayer key nor the agent key
  drop env -u RELAYER_KEY_PATH -u RELAYER_ID sh -c \
    'cd /app/agent && while true; do node_modules/.bin/tsx src/notify/run.ts || true; echo "notifier exited; restarting in 10s"; sleep 10; done' &
fi

cd /app/web
exec setpriv --reuid="$APP_USER" --regid="$APP_USER" --init-groups --no-new-privs \
  env -u TELEGRAM_BOT_TOKEN -u TELEGRAM_CHAT_ID node_modules/.bin/next start -p "${PORT:-3000}" -H 0.0.0.0
