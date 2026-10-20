/**
 * Hub de tempo real: UMA conexão `LISTEN` por processo, repartida entre os assinantes SSE.
 * O Postgres avisa (pg_notify, migration 0704); quem decide o que cada pessoa recebe é a
 * rota (`app/api/v1/realtime/route.ts`), que relê a linha com o token do usuário.
 */
import { EventEmitter } from "node:events";
import { Client } from "pg";
import { env } from "@/lib/env";
import type { AvisoDeLinha } from "@/lib/realtime/regras";

export interface AvisoDeBroadcast {
  channel: string;
  event: string;
  payload: unknown;
}

interface Estado {
  emissor: EventEmitter;
  iniciado: boolean;
}

// ponytail: um listener por processo; com várias réplicas do app cada uma escuta o mesmo NOTIFY
const global_ = globalThis as unknown as { __hubDeTempoReal?: Estado };

function estado(): Estado {
  return (global_.__hubDeTempoReal ??= { emissor: new EventEmitter().setMaxListeners(0), iniciado: false });
}

async function conectar(e: Estado, tentativa: number): Promise<void> {
  const cliente = new Client({ connectionString: env.AUTH_DB_URL || env.SUPABASE_DB_URL });
  const reconectar = () => {
    cliente.removeAllListeners();
    cliente.end().catch(() => undefined);
    // recuo exponencial com teto de 30 s; quem estava assinado recebe "reassinado" ao voltar
    setTimeout(() => void conectar(e, tentativa + 1), Math.min(30_000, 500 * 2 ** tentativa));
  };
  try {
    await cliente.connect();
    cliente.on("error", reconectar);
    cliente.on("end", reconectar);
    cliente.on("notification", (m) => {
      if (!m.payload) return;
      try {
        e.emissor.emit(m.channel, JSON.parse(m.payload));
      } catch {
        // payload malformado: ignora, nunca derruba o listener
      }
    });
    await cliente.query("listen realtime");
    await cliente.query("listen broadcast");
    if (tentativa > 0) e.emissor.emit("reconectado");
  } catch {
    reconectar();
  }
}

function iniciar(): EventEmitter {
  const e = estado();
  if (!e.iniciado) {
    e.iniciado = true;
    void conectar(e, 0);
  }
  return e.emissor;
}

/** Assina os avisos de linha. Devolve a função que cancela. */
export function aoMudarLinha(ouvinte: (aviso: AvisoDeLinha) => void): () => void {
  const emissor = iniciar();
  emissor.on("realtime", ouvinte);
  return () => void emissor.off("realtime", ouvinte);
}

export function aoTransmitir(ouvinte: (aviso: AvisoDeBroadcast) => void): () => void {
  const emissor = iniciar();
  emissor.on("broadcast", ouvinte);
  return () => void emissor.off("broadcast", ouvinte);
}

/** O listener caiu e voltou: o que passou nesse intervalo não chega, e a tela precisa buscar de novo. */
export function aoReconectar(ouvinte: () => void): () => void {
  const emissor = iniciar();
  emissor.on("reconectado", ouvinte);
  return () => void emissor.off("reconectado", ouvinte);
}
