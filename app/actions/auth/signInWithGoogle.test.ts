/**
 * COM O PROVEDOR DESLIGADO, ENTRAR COM GOOGLE NÃO PODE SAIR DO CRM (issue #1652).
 *
 * 1. Sem `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` → NÃO chama o Better Auth nem
 *    `redirect`: devolve `google_indisponivel`, que a tela transforma na mensagem.
 * 2. Com os dois → pede a URL ao Better Auth (`signInSocial`, `disableRedirect`) e
 *    redireciona para ela. É o controle: sem ele, "nunca redireciona" ficaria verde.
 * 3. O Better Auth falhar → `erro_inesperado`, com auditoria.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { estadoDoProvedorGoogle } from "@/lib/auth/provedor-google";

vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/auth/provedor-google", () => ({ estadoDoProvedorGoogle: vi.fn() }));

const signInSocial = vi.fn();
vi.mock("@/lib/auth/better-auth", () => ({ auth: () => ({ api: { signInSocial } }) }));

const URL_GOOGLE = "https://accounts.google.com/o/oauth2/v2/auth?client_id=x";

beforeEach(() => {
  signInSocial.mockReset().mockResolvedValue({ url: URL_GOOGLE, redirect: false });
  vi.mocked(redirect).mockClear();
  vi.mocked(audit).mockClear();
  vi.mocked(headers).mockResolvedValue({ get: () => null } as never);
  vi.mocked(estadoDoProvedorGoogle).mockResolvedValue("ligado");
});

describe("signInWithGoogle", () => {
  it("⭐ provedor desligado: não redireciona e não audita (ação pública, sem limite)", async () => {
    vi.mocked(estadoDoProvedorGoogle).mockResolvedValue("desligado");

    const { signInWithGoogle } = await import("./signInWithGoogle");
    const res = await signInWithGoogle();

    expect(res).toEqual({ ok: false, error: "google_indisponivel" });
    expect(signInSocial).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("CONTROLE — provedor ligado: pede a URL ao Better Auth e redireciona para ela", async () => {
    const { signInWithGoogle } = await import("./signInWithGoogle");
    const res = await signInWithGoogle({ next: "/app/inbox" });

    // `redirect` (mockado) não lança, então a action devolve `undefined`.
    expect(res).toBeUndefined();
    expect(signInSocial).toHaveBeenCalledTimes(1);
    const { body } = signInSocial.mock.calls[0]![0] as { body: Record<string, unknown> };
    expect(body).toMatchObject({ provider: "google", disableRedirect: true });
    expect(String(body.callbackURL)).toContain("/auth/google-ponte");
    expect(String(body.callbackURL)).toContain("next=%2Fapp%2Finbox");
    expect(redirect).toHaveBeenCalledWith(URL_GOOGLE);
  });

  it("Better Auth falha: erro_inesperado, auditado, sem redirect", async () => {
    signInSocial.mockRejectedValue(new Error("boom"));

    const { signInWithGoogle } = await import("./signInWithGoogle");
    const res = await signInWithGoogle();

    expect(res).toEqual({ ok: false, error: "erro_inesperado" });
    expect(redirect).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "auth.google_signin_failed" }));
  });
});
