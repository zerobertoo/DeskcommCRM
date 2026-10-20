/** Leitura pública das settings do GoTrue (resta só para o aviso de troca de modo; sai na Task 9). */
import { afterEach, describe, expect, it, vi } from "vitest";

const convite = async () => await import("./convite-no-gotrue");

function responderSettings(corpo: unknown, ok = true) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok, json: async () => corpo }) as Response));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("lerConfigPublicaDoGoTrue", () => {
  it("URL do Supabase com barra final não vira `//auth` (404 no gateway)", async () => {
    vi.resetModules();
    vi.doMock("@/lib/env", () => ({
      env: { NEXT_PUBLIC_SUPABASE_URL: "https://sb.exemplo.test/", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon" },
    }));
    try {
      responderSettings({ disable_signup: true });
      const { lerConfigPublicaDoGoTrue } = await convite();
      await lerConfigPublicaDoGoTrue();
      expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe("https://sb.exemplo.test/auth/v1/settings");
    } finally {
      vi.doUnmock("@/lib/env");
      vi.resetModules();
    }
  });

  it("lê `disable_signup` do endpoint público", async () => {
    responderSettings({ disable_signup: true, mailer_autoconfirm: false });
    await expect((await convite()).lerConfigPublicaDoGoTrue()).resolves.toEqual({ disable_signup: true });
  });

  it("cadastro aberto é `false`, não ausência de resposta", async () => {
    responderSettings({ disable_signup: false });
    await expect((await convite()).lerConfigPublicaDoGoTrue()).resolves.toEqual({ disable_signup: false });
  });

  it("rede fora → `null` (nunca lança: isto roda no meio do cadastro)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    await expect((await convite()).lerConfigPublicaDoGoTrue()).resolves.toBeNull();
  });

  it("resposta sem o campo → `null`: não sei não vira 'aberto'", async () => {
    responderSettings({ external: {} });
    await expect((await convite()).lerConfigPublicaDoGoTrue()).resolves.toBeNull();
  });

  it("HTTP 500 do GoTrue → `null`", async () => {
    responderSettings({ disable_signup: true }, false);
    await expect((await convite()).lerConfigPublicaDoGoTrue()).resolves.toBeNull();
  });
});

