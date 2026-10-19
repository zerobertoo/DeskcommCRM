import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { isPublicPath } from "@/lib/auth/public-paths";

/**
 * O banco e a API REST sobem no próprio compose, sem a plataforma Supabase.
 *
 * `db` (Postgres + pgvector) → `postgrest` (a API que o `@supabase/supabase-js`
 * já fala) → `gateway` (tira o prefixo `/rest/v1` que o SDK põe em toda
 * requisição). O gateway ocupa o lugar do Kong na topologia que
 * `SUPABASE_SERVER_URL` já previa: servidor e worker apontam para ele e nenhum
 * cliente muda. O navegador chega pelo app, via rewrite do `next.config.ts`.
 */

const RAIZ = process.cwd();
const ler = (relativo: string) => readFileSync(path.join(RAIZ, relativo), "utf8");

// bloco de um serviço: da linha `  nome:` até o próximo item do mesmo nível
function blocoDoServico(compose: string, nome: string): string {
  const linhas = compose.split("\n");
  const inicio = linhas.findIndex((l) => l === `  ${nome}:`);
  if (inicio < 0) return "";
  const fim = linhas.findIndex((l, i) => i > inicio && /^ {0,2}\S/.test(l));
  return linhas.slice(inicio, fim < 0 ? undefined : fim).join("\n");
}

describe.each(["docker-compose.prod.yml", "docker-compose.local.yml"])("%s", (arquivo) => {
  const compose = ler(arquivo);

  it("sobe o Postgres com pgvector na major do piso", () => {
    expect(blocoDoServico(compose, "db")).toMatch(/image: pgvector\/pgvector:pg15\b/);
  });

  it("sobe o PostgREST com tag fixa e conectando como authenticator", () => {
    const bloco = blocoDoServico(compose, "postgrest");
    expect(bloco).toMatch(/image: postgrest\/postgrest:v\d+\.\d+\.\d+\b/);
    expect(bloco).toContain("authenticator:");
    expect(bloco).toContain("PGRST_JWT_SECRET");
    expect(bloco).toContain("PGRST_DB_ANON_ROLE: anon");
  });

  it("sobe o gateway com o Caddyfile do repositório", () => {
    const bloco = blocoDoServico(compose, "gateway");
    expect(bloco).toMatch(/image: caddy:/);
    expect(bloco).toContain("infra/gateway/Caddyfile");
  });
});

describe("gateway e app", () => {
  it("o Caddyfile tira /rest/v1 e entrega ao postgrest", () => {
    const caddyfile = ler("infra/gateway/Caddyfile");
    expect(caddyfile).toMatch(/handle_path \/rest\/v1\/\*\s*\{[^}]*reverse_proxy postgrest:3000/);
  });

  it("o navegador chega ao PostgREST pelo app (rewrite no next.config)", () => {
    const config = ler("next.config.ts");
    expect(config).toContain('source: "/rest/v1/:path*"');
  });

  it("o proxy não decide /rest/v1: quem autentica é o JWT no PostgREST", () => {
    expect(isPublicPath("/rest/v1/contacts")).toBe(true);
    expect(isPublicPath("/rest/v1/rpc/fn_x")).toBe(true);
    expect(isPublicPath("/rest/v1x/contacts")).toBe(false);
  });
});
