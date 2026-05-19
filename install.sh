#!/usr/bin/env bash
set -euo pipefail

BACKEND_URL="${BACKEND_URL:-https://captains-log-backend-production.up.railway.app}"
UPLOAD_URL="$BACKEND_URL/reports/upload"
SCRIPT_URL="$BACKEND_URL/captains_log.py"

INSTALL_USER="${SUDO_USER:-$USER}"
INSTALL_HOME="$(getent passwd "$INSTALL_USER" | cut -d: -f6)"

APP_DIR="$INSTALL_HOME/captains-log"

CONFIG_DIR="/etc/captains-log"
CONFIG_FILE="$CONFIG_DIR/captains-log.env"

PUBLIC_UPLOAD_KEY="${CAPTAINS_LOG_PUBLIC_UPLOAD_KEY:-captainslog_pi_upload_2026}"

RUNNER="/usr/local/bin/captains-log-upload"

SERVICE_FILE="/etc/systemd/system/captains-log-upload.service"
TIMER_FILE="/etc/systemd/system/captains-log-upload.timer"

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1"
    exit 1
  }
}

prompt_required() {
  local label="$1"
  local value=""

  while [ -z "$value" ]; do
    read -r -p "$label: " value
  done

  printf '%s' "$value"
}

quote_env() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

fetch_fleet_options() {
python3 - <<PY
import json
import urllib.request

url = "$BACKEND_URL/installer/fleet-options"

try:
    data = json.load(urllib.request.urlopen(url, timeout=15))
except Exception:
    raise SystemExit(0)

fleets = data.get("fleets", [])

for fleet in fleets:
    print(fleet)
PY
}

choose_fleet() {

  mapfile -t fleets < <(fetch_fleet_options || true)

  if [ "${#fleets[@]}" -eq 0 ]; then
    echo ""
    echo "Could not fetch fleet list from backend."
    echo ""
    prompt_required "Fleet name"
    return
  fi

  echo ""
  echo "🏴‍☠️ Available Fleets"
  echo ""

  local i=1

  for f in "${fleets[@]}"; do
    echo "$i) $f"
    i=$((i+1))
  done

  echo ""

  while true; do

    read -r -p "Choose fleet number: " choice

    if [[ "$choice" =~ ^[0-9]+$ ]] &&
       [ "$choice" -ge 1 ] &&
       [ "$choice" -le "${#fleets[@]}" ]; then

      printf '%s' "${fleets[$((choice-1))]}"
      return
    fi

    echo "Invalid choice."

  done
}

auto_detect_source() {

  if command -v docker >/dev/null 2>&1 &&
     docker ps --format '{{.Names}}' 2>/dev/null | grep -qx 'mastchain-ais'; then
    echo "docker"
    return
  fi

  if systemctl list-unit-files 2>/dev/null | grep -q '^mastradar.service'; then
    echo "journal"
    return
  fi

  echo "docker"
}

main() {

  need_cmd curl
  need_cmd python3

  echo ""
  echo "📘 Captain's Log Station Installer"
  echo "Backend: $BACKEND_URL"
  echo ""

  STATION_NAME="$(prompt_required "Station name")"

  FLEET="$(choose_fleet)"

  echo ""
  echo "When should this station post its daily Captain's Log?"
  echo ""
  echo "  1) Daily at this time ($(date +%H:%M))"
  echo "  2) Choose custom time"
  echo ""

  while true; do
    read -r -p "Choose 1 or 2: " time_choice

    case "$time_choice" in

      1)
        DAILY_TIME="$(date +%H:%M)"
        break
        ;;

      2)

        while true; do

          read -r -p "Enter daily time (HH:MM): " DAILY_TIME

          [[ "$DAILY_TIME" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]] && break

          echo "Use HH:MM format"
        done

        break
        ;;

      *)
        echo "Invalid choice."
        ;;

    esac
  done

  SOURCE="$(auto_detect_source)"

  echo ""
  echo "Detected source: $SOURCE"

  sudo mkdir -p "$APP_DIR"
  sudo mkdir -p "$CONFIG_DIR"

  sudo chown -R "$INSTALL_USER:$INSTALL_USER" "$APP_DIR"

  echo ""
  echo "Downloading Captain's Log..."

  curl -fsSL "$SCRIPT_URL" -o "$APP_DIR/captains_log.py"

  chmod +x "$APP_DIR/captains_log.py"

  STATION_ID="$(
    echo "$STATION_NAME" |
    tr '[:upper:]' '[:lower:]' |
    sed 's/[^a-z0-9]/-/g; s/-\+/-/g; s/^-//; s/-$//'
  )"

  sudo tee "$CONFIG_FILE" >/dev/null <<EOF
CAPTAINS_LOG_BACKEND_URL="$BACKEND_URL"
CAPTAINS_LOG_UPLOAD_URL="$UPLOAD_URL"

CAPTAINS_LOG_API_KEY="$(quote_env "$PUBLIC_UPLOAD_KEY")"

CAPTAINS_LOG_STATION="$(quote_env "$STATION_NAME")"
CAPTAINS_LOG_STATION_ID="$(quote_env "$STATION_ID")"

CAPTAINS_LOG_FLEET="$(quote_env "$FLEET")"

CAPTAINS_LOG_SOURCE="$SOURCE"

CAPTAINS_LOG_CONTAINER="mastchain-ais"
CAPTAINS_LOG_SERVICE="mastradar.service"

CAPTAINS_LOG_TAIL="5000"
CAPTAINS_LOG_SINCE="24 hours ago"
EOF

  sudo chmod 644 "$CONFIG_FILE"

  sudo tee "$RUNNER" >/dev/null <<EOF
#!/usr/bin/env bash
set -euo pipefail

source /etc/captains-log/captains-log.env

cd "$APP_DIR"

ARGS=(
  python3 ./captains_log.py

  --station "\$CAPTAINS_LOG_STATION"
  --station-id "\$CAPTAINS_LOG_STATION_ID"
  --fleet "\$CAPTAINS_LOG_FLEET"

  --upload
  --upload-url "\$CAPTAINS_LOG_UPLOAD_URL"
  --api-key "\$CAPTAINS_LOG_API_KEY"
)

if [ "\$CAPTAINS_LOG_SOURCE" = "journal" ]; then

  ARGS+=(
    --source journal
    --service "\$CAPTAINS_LOG_SERVICE"
    --since "\$CAPTAINS_LOG_SINCE"
  )

else

  ARGS+=(
    --source docker
    --container "\$CAPTAINS_LOG_CONTAINER"
    --tail "\$CAPTAINS_LOG_TAIL"
  )

fi

exec "\${ARGS[@]}"
EOF

  sudo chmod +x "$RUNNER"

  sudo tee "$SERVICE_FILE" >/dev/null <<EOF
[Unit]
Description=Captain's Log daily station upload
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
User=$INSTALL_USER
EnvironmentFile=$CONFIG_FILE
WorkingDirectory=$APP_DIR
ExecStart=$RUNNER
EOF

  HOUR="${DAILY_TIME%:*}"
  MINUTE="${DAILY_TIME#*:}"

  sudo tee "$TIMER_FILE" >/dev/null <<EOF
[Unit]
Description=Run Captain's Log daily station upload

[Timer]
OnCalendar=*-*-* $HOUR:$MINUTE:00
Persistent=true
Unit=captains-log-upload.service

[Install]
WantedBy=timers.target
EOF

  sudo systemctl daemon-reload

  sudo systemctl enable --now captains-log-upload.timer

  echo ""
  echo "✅ Captain's Log installed"
  echo ""

  echo "Station: $STATION_NAME"
  echo "Fleet: $FLEET"
  echo "Source: $SOURCE"
  echo "Daily upload time: $DAILY_TIME"

  echo ""
  echo "Timer status:"
  systemctl list-timers captains-log-upload.timer --no-pager || true

  echo ""

  read -r -p "Run a test upload now? [Y/n]: " run_now

  if [[ ! "$run_now" =~ ^[Nn]$ ]]; then

    sudo systemctl start captains-log-upload.service

    echo ""
    echo "Recent upload logs:"
    echo ""

    journalctl -u captains-log-upload.service -n 80 --no-pager || true
  fi

  echo ""
  echo "Done."
  echo ""
  echo "Useful commands:"
  echo "  systemctl list-timers captains-log-upload.timer"
  echo "  journalctl -u captains-log-upload.service -n 100 --no-pager"
}

main "$@"