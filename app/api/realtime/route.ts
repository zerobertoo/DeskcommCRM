import { loadAuthUser } from "@/lib/auth/server";
import { criarClienteDoUsuario } from "@/lib/supabase/cliente-do-usuario";
import { conexoes, ligarAoHub, registrar, type Conexao, type PedidoDeAssinatura } from "@/lib/realtime/conexoes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BATIDA_MS = 25_000;
const CID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Tempo real por SSE no lugar do Realtime do Supabase — UMA conexão por aba.
 *
 *   GET    /api/realtime?cid=<id>             abre o fluxo (eventos `ready`, `change`, `broadcast`, `reassinado`)
 *   POST   /api/realtime  { cid, sid, table, event, filter } | { cid, sid, channel }   assina
 *   DELETE /api/realtime?cid=<id>&sid=<id>    cancela
 *
 * O Postgres só avisa ids (migration 0704). INSERT/UPDATE relêem a linha com o token do
 * usuário — a RLS decide se ele a vê. DELETE entrega só `{ id }` e só a quem é da
 * organização do aviso. Sessão revogada derruba o fluxo na próxima batida.
 *
 * Fora de /api/v1 de propósito: não é recurso do CRM, e o POST não muda dado de negócio.
 */
export async function GET(request: Request) {
  const usuario = await loadAuthUser();
  if (!usuario) return new Response("unauthenticated", { status: 401 });
  const cid = new URL(request.url).searchParams.get("cid") ?? "";
  if (!CID.test(cid)) return new Response("cid inválido", { status: 400 });

  // Reconexão do EventSource com o mesmo cid: a conexão velha, se ainda existe, sai de cena.
  conexoes().get(cid)?.soltar();

  const supabase = criarClienteDoUsuario(() => request.headers);
  const codificador = new TextEncoder();
  let batida: ReturnType<typeof setInterval> | undefined;
  let conexao: Conexao | undefined;

  const corpo = new ReadableStream<Uint8Array>({
    start(controle) {
      let aberto = true;
      const fechar = () => {
        if (!aberto) return;
        aberto = false;
        clearInterval(batida);
        conexao?.soltar();
        if (conexoes().get(cid) === conexao) conexoes().delete(cid);
        try {
          controle.close();
        } catch {
          // já fechado pelo cliente
        }
      };
      const enviar = (nome: string, dados: unknown) => {
        if (aberto) controle.enqueue(codificador.encode(`event: ${nome}\ndata: ${JSON.stringify(dados)}\n\n`));
      };

      conexao = {
        userId: usuario.id,
        orgs: new Set(usuario.organizations.map((o) => o.organization_id.toLowerCase())),
        admin: !!usuario.is_platform_admin,
        supabase,
        enviar,
        assinaturas: new Map(),
        soltar: () => undefined,
      };
      ligarAoHub(conexao);
      conexoes().set(cid, conexao);

      request.signal.addEventListener("abort", fechar);
      controle.enqueue(codificador.encode("retry: 3000\n\n"));
      enviar("ready", {});

      // Sessão revogada (logout, "sair de todos os dispositivos") derruba o fluxo na próxima batida.
      batida = setInterval(async () => {
        if (!aberto) return;
        const { data } = await supabase.auth.getUser();
        if (!data?.user) return fechar();
        controle.enqueue(codificador.encode(": batida\n\n"));
      }, BATIDA_MS);
    },
    cancel() {
      clearInterval(batida);
      conexao?.soltar();
      if (conexoes().get(cid) === conexao) conexoes().delete(cid);
    },
  });

  return new Response(corpo, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

/** A conexão `cid` tem de existir e ser DESTE usuário: o cid sozinho não dá acesso a nada. */
async function conexaoDoUsuario(cid: string) {
  const usuario = await loadAuthUser();
  if (!usuario) return { erro: new Response("unauthenticated", { status: 401 }) } as const;
  const conexao = CID.test(cid) ? conexoes().get(cid) : undefined;
  if (!conexao || conexao.userId !== usuario.id) return { erro: new Response("conexão não encontrada", { status: 404 }) } as const;
  return { conexao } as const;
}

export async function POST(request: Request) {
  const corpo = (await request.json().catch(() => null)) as (PedidoDeAssinatura & { cid?: string }) | null;
  if (!corpo || typeof corpo !== "object") return new Response("corpo inválido", { status: 400 });
  const r = await conexaoDoUsuario(String(corpo.cid ?? ""));
  if ("erro" in r) return r.erro;
  const recusa = registrar(r.conexao, corpo);
  return new Response(null, { status: recusa ?? 204 });
}

export async function DELETE(request: Request) {
  const busca = new URL(request.url).searchParams;
  const r = await conexaoDoUsuario(busca.get("cid") ?? "");
  if ("erro" in r) return r.erro;
  r.conexao.assinaturas.delete(busca.get("sid") ?? "");
  return new Response(null, { status: 204 });
}
