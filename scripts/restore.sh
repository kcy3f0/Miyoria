#!/usr/bin/env bash
# Restore a dump made by scripts/backup.sh into the compose PostgreSQL database.
# THIS REPLACES THE CURRENT DATA IN THE DATABASE.
#
#   scripts/restore.sh backups/miyoria-20260101-030000.dump
#   scripts/restore.sh --latest                 # newest dump in backups/
#   scripts/restore.sh --yes <file>             # no confirmation prompt
#
# If the core container is running (compose profile `core`) it is stopped first and started again
# afterwards. A core running on the host (cargo run -- core) must be stopped by you first.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE=(docker compose -f "$ROOT/deploy/docker-compose.yml")
# The core service sits behind a profile and its env_file needs the repo-root .env.
CORE=(docker compose -f "$ROOT/deploy/docker-compose.yml" --profile core)
DIR="${BACKUP_DIR:-$ROOT/backups}"
ASSUME_YES=0
FILE=""

usage() { sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) ASSUME_YES=1; shift ;;
    --latest) FILE="$(find "$DIR" -maxdepth 1 -name 'miyoria-*.dump' -print | sort -r | head -n 1)"
              [ -n "$FILE" ] || { echo "error: no dumps in $DIR" >&2; exit 1; }
              shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
    *) FILE="$1"; shift ;;
  esac
done
[ -n "$FILE" ] || { usage >&2; exit 2; }
[ -f "$FILE" ] || { echo "error: no such file: $FILE" >&2; exit 1; }

env_value() {
  local file="$ROOT/deploy/.env" line
  [ -f "$file" ] || return 0
  line="$(grep -E "^[[:space:]]*$1=" "$file" | tail -n 1 || true)"
  line="${line#*=}"
  line="${line%$'\r'}"
  line="${line#[\"\']}"; line="${line%[\"\']}"
  printf '%s' "$line"
}
PGUSER_NAME="${POSTGRES_USER:-$(env_value POSTGRES_USER)}"; PGUSER_NAME="${PGUSER_NAME:-miyoria}"
PGDB_NAME="${POSTGRES_DB:-$(env_value POSTGRES_DB)}"; PGDB_NAME="${PGDB_NAME:-miyoria}"

if ! docker info >/dev/null 2>&1; then
  echo "error: cannot reach the Docker daemon (is Docker running?)" >&2
  exit 1
fi
if [ -z "$("${COMPOSE[@]}" ps --status running --quiet postgres 2>/dev/null)" ]; then
  echo "error: the postgres service is not running. Start it: docker compose -f deploy/docker-compose.yml up -d postgres" >&2
  exit 1
fi

if [ "$ASSUME_YES" -ne 1 ]; then
  printf 'Restore %s into database "%s"? Current data will be replaced. [y/N] ' "$FILE" "$PGDB_NAME"
  read -r answer
  case "$answer" in y|Y|yes|YES) ;; *) echo "aborted"; exit 1 ;; esac
fi

CORE_WAS_RUNNING=0
if [ -f "$ROOT/.env" ] && [ -n "$("${CORE[@]}" ps --status running --quiet core 2>/dev/null)" ]; then
  CORE_WAS_RUNNING=1
  echo "stopping core ..."
  "${CORE[@]}" stop core
fi

REMOTE="/tmp/restore-$$.dump"
cleanup() { "${COMPOSE[@]}" exec -T postgres rm -f "$REMOTE" >/dev/null 2>&1 || true; }
trap cleanup EXIT

"${COMPOSE[@]}" cp "$FILE" "postgres:$REMOTE"
"${COMPOSE[@]}" exec -T postgres pg_restore --list "$REMOTE" >/dev/null || {
  echo "error: $FILE is not a valid pg_dump custom-format archive" >&2; exit 1; }

echo "restoring ..."
# --clean --if-exists drops existing objects first; --single-transaction rolls everything back on error.
"${COMPOSE[@]}" exec -T postgres pg_restore -U "$PGUSER_NAME" -d "$PGDB_NAME" \
  --clean --if-exists --no-owner --single-transaction "$REMOTE"
echo "ok: restored $FILE"

if [ "$CORE_WAS_RUNNING" -eq 1 ]; then
  echo "starting core ..."
  "${CORE[@]}" start core
fi
