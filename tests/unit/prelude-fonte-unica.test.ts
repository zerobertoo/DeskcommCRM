import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * O prelude do Postgres puro mora num arquivo só: `scripts/selfhost-prelude.sql`.
 *
 * Antes eram dois — o do self-host e um heredoc dentro de `scripts/test-db.sh` —
 * presos por um comentário ("se editar um, edite o outro"), e o do self-host
 * ficou sem o default ACL do Supabase: o gate media um banco e a VPS recebia
 * outro. Agora a VPS sem Supabase sobe com este arquivo, então ele é produção.
 */

const RAIZ = process.cwd();
const ler = (relativo: string) => readFileSync(path.join(RAIZ, relativo), "utf8");

describe("prelude do Postgres puro é fonte única", () => {
  it("test-db.sh aplica o arquivo e não redefine o shim inline", () => {
    const script = ler("scripts/test-db.sh");
    expect(script).toContain("scripts/selfhost-prelude.sql");
    expect(script).not.toMatch(/create or replace function auth\.uid/);
    expect(script).not.toMatch(/create table if not exists auth\.users/);
  });

  it("test-update-com-dados.sh lê o arquivo em vez de recortar o test-db.sh", () => {
    const script = ler("scripts/test-update-com-dados.sh");
    expect(script).toContain("scripts/selfhost-prelude.sql");
    expect(script).not.toMatch(/sed -n "\/\^psql_install/);
  });

  it("o prelude reproduz o default ACL do Supabase para funções e tabelas", () => {
    const prelude = ler("scripts/selfhost-prelude.sql");
    for (const papel of ["anon", "authenticated", "service_role"]) {
      expect(prelude).toContain(
        `alter default privileges for role postgres in schema public grant all on functions to ${papel};`,
      );
      expect(prelude).toContain(
        `alter default privileges for role postgres in schema public grant all on tables to ${papel};`,
      );
    }
    expect(prelude).toContain(
      "alter default privileges for role postgres in schema public revoke execute on functions from public;",
    );
  });

  it("o prelude cria o papel de login do PostgREST e o auth.role()", () => {
    const prelude = ler("scripts/selfhost-prelude.sql");
    expect(prelude).toMatch(/create role authenticator\b[^;]*noinherit/);
    expect(prelude).toContain("grant anon, authenticated, service_role to authenticator;");
    expect(prelude).toMatch(/create or replace function auth\.role\(\) returns text/);
  });

  it("auth.uid() é cópia fiel do Supabase (o nullif protege o cast)", () => {
    const prelude = ler("scripts/selfhost-prelude.sql");
    expect(prelude).toContain(
      "(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')",
    );
  });
});
