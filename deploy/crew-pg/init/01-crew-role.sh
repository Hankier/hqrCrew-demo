#!/bin/sh
# The role crew's agents use: may create and drop its own databases, nothing else.
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<SQL
CREATE ROLE crew LOGIN CREATEDB PASSWORD '${CREW_DB_PASSWORD}';
SQL
