#!/usr/bin/env bash
#
# Compose DATABASE_URL from the secret ECS injected, then exec the command.
#
# RDS manages the master password, which keeps it out of `terraform.tfstate` — no password is ever
# written to whatever laptop last ran a plan. The consequence is that the value exists only in
# Secrets Manager as a JSON document, and ECS can inject that document but cannot assemble a
# connection string from it. Something has to, once, at start.
#
# Here rather than in application code because both the API and the worker need it and neither
# should have to know where its credentials came from. `exec` so the real process keeps PID 1 and
# receives ECS's SIGTERM directly — a shell in between swallows it, and the worker's graceful
# shutdown never runs.
set -euo pipefail

if [ -n "${DATABASE_SECRET:-}" ] && [ -z "${DATABASE_URL:-}" ]; then
  : "${DATABASE_HOST:?DATABASE_SECRET is set but DATABASE_HOST is not}"
  : "${DATABASE_NAME:=main}"

  # Percent-encoded, because an RDS-generated password may contain characters that are delimiters
  # in a URL. An unencoded `/` or `@` produces a string that parses into a different host entirely,
  # and the error names the wrong thing.
  export DATABASE_URL="$(
    DATABASE_SECRET="$DATABASE_SECRET" \
    DATABASE_HOST="$DATABASE_HOST" \
    DATABASE_NAME="$DATABASE_NAME" \
    node -e '
      const s = JSON.parse(process.env.DATABASE_SECRET)
      const user = encodeURIComponent(s.username)
      const pass = encodeURIComponent(s.password)
      const host = process.env.DATABASE_HOST
      const name = process.env.DATABASE_NAME
      process.stdout.write(`postgresql://${user}:${pass}@${host}/${name}?sslmode=require`)
    '
  )"

  # Cleared so it is not inherited by anything the application spawns. The URL it became is enough.
  unset DATABASE_SECRET
fi

exec "$@"
