/**
 * Quem é o usuário desta requisição — o substituto de `supabase.auth.getUser()`.
 *
 * Sempre revalida no servidor (Better Auth consulta `auth.sessions`); nunca
 * confia só no cookie. `aal` vem da linha da sessão: o fluxo de MFA a promove a
 * `aal2` quando o segundo fator é verificado.
 */

import { headers } from "next/headers";
import { auth, poolDeAuth } from "@/lib/auth/better-auth";
import type { NivelDeAutenticacao } from "@/lib/auth/token-postgrest";

export interface UsuarioAtual {
  id: string;
  email: string;
  aal: NivelDeAutenticacao;
  sessionId: string;
}

export async function obterUsuarioAtual(): Promise<UsuarioAtual | null> {
  const sessao = await auth().api.getSession({ headers: await headers() });
  if (!sessao) return null;
  const { rows } = await poolDeAuth().query<{ aal: string | null }>(
    "select aal from auth.sessions where id = $1",
    [sessao.session.id],
  );
  return {
    id: sessao.user.id,
    email: sessao.user.email,
    aal: rows[0]?.aal === "aal2" ? "aal2" : "aal1",
    sessionId: sessao.session.id,
  };
}
