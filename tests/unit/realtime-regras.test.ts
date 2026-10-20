import { describe, expect, it } from "vitest";
import { canalAutorizado, lerFiltro, nomeDeTabelaValido, podeReceberExclusao } from "@/lib/realtime/regras";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const aviso = (org: string | null, id: string | null = "x") => ({ table: "messages", op: "DELETE" as const, id, organization_id: org });

describe("regras do tempo real", () => {
  it("filtro: só coluna=eq.<uuid>", () => {
    expect(lerFiltro(null)).toBeNull();
    expect(lerFiltro(`organization_id=eq.${A}`)).toEqual({ coluna: "organization_id", valor: A });
    for (const ruim of ["x=eq.1", `a=in.(${A})`, `A;drop=eq.${A}`, "organization_id=eq.x or 1=1"]) {
      expect(lerFiltro(ruim)).toBe("invalido");
    }
  });

  it("nome de tabela é identificador simples", () => {
    expect(nomeDeTabelaValido("crm_leads")).toBe(true);
    expect(nomeDeTabelaValido("a;b")).toBe(false);
    expect(nomeDeTabelaValido("public.users")).toBe(false);
  });

  it("DELETE só vai a quem é da organização do aviso (o isolamento entre tenants)", () => {
    const orgsDeA = new Set([A]);
    expect(podeReceberExclusao(aviso(A), orgsDeA, false, null)).toBe(true);
    expect(podeReceberExclusao(aviso(B), orgsDeA, false, null)).toBe(false);
    expect(podeReceberExclusao(aviso(null), orgsDeA, false, null)).toBe(false);
    expect(podeReceberExclusao(aviso(A, null), orgsDeA, false, null)).toBe(false);
    expect(podeReceberExclusao(aviso(B), orgsDeA, true, null)).toBe(true); // admin da plataforma
  });

  it("DELETE respeita o filtro de organização do assinante", () => {
    expect(podeReceberExclusao(aviso(A), new Set([A, B]), false, { coluna: "organization_id", valor: B })).toBe(false);
    expect(podeReceberExclusao(aviso(A), new Set([A, B]), false, { coluna: "organization_id", valor: A })).toBe(true);
  });

  it("canais: alerts-platform é da plataforma; os demais exigem pertencer à organização do nome", () => {
    const orgsDeA = new Set([A]);
    expect(canalAutorizado("alerts-platform", orgsDeA, false)).toBe(false);
    expect(canalAutorizado("alerts-platform", orgsDeA, true)).toBe(true);
    expect(canalAutorizado(`tenant-health-${A}`, orgsDeA, false)).toBe(true);
    expect(canalAutorizado(`org:${B}:queue`, orgsDeA, false)).toBe(false);
    expect(canalAutorizado("sem-uuid", orgsDeA, false)).toBe(false);
    expect(canalAutorizado(`x/../${A}`, orgsDeA, false)).toBe(false);
  });
});
