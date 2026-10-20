#!/usr/bin/env bash
# O kit gera as credenciais do banco próprio (fork sem a plataforma Supabase):
# POSTGRES_PASSWORD, PGRST_JWT_SECRET e as duas chaves de papel, que são JWTs
# HS256 assinados com o segredo. A assinatura é conferida com o `crypto` do
# Node — independente do `openssl` que a produziu.
set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMMON="$RAIZ/hostgator-setup-kit/_common.sh"
WORK="$(mktemp -d)"
[ -n "${MANTER:-}" ] || trap 'rm -rf "$WORK"' EXIT

FAILS=0
check() { if "${@:2}"; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s\n' "$1"; FAILS=$((FAILS + 1)); fi; }

# roda uma função do kit num bash limpo
kit() { bash -c 'source "$1"; shift; "$@"' _ "$COMMON" "$@"; }
valor() { grep -E "^$2=" "$1" | tail -1 | cut -d= -f2-; }

# confere assinatura e claim `role` com o Node: <jwt> <segredo> <papel>
jwt_valido() {
  node -e '
    const [jwt, segredo, papel] = process.argv.slice(1);
    const [h, c, a] = jwt.split(".");
    const esperada = require("crypto").createHmac("sha256", segredo).update(h + "." + c).digest("base64url");
    const corpo = JSON.parse(Buffer.from(c, "base64url").toString());
    const cabecalho = JSON.parse(Buffer.from(h, "base64url").toString());
    process.exit(a === esperada && corpo.role === papel && cabecalho.alg === "HS256" ? 0 : 1);
  ' "$@"
}

echo "▸ .env sem nada do banco: tudo é gerado"
ENV1="$WORK/env1"
printf 'DOMAIN=crm.exemplo.com\nPOSTGRES_PASSWORD=\n' > "$ENV1"
kit garantir_credenciais_do_banco_proprio "$ENV1" >/dev/null
SEGREDO="$(valor "$ENV1" PGRST_JWT_SECRET)"
check "senha do postgres em hex (cabe na URI de conexão)" grep -qE '^POSTGRES_PASSWORD=[0-9a-f]{48}$' "$ENV1"
check "segredo do PostgREST com 64 hex" grep -qE '^PGRST_JWT_SECRET=[0-9a-f]{64}$' "$ENV1"
check "anon key é JWT anon assinado com o segredo" jwt_valido "$(valor "$ENV1" NEXT_PUBLIC_SUPABASE_ANON_KEY)" "$SEGREDO" anon
check "service key é JWT service_role assinado com o segredo" jwt_valido "$(valor "$ENV1" SUPABASE_SERVICE_ROLE_KEY)" "$SEGREDO" service_role
check "uma linha por chave (sem duplicar)" [ "$(grep -c '^POSTGRES_PASSWORD=' "$ENV1")" = 1 ]

echo "▸ segunda passada não troca nada (update re-executa)"
cp "$ENV1" "$WORK/env1.antes"
kit garantir_credenciais_do_banco_proprio "$ENV1" >/dev/null
check "arquivo idêntico" cmp -s "$ENV1" "$WORK/env1.antes"

echo "▸ segredo já existe e as chaves não: as chaves saem do segredo existente"
ENV2="$WORK/env2"
EXISTENTE="$(printf 'b%.0s' $(seq 1 40))"
printf 'PGRST_JWT_SECRET=%s\nPOSTGRES_PASSWORD=senha123\n' "$EXISTENTE" > "$ENV2"
kit garantir_credenciais_do_banco_proprio "$ENV2" >/dev/null
check "segredo preservado" [ "$(valor "$ENV2" PGRST_JWT_SECRET)" = "$EXISTENTE" ]
check "senha preservada" [ "$(valor "$ENV2" POSTGRES_PASSWORD)" = "senha123" ]
check "anon assinada com o segredo existente" jwt_valido "$(valor "$ENV2" NEXT_PUBLIC_SUPABASE_ANON_KEY)" "$EXISTENTE" anon

echo "▸ chave de papel: recusas"
# recusa = sai com erro E diz o porquê (função ausente também sairia com erro)
recusa() {  # recusa <trecho-da-mensagem> <args de jwt_de_papel...>
  local trecho="$1" saida; shift
  ! saida="$(kit jwt_de_papel "$@" 2>&1)" && grep -q "$trecho" <<<"$saida"
}
check "segredo com menos de 32 caracteres é recusado" recusa "pelo menos 32" curto anon
check "papel fora de anon/service_role é recusado" recusa "anon ou service_role" "$EXISTENTE" authenticated

echo
if [ "$FAILS" -eq 0 ]; then echo "✓ chaves do banco próprio"; else echo "✗ $FAILS falha(s)"; exit 1; fi
