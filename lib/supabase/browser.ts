/**
 * Supabase client para Client Components (browser).
 *
 * Use este em qualquer arquivo com "use client". NUNCA em Server Components,
 * Route Handlers, ou middleware — eles devem usar `lib/supabase/server.ts`.
 *
 * A sessão é do Better Auth (cookie SameSite=Strict, httpOnly).
 */

import { createClient as createSupabaseClient } from "@supabase/supabase-js";

let _client: ReturnType<typeof createSupabaseClient> | null = null;

/**
 * O token do PostgREST no navegador. O cookie de sessão é httpOnly, então o
 * navegador não o lê: o token vem de /api/v1/auth/realtime-token, fica em memória
 * e é renovado antes de vencer. (O tempo real não usa mais socket do Supabase:
 * é SSE, ver hooks/realtime/conexao.ts.)
 */
const MARGEM_DE_RENOVACAO_MS = 60_000;

let tokenEmCache: { valor: string; expiraEm: number } | null = null;
let buscaEmVoo: Promise<string | null> | null = null;
let authEpoch = 0;

/** Invalida inclusive respostas em voo de um contexto que acabou. */
export function resetRealtimeAuthentication(): void {
  authEpoch++;
  tokenEmCache = null;
  buscaEmVoo = null;
}

/** Compatibilidade com os testes do cache. */
export const __resetTokenDoRealtime = resetRealtimeAuthentication;

async function tokenDoRealtime(): Promise<string | null> {
  const epoch = authEpoch;
  // Válido e longe de expirar: serve o cache. Sem isto seria uma requisição a
  // cada heartbeat — ~2/min por aba aberta, para um token que vale uma hora.
  if (tokenEmCache && Date.now() < tokenEmCache.expiraEm - MARGEM_DE_RENOVACAO_MS) {
    return tokenEmCache.valor;
  }
  // Coalesce: N canais assinando juntos fazem UMA requisição, não N.
  buscaEmVoo ??= (async () => {
    try {
      const res = await fetch("/api/v1/auth/realtime-token", { credentials: "include" });
      if (!res.ok) return null;
      const body = (await res.json()) as {
        data?: { access_token?: string; expires_at?: number | null };
      };
      if (epoch !== authEpoch) return null;
      const token = body.data?.access_token;
      if (!token) return null;
      // `expires_at` é epoch em SEGUNDOS. Sem ele, trata como já vencido na
      // próxima pergunta: revalidar de graça é melhor que servir token morto.
      const expiraEm = body.data?.expires_at ? body.data.expires_at * 1000 : 0;
      tokenEmCache = { valor: token, expiraEm };
      return token;
    } catch {
      // Ausência interna não autoriza canal: bootstrap recusa e a callback
      // externa lança, para o SDK não rebaixar um token existente a anônimo.
      return null;
    } finally {
      // ⚠️ NUNCA memoizar a promessa além da requisição: uma falha transitória
      // (sessão estabelecendo, cookie em renovação) condenaria o carregamento
      // inteiro a canais anônimos. O que se guarda é o token BOM, com prazo;
      // o que não se guarda é a falha. O critério não é "deu erro?" — é "o
      // resultado guardado é o resultado DESEJADO?".
      if (epoch === authEpoch) buscaEmVoo = null;
    }
  })();
  return buscaEmVoo;
}

export function createClient() {
  // Singleton no browser pra reaproveitar canais Realtime e auth state.
  if (_client) return _client;

  // Self-host (imagem genérica): valores injetados em runtime pelo
  // <PublicEnvScript/>. Vercel/dev: fallback pro process.env.NEXT_PUBLIC_*
  // (baked em build). Ler a URL do Supabase daqui é o que permite uma única
  // imagem servir qualquer projeto Supabase sem rebuild.
  const runtime =
    typeof window !== "undefined" ? window.__PUBLIC_ENV__ : undefined;
  const url = runtime?.NEXT_PUBLIC_SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    runtime?.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error(
      "[supabase/browser] NEXT_PUBLIC_SUPABASE_URL ou NEXT_PUBLIC_SUPABASE_ANON_KEY ausentes.",
    );
  }

  // O cookie de sessão é httpOnly: o navegador não assina nada sozinho. O token
  // vem de /api/v1/auth/realtime-token (em memória, renovado antes de vencer) e
  // serve ao PostgREST. Com `accessToken` o `.auth` do SDK não
  // existe — a sessão é do servidor (Better Auth).
  _client = createSupabaseClient(url, key, {
    accessToken: async () => (await tokenDoRealtime()) ?? key,
  });
  return _client;
}
