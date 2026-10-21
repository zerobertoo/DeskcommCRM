/**
 * `createClient` para scripts e specs: o do supabase-js, com o `.auth` trocado pelo adaptador
 * do Better Auth (lib/auth/compat) — o produto não tem GoTrue, então `auth.admin.*`, `signInWithPassword`
 * e `mfa.*` do SDK bateriam em /auth/v1, que não existe.
 *
 * - chave `service_role` → `.auth.admin` sobre o banco (lib/auth/compat/admin.ts) e `.storage` em disco;
 * - chave `anon` → `.auth` do usuário, com a sessão na memória do client (como no app).
 *
 * Precisa do ambiente do app (`AUTH_DB_URL`, `PGRST_JWT_SECRET`): o `.env.e2e` traz.
 * O PostgREST é alcançado por `SUPABASE_SERVER_URL` quando definida (o gateway), para o script
 * não depender do app estar de pé para reescrever /rest/v1.
 */

import { createClient as criarClienteDoSdk, type SupabaseClient, type SupabaseClientOptions } from "@supabase/supabase-js";
import { armazenamento } from "@/lib/armazenamento/disco";
import { criarAuthAdmin } from "@/lib/auth/compat/admin";
import { criarAuthDoUsuario } from "@/lib/auth/compat/usuario-logado";

/** O claim `role` de um JWT sem verificar a assinatura (o PostgREST é quem verifica). */
function papelDoJwt(chave: string): string | null {
  try {
    return (JSON.parse(Buffer.from(chave.split(".")[1] ?? "", "base64url").toString("utf8")) as { role?: string }).role ?? null;
  } catch {
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createClient<Database = any>(
  url: string,
  chave: string,
  opcoes?: SupabaseClientOptions<"public">,
): SupabaseClient<Database> {
  const base = process.env.SUPABASE_SERVER_URL || url;

  if (papelDoJwt(chave) === "service_role") {
    const client = criarClienteDoSdk(base, chave, opcoes) as unknown as SupabaseClient<Database>;
    (client as unknown as { storage: unknown }).storage = armazenamento;
    (client as unknown as { auth: unknown }).auth = {
      admin: criarAuthAdmin(),
      getSession: async () => ({ data: { session: null }, error: null }),
    };
    return client;
  }

  const { auth, token } = criarAuthDoUsuario(() => new Headers());
  const client = criarClienteDoSdk(base, chave, {
    ...opcoes,
    accessToken: async () => (await token()) ?? chave,
  }) as unknown as SupabaseClient<Database>;
  (client as unknown as { auth: unknown }).auth = auth;
  return client;
}

export type { SupabaseClient };
