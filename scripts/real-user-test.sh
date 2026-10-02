#!/usr/bin/env bash
# Real-user WhatsApp connector test harness.
# Wraps the curl + psql steps of the first real-user test scenario.
# Manual steps (scanning QR, sending messages, restarting) are called out inline.
#
# Usage:
#   ./scripts/real-user-test.sh <command>
#   ./scripts/real-user-test.sh guided   # step-by-step guided flow
#
# Commands: create, qr, status, wait-connected, dm, group, events, restart-check, guided, help
#
# Reads INTERNAL_API_TOKEN and DATABASE_URL from .env (or the process env).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env"
ID_FILE="$ROOT/.test-connection-id"
QR_FILE="$ROOT/qr.png"

# --- load .env (only if the var isn't already exported) ---------------------
# Parse .env manually so unquoted values with spaces (e.g. BAILEYS_BROWSER_NAME=Echo Guard)
# don't break bash sourcing. Existing process env wins over .env.
load_env() {
  [[ -f "$ENV_FILE" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in ''|\#*) continue ;; esac
    [[ "$line" == *=* ]] || continue
    local key="${line%%=*}"
    local val="${line#*=}"
    # strip surrounding quotes if present
    case "$val" in \"*\"|\'*\') val="${val#?}"; val="${val%?}" ;; esac
    [[ -n "${!key+x}" ]] || export "$key=$val"
  done < "$ENV_FILE"
}
load_env

: "${INTERNAL_API_TOKEN:?INTERNAL_API_TOKEN is required (set it in .env)}"
: "${DATABASE_URL:?DATABASE_URL is required (set it in .env)}"
: "${HOST:=0.0.0.0}"
: "${PORT:=8080}"
BASE="http://localhost:${PORT}"

for dep in curl jq psql base64; do
  command -v "$dep" >/dev/null 2>&1 || { echo "missing dependency: $dep"; exit 1; }
done

auth_header=(-H "Authorization: Bearer ${INTERNAL_API_TOKEN}")

# --- helpers ---------------------------------------------------------------
get_id() {
  if [[ -f "$ID_FILE" ]]; then cat "$ID_FILE"; else echo ""; fi
}

save_id() { echo "$1" > "$ID_FILE"; }

require_id() {
  local id; id="$(get_id)"
  [[ -n "$id" ]] || { echo "no connection_id found. run: $0 create"; exit 1; }
  echo "$id"
}

psql_query() { psql "$DATABASE_URL" -At -F '|' --no-psqlrc -c "$1"; }

# --- commands ---------------------------------------------------------------
cmd_create() {
  echo "POST /connections ..."
  local body; body=$(curl -s -X POST "$BASE/connections" \
    "${auth_header[@]}" -H "content-type: application/json" -d '{}')
  echo "$body" | jq .
  local id; id=$(echo "$body" | jq -r '.connection_id // empty')
  [[ -n "$id" ]] || { echo "failed to create connection"; exit 1; }
  save_id "$id"
  echo "saved connection_id -> $ID_FILE"
}

cmd_qr() {
  local id; id="$(require_id)"
  echo "polling /connections/$id/qr (timeout 60s) ..."
  for i in $(seq 1 30); do
    local body; body=$(curl -s "$BASE/connections/$id/qr" "${auth_header[@]}")
    local outcome; outcome=$(echo "$body" | jq -r '.outcome // empty')
    case "$outcome" in
      qr_ready)
        echo "$body" | jq -r '.image_base64' | base64 --decode > "$QR_FILE"
        echo "QR saved -> $QR_FILE  (open it and scan from WhatsApp > Linked Devices)"
        open "$QR_FILE" 2>/dev/null || true
        return 0 ;;
      already_authorized)
        echo "already_authorized: account is connected, no QR needed."; return 0 ;;
      timeout)
        echo "  [$i] QR not available yet, retrying in 2s ..."; sleep 2 ;;
      *)
        echo "unexpected response:"; echo "$body" | jq .; sleep 2 ;;
    esac
  done
  echo "timed out waiting for QR"; return 1
}

cmd_status() {
  local id; id="$(require_id)"
  curl -s "$BASE/connections/$id/status" "${auth_header[@]}" | jq .
}

cmd_wait_connected() {
  local id; id="$(require_id)"
  echo "waiting for status=connected (timeout 120s) ..."
  for i in $(seq 1 60); do
    local body; body=$(curl -s "$BASE/connections/$id/status" "${auth_header[@]}")
    local status; status=$(echo "$body" | jq -r '.status // empty')
    echo "  [$i] status=$status raw=$(echo "$body" | jq -r '.provider_raw_status // ""')"
    [[ "$status" == "connected" ]] && { echo "CONNECTED"; return 0; }
    sleep 2
  done
  echo "timed out waiting for connected"; return 1
}

cmd_events() {
  echo "latest 10 event_inbox rows:"
  psql_query "SELECT id, event_type, provider_message_id, payload->>'chat_id' AS chat_id, payload->>'text' AS text, received_at FROM whatsapp_connector.event_inbox ORDER BY id DESC LIMIT 10;" \
    | column -t -s '|'
}

cmd_dm() {
  local baseline; baseline=$(psql_query "SELECT count(*) FROM whatsapp_connector.event_inbox WHERE event_type='message' AND (payload->>'is_group')::boolean = false;")
  echo "waiting for new DM (baseline: $baseline, timeout 30s) ..."
  for i in $(seq 1 15); do
    local count; count=$(psql_query "SELECT count(*) FROM whatsapp_connector.event_inbox WHERE event_type='message' AND (payload->>'is_group')::boolean = false;")
    if [[ "$count" -gt "$baseline" ]]; then
      echo "new DM(s) detected ($count total)"
      break
    fi
    echo "  [$i] no new DM yet ..."
    sleep 2
  done
  echo "latest DM (non-group) message events:"
  psql_query "SELECT id, payload->>'chat_id' AS chat_id, payload->>'direction' AS dir, payload->>'text' AS text, payload->'sender'->>'canonical_id' AS sender_canonical, payload->'sender'->>'display_name' AS sender_name, received_at FROM whatsapp_connector.event_inbox WHERE event_type='message' AND (payload->>'is_group')::boolean = false ORDER BY id DESC LIMIT 10;" \
    | column -t -s '|'
}

cmd_group() {
  local baseline; baseline=$(psql_query "SELECT count(*) FROM whatsapp_connector.event_inbox WHERE event_type='message' AND (payload->>'is_group')::boolean = true;")
  echo "waiting for new group message (baseline: $baseline, timeout 30s) ..."
  for i in $(seq 1 15); do
    local count; count=$(psql_query "SELECT count(*) FROM whatsapp_connector.event_inbox WHERE event_type='message' AND (payload->>'is_group')::boolean = true;")
    if [[ "$count" -gt "$baseline" ]]; then
      echo "new group message(s) detected ($count total)"
      break
    fi
    echo "  [$i] no new group message yet ..."
    sleep 2
  done
  echo "latest group message events (LID/group normalization check):"
  psql_query "SELECT id, payload->>'chat_id' AS chat_id, payload->>'chat_name' AS chat_name, payload->'sender'->>'canonical_id' AS sender_canonical, payload->'sender'->>'lid' AS sender_lid, payload->'sender'->>'display_name' AS sender_name, payload->>'direction' AS dir, payload->>'text' AS text FROM whatsapp_connector.event_inbox WHERE event_type='message' AND (payload->>'is_group')::boolean = true ORDER BY id DESC LIMIT 20;" \
    | column -t -s '|'
}

cmd_restart_check() {
  echo "After restarting the connector (Ctrl+C then npm run dev), check status:"
  cmd_status
  echo
  echo "Then send another WhatsApp message and run: $0 dm"
}

cmd_guided() {
  echo "=== Step 1: start the service (in another terminal) ==="
  echo "  npm run dev"
  echo "  (wait for 'connector started' on port ${PORT})"
  echo
  read -r -p "Press Enter once the service is listening ..."

  echo "=== Step 2: create a connection ==="
  cmd_create

  echo
  echo "=== Step 3: get the QR and scan it ==="
  echo "  On your phone: WhatsApp > Settings > Linked Devices > Link a Device"
  cmd_qr

  echo
  echo "=== Step 4: wait for connected ==="
  cmd_wait_connected

  echo
  echo "=== Step 5: send a DM to the linked account from another phone ==="
  echo "  e.g. text 'hello from test' to your number"
  read -r -p "Press Enter once the DM has been sent ..."
  echo "checking event_inbox for the DM ..."
  cmd_dm

  echo
  echo "=== Step 6: send a message in a group containing the linked account ==="
  read -r -p "Press Enter once the group message has been sent ..."
  cmd_group

  echo
  echo "=== Step 7: restart test (Postgres auth persistence) ==="
  echo "  In the service terminal: Ctrl+C"
  echo "  Wait ~30s, then: npm run dev"
  read -r -p "Press Enter once the service has restarted ..."
  echo "expecting status=connected WITHOUT a new QR:"
  cmd_status

  echo
  echo "=== Step 8: send another message after restart, then verify ==="
  read -r -p "Press Enter once a post-restart message has been sent ..."
  cmd_dm

  echo
  echo "=== Done. Success criteria checklist ==="
  echo "  [1] QR pairing worked"
  echo "  [2] status became connected"
  echo "  [3] DM appeared in event_inbox"
  echo "  [4] group message has correct participant identity/name"
  echo "  [5] npm run dev restart reconnected without QR"
}

cmd_help() {
  cat <<'EOF'
real-user-test.sh - first real-user WhatsApp connector test

commands:
  create          POST /connections, save connection_id to .test-connection-id
  qr              poll /qr until ready, save+open qr.png
  status          GET /connections/:id/status
  wait-connected  poll status until connected
  events          latest 10 event_inbox rows
  dm              latest DM (non-group) message events
  group           latest group message events (LID/group normalization)
  restart-check   status after a connector restart
  guided          step-by-step guided flow through all 5 success criteria
  help            this message

typical manual flow:
  npm run dev                      # terminal 1
  ./scripts/real-user-test.sh guided   # terminal 2
EOF
}

# --- dispatch ---------------------------------------------------------------
case "${1:-help}" in
  create) cmd_create ;;
  qr) cmd_qr ;;
  status) cmd_status ;;
  wait-connected) cmd_wait_connected ;;
  events) cmd_events ;;
  dm) cmd_dm ;;
  group) cmd_group ;;
  restart-check) cmd_restart_check ;;
  guided) cmd_guided ;;
  help|--help|-h) cmd_help ;;
  *) echo "unknown command: $1"; cmd_help; exit 1 ;;
esac
