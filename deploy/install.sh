#!/usr/bin/env bash
#
# Attar World Sonar Bangla — one-command production installer
# Target: a FRESH AWS Lightsail instance running Ubuntu 22.04 LTS.
#
#   bash deploy/install.sh --domain example.com --email you@example.com
#
# Safe to re-run. Re-running upgrades in place: it never duplicates a user, a
# database, an nginx site or a cron entry, and it never overwrites an existing
# .env or an existing MySQL password.
#
# Run as a normal sudo-capable user, NOT as root. See usage() below.

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
# Defaults and configuration
# ---------------------------------------------------------------------------

DOMAIN=""
ADMIN_EMAIL=""
API_PORT="4000"
WEB_PORT="3000"
ADMIN_PORT="3001"
WITH_WEB="no"
WITH_ADMIN="no"
SKIP_SEED="no"
NODE_MAJOR="22"
DB_NAME="awsb"
DB_USER="awsb"

REPO_ROOT=""
RUN_USER="${USER:-$(id -un)}"
RUN_HOME=""
CRED_FILE=""
LOG_DIR=""

usage() {
    cat <<'HELPDOC'
Attar World Sonar Bangla — production installer (Ubuntu 22.04)

USAGE
    bash deploy/install.sh [options]

OPTIONS
    --domain <domain>     Apex domain, e.g. attarworldsonarbangla.com
                          The API is served from api.<domain>.
    --email <address>     Admin email. Used for Let's Encrypt expiry notices
                          and as the default admin alert address.
    --with-web            ALSO run the Next.js storefront on this box behind
                          nginx on the apex domain. Omit this if the
                          storefront is hosted on Vercel/Amplify (recommended).
    --with-admin          ALSO run the admin panel on this box, served from
                          admin.<domain>. It is a SEPARATE app from the
                          storefront, on its own origin, so a scripting bug
                          in the shop cannot reach an admin session.
    --api-port <port>     API port (default 4000).
    --web-port <port>     Storefront port (default 3000).
    --admin-port <port>   Admin panel port (default 3001).
    --skip-seed           Run migrations but not seeds. Use when re-running
                          against a database that already has real data.
    -h, --help            Show this help.

If --domain or --email are omitted you will be prompted for them.

This script must be run as a normal user with sudo rights, from inside the
checked-out repository. It will ask for your sudo password.
HELPDOC
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --domain)    DOMAIN="${2:-}"; shift 2 ;;
            --email)     ADMIN_EMAIL="${2:-}"; shift 2 ;;
            --with-web)   WITH_WEB="yes"; shift ;;
            --with-admin) WITH_ADMIN="yes"; shift ;;
            --api-port)  API_PORT="${2:-}"; shift 2 ;;
            --web-port)   WEB_PORT="${2:-}"; shift 2 ;;
            --admin-port) ADMIN_PORT="${2:-}"; shift 2 ;;
            --skip-seed) SKIP_SEED="yes"; shift ;;
            -h|--help)   usage; exit 0 ;;
            *)           usage; die "Unknown option: $1" ;;
        esac
    done
}

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

preflight() {
    step "Preflight checks"

    # 1. Refuse root. Running the whole install as root leaves every file,
    #    the pm2 daemon and the .env owned by root, which then makes routine
    #    maintenance require root too, and one typo destroys the box.
    if [[ "${EUID}" -eq 0 ]]; then
        die "Do not run this as root (or with sudo).
  Log in as your normal Lightsail user (usually 'ubuntu') and run:
      bash deploy/install.sh --domain example.com --email you@example.com
  The script calls sudo itself where it genuinely needs to."
    fi

    # 2. Require sudo rights, and prime the sudo timestamp up front so the
    #    password prompt appears here rather than halfway through an apt run.
    if ! command -v sudo >/dev/null 2>&1; then
        die "sudo is not installed. This script needs it."
    fi
    log "Checking sudo access (you may be asked for your password)..."
    if ! sudo -n true 2>/dev/null; then
        die "This user cannot use sudo. Use the default 'ubuntu' user on Lightsail."
    fi

    # 3. Refuse non-Ubuntu. The package names, the NodeSource repo and
    #    mysql_secure_installation's behaviour are all Debian/Ubuntu specific.
    [[ -r /etc/os-release ]] || die "Cannot read /etc/os-release. This is not a supported system."
    # shellcheck disable=SC1091
    . /etc/os-release
    if [[ "${ID:-}" != "ubuntu" ]]; then
        die "This installer supports Ubuntu only (found: ${PRETTY_NAME:-unknown}).
  Create a Lightsail instance with the 'Ubuntu 22.04 LTS' blueprint."
    fi
    if [[ "${VERSION_ID:-}" != "22.04" ]]; then
        warn "Expected Ubuntu 22.04, found ${VERSION_ID:-unknown}. Continuing, but this is untested."
        warn "Press Ctrl-C within 10 seconds to abort."
        sleep 10
    fi
    log "OS: ${PRETTY_NAME:-Ubuntu}"

    # 4. Locate the repository root from this script's own location, so the
    #    script works regardless of the directory it is invoked from.
    local script_dir
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    REPO_ROOT="$(cd "${script_dir}/.." && pwd)"

    # Two layouts, same detection as deploy/update.sh -- see the long comment
    # there. install.sh historically only understood the monorepo layout
    # (backend/, frontend/, admin/ as siblings under REPO_ROOT) and hard-died
    # on anything else, which meant it could not even be re-run against a box
    # that had migrated to the split layout -- the thing you would actually
    # reach for to regenerate a stale nginx config, such as the uploads alias
    # this same patch adds below.
    if [[ -f "${REPO_ROOT}/backend/package.json" ]]; then
        LAYOUT="monorepo"
        API_DIR="${REPO_ROOT}/backend"
        UPLOADS_DIR="${API_DIR}/uploads"
    elif [[ -f "${REPO_ROOT}/package.json" ]] && [[ -f "${REPO_ROOT}/src/server.js" ]]; then
        LAYOUT="split"
        API_DIR="${REPO_ROOT}"
        UPLOADS_DIR="${API_DIR}/uploads"
    else
        die "Cannot find the API relative to ${script_dir}.
  Run this script from inside the checked-out repository:
      cd ~/awsb && bash deploy/install.sh ..."
    fi
    log "Repository: ${REPO_ROOT}"
    log "Layout:     ${LAYOUT} (API at ${API_DIR})"

    RUN_USER="$(id -un)"
    RUN_HOME="$(getent passwd "${RUN_USER}" | cut -d: -f6)"
    [[ -n "${RUN_HOME}" && -d "${RUN_HOME}" ]] || die "Cannot determine home directory for ${RUN_USER}."
    CRED_FILE="${RUN_HOME}/awsb-credentials.txt"
    LOG_DIR="${RUN_HOME}/awsb-logs"
    log "User: ${RUN_USER} (home: ${RUN_HOME})"

    # 5. Architecture note — Lightsail offers both amd64 and arm64.
    log "Architecture: $(dpkg --print-architecture)"
}

prompt_inputs() {
    step "Configuration"

    while [[ -z "${DOMAIN}" ]]; do
        read -r -p "Your domain (without www, e.g. attarworldsonarbangla.com): " DOMAIN
    done
    # Strip a pasted scheme, any trailing slash and a leading www.
    DOMAIN="${DOMAIN#http://}"
    DOMAIN="${DOMAIN#https://}"
    DOMAIN="${DOMAIN%%/*}"
    DOMAIN="${DOMAIN#www.}"
    if [[ ! "${DOMAIN}" =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; then
        die "'${DOMAIN}' does not look like a domain name."
    fi

    while [[ -z "${ADMIN_EMAIL}" ]]; do
        read -r -p "Your email address (for certificate expiry warnings): " ADMIN_EMAIL
    done
    if [[ ! "${ADMIN_EMAIL}" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[A-Za-z]{2,}$ ]]; then
        die "'${ADMIN_EMAIL}' does not look like an email address."
    fi

    API_DOMAIN="api.${DOMAIN}"

    cat <<EOF

  Domain            ${DOMAIN}
  API domain        ${API_DOMAIN}
  Admin email       ${ADMIN_EMAIL}
  Storefront here?  ${WITH_WEB}
  Admin here?       ${WITH_ADMIN}
  API port          ${API_PORT}
EOF
    printf '\n'
}

# ---------------------------------------------------------------------------
# System packages
# ---------------------------------------------------------------------------

install_base_packages() {
    step "Installing system packages"

    export DEBIAN_FRONTEND=noninteractive

    log "Updating package lists..."
    sudo apt-get update -qq

    log "Upgrading existing packages (this can take a few minutes on a fresh box)..."
    sudo apt-get upgrade -y -qq

    # Build tooling and the native libraries sharp and tesseract.js rely on.
    #
    # sharp ships prebuilt libvips binaries for common platforms, but falls
    # back to building from source when no prebuilt matches (notably on some
    # arm64 images), and that build needs the -dev headers below.
    #
    # tesseract.js is WASM and does NOT need the system tesseract binary, but
    # it downloads language data at runtime, so ca-certificates must be sane.
    log "Installing base packages and native image libraries..."
    sudo apt-get install -y -qq \
        build-essential \
        python3 \
        pkg-config \
        ca-certificates \
        curl \
        wget \
        gnupg \
        git \
        unzip \
        jq \
        ufw \
        fail2ban \
        nginx \
        libvips-dev \
        libjpeg-dev \
        libpng-dev \
        libwebp-dev \
        libtiff-dev \
        libgif-dev \
        librsvg2-dev \
        liblcms2-dev \
        libexpat1-dev \
        libglib2.0-dev

    log "Base packages installed."
}

# ---------------------------------------------------------------------------
# Swap
# ---------------------------------------------------------------------------

setup_swap() {
    step "Swap file"

    local mem_kb mem_mb swap_size
    mem_kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
    mem_mb=$(( mem_kb / 1024 ))
    log "Detected ${mem_mb} MB of RAM."

    # Under 2 GB, sharp (image resize) and tesseract.js (OCR of label photos)
    # will push the box into the OOM killer under any real load. Swap is slow
    # but it is the difference between a sluggish request and a dead API.
    if (( mem_mb >= 1900 )); then
        log "2 GB or more of RAM; no swap file needed."
        return 0
    fi

    if swapon --show=NAME --noheadings 2>/dev/null | grep -q .; then
        log "Swap is already active:"
        swapon --show
        return 0
    fi

    local swap_mb
    if (( mem_mb < 1000 )); then
        swap_size="2G"
        swap_mb=2048
    else
        swap_size="1G"
        swap_mb=1024
    fi

    warn "Only ${mem_mb} MB of RAM. Creating a ${swap_size} swap file."
    warn "A 512 MB Lightsail instance will still struggle with OCR. See deploy/README.md."

    if [[ -f /swapfile ]]; then
        log "/swapfile already exists; enabling it rather than recreating."
    else
        # fallocate can produce a sparse file that swapon rejects on some
        # filesystems; dd is slower but always works.
        sudo fallocate -l "${swap_size}" /swapfile 2>/dev/null \
            || sudo dd if=/dev/zero of=/swapfile bs=1M count="${swap_mb}" status=none
        sudo chmod 600 /swapfile
        sudo mkswap /swapfile >/dev/null
    fi

    sudo swapon /swapfile

    # Persist across reboots, without duplicating the line on a re-run.
    if ! grep -qE '^\s*/swapfile\s' /etc/fstab; then
        echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
        log "Added /swapfile to /etc/fstab."
    fi

    # Prefer RAM, use swap only under real pressure.
    if ! grep -q '^vm.swappiness' /etc/sysctl.conf; then
        echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf >/dev/null
        sudo sysctl -q -w vm.swappiness=10
    fi

    log "Swap active:"
    swapon --show
}

# ---------------------------------------------------------------------------
# Node.js
# ---------------------------------------------------------------------------

install_node() {
    step "Node.js ${NODE_MAJOR} LTS"

    # backend/package.json declares engines.node >= 22.2.0 because razorpay@2.9.5
    # requires it. Ubuntu 22.04's own repo ships Node 12, so NodeSource is not
    # optional here.
    local current_major=""
    if command -v node >/dev/null 2>&1; then
        current_major="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
        log "Found Node $(node -v)."
    fi

    if [[ "${current_major}" == "${NODE_MAJOR}" ]]; then
        log "Node ${NODE_MAJOR} already installed; skipping NodeSource setup."
    else
        log "Adding the NodeSource repository for Node ${NODE_MAJOR}..."
        sudo mkdir -p /etc/apt/keyrings
        # Idempotent: overwrite the key each run rather than appending.
        curl -fsSL "https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key" \
            | sudo gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
        sudo chmod a+r /etc/apt/keyrings/nodesource.gpg
        echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
            | sudo tee /etc/apt/sources.list.d/nodesource.list >/dev/null
        sudo apt-get update -qq
        sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs
    fi

    command -v node >/dev/null 2>&1 || die "Node install failed: 'node' not found on PATH."

    # Verify the actual version satisfies the engine constraint, not just the
    # major. razorpay needs >= 22.2.0 specifically.
    local node_ver major minor
    node_ver="$(node -v)"
    major="$(echo "${node_ver}" | sed 's/^v\([0-9]*\).*/\1/')"
    minor="$(echo "${node_ver}" | sed 's/^v[0-9]*\.\([0-9]*\).*/\1/')"
    if (( major < 22 )) || { (( major == 22 )) && (( minor < 2 )); }; then
        die "Node ${node_ver} is too old. The Razorpay SDK requires >= 22.2.0."
    fi
    log "Node ${node_ver}, npm $(npm -v)."
}

install_pm2() {
    step "pm2 process manager"

    if command -v pm2 >/dev/null 2>&1; then
        log "pm2 present ($(pm2 -v 2>/dev/null || echo unknown)); updating to latest."
    else
        log "Installing pm2 globally..."
    fi
    sudo npm install -g pm2@latest --silent

    command -v pm2 >/dev/null 2>&1 || die "pm2 install failed."
    log "pm2 $(pm2 -v 2>/dev/null || echo installed)."
}

# ---------------------------------------------------------------------------
# MySQL
# ---------------------------------------------------------------------------

# Generate a password safe to paste into a .env file and into MySQL:
# alphanumeric only, so no quoting, no shell metacharacters, no '#' starting a
# comment in .env, and nothing MySQL's parser treats specially.
generate_password() {
    local len="${1:-32}"
    LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c "${len}"
}

install_mysql() {
    step "MySQL 8"

    if dpkg -l mysql-server 2>/dev/null | grep -q '^ii'; then
        log "mysql-server already installed."
    else
        log "Installing mysql-server (this takes a minute)..."
        sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq mysql-server
    fi

    sudo systemctl enable --now mysql
    sudo systemctl is-active --quiet mysql || die "MySQL failed to start. Check: sudo journalctl -u mysql -n 50"
    log "MySQL is running: $(mysql --version)"
}

secure_mysql() {
    step "Securing MySQL"

    # Equivalent of mysql_secure_installation, done non-interactively.
    #
    # On Ubuntu, the packaged MySQL 8 root account uses auth_socket, meaning
    # 'sudo mysql' works with no password and there is no root password to
    # set or leak. We deliberately LEAVE root on auth_socket: it is strictly
    # safer than a password, and it is why no root password is ever printed.
    log "Removing anonymous users, disabling remote root, dropping the test database..."

    sudo mysql --protocol=socket <<'SQL'
-- Anonymous users allow login with no credentials at all.
DELETE FROM mysql.user WHERE User = '';

-- root must be reachable only from this machine.
DELETE FROM mysql.user WHERE User = 'root' AND Host NOT IN ('localhost', '127.0.0.1', '::1');

-- The stock 'test' database is world-writable by default.
DROP DATABASE IF EXISTS test;
DELETE FROM mysql.db WHERE Db = 'test' OR Db = 'test\\_%';

FLUSH PRIVILEGES;
SQL

    # Bind to loopback only. Even with UFW closed, this removes the
    # possibility of MySQL ever answering on the public interface.
    local bind_conf="/etc/mysql/mysql.conf.d/zz-awsb-bind.cnf"
    if [[ ! -f "${bind_conf}" ]]; then
        sudo tee "${bind_conf}" >/dev/null <<'CONF'
# Written by deploy/install.sh — Attar World Sonar Bangla
# The API runs on this same box and connects over 127.0.0.1. MySQL must never
# be reachable from the internet.
[mysqld]
bind-address = 127.0.0.1
mysqlx-bind-address = 127.0.0.1
CONF
        sudo systemctl restart mysql
        log "MySQL bound to 127.0.0.1 only."
    else
        log "MySQL loopback binding already configured."
    fi

    log "MySQL secured."
}

setup_database() {
    step "Application database"

    local db_password="" existing_env="${REPO_ROOT}/backend/.env"

    # Idempotency rule: if a working password already exists, KEEP it.
    # Rotating the password on every run would break a running deployment,
    # which is exactly the kind of silent destruction this script must avoid.
    if [[ -f "${existing_env}" ]] && grep -q '^DB_PASSWORD=.\+' "${existing_env}"; then
        db_password="$(grep '^DB_PASSWORD=' "${existing_env}" | head -1 | cut -d= -f2-)"
        log "Reusing the existing database password from backend/.env."
    elif [[ -f "${CRED_FILE}" ]] && grep -q '^DB_PASSWORD=.\+' "${CRED_FILE}"; then
        db_password="$(grep '^DB_PASSWORD=' "${CRED_FILE}" | head -1 | cut -d= -f2-)"
        log "Reusing the existing database password from ${CRED_FILE}."
    else
        db_password="$(generate_password 32)"
        log "Generated a new database password (written to ${CRED_FILE}, never shown here)."
    fi

    DB_PASSWORD="${db_password}"

    # CREATE ... IF NOT EXISTS plus ALTER USER makes this safe to re-run: the
    # database is never dropped and the user is never recreated, but the
    # password is re-asserted so .env and MySQL cannot drift apart.
    #
    # The password is passed via a heredoc on stdin, not on the command line,
    # so it never appears in the process list or in the shell history.
    sudo mysql --protocol=socket <<SQL
CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost'
  IDENTIFIED BY '${DB_PASSWORD}';
ALTER USER '${DB_USER}'@'localhost'
  IDENTIFIED BY '${DB_PASSWORD}';

GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${DB_USER}'@'localhost';
FLUSH PRIVILEGES;
SQL

    # Prove the credentials actually work before the app depends on them.
    #
    # The password goes via a private defaults file, never as -p on the
    # command line: anything in argv is visible to every user on the box
    # through `ps`, which would defeat the point of generating a strong one.
    local check_defaults
    check_defaults="$(mktemp)"
    chmod 600 "${check_defaults}"
    # shellcheck disable=SC2064
    trap "rm -f '${check_defaults}'" RETURN

    cat > "${check_defaults}" <<EOF
[client]
host=127.0.0.1
port=3306
user=${DB_USER}
password=${DB_PASSWORD}
EOF

    if mysql --defaults-extra-file="${check_defaults}" --protocol=tcp \
            -e 'SELECT 1' "${DB_NAME}" >/dev/null 2>&1; then
        log "Database '${DB_NAME}' and user '${DB_USER}' verified."
    else
        die "Could not connect to MySQL as '${DB_USER}'. The install cannot continue."
    fi
}

write_credentials_file() {
    step "Credentials file"

    # Written with a restrictive umask so there is no window in which the file
    # exists world-readable between creation and chmod.
    local old_umask
    old_umask="$(umask)"
    umask 077

    cat > "${CRED_FILE}" <<EOF
# =====================================================================
#  Attar World Sonar Bangla — generated credentials
#  Created: $(date -u '+%Y-%m-%d %H:%M:%S UTC') on $(hostname)
#
#  SAVE THESE SOMEWHERE SAFE (a password manager), THEN DELETE THIS FILE:
#      rm ${CRED_FILE}
#
#  These values are already written into backend/.env. This file exists only
#  so you have a copy. It is readable only by you (mode 600).
# =====================================================================

DB_NAME=${DB_NAME}
DB_USER=${DB_USER}
DB_PASSWORD=${DB_PASSWORD}

JWT_SECRET=${JWT_SECRET}

# MySQL root does NOT have a password on this machine, by design.
# It uses Unix socket authentication instead, which is safer: only a user
# who can already run sudo on this box can become MySQL root. To open a
# root MySQL shell:
#     sudo mysql
#
# The database is bound to 127.0.0.1 and the firewall does not expose
# port 3306. Nothing outside this machine can reach MySQL.
EOF

    umask "${old_umask}"
    chmod 600 "${CRED_FILE}"
    log "Credentials written to ${CRED_FILE} (mode 600)."
}

# ---------------------------------------------------------------------------
# Application
# ---------------------------------------------------------------------------

write_env_file() {
    step "API environment (.env)"

    local env_file="${REPO_ROOT}/backend/.env"

    if [[ -f "${env_file}" ]]; then
        # Never clobber a live .env — it holds the Razorpay and Gmail secrets
        # the owner typed in by hand. Back it up and leave it alone.
        local backup="${env_file}.backup.$(date -u '+%Y%m%d%H%M%S')"
        cp -p "${env_file}" "${backup}"
        chmod 600 "${backup}"
        log "Existing backend/.env found; backed up to $(basename "${backup}")."
        log "Leaving it in place. Delete it and re-run if you want a fresh one."
        # Still ensure the DB password matches what MySQL now expects.
        if ! grep -q "^DB_PASSWORD=${DB_PASSWORD}$" "${env_file}"; then
            sed -i "s|^DB_PASSWORD=.*|DB_PASSWORD=${DB_PASSWORD}|" "${env_file}"
            log "Updated DB_PASSWORD in the existing .env to match the database."
        fi
        return 0
    fi

    local old_umask
    old_umask="$(umask)"
    umask 077

    # IMPORTANT: backend/src/config/env.js validates the ENTIRE environment at
    # boot with zod and exits non-zero on any failure — and migrate.js and
    # seed.js both import it. So placeholder values below are not cosmetic:
    # without them the API SERVER will not boot: src/config/env.js validates
    # every secret at startup and exits if one is missing.
    #
    # Migrations and seeds are exempt — they import src/config/db-env.js, which
    # validates the DB_* values only, so the schema can be created on a fresh
    # box before the owner has any Razorpay or Gmail credentials at all.
    #
    # Every placeholder is deliberately obvious and non-functional. The
    # summary at the end of this script tells the owner exactly which ones
    # must be replaced before the shop can take a single rupee.
    cat > "${env_file}" <<EOF
# Attar World Sonar Bangla — production environment
# Generated by deploy/install.sh on $(date -u '+%Y-%m-%d %H:%M:%S UTC')
#
# ############# VALUES MARKED 'REPLACE_ME' ARE PLACEHOLDERS #############
# The app will START with them, but payments and email will NOT work.
# See the checklist printed at the end of the installer.

NODE_ENV=production
PORT=${API_PORT}

# ---- URLs -------------------------------------------------------------
SITE_URL=https://${DOMAIN}
API_URL=https://${API_DOMAIN}

# ---- Database ---------------------------------------------------------
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=${DB_USER}
DB_PASSWORD=${DB_PASSWORD}
DB_NAME=${DB_NAME}
DB_CONNECTION_LIMIT=10

# ---- Razorpay ---------------------------------------------------------
# REPLACE BOTH. From https://dashboard.razorpay.com → Settings → API Keys.
# Test keys start rzp_test_, live keys rzp_live_.
RAZORPAY_KEY_ID=rzp_test_REPLACE_ME
RAZORPAY_KEY_SECRET=REPLACE_ME_razorpay_key_secret

# REPLACE. This is the WEBHOOK secret from Settings → Webhooks — a value you
# choose yourself when creating the webhook. It is NOT the key secret above.
# Using the key secret here makes every webhook signature check fail.
RAZORPAY_WEBHOOK_SECRET=REPLACE_ME_razorpay_webhook_secret

# ---- Auth -------------------------------------------------------------
# Generated with openssl. Do not change this after customers have logged in:
# changing it invalidates every existing session and password-reset link.
JWT_SECRET=${JWT_SECRET}
JWT_EXPIRES_IN=7d
ADMIN_JWT_EXPIRES_IN=12h

# ---- Email (Nodemailer over Gmail SMTP) -------------------------------
# REPLACE SMTP_PASSWORD with a Google App Password (16 characters, no spaces).
# It is NOT your Gmail password, and it requires 2FA to be enabled first:
#   https://myaccount.google.com/apppasswords
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=${ADMIN_EMAIL}
SMTP_PASSWORD=REPLACE_ME_gmail_app_password
MAIL_FROM_NAME=Attar World Sonar Bangla
MAIL_FROM_ADDRESS=${ADMIN_EMAIL}
ADMIN_ALERT_EMAIL=${ADMIN_EMAIL}

# ---- Object storage ---------------------------------------------------
# Starts as 'local' so the app boots without S3 credentials. Product images
# are then stored on this instance's disk and are LOST if the instance is
# rebuilt. Switch to s3 and fill the keys below before going live —
# see docs/01-architecture.md §8.
STORAGE_DRIVER=local
S3_ENDPOINT=https://s3.ap-south-1.amazonaws.com
S3_REGION=ap-south-1
S3_BUCKET=awsb-media
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
S3_PUBLIC_BASE_URL=

# ---- Behaviour --------------------------------------------------------
RESERVATION_MINUTES=30
BCRYPT_ROUNDS=12
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX=300
EOF

    umask "${old_umask}"
    chmod 600 "${env_file}"
    log "Wrote backend/.env (mode 600) with generated secrets and placeholders."
}

install_app_dependencies() {
    step "Application dependencies"

    cd "${REPO_ROOT}/backend"

    # npm ci requires a lockfile and installs exactly what it pins. --omit=dev
    # skips pino-pretty, which is only used for readable dev logs.
    if [[ ! -f package-lock.json ]]; then
        warn "No backend/package-lock.json found; falling back to 'npm install'."
        warn "Commit a lockfile so production installs are reproducible."
        npm install --omit=dev --no-audit --no-fund
    else
        log "Installing API dependencies with npm ci (this takes a few minutes)..."
        log "sharp may compile libvips from source; that is normal and slow."
        npm ci --omit=dev --no-audit --no-fund
    fi

    log "API dependencies installed."

    mkdir -p "${LOG_DIR}"
    log "Log directory: ${LOG_DIR}"
}

# A forgotten placeholder is the failure mode that costs real money: the API
# boots, the shop looks alive, and every payment or email silently fails. So
# say so loudly, by name, every run. Not fatal — on a first install the owner
# legitimately has none of these yet.
preflight_secrets() {
    local env_file="${REPO_ROOT}/backend/.env"
    [[ -f "${env_file}" ]] || return 0

    local -a pending=()
    local key
    # Plain ERE: GNU grep has no lookahead, so match the whole line and cut.
    while IFS= read -r key; do
        [[ -n "${key}" ]] && pending+=("${key}")
    done < <(grep -E '^[A-Z_]+=.*REPLACE_ME' "${env_file}" | cut -d= -f1)

    [[ ${#pending[@]} -eq 0 ]] && return 0

    warn "-----------------------------------------------------------------"
    warn "  These values in backend/.env are still placeholders:"
    for key in "${pending[@]}"; do
        warn "      ${key}"
    done
    warn ""
    warn "  The shop will run, but PAYMENTS AND EMAIL WILL NOT WORK until"
    warn "  they are replaced with real values. Edit backend/.env, then:"
    warn "      pm2 reload awsb-api"
    warn "-----------------------------------------------------------------"
}

run_migrations() {
    step "Database migrations and seeds"

    cd "${REPO_ROOT}/backend"

    log "Running migrations..."
    if ! npm run migrate; then
        die "Migrations failed.
  Migrations read ONLY the DB_* values in backend/.env (see src/config/db-env.js),
  so this is a database problem, not a missing Razorpay or Gmail secret.
  Check that MySQL is running and DB_USER/DB_PASSWORD/DB_NAME are right, then:
      cd ${REPO_ROOT}/backend && npm run migrate"
    fi
    log "Migrations applied."

    if [[ "${SKIP_SEED}" == "yes" ]]; then
        log "Skipping seeds (--skip-seed)."
        return 0
    fi

    log "Running seeds (shipping zones and couriers)..."
    if ! npm run seed; then
        warn "Seeding failed. This is not fatal — the schema is in place."
        warn "Re-run manually later: cd ${REPO_ROOT}/backend && npm run seed"
    else
        log "Seeds applied."
    fi
}

build_web() {
    [[ "${WITH_WEB}" == "yes" ]] || return 0

    step "Building the Next.js storefront"

    if [[ ! -f "${REPO_ROOT}/frontend/package.json" ]]; then
        warn "--with-web was given but frontend/package.json does not exist. Skipping."
        WITH_WEB="no"
        return 0
    fi

    cd "${REPO_ROOT}/frontend"

    # Next.js needs its dev dependencies (typescript, tailwind) to BUILD, so
    # this is a full install, unlike the API.
    log "Installing storefront dependencies..."
    if [[ -f package-lock.json ]]; then
        npm ci --no-audit --no-fund
    else
        warn "No frontend/package-lock.json; using npm install."
        npm install --no-audit --no-fund
    fi

    # The storefront needs to know where the API lives at BUILD time for
    # NEXT_PUBLIC_* values, which are inlined into the bundle.
    if [[ ! -f .env.production ]]; then
        cat > .env.production <<EOF
# Generated by deploy/install.sh
NEXT_PUBLIC_SITE_URL=https://${DOMAIN}
NEXT_PUBLIC_API_URL=https://${API_DOMAIN}
EOF
        chmod 600 .env.production
        log "Wrote frontend/.env.production."
    fi

    log "Building (this is the slowest step; several minutes on a small box)..."
    if ! npm run build; then
        warn "Storefront build FAILED. The API will still be installed and started."
        warn "Fix the build and re-run: cd ${REPO_ROOT}/frontend && npm run build"
        WITH_WEB="no"
        return 0
    fi

    log "Storefront built."
}

# The admin panel is a second Next.js app, deployed separately from the shop.
# Keeping it on its own origin is the point: a cross-site scripting bug in the
# storefront cannot read an admin token held on admin.<domain>, and customers
# never download the admin bundle.
build_admin() {
    [[ "${WITH_ADMIN}" == "yes" ]] || return 0

    step "Building the admin panel"

    if [[ ! -f "${REPO_ROOT}/admin/package.json" ]]; then
        warn "--with-admin was given but admin/package.json does not exist. Skipping."
        WITH_ADMIN="no"
        return 0
    fi

    cd "${REPO_ROOT}/admin"

    log "Installing admin panel dependencies..."
    if [[ -f package-lock.json ]]; then
        npm ci --no-audit --no-fund
    else
        warn "No admin/package-lock.json; using npm install."
        npm install --no-audit --no-fund
    fi

    # NEXT_PUBLIC_* values are inlined at BUILD time, so the API URL has to be
    # known now, not at start time.
    if [[ ! -f .env.production ]]; then
        cat > .env.production <<ADMINENV
# Generated by deploy/install.sh
NEXT_PUBLIC_SITE_URL=https://admin.${DOMAIN}
NEXT_PUBLIC_API_URL=https://${API_DOMAIN}
NEXT_PUBLIC_USE_MOCKS=false
ADMINENV
        chmod 600 .env.production
        log "Wrote admin/.env.production."
    fi

    log "Building the admin panel..."
    if ! npm run build; then
        warn "Admin panel build FAILED. The API will still be installed and started."
        warn "Fix the build and re-run: cd ${REPO_ROOT}/admin && npm run build"
        WITH_ADMIN="no"
        return 0
    fi

    log "Admin panel built."
}

# ---------------------------------------------------------------------------
# nginx
# ---------------------------------------------------------------------------

configure_nginx() {
    step "nginx reverse proxy"

    local template="${REPO_ROOT}/deploy/nginx/awsb.conf.template"
    local target="/etc/nginx/sites-available/awsb.conf"
    local tmp
    [[ -f "${template}" ]] || die "Missing nginx template: ${template}"

    tmp="$(mktemp)"
    # Ensure the temp file cannot be left behind on an unexpected exit.
    trap 'rm -f "${tmp}"' RETURN

    sed \
        -e "s|{{DOMAIN}}|${DOMAIN}|g" \
        -e "s|{{API_DOMAIN}}|${API_DOMAIN}|g" \
        -e "s|{{API_PORT}}|${API_PORT}|g" \
        -e "s|{{WEB_PORT}}|${WEB_PORT}|g" \
        -e "s|{{ADMIN_PORT}}|${ADMIN_PORT}|g" \
        -e "s|{{UPLOADS_DIR}}|${UPLOADS_DIR}|g" \
        "${template}" > "${tmp}"

    if [[ "${WITH_WEB}" == "yes" ]]; then
        # Keep the storefront block, just drop the marker lines.
        sed -i -e '/{{WEB_BLOCK_START}}/d' -e '/{{WEB_BLOCK_END}}/d' "${tmp}"
        log "Storefront vhost included (${DOMAIN} -> 127.0.0.1:${WEB_PORT})."
    else
        # Delete the whole optional block, markers included.
        sed -i '/{{WEB_BLOCK_START}}/,/{{WEB_BLOCK_END}}/d' "${tmp}"
        log "Storefront vhost omitted; the apex domain should point at your host (Vercel/Amplify)."
    fi

    if [[ "${WITH_ADMIN}" == "yes" ]]; then
        sed -i -e '/{{ADMIN_BLOCK_START}}/d' -e '/{{ADMIN_BLOCK_END}}/d' "${tmp}"
        log "Admin vhost included (admin.${DOMAIN} -> 127.0.0.1:${ADMIN_PORT})."
    else
        sed -i '/{{ADMIN_BLOCK_START}}/,/{{ADMIN_BLOCK_END}}/d' "${tmp}"
        log "Admin vhost omitted; host the admin panel separately."
    fi

    sudo cp "${tmp}" "${target}"
    sudo chmod 644 "${target}"

    # Enable our site; ln -sfn makes this idempotent.
    sudo ln -sfn "${target}" /etc/nginx/sites-enabled/awsb.conf

    # Remove the stock 'Welcome to nginx' site, which otherwise answers as the
    # default server for any unmatched hostname.
    if [[ -e /etc/nginx/sites-enabled/default ]]; then
        sudo rm -f /etc/nginx/sites-enabled/default
        log "Disabled the default nginx site."
    fi

    # ACME challenge webroot must exist before certbot runs.
    sudo mkdir -p /var/www/html/.well-known/acme-challenge

    log "Testing the nginx configuration..."
    if ! sudo nginx -t; then
        die "nginx configuration test FAILED. The config was written to ${target}.
  nginx has NOT been reloaded, so the current site is still running."
    fi

    sudo systemctl enable --now nginx
    sudo systemctl reload nginx
    log "nginx configured and reloaded."
}

install_certbot() {
    step "certbot (Let's Encrypt)"

    # snap is the method Let's Encrypt itself recommends on Ubuntu; the apt
    # package on 22.04 lags and has caused renewal issues.
    if command -v certbot >/dev/null 2>&1; then
        log "certbot already installed."
    else
        log "Installing certbot via snap..."
        sudo snap install core >/dev/null 2>&1 || true
        sudo snap refresh core >/dev/null 2>&1 || true
        sudo snap install --classic certbot
        sudo ln -sfn /snap/bin/certbot /usr/bin/certbot
    fi

    # Deliberately NOT running certbot automatically: it fails and burns Let's
    # Encrypt rate limit attempts if DNS has not propagated yet, and DNS is
    # the one step the owner must do by hand. The summary tells them when.
    log "certbot installed. Certificates are NOT requested yet — DNS must point here first."
}

# ---------------------------------------------------------------------------
# Firewall and fail2ban
# ---------------------------------------------------------------------------

configure_firewall() {
    step "Firewall (UFW)"

    # Order matters: allow SSH BEFORE enabling, or enabling the firewall
    # disconnects this very session and locks you out of the instance.
    sudo ufw allow OpenSSH >/dev/null
    sudo ufw allow 80/tcp  >/dev/null
    sudo ufw allow 443/tcp >/dev/null

    sudo ufw default deny incoming  >/dev/null
    sudo ufw default allow outgoing >/dev/null

    # MySQL (3306) is deliberately NOT opened. The API reaches it over
    # 127.0.0.1, and MySQL is bound to loopback anyway.

    if sudo ufw status | head -1 | grep -q 'inactive'; then
        log "Enabling UFW (SSH is already allowed, so this session survives)..."
        sudo ufw --force enable >/dev/null
    else
        log "UFW already enabled; rules re-applied."
    fi

    sudo ufw status verbose
    log "Firewall configured: SSH, 80 and 443 in; everything else denied."
}

configure_fail2ban() {
    step "fail2ban"

    # A jail.local override, never an edit of jail.conf, which apt replaces.
    local jail="/etc/fail2ban/jail.local"

    if [[ -f "${jail}" ]]; then
        log "${jail} already exists; leaving it untouched."
    else
        sudo tee "${jail}" >/dev/null <<'CONF'
# Written by deploy/install.sh — Attar World Sonar Bangla
# Bans IPs that repeatedly fail SSH authentication.

[DEFAULT]
# Ignore ourselves so a misconfiguration cannot lock out local processes.
ignoreip = 127.0.0.1/8 ::1
bantime  = 1h
findtime = 10m
maxretry = 5
backend  = systemd

[sshd]
enabled  = true
port     = ssh
logpath  = %(sshd_log)s
maxretry = 5
CONF
        log "Wrote ${jail} with an sshd jail."
    fi

    sudo systemctl enable --now fail2ban
    if sudo systemctl is-active --quiet fail2ban; then
        log "fail2ban is running."
    else
        warn "fail2ban did not start. Check: sudo journalctl -u fail2ban -n 50"
    fi
}

# ---------------------------------------------------------------------------
# Process manager
# ---------------------------------------------------------------------------

start_services() {
    step "Starting the API under pm2"

    local ecosystem="${REPO_ROOT}/deploy/ecosystem.config.cjs"
    [[ -f "${ecosystem}" ]] || die "Missing ${ecosystem}"

    # The API entry point must exist or pm2 will crash-loop silently.
    if [[ ! -f "${REPO_ROOT}/backend/src/server.js" ]]; then
        warn "backend/src/server.js does not exist yet, so the API cannot be started."
        warn "Everything else (database, nginx, firewall) is installed and ready."
        warn "Once server.js exists, start it with:"
        warn "    pm2 start ${ecosystem} --only awsb-api && pm2 save"
        return 0
    fi

    cd "${REPO_ROOT}"

    # reload if already running (zero downtime), start otherwise.
    if pm2 describe awsb-api >/dev/null 2>&1; then
        log "awsb-api is already running; reloading with zero downtime..."
        pm2 reload "${ecosystem}" --only awsb-api --update-env
    else
        log "Starting awsb-api..."
        pm2 start "${ecosystem}" --only awsb-api
    fi

    if [[ "${WITH_WEB}" == "yes" ]]; then
        if pm2 describe awsb-web >/dev/null 2>&1; then
            pm2 reload "${ecosystem}" --only awsb-web --update-env
        else
            pm2 start "${ecosystem}" --only awsb-web
        fi
    fi

    if [[ "${WITH_ADMIN}" == "yes" ]]; then
        if pm2 describe awsb-admin >/dev/null 2>&1; then
            pm2 reload "${ecosystem}" --only awsb-admin --update-env
        else
            pm2 start "${ecosystem}" --only awsb-admin
        fi
    fi

    # Survive reboot. `pm2 startup` PRINTS a sudo command rather than running
    # it, so we capture and execute it.
    log "Configuring pm2 to start on boot..."
    local startup_cmd
    startup_cmd="$(pm2 startup systemd -u "${RUN_USER}" --hp "${RUN_HOME}" 2>/dev/null \
                   | grep -E '^sudo ' | tail -1 || true)"
    if [[ -n "${startup_cmd}" ]]; then
        eval "${startup_cmd}"
        log "pm2 systemd service installed."
    else
        log "pm2 startup already configured."
    fi

    pm2 save
    log "Process list saved; the API will come back automatically after a reboot."

    pm2 status
}

install_cron() {
    step "Scheduled jobs"

    local cron_dir="${REPO_ROOT}/deploy/cron"
    local tmp_cron
    tmp_cron="$(mktemp)"
    trap 'rm -f "${tmp_cron}"' RETURN

    # Read the existing crontab, strip any block we previously installed, then
    # append a fresh one. This is what makes re-running non-duplicating.
    crontab -l 2>/dev/null | sed '/# BEGIN AWSB/,/# END AWSB/d' > "${tmp_cron}" || true

    cat >> "${tmp_cron}" <<EOF
# BEGIN AWSB — managed by deploy/install.sh, do not edit between these markers
# Release stock held by abandoned pending_payment orders, every 10 minutes.
*/10 * * * * cd ${REPO_ROOT}/backend && /usr/bin/env node src/scripts/release-stale-reservations.js >> ${LOG_DIR}/sweep.log 2>&1

# Nightly database backup at 02:30 server time.
30 2 * * * ${REPO_ROOT}/deploy/backup.sh >> ${LOG_DIR}/backup.log 2>&1

# Renew TLS certificates (certbot also installs its own timer; this is a belt-
# and-braces retry that reloads nginx on success).
15 3 * * * /usr/bin/certbot renew --quiet --deploy-hook "systemctl reload nginx" >> ${LOG_DIR}/certbot.log 2>&1
# END AWSB
EOF

    crontab "${tmp_cron}"
    log "Installed cron jobs (sweeper every 10 min, backup nightly, cert renewal)."

    if [[ ! -f "${REPO_ROOT}/backend/src/scripts/release-stale-reservations.js" ]]; then
        warn "backend/src/scripts/release-stale-reservations.js does not exist yet."
        warn "The sweeper cron entry is installed but will fail until it does."
        warn "Until then, stock from abandoned checkouts is NOT released."
    fi

    if [[ -d "${cron_dir}" ]]; then
        log "Reference copies of these entries are in deploy/cron/."
    fi
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

print_summary() {
    local ip
    ip="$(curl -fsS --max-time 5 https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]' || true)"
    [[ -n "${ip}" ]] || ip="<your instance's public IP>"

    cat <<EOF

${C_GREEN}${C_BOLD}================================================================${C_RESET}
${C_GREEN}${C_BOLD}  Installation complete.${C_RESET}
${C_GREEN}${C_BOLD}================================================================${C_RESET}

  The server is installed and the firewall is up. The shop is NOT yet
  able to take payments — there are ${C_BOLD}5 steps left${C_RESET}, in this order.

${C_BOLD}------------------------------------------------------------------${C_RESET}
${C_BOLD}STEP 1 — Save your passwords, then delete the file${C_RESET}

  Your generated passwords are in:

      ${C_BOLD}${CRED_FILE}${C_RESET}

  Open it, copy the contents into a password manager, then delete it:

      cat ${CRED_FILE}
      rm ${CRED_FILE}

  These passwords are ALSO already in backend/.env, which the app reads.
  Deleting the file above does not break anything.

${C_BOLD}------------------------------------------------------------------${C_RESET}
${C_BOLD}STEP 2 — Point your domain at this server${C_RESET}

  In your domain registrar's DNS settings, create two A records:

      Type    Name    Value
      ----    ----    -----------------
      A       @       ${ip}
      A       api     ${ip}
EOF

    if [[ "${WITH_WEB}" != "yes" ]]; then
        cat <<EOF

  ${C_YELLOW}NOTE:${C_RESET} the storefront is NOT running on this box. The '@' record
  above should instead point wherever you host it (Vercel/Amplify give
  you the value). Only the 'api' record must point at ${ip}.
EOF
    fi

    cat <<EOF

  DNS can take anywhere from 5 minutes to a few hours. Check it with:

      dig +short api.${DOMAIN}

  Do not continue until that prints ${ip}.

${C_BOLD}------------------------------------------------------------------${C_RESET}
${C_BOLD}STEP 3 — Get the HTTPS certificate${C_RESET}

  ONLY after DNS resolves correctly, run:

EOF
    if [[ "${WITH_WEB}" == "yes" ]]; then
        printf '      sudo certbot --nginx -d %s -d www.%s -d %s \\\n' "${DOMAIN}" "${DOMAIN}" "${API_DOMAIN}"
    else
        printf '      sudo certbot --nginx -d %s \\\n' "${API_DOMAIN}"
    fi
    cat <<EOF
        --agree-tos -m ${ADMIN_EMAIL} --redirect

  certbot edits the nginx config for you and sets up auto-renewal.
  Running it before DNS is ready will fail and count against a rate
  limit, so do not run it early.

${C_BOLD}------------------------------------------------------------------${C_RESET}
${C_BOLD}STEP 4 — Fill in your secrets${C_RESET}

  Edit the environment file:

      nano ${REPO_ROOT}/backend/.env

  Replace every value that says REPLACE_ME:

    ${C_BOLD}RAZORPAY_KEY_ID${C_RESET} and ${C_BOLD}RAZORPAY_KEY_SECRET${C_RESET}
        Razorpay Dashboard -> Settings -> API Keys -> Generate Key.
        The secret is shown ONCE. Copy it immediately.

    ${C_BOLD}RAZORPAY_WEBHOOK_SECRET${C_RESET}
        A DIFFERENT value, which you invent yourself in step 5 below.
        It is not the key secret. Reusing the key secret here makes
        every payment confirmation fail silently.

    ${C_BOLD}SMTP_PASSWORD${C_RESET}
        A Google App Password, 16 characters. NOT your Gmail password.
        Turn on 2-Step Verification first, then generate one at
        https://myaccount.google.com/apppasswords

  Then restart the API so it picks up the changes:

      pm2 restart awsb-api --update-env

${C_BOLD}------------------------------------------------------------------${C_RESET}
${C_BOLD}STEP 5 — Tell Razorpay where to send payment confirmations${C_RESET}

  Razorpay Dashboard -> Settings -> Webhooks -> Add New Webhook:

      Webhook URL     ${C_BOLD}https://${API_DOMAIN}/api/v1/webhooks/razorpay${C_RESET}
      Secret          (invent a long random one; put the SAME value in
                       RAZORPAY_WEBHOOK_SECRET in backend/.env)
      Active events   order.paid, payment.failed, payment.captured,
                      refund.processed

  This is what actually confirms orders. Without it, customers pay and
  their orders stay stuck as unpaid.

${C_BOLD}------------------------------------------------------------------${C_RESET}
${C_BOLD}STEP 6 — Create your admin login${C_RESET}

      cd ${REPO_ROOT}/backend && npm run create-admin

  Follow the prompts. Then sign in at https://${DOMAIN}/admin

${C_BOLD}==================================================================${C_RESET}
${C_BOLD}Everyday commands${C_RESET}

  See if it is running      pm2 status
  Read the API logs         pm2 logs awsb-api
  Restart the API           pm2 restart awsb-api
  Back up the database      ${REPO_ROOT}/deploy/backup.sh
  Deploy new code           ${REPO_ROOT}/deploy/update.sh

  Full instructions and troubleshooting: ${REPO_ROOT}/deploy/README.md

EOF

    if [[ ! -f "${REPO_ROOT}/backend/src/server.js" ]]; then
        cat <<EOF
${C_YELLOW}${C_BOLD}------------------------------------------------------------------${C_RESET}
${C_YELLOW}${C_BOLD}IMPORTANT: the application code is not finished yet.${C_RESET}

  backend/src/server.js does not exist, so there is nothing to run. The
  server itself is fully set up and waiting. Once the code is in place:

      cd ${REPO_ROOT} && git pull && ./deploy/update.sh

${C_YELLOW}${C_BOLD}------------------------------------------------------------------${C_RESET}

EOF
    fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
    parse_args "$@"
    preflight
    prompt_inputs

    # Generated once, up front, so both .env and the credentials file agree.
    # 48 bytes of hex = 96 chars, comfortably over the 32-char minimum that
    # backend/src/config/env.js enforces.
    if [[ -f "${REPO_ROOT}/backend/.env" ]] && grep -q '^JWT_SECRET=.\{32,\}' "${REPO_ROOT}/backend/.env"; then
        JWT_SECRET="$(grep '^JWT_SECRET=' "${REPO_ROOT}/backend/.env" | head -1 | cut -d= -f2-)"
        log "Reusing the existing JWT_SECRET (changing it would log everyone out)."
    else
        JWT_SECRET="$(openssl rand -hex 48)"
    fi

    install_base_packages
    setup_swap
    install_node
    install_pm2
    install_mysql
    secure_mysql
    setup_database
    write_credentials_file
    write_env_file
    install_app_dependencies
    run_migrations
    build_web
    build_admin
    configure_nginx
    install_certbot
    configure_firewall
    configure_fail2ban
    start_services
    install_cron
    print_summary
    # Last thing on screen, so an unreplaced placeholder cannot scroll away.
    preflight_secrets
}

main "$@"
