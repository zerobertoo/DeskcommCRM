#!/usr/bin/env bash
# Consulta OCI somente-leitura usada pelo publish-image.yml: confere se uma tag
# publicada oferece a plataforma esperada. Pode ser sourced sem iniciar Docker ou rede.

manifesto_tem_plataforma() { # <ref> <linux/platform>
  local ref="${1:-}" plataforma="${2:-}" bruto plataformas
  case "$plataforma" in
    linux/amd64|linux/arm64) ;;
    *) printf 'Plataforma OCI inválida: %s\n' "$plataforma" >&2; return 1 ;;
  esac
  [ -n "$ref" ] || { printf 'Referência de imagem vazia\n' >&2; return 1; }
  if ! bruto="$(docker buildx imagetools inspect --raw "$ref" 2>/dev/null)"; then
    printf 'Registro inacessível ou acesso negado para %s\n' "$ref" >&2
    return 1
  fi
  # O Buildx já parseia o JSON do registry. A sonda bruta só distingue índice
  # de manifesto simples; não exigimos jq numa VPS limpa. A plataforma vem do
  # Go template do próprio Buildx, nunca de grep sobre os campos do JSON.
  if [ -z "$bruto" ] || ! grep -Eq '"schemaVersion"[[:space:]]*:[[:space:]]*2' <<<"$bruto" \
    || { ! grep -Fq '"manifests"' <<<"$bruto" && ! grep -Fq '"config"' <<<"$bruto"; }; then
    printf 'Manifesto OCI inválido ou vazio para %s\n' "$ref" >&2
    return 1
  fi
  if grep -Fq '"manifests"' <<<"$bruto"; then
    if ! plataformas="$(docker buildx imagetools inspect \
      --format '{{range .Manifest.Manifests}}{{.Platform.OS}}/{{.Platform.Architecture}}{{println}}{{end}}' \
      "$ref" 2>/dev/null)"; then
      printf 'Registro inacessível ao consultar índice OCI de %s\n' "$ref" >&2
      return 1
    fi
  else
    # Um manifesto de imagem simples não declara plataforma; ela está no config.
    # Buildx resolve o config remoto e expõe os campos .Image.os/.architecture.
    if ! plataformas="$(docker buildx imagetools inspect --format '{{.Image.OS}}/{{.Image.Architecture}}' "$ref" 2>/dev/null)"; then
      printf 'Registro inacessível ao consultar config OCI de %s\n' "$ref" >&2
      return 1
    fi
  fi
  grep -Fxq "$plataforma" <<<"$plataformas" && return 0
  printf 'Imagem %s não oferece %s\n' "$ref" "$plataforma" >&2
  return 1
}
