import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import { criarAuthDoUsuario, type ObterHeaders } from "@/lib/auth/compat/usuario-logado";
import { fetchDoServidor } from "@/lib/supabase/fetch-do-servidor";
import { urlDoSupabaseNoServidor } from "@/lib/supabase/url-do-servidor";

/**
 * O client fala com o PostgREST com o token do usuário da requisição (JWT HS256
 * emitido por `lib/auth/token-postgrest.ts` a partir da sessão do Better Auth);
 * sem sessão, vai com a chave anon e a RLS decide. O `.auth` não é o do SDK: é o
 * adaptador de `lib/auth/compat`, com o mesmo formato `{ data, error }`.
 *
 * `obterHeaders` é de quem chama: `next/headers` em Server Component/Action/Route
 * Handler, os cabeçalhos do `NextRequest` no proxy.
 */
export function criarClienteDoUsuario(obterHeaders: ObterHeaders): SupabaseClient {
  const { auth, token } = criarAuthDoUsuario(obterHeaders);
  const client = createSupabaseClient(
    // #1082: a BASE fica na URL pública; o endereço interno entra SÓ no
    // transporte (global.fetch), para o link que o SDK entrega sair público.
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      accessToken: async () => (await token()) ?? env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      global: {
        fetch: fetchDoServidor(
          urlDoSupabaseNoServidor(env.SUPABASE_SERVER_URL, env.NEXT_PUBLIC_SUPABASE_URL),
          env.NEXT_PUBLIC_SUPABASE_URL,
        ),
      },
    },
  );
  // Com `accessToken` o SDK troca `.auth` por um Proxy que lança em qualquer uso.
  (client as unknown as { auth: unknown }).auth = auth;
  return client;
}
