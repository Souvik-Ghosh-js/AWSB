#!/usr/bin/env bash
#
# Attar World Sonar Bangla — database backup
#
#   ./deploy/backup.sh              take a backup now
#   ./deploy/backup.sh --quiet      no output unless something goes wrong
#
# Dumps the MySQL database, gzips it with a timestamped name, keeps the last
# N days locally, and uploads to S3 if the AWS CLI is configured.
#
# Installed as a nightly cron job by deploy/install.sh.
#
# Restoring is a SEPARATE script, deliberately: see deploy/restore.sh.

set -euo pipefail

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

QUIET="no"

if [[ -t 1 ]] && [[ "${TERM:-dumb}" != "dumb" ]]; then
    C_RESET=$'\033[0m'
    C_RED=$'\033[0;31m'
    C_GREEN=$'\033[0;32m'
    C_YELLOW=$'\033[0;33m'
else
    C_RESET='' C_RED='' C_GREEN='' C_YELLOW=''
fi

log()  { [[ "${QUIET}" == "yes" ]] || printf '%s==>%s %s\n' "${C_GREEN}" "${C_RESET}" "$*"; }
warn() { printf '%sWARN:%s %s\n' "${C_YELLOW}" "${C_RESET}" "$*" >&2; }
die()  { printf '%sERROR:%s %s\n' "${C_RED}" "${C_RESET}" "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${REPO_ROOT}/backend/.env"

BACKUP_DIR="${AWSB_BACKUP_DIR:-${HOME}/awsb-backups}"
RETENTION_DAYS="${AWSB_BACKUP_RETENTION_DAYS:-14}"
S3_BACKUP_BUCKET="${AWSB_BACKUP_S3_BUCKET:-}"

usage() {
    cat <<'HELPDOC'
Back up the Attar World Sonar Bangla database.

USAGE
    ./deploy/backup.sh [options]

OPTIONS
    --quiet             Only print warnings and errors (used by cron).
    --dir <path>        Where to write backups (default ~/awsb-backups).
    --retention <days>  How many days of backups to keep (default 14).
    --s3 <bucket>       Also upload to this S3 bucket, e.g. s3://my-bucket/db
                        Requires the AWS CLI to be installed and configured.
    -h, --help          Show this help.

ENVIRONMENT
    AWSB_BACKUP_DIR             same as --dir
    AWSB_BACKUP_RETENTION_DAYS  same as --retention
    AWSB_BACKUP_S3_BUCKET       same as --s3
HELPDOC
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --quiet)     QUIET="yes"; shift ;;
        --dir)       BACKUP_DIR="${2:-}"; shift 2 ;;
        --retention) RETENTION_DAYS="${2:-}"; shift 2 ;;
        --s3)        S3_BACKUP_BUCKET="${2:-}"; shift 2 ;;
        -h|--help)   usage; exit 0 ;;
        *)           usage; die "Unknown option: $1" ;;
    esac
done

[[ "${RETENTION_DAYS}" =~ ^[0-9]+$ ]] || die "--retention must be a whole number of days."
(( RETENTION_DAYS >= 1 )) || die "--retention must be at least 1 day."

# ---------------------------------------------------------------------------
# Read credentials from backend/.env
# ---------------------------------------------------------------------------

# Parse a single key out of .env without sourcing the file. Sourcing would
# execute whatever is in there, and a '#' or space in a password would break.
env_value() {
    local key="$1"
    [[ -f "${ENV_FILE}" ]] || return 1
    sed -n "s/^${key}=//p" "${ENV_FILE}" | head -1 | sed 's/^"\(.*\)"$/\1/; s/^'"'"'\(.*\)'"'"'$/\1/'
}

load_credentials() {
    [[ -f "${ENV_FILE}" ]] || die "Cannot find ${ENV_FILE}. Has deploy/install.sh been run?"

    DB_HOST="$(env_value DB_HOST || true)"
    DB_PORT="$(env_value DB_PORT || true)"
    DB_USER="$(env_value DB_USER || true)"
    DB_PASSWORD="$(env_value DB_PASSWORD || true)"
    DB_NAME="$(env_value DB_NAME || true)"

    DB_HOST="${DB_HOST:-127.0.0.1}"
    DB_PORT="${DB_PORT:-3306}"

    [[ -n "${DB_USER}" ]]     || die "DB_USER is not set in ${ENV_FILE}."
    [[ -n "${DB_NAME}" ]]     || die "DB_NAME is not set in ${ENV_FILE}."
    [[ -n "${DB_PASSWORD}" ]] || die "DB_PASSWORD is not set in ${ENV_FILE}."
}

# ---------------------------------------------------------------------------
# Backup
# ---------------------------------------------------------------------------

take_backup() {
    mkdir -p "${BACKUP_DIR}"
    chmod 700 "${BACKUP_DIR}"

    local stamp outfile tmpfile defaults_file
    stamp="$(date -u '+%Y%m%d-%H%M%S')"
    outfile="${BACKUP_DIR}/awsb-${stamp}.sql.gz"
    tmpfile="${outfile}.partial"

    # Pass the password via a defaults file on a private temp file, never on
    # the command line: anything on the command line is visible to every user
    # on the box via `ps`.
    defaults_file="$(mktemp)"
    chmod 600 "${defaults_file}"
    # shellcheck disable=SC2064
    trap "rm -f '${defaults_file}' '${tmpfile}'" EXIT

    cat > "${defaults_file}" <<EOF
[client]
host=${DB_HOST}
port=${DB_PORT}
user=${DB_USER}
password=${DB_PASSWORD}
EOF

    log "Backing up '${DB_NAME}' to $(basename "${outfile}")"

    # --single-transaction gives a consistent snapshot of InnoDB tables
    #   without locking the shop out mid-dump.
    # --routines / --triggers / --events keep stored logic with the data.
    # --set-gtid-purged=OFF keeps the dump restorable onto a different server.
    # --no-tablespaces avoids needing the PROCESS privilege, which the
    #   restricted 'awsb' user does not have.
    if ! mysqldump --defaults-extra-file="${defaults_file}" \
            --single-transaction \
            --quick \
            --routines \
            --triggers \
            --events \
            --no-tablespaces \
            --set-gtid-purged=OFF \
            --default-character-set=utf8mb4 \
            "${DB_NAME}" 2>"${tmpfile}.err" | gzip -9 > "${tmpfile}"; then
        local err
        err="$(head -5 "${tmpfile}.err" 2>/dev/null || true)"
        rm -f "${tmpfile}" "${tmpfile}.err"
        die "mysqldump failed: ${err}"
    fi
    rm -f "${tmpfile}.err"

    # A dump that is suspiciously small almost certainly failed partway.
    local size
    size="$(stat -c %s "${tmpfile}" 2>/dev/null || echo 0)"
    if (( size < 1024 )); then
        rm -f "${tmpfile}"
        die "The backup is only ${size} bytes, which cannot be right. Nothing was saved."
    fi

    # Only now promote it to its final name, so a partial dump is never
    # mistaken for a good backup.
    mv "${tmpfile}" "${outfile}"
    chmod 600 "${outfile}"

    # Verify the gzip stream is intact.
    if ! gzip -t "${outfile}" 2>/dev/null; then
        die "The backup file is corrupt (failed gzip integrity check): ${outfile}"
    fi

    trap - EXIT
    rm -f "${defaults_file}"

    BACKUP_FILE="${outfile}"
    log "Backup complete: ${outfile} ($(du -h "${outfile}" | cut -f1))"
}

# ---------------------------------------------------------------------------
# Retention
# ---------------------------------------------------------------------------

prune_old_backups() {
    log "Removing local backups older than ${RETENTION_DAYS} days..."

    local removed=0
    # -mtime +N is strictly "older than N days". The glob is anchored to our
    # own naming so this can never delete anything it did not create.
    while IFS= read -r -d '' old; do
        rm -f "${old}"
        log "  removed $(basename "${old}")"
        removed=$(( removed + 1 ))
    done < <(find "${BACKUP_DIR}" -maxdepth 1 -type f \
                  -name 'awsb-*.sql.gz' \
                  -mtime "+${RETENTION_DAYS}" -print0 2>/dev/null)

    if (( removed == 0 )); then
        log "  nothing old enough to remove."
    fi

    # Safety net: never leave zero backups, even if retention is misconfigured.
    local remaining
    remaining="$(find "${BACKUP_DIR}" -maxdepth 1 -type f -name 'awsb-*.sql.gz' | wc -l)"
    log "${remaining} backup(s) on disk in ${BACKUP_DIR}"
}

# ---------------------------------------------------------------------------
# S3
# ---------------------------------------------------------------------------

upload_to_s3() {
    [[ -n "${S3_BACKUP_BUCKET}" ]] || { log "No S3 bucket configured; keeping backups locally only."; return 0; }

    if ! command -v aws >/dev/null 2>&1; then
        warn "An S3 bucket is configured but the AWS CLI is not installed."
        warn "Install it with: sudo snap install aws-cli --classic"
        return 0
    fi

    # Confirm credentials actually work before trying to upload.
    if ! aws sts get-caller-identity >/dev/null 2>&1; then
        warn "The AWS CLI is installed but not configured (or the credentials are invalid)."
        warn "Run 'aws configure'. The backup is still saved locally."
        return 0
    fi

    local dest="${S3_BACKUP_BUCKET%/}/$(basename "${BACKUP_FILE}")"
    log "Uploading to ${dest}"

    if aws s3 cp "${BACKUP_FILE}" "${dest}" --only-show-errors; then
        log "Uploaded to S3."
    else
        # An S3 failure must not fail the whole job — the local backup is good.
        warn "S3 upload FAILED. The local backup is fine: ${BACKUP_FILE}"
    fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
    command -v mysqldump >/dev/null 2>&1 || die "mysqldump is not installed."

    load_credentials
    take_backup
    prune_old_backups
    upload_to_s3

    if [[ "${QUIET}" != "yes" ]]; then
        cat <<EOF

${C_GREEN}Backup finished.${C_RESET}

  File       ${BACKUP_FILE}
  Retention  ${RETENTION_DAYS} days
  Location   ${BACKUP_DIR}

  To restore one of these (DESTRUCTIVE — read the warnings first):
      ${SCRIPT_DIR}/restore.sh --latest --yes-i-am-sure

EOF
    fi
}

main "$@"
