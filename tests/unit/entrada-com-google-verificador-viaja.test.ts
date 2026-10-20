/**
 * O VERIFICADOR DE PKCE DA ENTRADA COM GOOGLE PRECISA VIAJAR DE VOLTA.
 *
 * ─── O defeito que este arquivo existe para não deixar voltar ────────────────
 *
 * `signInWithOAuth` (auth-js, com `flowType: "pkce"` que o `@supabase/ssr`
 * força) sorteia um verificador e o GRAVA EM COOKIE, usando as `cookieOptions`
 * do cliente que fez a chamada. O cliente do produto é `sameSite: "strict"`.
 *
 * A volta do Google é navegação vinda de outro site — `accounts.google.com` →
 * GoTrue → `/auth/callback` — e o navegador NÃO manda cookie `Strict` numa
 * dessas. Resultado medido na issue #1388, ao dirigir o `/authorize` na mão e
 * preparar o cookie por fora: `PKCE code verifier not found in storage`, e o
 * fluxo nunca completa.
 *
 * ─── Por que um teste, e não um comentário ──────────────────────────────────
 *
 * Consertar a INSTÂNCIA é trocar o `sameSite` de um cliente. O defeito volta
 * sozinho na próxima vez que alguém "limpar" o cliente de OAuth, ou apontar a
 * action para o `createClient` de sempre — o typecheck passa, a tela renderiza,
 * e o erro só aparece no fim de um consentimento real, que nenhuma suíte local
 * exercita. É a mesma classe que `tests/unit/callback-oauth-alcancavel.test.ts`
 * guarda para os callbacks de integração.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { isPublicPath } from "@/lib/auth/public-paths";
import { CAMINHO_DO_RETORNO_DO_GOOGLE, urlDeRetornoDoGoogle } from "@/lib/auth/entrada-com-google";

const FONTE_DO_BETTER_AUTH = readFileSync("lib/auth/better-auth.ts", "utf8");
const FONTE_DA_ACTION = readFileSync("app/actions/auth/signInWithGoogle.ts", "utf8");
const FONTE_DO_CALLBACK = readFileSync("app/auth/callback/route.ts", "utf8");

describe("o verificador de PKCE da entrada com Google viaja de volta", () => {
  it("o estado do OAuth do Better Auth grava com sameSite Lax — Strict não viaja na volta do Google", () => {
    expect(FONTE_DO_BETTER_AUTH).toMatch(/state:\s*\{\s*attributes:\s*\{\s*sameSite:\s*"lax"/);
    expect(FONTE_DO_BETTER_AUTH).toMatch(/oauth_state:\s*\{\s*attributes:\s*\{\s*sameSite:\s*"lax"/);
    // E a sessão segue Strict: o que fica frouxo é o estado de uso único.
    expect(FONTE_DO_BETTER_AUTH).toMatch(/defaultCookieAttributes:\s*\{\s*sameSite:\s*"strict"/);
  });

  it("a action de ida usa o Better Auth — e a volta lê a sessão que ele gravou", () => {
    expect(FONTE_DA_ACTION).toMatch(/auth\(\)\.api\.signInSocial\(/);
    expect(FONTE_DO_CALLBACK).toMatch(/auth\.getUser\(\)/);
    expect(FONTE_DO_CALLBACK).toMatch(/await createClient\(\)/);
  });

  it("a ida devolve o navegador pela ponte, e a ponte é pública", () => {
    expect(CAMINHO_DO_RETORNO_DO_GOOGLE).toBe("/auth/google-ponte");
    expect(isPublicPath("/auth/callback")).toBe(true);
  });

  it("`/auth/callback` é alcançável sem cookie de sessão", () => {
    // Sem isto o `proxy` responde 307 para `/login` antes de a rota existir, e
    // o fluxo nunca completa — medido em produção com o callback da agenda.
    expect(isPublicPath(CAMINHO_DO_RETORNO_DO_GOOGLE)).toBe(true);
  });

  it("os destinos que EXIGEM sessão saem pela ponte, nunca por 302 — e o cookie segue Strict", () => {
    // ─── O defeito que este caso existe para não deixar voltar (issue #1646) ──
    //
    // A falha fecha em `/login`, tela pública: um 302 para lá funciona. O SUCESSO
    // vai para tela que exige sessão, e ali o 302 é o defeito — ele continua a
    // cadeia de navegação começada em `accounts.google.com`, o cookie de sessão é
    // `sameSite: "strict"` e não viaja num initiator cross-site. O `proxy.ts` manda
    // para `/login?next=%2Fapp` com a sessão já criada: o login não falhou, pareceu.
    //
    // Consertar a INSTÂNCIA é trocar uma das cinco saídas. A sexta nasce com o
    // defeito de novo, e nenhum teste que só olhe o DESTINO a pega — o destino não
    // muda; muda quem inicia a navegação. Por isso a varredura é do CÓDIGO: o que
    // sobra em `redirectTo` só pode ser tela pública.
    const saidasPorRedirect = [
      ...FONTE_DO_CALLBACK.matchAll(/return\s+redirectTo\(([^;]*?)\);/gs),
    ].map((m) => m[1]!);
    expect(
      saidasPorRedirect.length,
      "nenhum `return redirectTo(...)` encontrado — o regex quebrou, e um caso que mede o vazio passa",
    ).toBeGreaterThan(0);
    for (const argumento of saidasPorRedirect) {
      expect(
        argumento,
        `\`redirectTo(${argumento})\` sai da volta do Google por 302. Se o destino EXIGE ` +
          "sessão, o salto continua na cadeia cross-site do provedor e o cookie Strict " +
          "não viaja: use `paraTelaAutenticada(...)`, que entrega a ponte same-origin " +
          "(issue #1646).",
      ).toMatch(/\/(login|team\/accept-invite)/);
    }

    // O sucesso entra pela ponte — e a ponte NÃO pode ter vindo acompanhada de
    // cookie mais permissivo: o que fica frouxo nesta volta é só o verificador de
    // PKCE da IDA (caso acima), nunca o cookie de sessão.
    expect(FONTE_DO_CALLBACK).toMatch(/paraTelaAutenticada\(safeNext\(next, "\/app"\)\)/);
    expect(FONTE_DO_CALLBACK).toMatch(/respostaDePonte\(/);
    expect(
      FONTE_DO_CALLBACK,
      "a volta autenticada não afrouxa cookie nenhum: quem precisa viajar é o initiator, não o cookie",
    ).not.toMatch(/sameSite:\s*"lax"/);
  });
});

describe("o redirectTo da ida", () => {
  const APP = "https://crm.exemplo.com.br";

  it("é absoluto, no domínio da instalação, e aponta para a ponte do callback", () => {
    expect(urlDeRetornoDoGoogle(APP)).toBe(`${APP}/auth/google-ponte`);
  });

  it("leva o `next` pedido — é o único canal que sobrevive ao pulo pelo Google", () => {
    const url = new URL(urlDeRetornoDoGoogle(APP, { next: "/app/inbox" }));
    expect(url.searchParams.get("next")).toBe("/app/inbox");
  });

  it("descarta `next` externo — quem o aplica é `safeNext`, e a URL é nossa", () => {
    const url = new URL(urlDeRetornoDoGoogle(APP, { next: "https://evil.exemplo.com" }));
    expect(url.searchParams.get("next")).toBeNull();
    expect(url.host).toBe("crm.exemplo.com.br");
  });

  it("leva o convite quando há, e nada quando não há", () => {
    expect(
      new URL(urlDeRetornoDoGoogle(APP, { convite: " tok " })).searchParams.get("convite"),
    ).toBe("tok");
    expect(
      new URL(urlDeRetornoDoGoogle(APP, { convite: "   " })).searchParams.get("convite"),
    ).toBeNull();
  });
});
