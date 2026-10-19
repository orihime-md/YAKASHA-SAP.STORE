#!/bin/sh
set -eu

# Render owns the public port; WAHA uses a private localhost port.
export PORT="${PORT:-10000}"
export WHATSAPP_API_PORT="${WHATSAPP_API_PORT:-3000}"
export WHATSAPP_API_HOSTNAME="${WHATSAPP_API_HOSTNAME:-127.0.0.1}"
export WAHA_URL="${WAHA_URL:-http://127.0.0.1:${WHATSAPP_API_PORT}}"
export WHATSAPP_DEFAULT_ENGINE="${WHATSAPP_DEFAULT_ENGINE:-GOWS}"
export WAHA_LOCAL_STORE_BASE_DIR="${WAHA_LOCAL_STORE_BASE_DIR:-/app/.sessions}"
export WHATSAPP_FILES_FOLDER="${WHATSAPP_FILES_FOLDER:-/app/.media}"
export PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-${RENDER_EXTERNAL_URL:-}}"

mkdir -p "$WAHA_LOCAL_STORE_BASE_DIR" "$WHATSAPP_FILES_FOLDER" /yakasha/backend/data

# Render's Blueprint generates both values. The fallback is for local Docker runs only.
if [ -z "${WAHA_API_KEY:-}" ]; then
  WAHA_API_KEY="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")"
  export WAHA_API_KEY
  echo "[yakasha] Generated a temporary WAHA API key for this run."
fi
if [ -z "${WEBHOOK_SECRET:-}" ]; then
  WEBHOOK_SECRET="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")"
  export WEBHOOK_SECRET
  echo "[yakasha] Generated a temporary webhook secret for this run."
fi

# WAHA and Yakasha share the Blueprint database. Yakasha uses its own prefixed tables.
if [ -n "${DATABASE_URL:-}" ] && [ -z "${WHATSAPP_SESSIONS_POSTGRESQL_URL:-}" ]; then
  export WHATSAPP_SESSIONS_POSTGRESQL_URL="$DATABASE_URL"
fi

# The backend registers per-session webhooks, so a global WAHA webhook is not enabled.
unset WHATSAPP_HOOK_URL WHATSAPP_HOOK_EVENTS || true

echo "[yakasha] Starting WAHA GOWS privately on 127.0.0.1:${WHATSAPP_API_PORT}."
PORT="$WHATSAPP_API_PORT" WHATSAPP_API_PORT="$WHATSAPP_API_PORT" WHATSAPP_API_HOSTNAME="$WHATSAPP_API_HOSTNAME" node /app/dist/main &
WAHA_PID=$!

READY_TIMEOUT="${WAHA_READY_TIMEOUT_S:-120}"
i=0
while [ "$i" -lt "$READY_TIMEOUT" ]; do
  if node -e "fetch('http://127.0.0.1:' + process.env.WHATSAPP_API_PORT + '/ping').then(() => process.exit(0)).catch(() => process.exit(1))"; then
    break
  fi
  if ! kill -0 "$WAHA_PID" 2>/dev/null; then
    echo "[yakasha] WAHA exited before becoming ready."
    exit 1
  fi
  i=$((i + 1))
  if [ "$((i % 15))" -eq 0 ]; then
    echo "[yakasha] Waiting for WAHA (${i}s of ${READY_TIMEOUT}s)..."
  fi
  sleep 1
done
if [ "$i" -ge "$READY_TIMEOUT" ]; then
  echo "[yakasha] WAHA did not become ready within ${READY_TIMEOUT}s."
  kill "$WAHA_PID" 2>/dev/null || true
  exit 1
fi

echo "[yakasha] Starting Yakasha SAP on Render port ${PORT}."
node /yakasha/backend/server.js &
APP_PID=$!

shutdown() {
  echo "[yakasha] Shutting down Yakasha SAP and WAHA..."
  kill "$APP_PID" 2>/dev/null || true
  kill "$WAHA_PID" 2>/dev/null || true
  wait "$APP_PID" 2>/dev/null || true
  wait "$WAHA_PID" 2>/dev/null || true
}
trap shutdown INT TERM EXIT

# If either process exits, fail the container so Render can restart it.
while :; do
  if ! kill -0 "$WAHA_PID" 2>/dev/null; then
    echo "[yakasha] WAHA stopped unexpectedly."
    exit 1
  fi
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    echo "[yakasha] Yakasha backend stopped unexpectedly."
    exit 1
  fi
  sleep 5
done
