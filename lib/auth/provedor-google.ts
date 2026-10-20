/**
 * O provedor Google está LIGADO nesta instalação?
 *
 * Sem GoTrue não há `/auth/v1/settings` para perguntar: o Better Auth só registra
 * o Google quando `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET` existem
 * (lib/auth/better-auth.ts). Desligado, a action recusa dentro do CRM com
 * `google_indisponivel` em vez de mandar a pessoa para um erro cru (issue #1652).
 */
import { env } from "@/lib/env";

/** `desconhecido` fica no tipo porque quem consome já o trata; hoje a resposta é sempre exata. */
export type EstadoDoProvedorGoogle = "ligado" | "desligado" | "desconhecido";

export async function estadoDoProvedorGoogle(): Promise<EstadoDoProvedorGoogle> {
  return env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? "ligado" : "desligado";
}
