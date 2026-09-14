#!/usr/bin/env bash
#
# Attar World Sonar Bangla — restore the database from a backup
#
# ###########################################################################
# #  THIS DESTROYS THE CURRENT DATABASE AND REPLACES IT WITH THE BACKUP.    #
# #  Every order, customer and payment recorded since that backup was       #
# #  taken is PERMANENTLY LOST. There is no undo.                           #
# ###########################################################################
#
# It refuses to do anything without --yes-i-am-sure, by design.
#
#   ./deploy/restore.sh --list
#   ./deploy/restore.sh --latest --yes-i-am-sure
#   ./deploy/restore.sh --file ~/awsb-backups/awsb-20260914-023000.sql.gz --yes-i-am-sure

set -euo pipefail

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

if [[ -t 1 ]] && [[ "${TERM:-dumb}" != "dumb" ]]; then
    C_RESET=$'\033[0m'
    C_RED=$'\033[0;31m'
    C_GREEN=$'\033[0;32m'
    C_YELLOW=$'\033[0;33m'
    C_BOLD=$'\033[1m'
else
    C_RESET='' C_RED='' C_GREEN='' C_YELLOW='' C_BOLD=''
fi

log()  { printf '%s==>%s %s\n' "${C_GREEN}" "${C_RESET}" "$*"; }
warn() { printf '%sWARN:%s %s\n' "${C_YELLOW}" "${C_RESET}" "$*" >&2; }
die()  { printf '%sERROR:%s %s\n' "${C_RED}" "${C_RESET}" "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${REPO_ROOT}/backend/.env"
BACKUP_DIR="${AWSB_BACKUP_DIR:-${HOME}/awsb-backups}"

CONFIRMED="no"
USE_LATEST="no"
LIST_ONLY="no"
BACKUP_FILE=""
NO_SAFETY="no"

usage() {
    cat <<'HELPDOC'
Restore the Attar World Sonar Bangla database from a backup.

  *** THIS REPLACES THE ENTIRE DATABASE. DATA SINCE THE BACKUP IS LOST. ***

USAGE
    ./deploy/restore.sh --list
    ./deploy/restore.sh --latest --yes-i-am-sure
    ./deploy/restore.sh --file <path> --yes-i-am-sure

OPTIONS
    --list              Show available backups and exit. Safe.
    --latest            Restore the most recent backup.
    --file <path>       Restore this specific .sql.gz file.
    --yes-i-am-sure     REQUIRED. Without it, this script does nothing.
    --no-safety-backup  Skip the safety backup taken before overwriting.
                        Do not use this.
    --dir <path>        Where backups live (default ~/awsb-backups).
    -h, --help          Show this help.

WHAT HAPPENS
    1. A safety backup of the CURRENT database is taken first.
    2. The API is stopped so nothing writes mid-restore.
    3. The backup is loaded, replacing everything.
    4. The API is started again.
HELPDOC
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --list)             LIST_ONLY="yes"; shift ;;
        --latest)           USE_LATEST="yes"; shift ;;
        --file)             BACKUP_FILE="${2:-}"; shift 2 ;;
        --yes-i-am-sure)    CONFIRMED="yes"; shift ;;
        --no-safety-backup) NO_SAFETY="yes"; shift ;;
        --dir)              BACKUP_DIR="${2:-}"; shift 2 ;;
        -h|--help)          usage; exit 0 ;;
        *)                  usage; die "Unknown option: $1" ;;
    esac
done

# ---------------------------------------------------------------------------
# Listing
# ---------------------------------------------------------------------------

list_backups() {
    if [[ ! -d "${BACKUP_DIR}" ]]; then
        die "No backup directory at ${BACKUP_DIR}."
    fi

    local found
    found="$(find "${BACKUP_DIR}" -maxdepth 1 -type f -name 'awsb-*.sql.gz' | wc -l)"
    if (( found == 0 )); then
        die "No backups found in ${BACKUP_DIR}."
    fi

    printf '\n%sAvailable backups in %s%s\n\n' "${C_BOLD}" "${BACKUP_DIR}" "${C_RESET}"
    # Newest first.
    find "${BACKUP_DIR}" -maxdepth 1 -type f -name 'awsb-*.sql.gz' -printf '%T@ %p\n' \
        | sort -rn \
        | cut -d' ' -f2- \
        | while IFS= read -r f; do
            printf '  %-46s %8s   %s\n' \
                "$(basename "${f}")" \
                "$(du -h "${f}" | cut -f1)" \
                "$(date -r "${f}" '+%Y-%m-%d %H:%M')"
        done
    printf '\n'
}

resolve_backup_file() {
    if [[ "${USE_LATEST}" == "yes" ]]; then
        BACKUP_FILE="$(find "${BACKUP_DIR}" -maxdepth 1 -type f -name 'awsb-*.sql.gz' -printf '%T@ %p\n' 2>/dev/null \
                       | sort -rn | head -1 | cut -d' ' -f2-)"
        [[ -n "${BACKUP_FILE}" ]] || die "No backups found in ${BACKUP_DIR}."
        log "Most recent backup: $(basename "${BACKUP_FILE}")"
    fi

    [[ -n "${BACKUP_FILE}" ]] || die "Specify which backup to restore: --latest or --file <path>.
  See what is available with:  ${SCRIPT_DIR}/restore.sh --list"

    [[ -f "${BACKUP_FILE}" ]] || die "No such file: ${BACKUP_FILE}"

    # Refuse a corrupt archive before touching the live database.
    if [[ "${BACKUP_FILE}" == *.gz ]]; then
        gzip -t "${BACKUP_FILE}" 2>/dev/null \
            || die "That backup is corrupt and cannot be restored: ${BACKUP_FILE}"
    fi
}

# ---------------------------------------------------------------------------
# Credentials
# ---------------------------------------------------------------------------

env_value() {
    local key="$1"
    [[ -f "${ENV_FILE}" ]] || return 1
    sed -n "s/^${key}=//p" "${ENV_FILE}" | head -1 | sed 's/^"\(.*\)"$/\1/; s/^'"'"'\(.*\)'"'"'$/\1/'
}

load_credentials() {
    [[ -f "${ENV_FILE}" ]] || die "Cannot find ${ENV_FILE}."

    DB_HOST="$(env_value DB_HOST || true)"; DB_HOST="${DB_HOST:-127.0.0.1}"
    DB_PORT="$(env_value DB_PORT || true)"; DB_PORT="${DB_PORT:-3306}"
    DB_USER="$(env_value DB_USER || true)"
    DB_PASSWORD="$(env_value DB_PASSWORD || true)"
    DB_NAME="$(env_value DB_NAME || true)"

    [[ -n "${DB_USER}" && -n "${DB_NAME}" && -n "${DB_PASSWORD}" ]] \
        || die "DB_USER, DB_NAME or DB_PASSWORD missing from ${ENV_FILE}."
}

# ---------------------------------------------------------------------------
# Restore
# ---------------------------------------------------------------------------

confirm_or_die() {
    if [[ "${CONFIRMED}" != "yes" ]]; then
        cat >&2 <<EOF

${C_RED}${C_BOLD}REFUSING TO RUN.${C_RESET}

  Restoring replaces the ENTIRE '${DB_NAME}' database with the contents
  of a backup file. Every order, customer, payment and stock change
  recorded since that backup was taken will be ${C_BOLD}permanently lost${C_RESET}.

  Backup to restore:  $(basename "${BACKUP_FILE}")
  Taken:              $(date -r "${BACKUP_FILE}" '+%Y-%m-%d %H:%M' 2>/dev/null || echo unknown)

  If that is genuinely what you want, run the command again with the
  confirmation flag added:

      ${C_BOLD}$0 --file "${BACKUP_FILE}" --yes-i-am-sure${C_RESET}

EOF
        exit 1
    fi
}

safety_backup() {
    [[ "${NO_SAFETY}" == "no" ]] || { warn "Skipping the safety backup (--no-safety-backup)."; return 0; }

    log "Taking a safety backup of the CURRENT database first..."

    if [[ -x "${SCRIPT_DIR}/backup.sh" ]]; then
        if "${SCRIPT_DIR}/backup.sh" --quiet; then
            log "Safety backup saved. If this restore is a mistake, that file is your way back."
        else
            warn "The safety backup FAILED."
            read -r -p "Continue with the restore anyway, with no way back? [y/N] " reply
            [[ "${reply}" =~ ^[Yy]$ ]] || die "Aborted. Nothing was changed."
        fi
    else
        warn "deploy/backup.sh not found; cannot take a safety backup."
    fi
}

stop_api() {
    if command -v pm2 >/dev/null 2>&1 && pm2 describe awsb-api >/dev/null 2>&1; then
        log "Stopping the API so nothing writes during the restore..."
        pm2 stop awsb-api >/dev/null 2>&1 || warn "Could not stop the API cleanly."
        API_WAS_RUNNING="yes"
    else
        API_WAS_RUNNING="no"
    fi
}

start_api() {
    [[ "${API_WAS_RUNNING:-no}" == "yes" ]] || return 0
    log "Starting the API again..."
    pm2 start awsb-api >/dev/null 2>&1 || warn "Could not restart the API. Do it manually: pm2 start awsb-api"
}

do_restore() {
    local defaults_file
    defaults_file="$(mktemp)"
    chmod 600 "${defaults_file}"
    # shellcheck disable=SC2064
    trap "rm -f '${defaults_file}'" EXIT

    cat > "${defaults_file}" <<EOF
[client]
host=${DB_HOST}
port=${DB_PORT}
user=${DB_USER}
password=${DB_PASSWORD}
EOF

    log "Restoring ${DB_NAME} from $(basename "${BACKUP_FILE}")..."
    log "Do not interrupt this."

    # The dump does not contain CREATE DATABASE, so ensure it exists.
    mysql --defaults-extra-file="${defaults_file}" \
        -e "CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;" \
        || die "Could not reach MySQL. Nothing was changed."

    if [[ "${BACKUP_FILE}" == *.gz ]]; then
        gunzip -c "${BACKUP_FILE}" | mysql --defaults-extra-file="${defaults_file}" "${DB_NAME}" \
            || die "The restore FAILED partway through. The database may be in a broken state.
  Your safety backup is in ${BACKUP_DIR}."
    else
        mysql --defaults-extra-file="${defaults_file}" "${DB_NAME}" < "${BACKUP_FILE}" \
            || die "The restore FAILED partway through."
    fi

    rm -f "${defaults_file}"
    trap - EXIT

    log "Restore complete."
}

verify_restore() {
    local defaults_file count
    defaults_file="$(mktemp)"
    chmod 600 "${defaults_file}"
    # shellcheck disable=SC2064
    trap "rm -f '${defaults_file}'" EXIT

    cat > "${defaults_file}" <<EOF
[client]
host=${DB_HOST}
port=${DB_PORT}
user=${DB_USER}
password=${DB_PASSWORD}
EOF

    count="$(mysql --defaults-extra-file="${defaults_file}" -N -B \
             -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${DB_NAME}';" 2>/dev/null || echo 0)"

    rm -f "${defaults_file}"
    trap - EXIT

    if (( count > 0 )); then
        log "Verified: ${count} table(s) present in '${DB_NAME}'."
    else
        warn "The database appears to have no tables. Something went wrong."
    fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
    command -v mysql >/dev/null 2>&1 || die "The mysql client is not installed."

    if [[ "${LIST_ONLY}" == "yes" ]]; then
        list_backups
        exit 0
    fi

    load_credentials
    resolve_backup_file
    confirm_or_die

    printf '\n%s%sRestoring in 5 seconds. Press Ctrl-C to abort.%s\n\n' "${C_YELLOW}" "${C_BOLD}" "${C_RESET}"
    sleep 5

    safety_backup
    stop_api
    do_restore
    verify_restore
    start_api

    cat <<EOF

${C_GREEN}${C_BOLD}Restore finished.${C_RESET}

  Restored from  $(basename "${BACKUP_FILE}")
  Database       ${DB_NAME}

  Check the shop works, then watch the logs:
      pm2 logs awsb-api

EOF
}

main "$@"
