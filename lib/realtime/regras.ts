/**
 * Regras puras do tempo real próprio (hub e rota SSE): quem pode assinar o quê.
 * Sem I/O, para serem testadas sem banco.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Aviso que o trigger `fn_realtime_notificar` manda: só identificadores, nunca a linha. */
export interface AvisoDeLinha {
  table: string;
  op: "INSERT" | "UPDATE" | "DELETE";
  id: string | null;
  organization_id: string | null;
}

export interface FiltroDeColuna {
  coluna: string;
  valor: string;
}

/** `coluna=eq.<uuid>` (o único formato que os hooks usam) → filtro; qualquer outra coisa → `null`. */
export function lerFiltro(bruto: string | null): FiltroDeColuna | null | "invalido" {
  if (!bruto) return null;
  const m = /^([a-z_]+)=eq\.(.+)$/.exec(bruto);
  if (!m || !UUID.test(m[2]!)) return "invalido";
  return { coluna: m[1]!, valor: m[2]! };
}

export const nomeDeTabelaValido = (t: string) => /^[a-z][a-z0-9_]*$/.test(t);

/**
 * DELETE não pode ser relido (a linha acabou) e a RLS não chega a decidir. O que
 * se entrega é só `{ id }`, e só a quem pertence à organização do aviso — ou é
 * administrador da plataforma. Filtro por `organization_id` também tem de bater.
 */
export function podeReceberExclusao(
  aviso: AvisoDeLinha,
  orgsDoUsuario: ReadonlySet<string>,
  ehAdminDaPlataforma: boolean,
  filtro: FiltroDeColuna | null,
): boolean {
  if (!aviso.id) return false;
  if (filtro?.coluna === "organization_id" && filtro.valor !== aviso.organization_id) return false;
  if (ehAdminDaPlataforma) return true;
  return !!aviso.organization_id && orgsDoUsuario.has(aviso.organization_id);
}

/**
 * Canal de broadcast: `alerts-platform` é só da plataforma; os demais carregam o id da
 * organização no nome (`org:<id>:queue`, `tenant-health-<id>`) e só quem a integra assina.
 */
export function canalAutorizado(
  canal: string,
  orgsDoUsuario: ReadonlySet<string>,
  ehAdminDaPlataforma: boolean,
): boolean {
  if (!/^[A-Za-z0-9:_-]{1,128}$/.test(canal)) return false;
  if (ehAdminDaPlataforma) return true;
  if (canal === "alerts-platform") return false;
  const ids = canal.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [];
  return ids.length > 0 && ids.every((id) => orgsDoUsuario.has(id.toLowerCase()));
}
