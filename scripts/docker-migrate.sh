#!/bin/sh
# Run Drizzle migrations inside the family-os image (production / deploy).
# No-op exit 0 when there is nothing pending.
set -eu

if [ -z "${DATABASE_URL:-}" ]; then
  echo "docker-migrate: DATABASE_URL is required" >&2
  exit 1
fi

echo "docker-migrate: applying pending Drizzle migrations (if any)..."
exec ./node_modules/.bin/drizzle-kit migrate --config drizzle.config.ts
