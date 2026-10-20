"use client";

import { randomId } from "@/lib/random-id";

/**
 * A ÚNICA conexão SSE da aba (`/api/realtime`), repartida entre todos os hooks
 * `useRealtimeChannel`. Um EventSource por hook estouraria o limite de 6 conexões por
 * origem do HTTP/1.1 numa só tela (e travaria até os `fetch` da própria página).
 *
 * O servidor liga o fluxo (GET) às assinaturas (POST/DELETE) pelo `cid` desta aba. O
 * EventSource reconecta sozinho em queda de rede; quando o servidor RECUSA (401) ele
 * fecha de vez, e aqui o fluxo é recriado com recuo exponencial (teto 30 s). Ao voltar de
 * uma queda, cada assinante recebe `{ tipo: "reassinado" }`: o que passou não é reenviado.
 */

export type EstadoDoFluxo = "connecting" | "subscribed" | "channel_error" | "closed";

export interface EspecDeAssinatura {
  table?: string;
  event?: string;
  filter?: string;
  channel?: string;
}

interface Assinante {
  spec: EspecDeAssinatura;
  entregar: (payload: unknown) => void;
  aoMudarEstado: (estado: EstadoDoFluxo) => void;
}

const cid = randomId();
const assinantes = new Map<string, Assinante>();
let fonte: EventSource | null = null;
let pronta = false;
let caiu = false;
let tentativas = 0;
let retomada: ReturnType<typeof setTimeout> | null = null;
let proximoSid = 0;

const avisarTodos = (estado: EstadoDoFluxo) => assinantes.forEach((a) => a.aoMudarEstado(estado));

function registrar(sid: string, a: Assinante) {
  void fetch("/api/realtime", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cid, sid, ...a.spec }),
  }).then((r) => {
    if (!r.ok && assinantes.get(sid) === a) a.aoMudarEstado("channel_error");
  }, () => assinantes.get(sid) === a && a.aoMudarEstado("channel_error"));
}

function abrir() {
  // sem EventSource (SSR, jsdom sem polyfill): fica em "connecting" e nada quebra
  if (typeof EventSource === "undefined" || fonte || assinantes.size === 0) return;
  const atual = new EventSource(`/api/realtime?cid=${cid}`);
  fonte = atual;
  pronta = false;

  atual.addEventListener("ready", () => {
    if (fonte !== atual) return;
    pronta = true;
    tentativas = 0;
    assinantes.forEach((a, sid) => registrar(sid, a));
    avisarTodos("subscribed");
    // Voltou depois de ter caído: o que aconteceu no intervalo não será reenviado.
    if (caiu) {
      caiu = false;
      assinantes.forEach((a) => a.entregar({ tipo: "reassinado" }));
    }
  });

  const rotear = (e: MessageEvent) => {
    try {
      const { sid, ...payload } = JSON.parse(e.data) as { sid: string };
      assinantes.get(sid)?.entregar(payload);
    } catch {
      // quadro malformado: ignora, o fluxo segue
    }
  };
  atual.addEventListener("change", rotear);
  atual.addEventListener("broadcast", rotear);
  atual.addEventListener("reassinado", () => assinantes.forEach((a) => a.entregar({ tipo: "reassinado" })));

  atual.onerror = () => {
    if (fonte !== atual) return;
    pronta = false;
    caiu = true;
    avisarTodos("channel_error");
    // CLOSED = o servidor recusou: recria com recuo. CONNECTING = o EventSource já reconecta.
    if (atual.readyState === EventSource.CLOSED) {
      atual.close();
      fonte = null;
      const espera = Math.min(30_000, 1_000 * 2 ** tentativas);
      tentativas++;
      retomada = setTimeout(abrir, espera);
    }
  };
}

/** Assina `spec`. Devolve o cancelamento; a última assinatura cancelada fecha o fluxo. */
export function assinar(
  spec: EspecDeAssinatura,
  entregar: (payload: unknown) => void,
  aoMudarEstado: (estado: EstadoDoFluxo) => void,
): () => void {
  const sid = `s${++proximoSid}`;
  const a: Assinante = { spec, entregar, aoMudarEstado };
  assinantes.set(sid, a);
  if (pronta) {
    registrar(sid, a);
    aoMudarEstado("subscribed");
  } else {
    aoMudarEstado("connecting");
    abrir();
  }
  return () => {
    assinantes.delete(sid);
    if (pronta) void fetch(`/api/realtime?cid=${cid}&sid=${sid}`, { method: "DELETE" }).catch(() => undefined);
    if (assinantes.size === 0) {
      if (retomada) clearTimeout(retomada);
      retomada = null;
      fonte?.close();
      fonte = null;
      pronta = false;
      caiu = false;
      tentativas = 0;
    }
  };
}
