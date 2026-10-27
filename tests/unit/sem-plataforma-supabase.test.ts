import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Cerca da saída da plataforma Supabase (docs/superpowers/plans/2026-10-19-sair-da-plataforma-supabase.md).
 *
 * O produto roda sobre Postgres + PostgREST + Better Auth. O que esta cerca recusa é a
 * dependência VOLTAR: o cliente de cookie do GoTrue (`@supabase/ssr`), a chamada ao serviço de
 * login (`/auth/v1`) no código que executa e o endereço de um projeto hospedado.
 * `@supabase/supabase-js` fica: é só o cliente do PostgREST.
 */

const CODIGO = ["app", "lib", "components", "hooks", "scripts", "workers", "proxy.ts"];

function arquivosDeCodigo(): string[] {
  const saida = execFileSync("git", ["ls-files", "--", ...CODIGO], { encoding: "utf8" });
  return saida.split("\n").filter((f) => /\.(ts|tsx|mjs)$/.test(f) && !/\.test\.tsx?$/.test(f));
}

/** Linhas de código, sem comentário (`//`, `*` e `/*`): comentário pode contar a história. */
function linhasDeCodigo(arquivo: string): { n: number; texto: string }[] {
  return readFileSync(arquivo, "utf8")
    .split("\n")
    .map((texto, i) => ({ n: i + 1, texto }))
    .filter(({ texto }) => !/^\s*(\/\/|\*|\/\*)/.test(texto));
}

function achar(padrao: RegExp): string[] {
  return arquivosDeCodigo().flatMap((f) =>
    linhasDeCodigo(f)
      .filter(({ texto }) => padrao.test(texto))
      .map(({ n, texto }) => `${f}:${n}: ${texto.trim()}`),
  );
}

describe("sem a plataforma Supabase", () => {
  it("o package.json não depende de @supabase/ssr", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { dependencies?: object; devDependencies?: object };
    expect({ ...pkg.dependencies, ...pkg.devDependencies }).not.toHaveProperty("@supabase/ssr");
  });

  it("nenhum código importa @supabase/ssr", () => {
    expect(achar(/@supabase\/ssr/)).toEqual([]);
  });

  it("nenhum código executa chamada ao serviço de login do GoTrue (/auth/v1)", () => {
    expect(achar(/["'`][^"'`]*\/auth\/v1/)).toEqual([]);
  });

  it("nenhum código aponta para um projeto hospedado (*.supabase.co)", () => {
    // o placeholder do build é conhecido e vigiado por placeholder-do-supabase-recusa-sem-dns.test.ts
    const achados = achar(/[a-z0-9-]+\.supabase\.(co|in)\b/).filter((l) => !/placeholder/.test(l));
    expect(achados).toEqual([]);
  });
});
