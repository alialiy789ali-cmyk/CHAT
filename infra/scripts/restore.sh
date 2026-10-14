#!/usr/bin/env bash
# ============================================================================
# Sovereign restore — restores a database dump and/or a storage archive.
# Requires a typed confirmation because it overwrites live data.
#
#   infra/scripts/restore.sh <db-....dump[.gpg]>          # restore database
#   infra/scripts/restore.sh --storage <storage-....tar.gz> [DEST_DIR]
#
# You must confirm by typing RESTORE (or set RESTORE_CONFIRM=RESTORE for an automated drill).
#
# Environment: COMPOSE_FILE, GPG_RECIPIENT (to decrypt .gpg archives), DEST_DIR for storage
# ============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$REPO_ROOT/infra/docker-compose.yml}"
STORAGE_TARGET="${STORAGE_TARGET:-$REPO_ROOT/apps/server/var/storage}"
STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"

log() { printf '[restore] %s\n' "$*"; }
dc() { docker compose -f "$COMPOSE_FILE" "$@"; }

usage() {
  sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 1
}

# Restoring overwrites live data, so it must be deliberate. In an automated drill set
# RESTORE_CONFIRM=RESTORE (documented in docs/backup-restore.md) — never guess it.
confirm_restore() {
  if [[ "${RESTORE_CONFIRM:-}" == "RESTORE" ]]; then
    log "confirmation accepted from RESTORE_CONFIRM (non-interactive)"
    return 0
  fi
  if [[ ! -t 0 ]]; then
    log "ERROR: refusing to restore without confirmation."
    log "       Run interactively and type RESTORE, or set RESTORE_CONFIRM=RESTORE for automation."
    exit 1
  fi
  printf '[restore] This OVERWRITES the live database. Type RESTORE to continue: '
  local answer
  read -r answer
  if [[ "$answer" != "RESTORE" ]]; then
    log "aborted — nothing was changed"
    exit 1
  fi
}

decrypt_if_needed() {
  local file="$1"
  if [[ "$file" == *.gpg ]]; then
    command -v gpg >/dev/null 2>&1 || { log "ERROR: gpg required to decrypt $file"; exit 1; }
    local out="${file%.gpg}"
    log "decrypting $file"
    gpg --batch --yes --output "$out" --decrypt "$file"
    echo "$out"
  else
    echo "$file"
  fi
}

verify_checksum() {
  local file="$1"
  if [[ -f "$file.sha256" ]]; then
    log "verifying checksum"
    (cd "$(dirname "$file")" && sha256sum -c "$(basename "$file").sha256")
  else
    log "WARN: no checksum file next to $file"
  fi
}

restore_database() {
  local archive
  archive="$(decrypt_if_needed "$1")"
  verify_checksum "$archive"
  [[ -s "$archive" ]] || { log "ERROR: archive is empty"; exit 1; }

  confirm_restore
  log "stopping api and web so nothing writes during the restore"
  dc stop api web || true

  local db_user db_name
  db_user="$(dc exec -T postgres printenv POSTGRES_USER 2>/dev/null || echo sovereign)"
  db_name="$(dc exec -T postgres printenv POSTGRES_DB 2>/dev/null || echo sovereign)"

  # Safety net: keep the current state before overwriting anything.
  local safety="/tmp/pre-restore-$STAMP.dump"
  log "saving current state to $safety (inside the postgres container)"
  dc exec -T postgres pg_dump -U "$db_user" -d "$db_name" --format=custom --no-owner > "$safety"
  [[ -s "$safety" ]] || { log "ERROR: pre-restore safety dump is empty — aborting before touching live data"; exit 1; }

  log "restoring $archive into $db_name"
  dc exec -T postgres psql -U "$db_user" -d postgres -c \
    "select pg_terminate_backend(pid) from pg_stat_activity where datname = '$db_name' and pid <> pg_backend_pid();" >/dev/null
  dc exec -T postgres dropdb -U "$db_user" --if-exists "$db_name"
  dc exec -T postgres createdb -U "$db_user" "$db_name"
  # pgcrypto/citext are required by the schema; the dump also contains them,
  # but creating them first makes the restore robust on managed providers.
  dc exec -T postgres psql -U "$db_user" -d "$db_name" -c 'create extension if not exists pgcrypto; create extension if not exists citext;' >/dev/null
  dc exec -T postgres pg_restore -U "$db_user" -d "$db_name" --no-owner --exit-on-error < "$archive"

  log "restarting api and web"
  dc start api web
  log "waiting for the health endpoint"
  for _ in $(seq 1 30); do
    if curl -fsS http://localhost:8787/api/health >/dev/null 2>&1; then log "api healthy"; break; fi
    sleep 2
  done
}

restore_storage() {
  local archive
  archive="$(decrypt_if_needed "$1")"
  verify_checksum "$archive"
  confirm_restore
  log "restoring object storage into $STORAGE_TARGET"
  mkdir -p "$STORAGE_TARGET"
  tar -xzf "$archive" -C "$(dirname "$STORAGE_TARGET")" --strip-components=1 2>/dev/null || tar -xzf "$archive" -C "$STORAGE_TARGET"
  log "storage restored ($(du -sh "$STORAGE_TARGET" | cut -f1))"
}

[[ $# -ge 1 ]] || usage

if [[ "$1" == "--storage" ]]; then
  [[ $# -ge 2 ]] || usage
  restore_storage "$2"
else
  restore_database "$1"
fi

log "DONE. Verify with: npm run smoke   (and check row counts in your manifest file)"
