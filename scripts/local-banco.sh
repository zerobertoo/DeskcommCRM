#!/usr/bin/env bash
# Banco local do desenvolvimento e do e2e: Postgres + PostgREST + gateway do
# docker-compose.local.yml (os mesmos serviços da produção), com o baseline aplicado.
# Substitui o antigo `supabase start`.
#
# Uso: scripts/local-banco.sh {start|status|env|apply-baseline|stop}
#   COM_EMAIL=1 start  sobe também o mailpit (caixa de e-mail do e2e: HTTP 54324, SMTP 54325)
#   env     as mesmas chaves do status, como KEY="valor" (o formato do antigo `supabase status -o env`)
#   status  JSON com API_URL, DB_URL, ANON_KEY, SERVICE_ROLE_KEY, JWT_SECRET, POSTGRES_PASSWORD
#
# Segredos de DESENVOLVIMENTO: os defaults do compose local (senha `postgres`, segredo do
# PostgREST fixo), porque o banco só atende 127.0.0.1. Instalação de verdade usa o kit,
# que gera credenciais aleatórias.
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

readonly POSTGRES_PASSWORD_LOCAL="postgres"
readonly JWT_SECRET_LOCAL="segredo-local-de-desenvolvimento-com-32-bytes"
readonly DB_PORT_LOCAL="${DB_PORT:-54322}"
readonly GATEWAY_PORT_LOCAL="${GATEWAY_PORT:-54321}"

# SRH_TOKEN e WAHA_* existem só para o compose interpolar; este script não sobe esses serviços
compose() {
  POSTGRES_PASSWORD="$POSTGRES_PASSWORD_LOCAL" PGRST_JWT_SECRET="$JWT_SECRET_LOCAL" \
    SRH_TOKEN=x WAHA_API_KEY_SHA512=x WAHA_HMAC_SECRET=x \
    docker compose -f docker-compose.local.yml "$@"
}

# chave de papel sem `exp`, como o kit gera (hostgator-setup-kit/_common.sh, jwt_de_papel)
chave_de_papel() {
  node -e '
    const { createHmac } = require("node:crypto");
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const corpo = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ role: process.argv[2], iss: "crm", iat: 1700000000 })}`;
    process.stdout.write(`${corpo}.${createHmac("sha256", process.argv[1]).update(corpo).digest("base64url")}`);
  ' "$JWT_SECRET_LOCAL" "$1"
}

status_json() {
  compose ps --status running --services 2>/dev/null | grep -qx gateway || { printf 'banco local fora do ar\n' >&2; return 1; }
  printf '{"API_URL":"http://127.0.0.1:%s","DB_URL":"postgresql://postgres:%s@127.0.0.1:%s/postgres","ANON_KEY":"%s","SERVICE_ROLE_KEY":"%s","JWT_SECRET":"%s","POSTGRES_PASSWORD":"%s"}\n' \
    "$GATEWAY_PORT_LOCAL" "$POSTGRES_PASSWORD_LOCAL" "$DB_PORT_LOCAL" \
    "$(chave_de_papel anon)" "$(chave_de_papel service_role)" "$JWT_SECRET_LOCAL" "$POSTGRES_PASSWORD_LOCAL"
}

# O prelude (papéis, schema auth, extensões) roda no 1º boot do volume (infra/postgres/initdb);
# aqui entra o baseline, que é o artefato de instalação nova.
apply_baseline() {
  compose exec -T db psql -U postgres -v ON_ERROR_STOP=1 -q < supabase/baseline.sql
}

case "${1:-}" in
  start)
    servicos=(db postgrest gateway)
    [[ "${COM_EMAIL:-}" == "1" ]] && servicos+=(mailpit)
    compose --profile e2e up -d --wait "${servicos[@]}"
    # idempotente: só aplica quando o banco ainda não tem o schema do produto
    if [[ "$(compose exec -T db psql -U postgres -Atc "select to_regclass('public.organizations') is not null")" != "t" ]]; then
      apply_baseline
    fi
    ;;
  status)
    status_json
    ;;
  env)
    status_json | node -e 'let s=""; process.stdin.on("data", c => s += c).on("end", () => {
      for (const [k, v] of Object.entries(JSON.parse(s))) console.log(`${k}="${v}"`);
    })'
    ;;
  apply-baseline)
    apply_baseline
    ;;
  stop)
    compose --profile e2e stop db postgrest gateway mailpit
    ;;
  *)
    printf 'Uso: %s {start|status|env|apply-baseline|stop}\n' "$0"
    exit 2
    ;;
esac
