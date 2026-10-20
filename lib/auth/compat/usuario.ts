/**
 * Forma de usuário que o app herdou do GoTrue (`supabase.auth.*`), montada a
 * partir de `auth.users`. O adaptador existe para que os ~100 arquivos que leem
 * `user.id`, `user.user_metadata`, `user.email_confirmed_at`... não mudem.
 */

import { poolDeAuth } from "@/lib/auth/better-auth";

export interface LinhaDeUsuario {
  id: string;
  email: string | null;
  email_verified: boolean;
  email_confirmed_at: Date | null;
  raw_user_meta_data: Record<string, unknown> | null;
  raw_app_meta_data: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
  last_sign_in_at: Date | null;
  banned: boolean;
  ban_expires: Date | null;
}

export interface UsuarioCompat {
  id: string;
  aud: "authenticated";
  role: "authenticated";
  email: string | undefined;
  email_confirmed_at: string | undefined;
  user_metadata: Record<string, unknown>;
  app_metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  last_sign_in_at: string | undefined;
  banned_until: string | undefined;
  identities: never[];
  factors: never[];
}

export const COLUNAS_DE_USUARIO =
  "id, email, email_verified, email_confirmed_at, raw_user_meta_data, raw_app_meta_data, created_at, updated_at, last_sign_in_at, banned, ban_expires";

const iso = (d: Date | null) => (d ? d.toISOString() : undefined);

export function paraUsuarioCompat(l: LinhaDeUsuario): UsuarioCompat {
  const confirmado = l.email_verified ? (l.email_confirmed_at ?? l.created_at) : l.email_confirmed_at;
  return {
    id: l.id,
    aud: "authenticated",
    role: "authenticated",
    email: l.email ?? undefined,
    email_confirmed_at: iso(confirmado),
    user_metadata: l.raw_user_meta_data ?? {},
    app_metadata: l.raw_app_meta_data ?? {},
    created_at: l.created_at.toISOString(),
    updated_at: l.updated_at.toISOString(),
    last_sign_in_at: iso(l.last_sign_in_at),
    // banido sem prazo = ban_expires nulo; o GoTrue devolve uma data no futuro
    banned_until: l.banned ? (iso(l.ban_expires) ?? "infinity") : undefined,
    identities: [],
    factors: [],
  };
}

export async function buscarUsuarioPorId(id: string): Promise<UsuarioCompat | null> {
  // id que não é uuid derrubaria a query com 22P02; o GoTrue responde "não achei"
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { rows } = await poolDeAuth().query<LinhaDeUsuario>(
    `select ${COLUNAS_DE_USUARIO} from auth.users where id = $1`,
    [id],
  );
  return rows[0] ? paraUsuarioCompat(rows[0]) : null;
}

/** Erro no formato que o app lê: `error.message` e `error.status`. */
export function erroCompat(message: string, status = 400, code?: string) {
  return Object.assign(new Error(message), { status, code: code ?? "unexpected_failure", __isAuthError: true });
}
