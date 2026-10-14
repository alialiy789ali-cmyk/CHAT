#!/usr/bin/env bash
# ============================================================================
# Sovereign backup — PostgreSQL dump + object storage mirror + integrity manifest.
#
#   infra/scripts/backup.sh [DEST_DIR]        # default: /var/backups/sovereign
#
# Optional environment:
#   COMPOSE_FILE   path to docker-compose.yml (default: infra/docker-compose.yml)
#   STORAGE_DIR    local storage directory to archive when STORAGE_DRIVER=local
#   MINIO_ALIAS    mc alias name for mirroring (default: sovereign)
#   GPG_RECIPIENT  if set, archives are encrypted with gpg
#   RETENTION_DAYS number of days to keep (default: 14)
# ============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEST="${1:-/var/backups/sovereign}"
COMPOSE_FILE="${COMPOSE_FILE:-$REPO_ROOT/infra/docker-compose.yml}"
STORAGE_DIR="${STORAGE_DIR:-$REPO_ROOT/apps/server/var/storage}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
mkdir -p "$DEST"

log() { printf '[backup %s] %s\n' "$STAMP" "$*"; }
dc() { docker compose -f "$COMPOSE_FILE" "$@"; }

# ---------------------------------------------------------------- database
DB_USER="$(dc exec -T postgres printenv POSTGRES_USER 2>/dev/null || echo sovereign)"
DB_NAME="$(dc exec -T postgres printenv POSTGRES_DB 2>/dev/null || echo sovereign)"
DUMP="$DEST/db-$STAMP.dump"

log "dumping database $DB_NAME as $DB_USER"
dc exec -T postgres pg_dump -U "$DB_USER" -d "$DB_NAME" --format=custom --no-owner --compress=6 > "$DUMP"
log "database dump: $(du -h "$DUMP" | cut -f1)"

# ---------------------------------------------------------------- storage
STORAGE_DRIVER="$(grep -E '^STORAGE_DRIVER=' "$REPO_ROOT/.env" 2>/dev/null | cut -d= -f2 | tr -d '"' || true)"
ARCHIVE=""
if [[ "${STORAGE_DRIVER:-local}" == "s3" ]]; then
  if command -v mc >/dev/null 2>&1; then
    ARCHIVE="$DEST/storage-$STAMP.tar.gz"
    TMP="$(mktemp -d)"
    log "mirroring object storage via mc"
    mc mirror --quiet "${MINIO_ALIAS:-sovereign}/${S3_BUCKET:-sovereign}" "$TMP"
    tar -czf "$ARCHIVE" -C "$TMP" .
    rm -rf "$TMP"
  else
    log "WARN: STORAGE_DRIVER=s3 but 'mc' is not installed — skipping object storage"
  fi
elif [[ -d "$STORAGE_DIR" ]]; then
  ARCHIVE="$DEST/storage-$STAMP.tar.gz"
  log "archiving local storage $STORAGE_DIR"
  tar -czf "$ARCHIVE" -C "$(dirname "$STORAGE_DIR")" "$(basename "$STORAGE_DIR")"
else
  log "WARN: no storage directory at $STORAGE_DIR — skipping"
fi

# ---------------------------------------------------------------- encryption
if [[ -n "${GPG_RECIPIENT:-}" ]] && command -v gpg >/dev/null 2>&1; then
  log "encrypting archives for $GPG_RECIPIENT"
  gpg --batch --yes --encrypt --recipient "$GPG_RECIPIENT" "$DUMP"
  rm -f "$DUMP"; DUMP="$DUMP.gpg"
  if [[ -n "$ARCHIVE" ]]; then gpg --batch --yes --encrypt --recipient "$GPG_RECIPIENT" "$ARCHIVE"; rm -f "$ARCHIVE"; ARCHIVE="$ARCHIVE.gpg"; fi
fi

# ---------------------------------------------------------------- integrity
log "writing checksums + manifest"
sha256sum "$DUMP" > "$DUMP.sha256"
[[ -n "$ARCHIVE" ]] && sha256sum "$ARCHIVE" > "$ARCHIVE.sha256"

{
  echo "sovereign backup"
  echo "timestamp: $STAMP"
  echo "database: $DB_NAME"
  echo "users: $(dc exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" -tAc 'select count(*) from users' 2>/dev/null || echo '?')"
  echo "messages: $(dc exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" -tAc 'select count(*) from messages' 2>/dev/null || echo '?')"
  echo "posts: $(dc exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" -tAc 'select count(*) from posts' 2>/dev/null || echo '?')"
  echo "attachments: $(dc exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" -tAc 'select count(*) from attachments' 2>/dev/null || echo '?')"
  echo "database_archive: $(basename "$DUMP")"
  echo "storage_archive: ${ARCHIVE:-none}"
  echo "git_revision: $(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
} > "$DEST/manifest-$STAMP.txt"

# ---------------------------------------------------------------- retention
log "pruning backups older than $RETENTION_DAYS days"
find "$DEST" -maxdepth 1 -type f \( -name 'db-*.dump*' -o -name 'storage-*.tar.gz*' -o -name 'manifest-*.txt' \) \
  -mtime "+$RETENTION_DAYS" -print -delete || true

log "done → $DEST"
log "copy off-host next: aws s3 sync $DEST s3://<your-bucket>/$(hostname)/  OR  rsync -az $DEST/ backup@host:/srv/sovereign/"
