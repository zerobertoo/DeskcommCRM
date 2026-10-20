/**
 * `supabase.auth.*` do usuário da requisição, sobre o Better Auth.
 *
 * Cada método devolve o mesmo `{ data, error }` do SDK, para que os arquivos que
 * o chamam não mudem. O que ainda não foi convertido (OAuth, e-mail de
 * verificação/recuperação) recusa com 501 e nome: falha alta, nunca silêncio.
 */

import { APIError } from "better-auth/api";
import { auth, poolDeAuth } from "@/lib/auth/better-auth";
import { gravarSenha } from "@/lib/auth/compat/admin";
import { buscarUsuarioPorId, erroCompat } from "@/lib/auth/compat/usuario";
import { criarMfaCompat } from "@/lib/auth/compat/mfa";
import { emitirTokenDoUsuario, type NivelDeAutenticacao } from "@/lib/auth/token-postgrest";

export type ObterHeaders = () => Promise<Headers> | Headers;

const SEM_SESSAO = () => erroCompat("Auth session missing!", 400, "session_missing");
const naoConvertido = (nome: string) => async () => ({
  data: null,
  error: erroCompat(`supabase.auth.${nome} ainda não foi convertido para o Better Auth`, 501, "not_implemented"),
});

export interface SessaoResolvida {
  userId: string;
  sessionId: string;
  aal: NivelDeAutenticacao;
}

/** A sessão desta requisição, revalidada no banco; null se ausente ou vencida. */
export async function resolverSessao(obterHeaders: ObterHeaders): Promise<SessaoResolvida | null> {
  const sessao = await auth().api.getSession({ headers: await obterHeaders() });
  if (!sessao) return null;
  const { rows } = await poolDeAuth().query<{ aal: string | null }>(
    "select aal from auth.sessions where id = $1",
    [sessao.session.id],
  );
  return {
    userId: sessao.user.id,
    sessionId: sessao.session.id,
    aal: rows[0]?.aal === "aal2" ? "aal2" : "aal1",
  };
}

async function tokenDe(s: SessaoResolvida | null): Promise<string | null> {
  if (!s) return null;
  return (await emitirTokenDoUsuario({ userId: s.userId, sessionId: s.sessionId, aal: s.aal })).token;
}

function mensagemDe(e: unknown): { message: string; status: number } {
  if (e instanceof APIError) return { message: e.body?.message ?? e.message, status: Number(e.statusCode) || 400 };
  return { message: e instanceof Error ? e.message : "erro", status: 500 };
}

/**
 * O `auth` do client + o token que o mesmo client manda ao PostgREST.
 *
 * Quem entra numa Server Action não vê o cookie novo no `headers()` da própria
 * requisição; o GoTrue resolvia isso guardando a sessão no client. Aqui, depois
 * de `signInWithPassword`, a sessão fica na closure (`emMemoria`) e vale para o
 * restante deste client — `mfa.listFactors()` logo após o login depende disso.
 */
export function criarAuthDoUsuario(obterHeaders: ObterHeaders) {
  let emMemoria: SessaoResolvida | null | undefined;
  const sessaoAtual = async (): Promise<SessaoResolvida | null> => {
    if (emMemoria === undefined) return resolverSessao(obterHeaders);
    if (emMemoria === null) return null;
    // o `aal` muda depois (mfa.verify), e a sessão pode ter sido revogada
    const { rows } = await poolDeAuth().query<{ aal: string | null }>("select aal from auth.sessions where id = $1", [emMemoria.sessionId]);
    return rows[0] ? { ...emMemoria, aal: rows[0].aal === "aal2" ? "aal2" : "aal1" } : null;
  };
  const auth_ = montarAuth(obterHeaders, sessaoAtual, (s) => { emMemoria = s; });
  return { auth: auth_, token: async () => tokenDe(await sessaoAtual()) };
}

function montarAuth(
  obterHeaders: ObterHeaders,
  sessaoAtual: () => Promise<SessaoResolvida | null>,
  definirSessao: (s: SessaoResolvida | null) => void,
) {
  return {
    async getUser() {
      const s = await sessaoAtual();
      const user = s ? await buscarUsuarioPorId(s.userId) : null;
      return user ? { data: { user }, error: null } : { data: { user: null }, error: SEM_SESSAO() };
    },

    async getClaims() {
      const s = await sessaoAtual();
      if (!s) return { data: null, error: SEM_SESSAO() };
      return {
        data: { claims: { sub: s.userId, session_id: s.sessionId, aal: s.aal, role: "authenticated" } },
        error: null,
      };
    },

    async getSession() {
      const s = await sessaoAtual();
      const user = s ? await buscarUsuarioPorId(s.userId) : null;
      if (!s || !user) return { data: { session: null }, error: null };
      const { token, expiraEm } = await emitirTokenDoUsuario({ userId: s.userId, sessionId: s.sessionId, aal: s.aal });
      return { data: { session: { access_token: token, expires_at: expiraEm, user } }, error: null };
    },

    async signInWithPassword({ email, password }: { email: string; password: string }) {
      try {
        const r = await auth().api.signInEmail({ body: { email, password }, headers: await obterHeaders() });
        await poolDeAuth().query("update auth.users set last_sign_in_at = now() where id = $1", [r.user.id]);
        const { rows } = await poolDeAuth().query<{ id: string }>("select id from auth.sessions where token = $1", [r.token]);
        if (rows[0]) definirSessao({ userId: r.user.id, sessionId: rows[0].id, aal: "aal1" });
        const user = await buscarUsuarioPorId(r.user.id);
        return { data: { user, session: { access_token: r.token, user } }, error: null };
      } catch (e) {
        const { message, status } = mensagemDe(e);
        return { data: { user: null, session: null }, error: erroCompat(message, status, "invalid_credentials") };
      }
    },

    async signOut(opcoes?: { scope?: "global" | "local" | "others" }) {
      const s = await sessaoAtual();
      definirSessao(null);
      if (s && opcoes?.scope === "global") {
        await poolDeAuth().query("delete from auth.sessions where user_id = $1", [s.userId]);
      }
      try {
        await auth().api.signOut({ headers: await obterHeaders() });
      } catch {
        // sessão já apagada acima, ou cookie sem sessão: o objetivo (sair) está cumprido
      }
      return { error: null };
    },

    async updateUser(attrs: { password?: string; data?: Record<string, unknown>; email?: string }) {
      const s = await sessaoAtual();
      if (!s) return { data: { user: null }, error: SEM_SESSAO() };
      if (attrs.password) await gravarSenha(s.userId, attrs.password);
      if (attrs.data || attrs.email) {
        await poolDeAuth().query(
          `update auth.users set raw_user_meta_data = raw_user_meta_data || $2::jsonb,
             email = coalesce($3, email), updated_at = now() where id = $1`,
          [s.userId, JSON.stringify(attrs.data ?? {}), attrs.email?.trim().toLowerCase() ?? null],
        );
      }
      return { data: { user: await buscarUsuarioPorId(s.userId) }, error: null };
    },

    async refreshSession() {
      const s = await sessaoAtual();
      const user = s ? await buscarUsuarioPorId(s.userId) : null;
      if (!s || !user) return { data: { session: null, user: null }, error: SEM_SESSAO() };
      const { token, expiraEm } = await emitirTokenDoUsuario({ userId: s.userId, sessionId: s.sessionId, aal: s.aal });
      return { data: { session: { access_token: token, expires_at: expiraEm, user }, user }, error: null };
    },

    mfa: criarMfaCompat(sessaoAtual),

    signUp: naoConvertido("signUp"),
    verifyOtp: naoConvertido("verifyOtp"),
    resend: naoConvertido("resend"),
    resetPasswordForEmail: naoConvertido("resetPasswordForEmail"),
    signInWithOAuth: naoConvertido("signInWithOAuth"),
    exchangeCodeForSession: naoConvertido("exchangeCodeForSession"),
  };
}
