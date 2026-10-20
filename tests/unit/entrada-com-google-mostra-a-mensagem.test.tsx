/**
 * A MENSAGEM DO CRM PRECISA SER QUEM FALA QUANDO O PROVEDOR ESTÁ DESLIGADO.
 *
 * ─── O par deste arquivo ────────────────────────────────────────────────────
 *
 * `app/actions/auth/signInWithGoogle.test.ts` guarda o lado da action (sem
 * `redirect` quando `external.google: false`). Aqui, o lado da TELA, com a
 * action de verdade no meio: a recusa tinha que virar a frase que já existe
 * embaixo do botão — não um botão mudo, nem um navigate para o JSON cru do
 * GoTrue (issue #1652).
 *
 * Separados de propósito: a action podia devolver `google_indisponivel`
 * certinho e a tela não mostrar nada, e era exatamente isso que faltava ao
 * usuário — a mensagem esperada da issue.
 *
 * A action é a REAL aqui (só os vizinhos dela são mockados) porque o que se
 * exercita é a costura: provedor → action → estado → mensagem na tela.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { redirect } from "next/navigation";
import { EntrarComGoogle } from "@/components/auth/EntrarComGoogle";
import { audit } from "@/lib/audit";
import { estadoDoProvedorGoogle } from "@/lib/auth/provedor-google";

vi.mock("next/headers", () => ({
  // Implementação de verdade, não `vi.fn()` nu: a action lê
  // `(await headers()).get("x-request-id")` e um mock que devolve `undefined`
  // derruba a chamada inteira dentro do transition — a tela nem vê o resultado.
  headers: vi.fn(async () => ({ get: () => null })),
}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/auth/provedor-google", () => ({ estadoDoProvedorGoogle: vi.fn() }));

const signInSocial = vi.fn();
vi.mock("@/lib/auth/better-auth", () => ({ auth: () => ({ api: { signInSocial } }) }));

beforeEach(() => {
  signInSocial.mockReset().mockResolvedValue({
    url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=x",
    redirect: false,
  });
  vi.mocked(redirect).mockClear();
  vi.mocked(audit).mockClear();
  vi.mocked(estadoDoProvedorGoogle).mockResolvedValue("ligado");
});

async function clicar() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /entrar com google/i }));
}

describe("Entrar com Google com o provedor desligado", () => {
  it("⭐ a pessoa fica na tela e vê a mensagem da issue, sem sair para o JSON cru", async () => {
    vi.mocked(estadoDoProvedorGoogle).mockResolvedValue("desligado");

    render(<EntrarComGoogle />);

    await clicar();

    const aviso = await screen.findByText(/O Google não está habilitado nesta instalação/i);
    expect(aviso).toBeInTheDocument();
    // Nada de navegador para fora: nem o /authorize montado, nem o redirect.
    expect(redirect).not.toHaveBeenCalled();
    expect(signInSocial).not.toHaveBeenCalled();
    // E a frase genérica de "não foi possível falar com o Google" não pode
    // roubar o lugar da mensagem que diz ONDE está o conserto.
    expect(screen.queryByText(/Não foi possível falar com o Google agora/i)).toBeNull();
  });

  it("CONTROLE — provedor LIGADO: segue para o Google e nenhuma mensagem aparece", async () => {
    render(<EntrarComGoogle />);

    await clicar();

    await waitFor(() => expect(redirect).toHaveBeenCalledTimes(1));
    expect(signInSocial).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/O Google não está habilitado/i)).toBeNull();
  });
});
