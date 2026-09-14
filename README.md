# Attar World Sonar Bangla — API

Node + Express REST API (`/api/v1`) backing the storefront and admin panel,
plus the deployment tooling and project documentation for the whole shop.

- Storefront: https://github.com/Souvik-Ghosh-js/AWSB-FE
- Admin panel: https://github.com/Souvik-Ghosh-js/AWSB-admin

## Layout

| Path | What it is |
|---|---|
| `src/` | The API — routes, services, middleware, DB migrations and seeds |
| `tests/` | `node --test` suite |
| `deploy/` | Lightsail installer, updater, backup/restore, nginx and pm2 config |
| `docs/` | Architecture notes and the verified courier tracking reference |

## Requirements

Node **>= 22.2.0** (`razorpay@2.9.5` requires it) and MySQL 8.

## Getting started

```bash
npm ci
cp .env.example .env     # then fill in the blanks
npm run migrate
npm run seed
npm run dev
```

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Run with `--watch` |
| `npm start` | Run for production |
| `npm run migrate` | Apply SQL migrations |
| `npm run seed` | Load seed data |
| `npm run create-admin` | Create an admin user |
| `npm run sweep` | Release stale stock reservations |
| `npm test` | Run the test suite |

## Configuration

Copy `.env.example` to `.env`. Every secret field is intentionally blank.
Two Razorpay secrets are **not** interchangeable: `RAZORPAY_KEY_SECRET`
signs payments, `RAZORPAY_WEBHOOK_SECRET` verifies webhooks. Using one in
place of the other fails every signature check silently.

`.env` is gitignored and must never be committed.

## Deployment

See [`deploy/README.md`](deploy/README.md) for the full walkthrough.

> **Note:** the scripts in `deploy/` were written for a single monorepo
> checkout containing `backend/`, `frontend/` and `admin/` as siblings —
> `update.sh` pulls one repo and builds several apps from it. Now that the
> storefront and admin panel live in their own repositories, that assumption
> no longer holds and the scripts need reworking before the next deploy.
