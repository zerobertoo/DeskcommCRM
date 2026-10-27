/**
 * `supabase.auth.*` do usuário da requisição, sobre o Better Auth.
 *
 * Cada método devolve o mesmo `{ data, error }` do SDK, para que os arquivos que
 * o chamam não mudem. O que ainda não foi convertido (OAuth, e-mail de
 * verificação/recuperação) recusa com 501 e nome: falha alta, nunca silêncio.
 */

import { randomUUID } from "node:crypto";
import { APIError } from "better-auth/api";
import { env } from "@/lib/env";
import { emailConfigurado } from "@/lib/email/roteador";
import { criarAuthAdmin, gravarSenha } from "@/lib/auth/compat/admin";
import { enviarLink } from "@/lib/auth/compat/enviar-link";
import { consumirLink, descartarLinksPendentes, emitirLink } from "@/lib/auth/compat/verificacao";
import { auth, poolDeAuth } from "@/lib/auth/better-auth";
import { ehHashBcrypt } from "@/lib/auth/senha-legada";
import { buscarUsuarioPorId, erroCompat } from "@/lib/auth/compat/usuario";
import { criarMfaCompat } from "@/lib/auth/compat/mfa";
import { emitirTokenDoUsuario, type NivelDeAutenticacao } from "@/lib/auth/token-postgrest";

export type ObterHeaders = () => Promise<Headers> | Headers;

const SEM_SESSAO = () => erroCompat("Auth session missing!", 400, "session_missing");

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
        // entrou com bcrypt do GoTrue: regrava no formato nativo
        const { rows: conta } = await poolDeAuth().query<{ password: string | null }>(
          "select password from auth.accounts where user_id = $1 and provider_id = 'credential'",
          [r.user.id],
        );
        if (conta[0]?.password && ehHashBcrypt(conta[0].password)) await gravarSenha(r.user.id, password);
        const { rows } = await poolDeAuth().query<{ id: string }>("select id from auth.sessions where token = $1", [r.token]);
        if (rows[0]) definirSessao({ userId: r.user.id, sessionId: rows[0].id, aal: "aal1" });
        const user = await buscarUsuarioPorId(r.user.id);
        // JWT com `session_id`, como o GoTrue devolvia: o dispositivo confiável amarra a sessão por ele
        const accessToken = rows[0]
          ? (await emitirTokenDoUsuario({ userId: r.user.id, sessionId: rows[0].id, aal: "aal1" })).token
          : r.token;
        return { data: { user, session: { access_token: accessToken, user } }, error: null };
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

    /**
     * Cria a conta e manda o link de confirmação. Com `AUTH_EMAIL_AUTOCONFIRM=true`
     * a conta nasce verificada e a sessão abre no ato (`data.session` preenchido
     * é o sinal que a tela lê). E-mail já cadastrado devolve sucesso ofuscado
     * (anti-enumeração) — salvo com convite, que já prova que o e-mail é conhecido.
     */
    async signUp({ email, password, options }: { email: string; password: string; options?: { emailRedirectTo?: string; data?: Record<string, unknown> } }) {
      const endereco = email.trim().toLowerCase();
      const meta = options?.data ?? {};
      const existente = await poolDeAuth().query<{ id: string; email_verified: boolean }>(
        "select id, email_verified from auth.users where email = $1",
        [endereco],
      );
      if (existente.rows[0]) {
        if (meta.invite_token) {
          return { data: { user: null, session: null }, error: erroCompat("User already registered", 422, "user_already_exists") };
        }
        const { id, email_verified } = existente.rows[0];
        if (!email_verified && options?.emailRedirectTo) {
          await descartarLinksPendentes("signup", id);
          await enviarLink({ tipo: "signup", para: endereco, token: await emitirLink("signup", id, endereco), redirectTo: options.emailRedirectTo });
        }
        return { data: { user: { ...(await buscarUsuarioPorId(id))!, id: randomUUID() }, session: null }, error: null };
      }

      const autoconfirma = env.AUTH_EMAIL_AUTOCONFIRM === "true";
      if (!autoconfirma && !(await emailConfigurado())) {
        return { data: { user: null, session: null }, error: erroCompat("Error sending confirmation email", 500, "unexpected_failure") };
      }

      const criada = await criarAuthAdmin().createUser({ email: endereco, password, email_confirm: autoconfirma, user_metadata: meta });
      if (criada.error || !criada.data.user) return { data: { user: null, session: null }, error: criada.error };
      const user = criada.data.user;

      if (autoconfirma) {
        const aberta = await auth().api.abrirSessao({ body: { userId: user.id }, headers: await obterHeaders() });
        definirSessao({ userId: user.id, sessionId: aberta.sessionId, aal: "aal1" });
        return { data: { user, session: { access_token: aberta.token, user } }, error: null };
      }

      const enviado = await enviarLink({
        tipo: "signup",
        para: endereco,
        token: await emitirLink("signup", user.id, endereco),
        redirectTo: options?.emailRedirectTo ?? `${env.NEXT_PUBLIC_APP_URL}/auth/confirm?type=signup`,
      });
      if (!enviado.ok) {
        await criarAuthAdmin().deleteUser(user.id); // sem e-mail não há como confirmar: não deixa conta órfã
        return { data: { user: null, session: null }, error: erroCompat("Error sending confirmation email", 500, "unexpected_failure") };
      }
      return { data: { user, session: null }, error: null };
    },
    /** Gasta o link do e-mail (signup/invite/recovery), confirma o e-mail e abre a sessão. */
    async verifyOtp({ type, token_hash }: { type: string; token_hash: string }) {
      const tipo = type === "signup" || type === "invite" || type === "recovery" ? type : null;
      const dono = tipo ? await consumirLink([tipo], token_hash) : null;
      if (!dono) return { data: { user: null, session: null }, error: erroCompat("Email link is invalid or has expired", 403, "otp_expired") };
      await poolDeAuth().query(
        "update auth.users set email_verified = true, email_confirmed_at = coalesce(email_confirmed_at, now()), updated_at = now() where id = $1",
        [dono.userId],
      );
      const aberta = await auth().api.abrirSessao({ body: { userId: dono.userId }, headers: await obterHeaders() });
      definirSessao({ userId: dono.userId, sessionId: aberta.sessionId, aal: "aal1" });
      const user = await buscarUsuarioPorId(dono.userId);
      return { data: { user, session: { access_token: aberta.token, user } }, error: null };
    },

    /** Reenvia a confirmação de cadastro; e-mail desconhecido ou já confirmado responde igual (anti-enumeração). */
    async resend({ email, options }: { type: "signup"; email: string; options?: { emailRedirectTo?: string } }) {
      const endereco = email.trim().toLowerCase();
      const { rows } = await poolDeAuth().query<{ id: string }>(
        "select id from auth.users where email = $1 and not email_verified",
        [endereco],
      );
      if (rows[0]) {
        await descartarLinksPendentes("signup", rows[0].id);
        const enviado = await enviarLink({
          tipo: "signup",
          para: endereco,
          token: await emitirLink("signup", rows[0].id, endereco),
          redirectTo: options?.emailRedirectTo ?? `${env.NEXT_PUBLIC_APP_URL}/auth/confirm?type=signup`,
        });
        if (!enviado.ok) return { data: null, error: erroCompat("Error sending confirmation email", 500) };
      }
      return { data: {}, error: null };
    },

    /** Manda o link de redefinição; e-mail desconhecido responde sucesso igual (anti-enumeração). */
    async resetPasswordForEmail(email: string, opcoes?: { redirectTo?: string }) {
      const endereco = email.trim().toLowerCase();
      const { rows } = await poolDeAuth().query<{ id: string }>("select id from auth.users where email = $1 and not banned", [endereco]);
      if (rows[0]) {
        await descartarLinksPendentes("recovery", rows[0].id);
        const enviado = await enviarLink({
          tipo: "recovery",
          para: endereco,
          token: await emitirLink("recovery", rows[0].id, endereco),
          redirectTo: opcoes?.redirectTo ?? `${env.NEXT_PUBLIC_APP_URL}/auth/confirm?type=recovery`,
        });
        if (!enviado.ok) return { data: null, error: erroCompat("Error sending recovery email", 500) };
      }
      return { data: {}, error: null };
    },
  };
}
