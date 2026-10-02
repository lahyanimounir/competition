#!/usr/bin/env bash
# Linux server setup: checks Docker, detects the LAN IP, generates secrets, writes .env,
# optionally opens the firewall and starts the platform.
#
# Usage (from the project folder):
#   bash scripts/setup.sh                      # interactive defaults
#   bash scripts/setup.sh --ip 192.168.1.50    # force the server IP
#   bash scripts/setup.sh --port 8080          # dashboard/apps on another port than 80
#   bash scripts/setup.sh --firewall --start   # also open firewall ports and run docker compose
#   bash scripts/setup.sh --force              # overwrite an existing .env without asking
set -euo pipefail

IP=""
PORT=80
FIREWALL=0
START=0
FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --ip) IP="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --firewall) FIREWALL=1; shift ;;
    --start) START=1; shift ;;
    --force|-y) FORCE=1; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)"; exit 1 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env"
red() { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
SUDO=""
[ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1 && SUDO="sudo"

# --- 1. Docker -------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  red "Docker is not installed."
  echo "Install it (Ubuntu/Debian/Fedora/RHEL...), then run this script again:"
  echo "  curl -fsSL https://get.docker.com | sudo sh"
  echo "  sudo systemctl enable --now docker"
  echo "  sudo usermod -aG docker \$USER   # then log out and back in"
  exit 1
fi
DOCKER="docker"
if ! docker info >/dev/null 2>&1; then
  if [ -n "$SUDO" ] && $SUDO docker info >/dev/null 2>&1; then
    DOCKER="$SUDO docker"
    yellow "Note: your user is not in the 'docker' group - using sudo. To fix: sudo usermod -aG docker \$USER (then log in again)."
  else
    red "Docker is installed but not running (or not reachable)."
    echo "  sudo systemctl enable --now docker"
    exit 1
  fi
fi
if ! $DOCKER compose version >/dev/null 2>&1; then
  red "Docker Compose v2 is missing. Install the 'docker-compose-plugin' package (it comes with get.docker.com)."
  exit 1
fi
green "Docker $($DOCKER version --format '{{.Server.Version}}') and $($DOCKER compose version --short 2>/dev/null || echo 'compose v2') found."

# --- 2. Existing .env ------------------------------------------------------------
if [ -f "$ENV_FILE" ] && [ "$FORCE" -ne 1 ]; then
  if [ -t 0 ]; then
    read -r -p ".env already exists. Overwrite it? (y/N) " answer
  else
    answer="n"
  fi
  if [ "$answer" != "y" ] && [ "$answer" != "Y" ]; then
    echo "Keeping the existing .env (use --force to overwrite)."
    KEEP_ENV=1
  fi
fi

if [ "${KEEP_ENV:-0}" -ne 1 ]; then
  # --- 3. LAN IP -----------------------------------------------------------------
  if [ -z "$IP" ]; then
    IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<NF;i++) if ($i=="src") {print $(i+1); exit}}' || true)"
  fi
  if [ -z "$IP" ]; then
    IP="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^(10|172\.(1[6-9]|2[0-9]|3[01])|192\.168)\.' | head -n1 || true)"
  fi
  if ! printf '%s' "$IP" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$'; then
    red "Could not detect the server's LAN IP. Run again with:  bash scripts/setup.sh --ip 192.168.x.x"
    exit 1
  fi

  # --- 4. Secrets -------------------------------------------------------------
  # (subshells without pipefail: `head` closing the pipe makes `tr` exit with SIGPIPE)
  rand_chars() { (set +o pipefail; LC_ALL=C tr -dc "$1" </dev/urandom | head -c "$2"); }
  ADMIN_CODE="$(rand_chars '1-9' 1)$(rand_chars '0-9' 7)"
  MYSQL_PASS="$(rand_chars 'A-Za-z0-9' 24)"

  umask 077
  cat >"$ENV_FILE" <<EOF
BASE_DOMAIN=$IP.nip.io
HTTP_PORT=$PORT
ADMIN_CODE=$ADMIN_CODE
MYSQL_ROOT_PASSWORD=$MYSQL_PASS
MYSQL_PORT=3306
BUILD_CONCURRENCY=2
NPM_MAXSOCKETS=
IDLE_MINUTES=30
EOF
  green "Created .env"
  SUFFIX=""; [ "$PORT" != "80" ] && SUFFIX=":$PORT"
  echo "  Server IP      : $IP"
  echo "  Dashboard URL  : http://$IP.nip.io$SUFFIX"
  yellow "  Admin code     : $ADMIN_CODE   (keep it safe - also in .env)"
else
  PORT="$(grep -E '^HTTP_PORT=' "$ENV_FILE" | cut -d= -f2 || echo 80)"
  PORT="${PORT:-80}"
fi

# --- 5. Port check -------------------------------------------------------------
# (skipped when the platform is already running - then the ports are ours)
if command -v ss >/dev/null 2>&1 && ! $DOCKER ps --format '{{.Names}}' 2>/dev/null | grep -q '^ws-platform$'; then
  for p in "$PORT" 3306; do
    owner="$(ss -ltnH "sport = :$p" 2>/dev/null | head -n1 || true)"
    if [ -n "$owner" ]; then
      yellow "Warning: port $p is already used by another program:"
      echo "  $owner"
      echo "  Stop it (e.g. sudo systemctl stop apache2 / nginx / mysql) or choose another port with --port."
    fi
  done
fi

# --- 6. Firewall ---------------------------------------------------------------
if [ "$FIREWALL" -eq 1 ]; then
  if command -v ufw >/dev/null 2>&1; then
    $SUDO ufw allow "$PORT/tcp" comment 'WorldSkills platform'
    $SUDO ufw allow 3306/tcp comment 'WorldSkills MySQL'
    green "ufw: opened $PORT/tcp and 3306/tcp"
  elif command -v firewall-cmd >/dev/null 2>&1; then
    $SUDO firewall-cmd --permanent --add-port="$PORT/tcp"
    $SUDO firewall-cmd --permanent --add-port=3306/tcp
    $SUDO firewall-cmd --reload
    green "firewalld: opened $PORT/tcp and 3306/tcp"
  else
    yellow "No ufw/firewalld found - if you use another firewall, allow TCP $PORT and 3306."
  fi
fi

# --- 7. Start ------------------------------------------------------------------
if [ "$START" -eq 1 ]; then
  cd "$ROOT"
  $DOCKER compose up -d --build
  echo
  green "Platform started. Check it with:  $DOCKER compose ps   /   $DOCKER compose logs -f platform"
else
  echo
  echo "Next:"
  [ "$FIREWALL" -eq 1 ] || echo "  bash scripts/setup.sh --firewall   (or open TCP $PORT and 3306 in your firewall)"
  echo "  docker compose up -d --build"
fi
