#!/usr/bin/env bash
# Run database migrations against DATABASE_URL (Render) or local PG env vars
set -e

if [ -n "$DATABASE_URL" ]; then
  echo "[migrate] Running schema against DATABASE_URL..."
  psql "$DATABASE_URL" -f "$(dirname "$0")/../packages/backend/src/db/schema.sql"
else
  echo "[migrate] Running schema against local PG..."
  PGPASSWORD="${PG_PASSWORD:-gleameet_dev}" psql \
    -h "${PG_HOST:-localhost}" \
    -p "${PG_PORT:-5432}" \
    -U "${PG_USER:-gleameet}" \
    -d "${PG_DATABASE:-gleameet}" \
    -f "$(dirname "$0")/../packages/backend/src/db/schema.sql"
fi

echo "[migrate] Done."
