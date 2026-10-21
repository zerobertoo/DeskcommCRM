#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE="${LOCAL_ENV_FILE:-.env.local}"
COMPOSE=(docker compose -f docker-compose.local.yml --env-file "$ENV_FILE")

usage() {
  printf 'Uso: %s {up|down|restart|status|logs|banco-status|reset}\n' "$0"
}

require_env() {
  if [[ ! -s "$ENV_FILE" ]]; then
    printf 'Erro: %s não existe. Execute ./ubuntu-local-installer.sh primeiro.\n' "$ENV_FILE" >&2
    exit 1
  fi
}

ensure_banco() {
  # idempotente: sobe o que faltar e só aplica o baseline em banco vazio
  ./scripts/local-banco.sh start
}

ensure_encryption_key() {
  local key
  key="$(awk -F= '$1 == "NUVEMSHOP_OAUTH_ENCRYPTION_KEY" { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE")"
  if [[ -z "$key" ]]; then
    key="$(openssl rand -hex 32)"
    printf '\nNUVEMSHOP_OAUTH_ENCRYPTION_KEY=%s\n' "$key" >> "$ENV_FILE"
  fi
  "${COMPOSE[@]}" exec -T db psql -U postgres -v ON_ERROR_STOP=1 -c \
    "insert into private.app_secrets (name, value) values ('nuvemshop_oauth_key', '$key') on conflict (name) do update set value = excluded.value, updated_at = now();" \
    >/dev/null
}

case "${1:-}" in
  up)
    ensure_banco
    ./scripts/local-env.sh ensure
    require_env
    ensure_encryption_key
    "${COMPOSE[@]}" up -d --build
    ;;
  down)
    "${COMPOSE[@]}" down
    ./scripts/local-banco.sh stop || true
    ;;
  restart)
    require_env
    "${COMPOSE[@]}" restart
    ;;
  status)
    require_env
    ./scripts/local-banco.sh status
    "${COMPOSE[@]}" ps
    ;;
  logs)
    require_env
    "${COMPOSE[@]}" logs -f --tail=200 "${2:-app}"
    ;;
  banco-status)
    ./scripts/local-banco.sh status
    ;;
  reset)
    require_env
    "${COMPOSE[@]}" down
    ./scripts/local-banco.sh stop
    ./scripts/local-banco.sh start
    "${COMPOSE[@]}" up -d
    ;;
  *)
    usage
    exit 2
    ;;
esac
