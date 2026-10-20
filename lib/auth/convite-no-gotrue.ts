/**
 * Leitura de `GET /auth/v1/settings` do GoTrue. O convite deixou de depender dele
 * (a conta do convidado nasce em `supabase.auth.signUp`, sobre o Better Auth);
 * resta só o aviso de troca de modo (`aviso-da-troca-de-modo.ts`). Sai na Task 9.
 */
import { env } from "@/lib/env";
import { urlDoSupabaseNoServidor } from "@/lib/supabase/url-do-servidor";

/** O que o GoTrue conta de si no endpoint público de settings. */
export type ConfigPublicaDoGoTrue = {
  /** `true` = `POST /auth/v1/signup` recusa cadastro novo (inclusive por OAuth). */
  disable_signup: boolean;
};

/**
 * `GET /auth/v1/settings` — anon key, mesmo caminho que o navegador usa.
 *
 * NUNCA LANÇA e devolve `null` quando não deu para perguntar: "não sei" não
 * pode virar "cadastro aberto" (aí sairíamos pelo caminho errado) nem
 * "cadastro fechado" (aí quebraríamos o convite numa instalação que está
 * aberta). Quem chama trata `null` como "segue o de sempre".
 */
export async function lerConfigPublicaDoGoTrue(): Promise<ConfigPublicaDoGoTrue | null> {
  try {
    // Sem a barra final: `https://x/` + `/auth/v1/settings` vira `//auth`, o
    // gateway responde 404, e o `null` mandaria o convite para o caminho que o
    // GoTrue fechado recusa.
    // #1082: pelo mesmo resolvedor dos clients — vazia, vale a pública.
    const base = urlDoSupabaseNoServidor(
      env.SUPABASE_SERVER_URL,
      env.NEXT_PUBLIC_SUPABASE_URL,
    ).replace(/\/+$/, "");
    const resposta = await fetch(`${base}/auth/v1/settings`, {
      headers: { apikey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY },
      cache: "no-store",
    });
    if (!resposta.ok) return null;
    const corpo = (await resposta.json()) as { disable_signup?: unknown };
    return typeof corpo.disable_signup === "boolean" ? { disable_signup: corpo.disable_signup } : null;
  } catch {
    return null;
  }
}
