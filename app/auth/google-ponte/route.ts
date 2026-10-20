import { respostaDePonte } from "@/lib/auth/ponte-de-volta";
import { marcaDaSaida } from "@/lib/branding/saida";

// O Better Auth grava a sessão (cookie Strict) e manda o navegador para cá,
// vindo do Google: nessa navegação o cookie não viaja. Esta página não lê nada
// e só reabre /auth/callback por navegação interna, onde o cookie já vai junto.
// Só `next` e `convite` seguem adiante; o /auth/callback os filtra de novo.
export async function GET(request: Request) {
  const entrada = new URL(request.url).searchParams;
  const destino = new URLSearchParams();
  for (const chave of ["next", "convite"]) {
    const valor = entrada.get(chave);
    if (valor) destino.set(chave, valor);
  }
  const consulta = destino.size ? `?${destino}` : "";
  const marca = await marcaDaSaida(null);
  return respostaDePonte(`/auth/callback${consulta}`, marca.nome, "Voltando para o sistema…");
}
