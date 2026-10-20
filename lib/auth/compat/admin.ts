/**
 * `supabase.auth.admin.*` sobre o banco. Só serve a service role: quem monta o
 * client com a chave de serviço (`createAdminClient`) recebe este objeto.
 */

import { auth, poolDeAuth } from "@/lib/auth/better-auth";
import {
  COLUNAS_DE_USUARIO,
  buscarUsuarioPorId,
  erroCompat,
  paraUsuarioCompat,
  type LinhaDeUsuario,
  type UsuarioCompat,
} from "@/lib/auth/compat/usuario";

interface AtributosDeCriacao {
  email?: string;
  password?: string;
  email_confirm?: boolean;
  user_metadata?: Record<string, unknown>;
  app_metadata?: Record<string, unknown>;
}

interface AtributosDeAtualizacao extends AtributosDeCriacao {
  ban_duration?: string;
}

async function hashDeSenha(senha: string): Promise<string> {
  return (await auth().$context).password.hash(senha);
}

/** Grava a senha na conta `credential` (cria a conta se o usuário ainda não tem). */
export async function gravarSenha(userId: string, senha: string): Promise<void> {
  const hash = await hashDeSenha(senha);
  const { rowCount } = await poolDeAuth().query(
    "update auth.accounts set password = $2, updated_at = now() where user_id = $1 and provider_id = 'credential'",
    [userId, hash],
  );
  if (!rowCount) {
    await poolDeAuth().query(
      "insert into auth.accounts (account_id, provider_id, user_id, password) values ($1::text, 'credential', $1::uuid, $2)",
      [userId, hash],
    );
  }
}

export function criarAuthAdmin() {
  return {
    async getUserById(id: string) {
      const user = await buscarUsuarioPorId(id);
      return user
        ? { data: { user }, error: null }
        : { data: { user: null }, error: erroCompat("User not found", 404, "user_not_found") };
    },

    async listUsers(opcoes: { page?: number; perPage?: number } = {}) {
      const perPage = Math.min(Math.max(opcoes.perPage ?? 50, 1), 1000);
      const page = Math.max(opcoes.page ?? 1, 1);
      const { rows } = await poolDeAuth().query<LinhaDeUsuario>(
        `select ${COLUNAS_DE_USUARIO} from auth.users order by created_at, id limit $1 offset $2`,
        [perPage, (page - 1) * perPage],
      );
      const users = rows.map(paraUsuarioCompat);
      return { data: { users, aud: "authenticated" }, error: null };
    },

    async createUser(attrs: AtributosDeCriacao) {
      const email = attrs.email?.trim().toLowerCase();
      if (!email) return { data: { user: null }, error: erroCompat("email obrigatório", 422) };
      try {
        const nome = String(attrs.user_metadata?.full_name ?? attrs.user_metadata?.name ?? "");
        const { rows } = await poolDeAuth().query<{ id: string }>(
          `insert into auth.users (email, name, email_verified, email_confirmed_at, raw_user_meta_data, raw_app_meta_data)
           values ($1, $2, $3, case when $3 then now() end, $4::jsonb, $5::jsonb) returning id`,
          [email, nome, attrs.email_confirm === true, JSON.stringify(attrs.user_metadata ?? {}), JSON.stringify(attrs.app_metadata ?? {})],
        );
        const id = rows[0]!.id;
        if (attrs.password) await gravarSenha(id, attrs.password);
        return { data: { user: (await buscarUsuarioPorId(id))! }, error: null };
      } catch (e) {
        if ((e as { code?: string }).code === "23505") {
          return { data: { user: null }, error: erroCompat("A user with this email address has already been registered", 422, "email_exists") };
        }
        throw e;
      }
    },

    async updateUserById(id: string, attrs: AtributosDeAtualizacao) {
      const atual = await buscarUsuarioPorId(id);
      if (!atual) return { data: { user: null }, error: erroCompat("User not found", 404, "user_not_found") };
      const metaUsuario = attrs.user_metadata ? { ...atual.user_metadata, ...attrs.user_metadata } : atual.user_metadata;
      const metaApp = attrs.app_metadata ? { ...atual.app_metadata, ...attrs.app_metadata } : atual.app_metadata;
      const banir = attrs.ban_duration === undefined ? null : attrs.ban_duration !== "none";
      await poolDeAuth().query(
        `update auth.users set
           email = coalesce($2, email),
           raw_user_meta_data = $3::jsonb,
           raw_app_meta_data = $4::jsonb,
           email_verified = case when $5::boolean then true else email_verified end,
           banned = coalesce($6::boolean, banned),
           updated_at = now()
         where id = $1`,
        [id, attrs.email?.trim().toLowerCase() ?? null, JSON.stringify(metaUsuario), JSON.stringify(metaApp), attrs.email_confirm === true, banir],
      );
      if (attrs.password) await gravarSenha(id, attrs.password);
      return { data: { user: (await buscarUsuarioPorId(id)) as UsuarioCompat }, error: null };
    },

    async deleteUser(id: string) {
      await poolDeAuth().query("delete from auth.users where id = $1", [id]);
      return { data: { user: null }, error: null };
    },

    /** Encerra as sessões do usuário (scripts/revoke-sessions.ts passa o id, como o GoTrue aceitava o JWT). */
    async signOut(userId: string, _escopo?: string) {
      await poolDeAuth().query("delete from auth.sessions where user_id = $1", [userId]);
      return { data: null, error: null };
    },

    mfa: {
      async listFactors({ userId }: { userId: string }) {
        const { rows } = await poolDeAuth().query(
          "select id, status, factor_type from auth.mfa_factors where user_id = $1",
          [userId],
        );
        return {
          data: {
            factors: rows.map((r) => ({ id: r.id, status: r.status, factor_type: r.factor_type })),
          },
          error: null,
        };
      },
      async deleteFactor({ userId, id }: { userId: string; id: string }) {
        await poolDeAuth().query("delete from auth.mfa_factors where id = $1 and user_id = $2", [id, userId]);
        return { data: { id }, error: null };
      },
    },
  };
}
