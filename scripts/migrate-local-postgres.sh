#!/usr/bin/env sh
set -eu

container_name="${POSTGRES_CONTAINER_NAME:-family-os-postgres}"
database="${POSTGRES_DB:-family_os}"
user="${POSTGRES_USER:-family_os}"
database_url="${DATABASE_URL:-postgres://family_os:family_os@localhost:5432/family_os}"

docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U "$user" -d "$database" < db/local/0000_auth_stub.sql
DATABASE_URL="$database_url" npx drizzle-kit migrate --config drizzle.config.ts
