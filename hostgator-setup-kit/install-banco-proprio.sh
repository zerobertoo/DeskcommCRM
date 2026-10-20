#!/usr/bin/env bash
# Instala o DeskcommCRM com banco próprio — Postgres + PostgREST do compose, login
# pelo Better Auth dentro do app — sem a plataforma Supabase.
#
# Faz o que só o wrapper sabe: gera as credenciais do banco, sobe o `db` e entrega
# a URL e as chaves ao install.sh em modo BANCO_PROPRIO=1 (que não prova nada em
# /auth/v1, porque não existe GoTrue). O resto — prelude, baseline, dono, stack —
# é do install.sh.
#
# Uso: bash hostgator-setup-kit/install-banco-proprio.sh [--domain DOMINIO]
set -Eeuo pipefail

readonly ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly KIT_DIR="$ROOT_DIR/hostgator-setup-kit"
readonly RUNTIME_DIR="$ROOT_DIR/.runtime"
readonly CREDENTIALS_FILE="$RUNTIME_DIR/admin-credentials"

source "$KIT_DIR/_common.sh"

PROJECT_DIR="$ROOT_DIR"

domain="${DOMAIN:-}"
while (($#)); do
  case "$1" in
    --domain) shift; (($#)) || die "--domain exige um dominio."; domain="$1";;
    -h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}"; exit 0;;
    *) echo "argumento desconhecido: $1" >&2; exit 2;;
  esac
  shift
done
if [[ -z "$domain" ]]; then
  read -r -p "Dominio do CRM (ex: crm.suaempresa.com.br): " domain
fi
domain="$(printf '%s' "$domain" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
[[ "$domain" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]] \
  || die "Dominio invalido. Informe somente o host, sem https:// nem caminho."

command -v docker >/dev/null 2>&1 || die "Docker nao esta instalado. Rode primeiro ubuntu-production-installer.sh."
docker info >/dev/null 2>&1 || die "Nao foi possivel acessar o daemon Docker."
command -v openssl >/dev/null 2>&1 || die "openssl nao encontrado."

recusar_projeto_de_outra_arvore || die "Instalação interrompida para não derrubar o CRM que já está no ar nesta VPS."

mkdir -p "$RUNTIME_DIR"
chmod 700 "$RUNTIME_DIR"
app_env="$ROOT_DIR/.env"
[[ -f "$app_env" ]] || { umask 077; : > "$app_env"; chmod 600 "$app_env"; }

step "Gerando as credenciais do banco próprio"
garantir_credenciais_do_banco_proprio "$app_env" >/dev/null
postgres_password="$(grep -E '^POSTGRES_PASSWORD=' "$app_env" | tail -1 | cut -d= -f2-)"

# Dono do primeiro acesso: gerado uma vez e guardado com permissão 600.
if [[ -f "$CREDENTIALS_FILE" ]]; then
  owner_email="$(grep -E '^OWNER_EMAIL=' "$CREDENTIALS_FILE" | cut -d= -f2-)"
  owner_password="$(grep -E '^OWNER_PASSWORD=' "$CREDENTIALS_FILE" | cut -d= -f2-)"
else
  owner_email="admin@${domain}"
  owner_password="$(openssl rand -hex 16)"
  (umask 077 && printf 'OWNER_EMAIL=%s\nOWNER_PASSWORD=%s\n' "$owner_email" "$owner_password" > "$CREDENTIALS_FILE")
fi

set_env_var "$app_env" DOMAIN "$domain"
set_env_var "$app_env" ACME_EMAIL "admin@${domain}"
set_env_var "$app_env" BANCO_PROPRIO 1
set_env_var "$app_env" NEXT_PUBLIC_SUPABASE_URL "https://${domain}"
set_env_var "$app_env" SUPABASE_SERVER_URL "http://gateway:8000"
set_env_var "$app_env" SUPABASE_DB_URL "postgresql://postgres:${postgres_password}@db:5432/postgres"
set_env_var "$app_env" AUTH_DB_URL "postgresql://postgres:${postgres_password}@db:5432/postgres"
set_env_var "$app_env" OWNER_EMAIL "$owner_email"
set_env_var "$app_env" OWNER_PASSWORD "$owner_password"
set_env_var "$app_env" APP_NAME DeskcommCRM
set_env_var "$app_env" APP_LOCALE pt-BR
set_env_var "$app_env" SENTRY_DSN off

step "Subindo o banco"
(cd "$ROOT_DIR" && docker compose -f docker-compose.prod.yml --env-file "$app_env" up -d --wait db)
set_env_var "$app_env" PSQL_DOCKER_NETWORK "$(nome_do_projeto_atual)_internal"

step "Configurando o CRM sem perguntas adicionais"
cd "$ROOT_DIR"
BANCO_PROPRIO=1 bash "$KIT_DIR/install.sh" --yes

cat <<EOF

Credenciais iniciais (arquivo protegido com permissao 600: ${CREDENTIALS_FILE}):
  usuario: ${owner_email}
Abra https://${domain}/app para entrar.
EOF
