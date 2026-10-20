/**
 * Conexões SSE abertas (uma por aba do navegador), cada uma com as suas assinaturas.
 * O fluxo (GET) e o registro de assinaturas (POST/DELETE) são requisições diferentes
 * de `app/api/realtime/route.ts`; o que as liga é o `cid` que a aba gera.
 *
 * Uma conexão por aba, e não um EventSource por hook: sobre HTTP/1.1 o navegador
 * limita 6 conexões por origem, e os hooks de uma só tela já passariam disso.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { aoMudarLinha, aoReconectar, aoTransmitir } from "@/lib/realtime/hub";
import {
  canalAutorizado,
  lerFiltro,
  nomeDeTabelaValido,
  podeReceberExclusao,
  type FiltroDeColuna,
} from "@/lib/realtime/regras";

export interface PedidoDeAssinatura {
  sid: string;
  table?: string;
  event?: string;
  filter?: string | null;
  channel?: string;
}

type Assinatura =
  | { tipo: "linha"; tabela: string; evento: string; filtro: FiltroDeColuna | null }
  | { tipo: "canal"; canal: string };

export interface Conexao {
  userId: string;
  orgs: ReadonlySet<string>;
  admin: boolean;
  supabase: SupabaseClient;
  enviar: (nome: string, dados: unknown) => void;
  assinaturas: Map<string, Assinatura>;
  /** Cancela os ouvintes do hub. */
  soltar: () => void;
}

const EVENTOS = new Set(["INSERT", "UPDATE", "DELETE", "*"]);

const g = globalThis as unknown as { __conexoesDeTempoReal?: Map<string, Conexao> };
export const conexoes = (): Map<string, Conexao> => (g.__conexoesDeTempoReal ??= new Map());

/** Liga a conexão ao hub: cada aviso é repartido entre as assinaturas dela. */
export function ligarAoHub(c: Conexao): void {
  const soltarLinha = aoMudarLinha(async (aviso) => {
    if (!aviso.id) return;
    for (const [sid, a] of c.assinaturas) {
      if (a.tipo !== "linha" || a.tabela !== aviso.table) continue;
      if (a.evento !== "*" && a.evento !== aviso.op) continue;
      if (aviso.op === "DELETE") {
        if (podeReceberExclusao(aviso, c.orgs, c.admin, a.filtro)) {
          c.enviar("change", { sid, eventType: "DELETE", schema: "public", table: a.tabela, old: { id: aviso.id } });
        }
        continue;
      }
      // A linha é RELIDA com o token do usuário: a RLS decide se ele a recebe.
      let consulta = c.supabase.from(a.tabela).select("*").eq("id", aviso.id);
      if (a.filtro) consulta = consulta.eq(a.filtro.coluna, a.filtro.valor);
      const { data } = await consulta.maybeSingle();
      if (data) c.enviar("change", { sid, eventType: aviso.op, schema: "public", table: a.tabela, new: data });
    }
  });
  const soltarCanal = aoTransmitir((b) => {
    for (const [sid, a] of c.assinaturas) {
      if (a.tipo === "canal" && a.canal === b.channel) c.enviar("broadcast", { sid, event: b.event, payload: b.payload });
    }
  });
  const soltarReconexao = aoReconectar(() => c.enviar("reassinado", { tipo: "reassinado" }));
  c.soltar = () => {
    soltarLinha();
    soltarCanal();
    soltarReconexao();
  };
}

/** Valida e registra uma assinatura. Devolve o status HTTP de recusa, ou `null` se registrou. */
export function registrar(c: Conexao, p: PedidoDeAssinatura): 400 | 403 | null {
  if (typeof p.sid !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(p.sid)) return 400;
  if (!!p.table === !!p.channel) return 400;
  if (p.channel) {
    if (!canalAutorizado(p.channel, c.orgs, c.admin)) return 403;
    c.assinaturas.set(p.sid, { tipo: "canal", canal: p.channel });
    return null;
  }
  const filtro = lerFiltro(p.filter ?? null);
  const evento = p.event ?? "*";
  if (!nomeDeTabelaValido(p.table!) || !EVENTOS.has(evento) || filtro === "invalido") return 400;
  c.assinaturas.set(p.sid, { tipo: "linha", tabela: p.table!, evento, filtro });
  return null;
}
