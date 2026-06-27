#!/usr/bin/env sh
set -eu

container_name="${POSTGRES_CONTAINER_NAME:-family-os-postgres}"
database="${POSTGRES_DB:-family_os}"
user="${POSTGRES_USER:-family_os}"

docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U "$user" -d "$database" < db/local/0000_auth_stub.sql
docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U "$user" -d "$database" <<'SQL'
create table if not exists local_schema_migrations (
  filename text primary key,
  applied_at timestamptz not null default now()
);
SQL

for migration in db/migrations/*.sql; do
  filename="$(basename "$migration")"
  applied="$(
    docker exec -i "$container_name" psql -At -v ON_ERROR_STOP=1 -U "$user" -d "$database" \
      -c "select 1 from local_schema_migrations where filename = '$filename';"
  )"

  if [ "$applied" = "1" ]; then
    echo "Skipping already applied migration $filename"
    continue
  fi

  docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U "$user" -d "$database" < "$migration"
  docker exec -i "$container_name" psql -v ON_ERROR_STOP=1 -U "$user" -d "$database" \
    -c "insert into local_schema_migrations (filename) values ('$filename');"
done
