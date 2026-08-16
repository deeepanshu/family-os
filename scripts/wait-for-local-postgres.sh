#!/usr/bin/env sh
set -eu

# Wait until Postgres accepts TCP on 127.0.0.1:5432 inside the container.
# docker exec pg_isready without -h only checks the unix socket, which can
# succeed before the migrate script's `psql -h 127.0.0.1` can connect.

container_name="${POSTGRES_CONTAINER_NAME:-family-os-postgres}"
database="${POSTGRES_DB:-family_os}"
user="${POSTGRES_USER:-family_os}"
attempts="${POSTGRES_READY_ATTEMPTS:-30}"

i=1
while [ "$i" -le "$attempts" ]; do
  if docker exec "$container_name" pg_isready -h 127.0.0.1 -U "$user" -d "$database" >/dev/null 2>&1; then
    exit 0
  fi
  i=$((i + 1))
  sleep 1
done

echo "Postgres did not accept TCP connections in time" >&2
exit 1
