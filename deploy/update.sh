#!/usr/bin/env bash
#
# Attar World Sonar Bangla — deploy the latest code
#
#   ./deploy/update.sh
#
# Pulls the latest code, installs dependencies, runs migrations, rebuilds the
# storefront if it is hosted here, and reloads the API with zero downtime.
#
# If the health check fails afterwards, it rolls the code back to the previous
# commit and reloads again, so a bad deploy does not leave the shop down.
#
# What it does NOT roll back: database migrations. Migrations are forward-only
# by design (see backend/src/db/migrate.js). A migration that breaks the app has to
# be fixed with a new migration, not by rewinding. This is why the script takes
# a database backup BEFORE migrating.

set -euo pipefail

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

if [[ -t 1 ]] && [[ "${TERM:-dumb}" != "dumb" ]]; then
    C_RESET=$'\033[0m'
    C_RED=$'\033[0;31m'
    C_GREEN=$'\033[0;32m'
    C_YELLOW=$'\033[0;33m'
    C_BLUE=$'\033[0;34m'
    C_BOLD=$'\033[1m'
else
    C_RESET='' C_RED='' C_GREEN='' C_YELLOW='' C_BLUE='' C_BOLD=''
fi

log()  { printf '%s==>%s %s\n' "${C_GREEN}" "${C_RESET}" "$*"; }
step() { printf '\n%s===%s %s%s%s\n' "${C_BLUE}" "${C_RESET}" "${C_BOLD}" "$*" "${C_RESET}"; }
warn() { printf '%sWARN:%s %s\n' "${C_YELLOW}" "${C_RESET}" "$*" >&2; }
die()  { printf '%sERROR:%s %s\n' "${C_RED}" "${C_RESET}" "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Two layouts are supported, because the code moved and deployed boxes did not.
#
#   SPLIT     (current): this repo IS the API. deploy/ sits beside src/, so
#                        REPO_ROOT is the API directory itself. The storefront
#                        and admin panel live in their own repositories and are
#                        deployed separately (Netlify), so there is no frontend
#                        to build here.
#   MONOREPO  (legacy):  backend/, frontend/ and admin/ are siblings under
#                        REPO_ROOT, which is what the original installer laid
#                        down and what any box provisioned before the split
#                        still has on disk.
#
# Detect rather than assume: a box that has not been re-cloned must keep
# working, and a fresh clone of the split repo must work without flags.
if [[ -f "${REPO_ROOT}/backend/package.json" ]]; then
    LAYOUT="monorepo"
    API_DIR="${REPO_ROOT}/backend"
    WEB_DIR="${REPO_ROOT}/frontend"
elif [[ -f "${REPO_ROOT}/package.json" ]] && [[ -f "${REPO_ROOT}/src/server.js" ]]; then
    LAYOUT="split"
    API_DIR="${REPO_ROOT}"
    WEB_DIR=""
else
    echo "ERROR: cannot find the API. Looked for backend/package.json and" >&2
    echo "       package.json+src/server.js under ${REPO_ROOT}." >&2
    exit 1
fi

ECOSYSTEM="${SCRIPT_DIR}/ecosystem.config.cjs"

HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:4000/api/v1/health}"
HEALTH_RETRIES="${HEALTH_RETRIES:-15}"
HEALTH_DELAY="${HEALTH_DELAY:-2}"

SKIP_BACKUP="no"
SKIP_MIGRATE="no"
FORCE="no"

PREVIOUS_COMMIT=""
ROLLED_BACK="no"

usage() {
    cat <<'HELPDOC'
Deploy the latest code.

USAGE
    ./deploy/update.sh [options]

OPTIONS
    --skip-backup    Do not take a database backup first. Not recommended.
    --skip-migrate   Do not run database migrations.
    --force          Deploy even if there are uncommitted local changes
                     (they will be stashed).
    -h, --help       Show this help.

ENVIRONMENT
    HEALTH_URL       Health endpoint to poll (default
                     http://127.0.0.1:4000/api/v1/health)
HELPDOC
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --skip-backup)  SKIP_BACKUP="yes"; shift ;;
        --skip-migrate) SKIP_MIGRATE="yes"; shift ;;
        --force)        FORCE="yes"; shift ;;
        -h|--help)      usage; exit 0 ;;
        *)              usage; die "Unknown option: $1" ;;
    esac
done

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

preflight() {
    step "Preflight"

    [[ "${EUID}" -ne 0 ]] || die "Do not run this as root. Run it as the user that owns the app."
    [[ -f "${API_DIR}/package.json" ]] || die "Cannot find the API's package.json under ${API_DIR}."
    command -v pm2 >/dev/null 2>&1 || die "pm2 is not installed. Run deploy/install.sh first."

    if [[ ! -f "${API_DIR}/.env" ]]; then
        die "The API's .env is missing (expected ${API_DIR}/.env). Run deploy/install.sh first."
    fi

    log "Repository: ${REPO_ROOT}"
    log "Layout:     ${LAYOUT} (API at ${API_DIR})"
}

# ---------------------------------------------------------------------------
# Git
# ---------------------------------------------------------------------------

pull_code() {
    step "Fetching the latest code"

    if [[ ! -d "${REPO_ROOT}/.git" ]]; then
        warn "${REPO_ROOT} is not a git repository, so there is nothing to pull."
        warn "Skipping straight to dependencies and restart."
        warn "If you deploy by uploading files, that is fine — copy them in before running this."
        return 0
    fi

    cd "${REPO_ROOT}"

    # Record where we are, so a failed health check can come back here.
    PREVIOUS_COMMIT="$(git rev-parse HEAD)"
    log "Current commit: $(git rev-parse --short HEAD) — $(git log -1 --pretty=%s)"

    # Uncommitted changes would be silently clobbered by a checkout, so stop
    # unless explicitly told to stash them.
    if ! git diff-index --quiet HEAD -- 2>/dev/null; then
        if [[ "${FORCE}" == "yes" ]]; then
            warn "Uncommitted changes found; stashing them."
            git stash push -u -m "update.sh auto-stash $(date -u '+%Y-%m-%d %H:%M:%S')"
            warn "Recover them later with: git stash pop"
        else
            die "There are uncommitted changes in ${REPO_ROOT}.

  Someone has edited files directly on the server. Deploying would
  overwrite them. Review them first:

      cd ${REPO_ROOT} && git status && git diff

  Then either commit them, discard them, or re-run with --force to
  stash them automatically."
        fi
    fi

    local branch
    branch="$(git rev-parse --abbrev-ref HEAD)"
    log "Pulling ${branch}..."
    git pull --ff-only origin "${branch}" \
        || die "git pull failed. Resolve the problem above and try again.
  Nothing has changed; the shop is still running the old code."

    local new_commit
    new_commit="$(git rev-parse HEAD)"
    if [[ "${new_commit}" == "${PREVIOUS_COMMIT}" ]]; then
        log "Already up to date; continuing anyway to pick up any dependency changes."
    else
        log "Updated to $(git rev-parse --short HEAD) — $(git log -1 --pretty=%s)"
    fi
}

# ---------------------------------------------------------------------------
# Backup
# ---------------------------------------------------------------------------

backup_database() {
    [[ "${SKIP_BACKUP}" == "no" ]] || { log "Skipping backup (--skip-backup)."; return 0; }

    step "Backing up the database first"

    if [[ -x "${SCRIPT_DIR}/backup.sh" ]]; then
        if "${SCRIPT_DIR}/backup.sh" --quiet; then
            log "Backup complete."
        else
            warn "Backup FAILED."
            if [[ "${FORCE}" != "yes" ]]; then
                die "Refusing to deploy without a backup. Fix the backup, or re-run with --force."
            fi
            warn "Continuing anyway because --force was given."
        fi
    else
        warn "deploy/backup.sh is not executable or missing; skipping the backup."
        warn "Fix with: chmod +x ${SCRIPT_DIR}/backup.sh"
    fi
}

# ---------------------------------------------------------------------------
# Dependencies, migrations, build
# ---------------------------------------------------------------------------

install_dependencies() {
    step "Installing API dependencies"

    cd "${API_DIR}"
    if [[ -f package-lock.json ]]; then
        npm ci --omit=dev --no-audit --no-fund
    else
        warn "No package-lock.json; using npm install."
        npm install --omit=dev --no-audit --no-fund
    fi
    log "Dependencies up to date."
}

run_migrations() {
    [[ "${SKIP_MIGRATE}" == "no" ]] || { log "Skipping migrations (--skip-migrate)."; return 0; }

    step "Running database migrations"

    cd "${API_DIR}"
    if ! npm run migrate; then
        die "Migrations FAILED.

  The old code is still running and the shop is still up. Nothing has
  been reloaded. Fix the migration, then run this script again.

  If the database is now in a half-migrated state, restore the backup
  taken at the start of this run:
      ${SCRIPT_DIR}/restore.sh --latest --yes-i-am-sure"
    fi
    log "Migrations applied."
}

build_web() {
    # In the split layout the storefront is its own repository, deployed
    # elsewhere (Netlify). There is no frontend/ here to build, and pulling
    # this repo cannot change the storefront.
    if [[ "${LAYOUT}" == "split" ]]; then
        log "Split layout: the storefront deploys from its own repository."
        return 0
    fi

    # Only rebuild if the storefront is actually served from this box, which
    # we detect by pm2 knowing about it.
    if ! pm2 describe awsb-web >/dev/null 2>&1; then
        log "Storefront is not running on this box; nothing to rebuild."
        return 0
    fi

    [[ -f "${WEB_DIR}/package.json" ]] || { warn "frontend/package.json missing; skipping build."; return 0; }

    step "Rebuilding the storefront"

    cd "${WEB_DIR}"
    if [[ -f package-lock.json ]]; then
        npm ci --no-audit --no-fund
    else
        npm install --no-audit --no-fund
    fi

    log "Building (slow on a small instance)..."
    if ! npm run build; then
        die "Storefront build FAILED.

  The API has NOT been reloaded and the old storefront build is still
  being served, so the shop is still up. Fix the build and re-run."
    fi
    log "Storefront built."
}

# ---------------------------------------------------------------------------
# Reload and verify
# ---------------------------------------------------------------------------

health_check() {
    local attempt=1
    while (( attempt <= HEALTH_RETRIES )); do
        if curl -fsS --max-time 5 "${HEALTH_URL}" >/dev/null 2>&1; then
            return 0
        fi
        printf '  waiting for the API to respond (%d/%d)...\n' "${attempt}" "${HEALTH_RETRIES}"
        sleep "${HEALTH_DELAY}"
        (( attempt++ ))
    done
    return 1
}

reload_services() {
    step "Reloading the API"

    if [[ ! -f "${API_DIR}/src/server.js" ]]; then
        warn "backend/src/server.js does not exist; there is nothing to reload."
        return 0
    fi

    cd "${REPO_ROOT}"

    if pm2 describe awsb-api >/dev/null 2>&1; then
        # reload (not restart) replaces workers one at a time, so requests in
        # flight are never dropped.
        log "Reloading with zero downtime..."
        pm2 reload "${ECOSYSTEM}" --only awsb-api --update-env
    else
        log "API was not running; starting it."
        pm2 start "${ECOSYSTEM}" --only awsb-api
    fi

    if pm2 describe awsb-web >/dev/null 2>&1; then
        log "Reloading the storefront..."
        pm2 reload "${ECOSYSTEM}" --only awsb-web --update-env
    fi

    pm2 save >/dev/null 2>&1 || true
}

rollback() {
    step "ROLLING BACK"

    if [[ -z "${PREVIOUS_COMMIT}" ]] || [[ ! -d "${REPO_ROOT}/.git" ]]; then
        warn "Cannot roll back automatically: no previous commit was recorded."
        warn "The API is unhealthy. Check the logs immediately:"
        warn "    pm2 logs awsb-api --lines 100"
        return 1
    fi

    warn "Reverting the code to ${PREVIOUS_COMMIT:0:8} and reloading."

    cd "${REPO_ROOT}"
    git checkout -q "${PREVIOUS_COMMIT}" -- . 2>/dev/null || git reset --hard "${PREVIOUS_COMMIT}"

    cd "${API_DIR}"
    npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1 || warn "Dependency rollback had problems."

    cd "${REPO_ROOT}"
    pm2 reload "${ECOSYSTEM}" --only awsb-api --update-env >/dev/null 2>&1 || true

    ROLLED_BACK="yes"

    if health_check; then
        warn "Rollback succeeded. The shop is running the PREVIOUS version again."
        warn "The deploy you just attempted did NOT go live. Investigate with:"
        warn "    pm2 logs awsb-api --lines 100"
        return 0
    fi

    warn "Rollback did NOT restore health. The shop may be down."
    warn "Look at the logs now: pm2 logs awsb-api --lines 100"
    return 1
}

verify() {
    step "Health check"

    if [[ ! -f "${API_DIR}/src/server.js" ]]; then
        warn "No server.js, so there is nothing to health check."
        return 0
    fi

    log "Polling ${HEALTH_URL}"

    if health_check; then
        log "API is healthy."
        return 0
    fi

    warn "The API did not become healthy after $(( HEALTH_RETRIES * HEALTH_DELAY )) seconds."

    if rollback; then
        die "Deploy failed and was rolled back. The shop is running the previous version."
    else
        die "Deploy failed AND the rollback did not restore health. The shop may be DOWN.
  Check immediately:  pm2 logs awsb-api --lines 100"
    fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
    preflight
    pull_code
    backup_database
    install_dependencies
    run_migrations
    build_web
    reload_services
    verify

    step "Done"
    pm2 status
    cat <<EOF

${C_GREEN}${C_BOLD}Deploy complete.${C_RESET} The shop is running the latest code.

  Watch the logs for a minute to be sure:
      pm2 logs awsb-api

EOF
}

main "$@"
