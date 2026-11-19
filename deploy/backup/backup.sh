#!/usr/bin/env bash
# Nightly off-box backup of every database on the box, before the night shift starts.
# Runs as your admin user (who has Docker), never as crew. SQLite files get a WAL-safe snapshot (VACUUM INTO) and an
# integrity check; Postgres databases get pg_dump -Fc and a pg_restore listing. Everything is
# encrypted with age to a PUBLIC key (the private key stays on your PC, so this box cannot read its
# own backups) and uploaded with rclone to an R2 bucket whose bucket lock stops deletes.
# It writes a status file that crew checks: no fresh backup, no night shift.
#
# Config: ~/.config/crew-backup/backup.env (see backup.env.example). Test: backup.sh --dry-run
set -euo pipefail

CONF=${CREW_BACKUP_CONF:-$HOME/.config/crew-backup/backup.env}
# shellcheck source=/dev/null
. "$CONF"
: "${AGE_RECIPIENT:?set AGE_RECIPIENT in $CONF}" "${RCLONE_DEST:?set RCLONE_DEST in $CONF}"
DRY=${1:-}
STAMP=$(date -u +%Y-%m-%dT%H%MZ)
HOST=$(hostname -s)
STATUS=${STATUS_FILE:-/srv/crew-share/backup-status.json}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/crew-backup.XXXXXX")
trap 'rm -rf "$WORK" "$WORK.tgz.age"' EXIT
FILES=()

notify() {
  [ -n "${NTFY_URL:-}" ] || return 0
  curl -fsS -m 10 -H "Title: $1" -H "Tags: floppy_disk" -d "$2" "$NTFY_URL" >/dev/null || true
}

# {"ok", "at", "okAt" (last good run), "host", "detail", "files"}; crew reads okAt.
write_status() {
  if [ "$DRY" = "--dry-run" ]; then
    echo "status: ok=$1 $2"
    return
  fi
  mkdir -p "$(dirname "$STATUS")"
  OK="$1" DETAIL="$2" HOSTN="$HOST" FILES_LIST="${FILES[*]:-}" STATUS="$STATUS" python3 - <<'PY'
import datetime, json, os
p = os.environ["STATUS"]
now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
try:
    prev = json.load(open(p))
except Exception:
    prev = {}
ok = os.environ["OK"] == "true"
data = {"ok": ok, "at": now, "okAt": now if ok else prev.get("okAt"), "host": os.environ["HOSTN"],
        "detail": os.environ["DETAIL"], "files": os.environ["FILES_LIST"].split()}
with open(p + ".tmp", "w") as f:
    json.dump(data, f, indent=2)
os.chmod(p + ".tmp", 0o640)
os.replace(p + ".tmp", p)
PY
}

fail() {
  echo "backup: $*" >&2
  notify "Backup FAILED on $HOST" "$*"
  write_status false "$*"
  exit 1
}
# Anything that fails outside an explicit `|| fail` still reports, instead of dying silently.
trap 'fail "unexpected error on line $LINENO"' ERR

# A tiny image with the sqlite3 CLI (the host has none). Built once, reused.
docker image inspect crew-sqlite3 >/dev/null 2>&1 || docker build -q -t crew-sqlite3 - >/dev/null <<'EOF' || fail "could not build the sqlite3 image"
FROM alpine:3.20
RUN apk add --no-cache sqlite
EOF

# 1. SQLite: name=/path/to/file.sqlite (the folder is mounted so the -wal/-shm files are seen)
for entry in ${SQLITE_DBS:-}; do
  name=${entry%%=*}
  file=${entry#*=}
  [ -f "$file" ] || fail "SQLite file for $name not found: $file"
  # Run as the database's own owner, so a -wal/-shm file created during the backup never ends up
  # owned by root (which could leave the live app read-only).
  owner=$(stat -c %u:%g "$file")
  out="$WORK/sqlite-$name"
  mkdir -p "$out" && chmod 777 "$out"
  docker run --rm --user "$owner" -v "$(dirname "$file")":/data -v "$out":/out crew-sqlite3 \
    sqlite3 "/data/$(basename "$file")" "VACUUM INTO '/out/$name.sqlite'" \
    || fail "SQLite snapshot of $name failed"
  check=$(docker run --rm --user "$owner" -v "$out":/out crew-sqlite3 sqlite3 "/out/$name.sqlite" "PRAGMA integrity_check" || true)
  [ "$check" = "ok" ] || fail "SQLite integrity check of $name: $check"
  cp "$out/$name.sqlite" "$WORK/$name.sqlite" && rm -rf "$out"
  FILES+=("$name.sqlite")
done

# 2. Postgres: container:user:database (pg_dump runs inside the container)
for entry in ${PG_DBS:-}; do
  c=${entry%%:*}
  rest=${entry#*:}
  u=${rest%%:*}
  db=${rest#*:}
  docker exec "$c" pg_dump -U "$u" -Fc "$db" > "$WORK/$c.$db.dump" || fail "pg_dump of $c/$db failed (is the container running?)"
  docker exec -i "$c" pg_restore -l < "$WORK/$c.$db.dump" > /dev/null || fail "pg_restore cannot read the dump of $c/$db"
  FILES+=("$c.$db.dump")
done
for c in ${PG_GLOBALS:-}; do
  cont=${c%%:*}
  u=${c#*:}
  docker exec "$cont" pg_dumpall -U "$u" --globals-only > "$WORK/$cont.globals.sql" || fail "pg_dumpall globals of $cont failed"
  FILES+=("$cont.globals.sql")
done
[ ${#FILES[@]} -gt 0 ] || fail "nothing to back up: set SQLITE_DBS and PG_DBS"

# 3. Optional: a SCRUBBED copy of the demo dump for crew's golden database (group crewshare, 640).
# The raw dump holds integration secrets in its settings rows, so it is restored into a throwaway
# Postgres, scrubbed with scrub.sql, dumped again, and only that copy is shared with crew.
if [ -n "${CREW_DEMO_DUMP:-}" ] && [ -n "${CREW_DEMO_SOURCE:-}" ] && [ "$DRY" != "--dry-run" ]; then
  : "${CREW_SCRUB_SQL:?set CREW_SCRUB_SQL to the path of scrub.sql}"
  sc="crew-scrub-$$"
  docker run -d --rm --name "$sc" -e POSTGRES_PASSWORD=scrub postgres:16 >/dev/null || fail "could not start the scrub container"
  # The image restarts its server once after init, so "ready" can be a false start: retry createdb.
  for _ in $(seq 1 60); do docker exec "$sc" createdb -U postgres demo 2>/dev/null && break; sleep 1; done
  { docker exec "$sc" psql -U postgres -lqt | cut -d'|' -f1 | grep -qw demo &&
    docker exec -i "$sc" pg_restore -U postgres -d demo --no-owner --no-acl < "$WORK/$CREW_DEMO_SOURCE.dump" &&
    docker exec -i "$sc" psql -U postgres -d demo -v ON_ERROR_STOP=1 -q < "$CREW_SCRUB_SQL" &&
    docker exec "$sc" pg_dump -U postgres -Fc demo > "$CREW_DEMO_DUMP.tmp"; } || { docker rm -f "$sc" >/dev/null; fail "scrubbing the demo dump failed"; }
  docker rm -f "$sc" >/dev/null
  chmod 640 "$CREW_DEMO_DUMP.tmp" && mv "$CREW_DEMO_DUMP.tmp" "$CREW_DEMO_DUMP"
fi

# 4. Encrypt to the public key and upload
tar -C "$WORK" -czf - . | age -r "$AGE_RECIPIENT" > "$WORK.tgz.age" || fail "encryption failed"
SIZE=$(du -h "$WORK.tgz.age" | cut -f1)
if [ "$DRY" = "--dry-run" ]; then
  echo "dry run: would upload $SIZE to $RCLONE_DEST/daily/$HOST/$STAMP.tgz.age (${FILES[*]})"
else
  rclone copyto --s3-no-check-bucket "$WORK.tgz.age" "$RCLONE_DEST/daily/$HOST/$STAMP.tgz.age" || fail "upload to $RCLONE_DEST failed"
fi
write_status true "$SIZE, ${#FILES[@]} files"
echo "backup ok: $SIZE, ${FILES[*]}"
