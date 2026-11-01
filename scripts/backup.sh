#!/usr/bin/env bash
# Back up the compose PostgreSQL database (deploy/docker-compose.yml) with pg_dump.
#
#   scripts/backup.sh                 # -> backups/miyoria-YYYYMMDD-HHMMSS.dump
#   scripts/backup.sh --keep 30       # keep the newest 30 dumps (default 14, 0 = keep all)
#   scripts/backup.sh --dir /mnt/nas  # write somewhere else (default <repo>/backups)
#
# Environment: POSTGRES_USER / POSTGRES_DB (default: values from deploy/.env, else miyoria),
# BACKUP_KEEP, BACKUP_DIR. Restore with scripts/restore.sh. Cron example in docs/OPERATIONS.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE=(docker compose -f "$ROOT/deploy/docker-compose.yml")
KEEP="${BACKUP_KEEP:-14}"
DIR="${BACKUP_DIR:-$ROOT/backups}"

usage() { sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --keep) KEEP="${2:?--keep needs a number}"; shift 2 ;;
    --dir) DIR="${2:?--dir needs a path}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done
case "$KEEP" in ''|*[!0-9]*) echo "--keep must be a non-negative integer" >&2; exit 2 ;; esac

# Read a KEY=value from deploy/.env without sourcing it (values may contain special characters).
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

mkdir -p "$DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$DIR/miyoria-$STAMP.dump"
TMP="$OUT.partial"
REMOTE="/tmp/miyoria-$STAMP.dump"
trap 'rm -f "$TMP"; "${COMPOSE[@]}" exec -T postgres rm -f "$REMOTE" >/dev/null 2>&1 || true' EXIT

echo "dumping $PGDB_NAME (user $PGUSER_NAME) ..."
# Custom format (-Fc): compressed, and restorable selectively with pg_restore. The dump is written
# inside the container and copied out so that no shell redirection touches the binary data.
"${COMPOSE[@]}" exec -T postgres pg_dump -U "$PGUSER_NAME" -d "$PGDB_NAME" -Fc --no-owner -f "$REMOTE"
"${COMPOSE[@]}" cp "postgres:$REMOTE" "$TMP"
# Sanity check: the archive must be readable.
"${COMPOSE[@]}" exec -T postgres pg_restore --list "$REMOTE" >/dev/null
mv "$TMP" "$OUT"
echo "ok: $OUT ($(du -h "$OUT" | cut -f1))"

if [ "$KEEP" -gt 0 ]; then
  # Names embed a sortable timestamp, so a reverse name sort is newest-first.
  find "$DIR" -maxdepth 1 -name 'miyoria-*.dump' -print | sort -r | tail -n +"$((KEEP + 1))" |
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      rm -f -- "$f"
      echo "pruned: $f"
    done
fi
