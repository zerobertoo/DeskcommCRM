#!/bin/sh
# Primeiro boot do volume `db-data`: o que o baseline supõe existir antes dele
# (papéis, schema `auth`, default ACL — scripts/selfhost-prelude.sql) e a senha
# do papel com que o PostgREST conecta. O baseline em si é aplicado pelo kit
# (install.sh/update.sh), que tem o log, a idempotência e a promoção do dono.
#
# A imagem do Postgres roda isto UMA vez, com o volume vazio; o update.sh
# re-aplica o prelude a cada atualização.
set -e

psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -q -f /deskcomm/selfhost-prelude.sql

psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -q -v senha="$POSTGRES_PASSWORD" <<'SQL'
alter role authenticator with password :'senha';
SQL
