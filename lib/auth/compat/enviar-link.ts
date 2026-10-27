import type { TipoDeLink } from "@/lib/auth/compat/verificacao";
import { assuntoDoModelo, montarTemplateDeAcesso, type ModeloDeAcesso } from "@/lib/email/templates/acesso-gotrue";
import { marcaDaSaida } from "@/lib/branding/saida";
import { sendEmail } from "@/lib/email/roteador";

// Fica fora de `verificacao.ts` de propósito: `compat/admin` importa aquele arquivo, e quem
// importa `lib/supabase/admin` (o Jev, por exemplo) passaria a alcançar o roteador de e-mail.
const modeloDe = (tipo: TipoDeLink): ModeloDeAcesso => (tipo === "recovery" ? "recovery" : "confirmation");

/**
 * Manda o e-mail do link pelo roteador (SMTP ou Resend). `redirectTo` já traz
 * `?type=…`, como nos e-mails do GoTrue; o token entra com `&token_hash=`.
 */
export async function enviarLink(params: { tipo: TipoDeLink; para: string; token: string; redirectTo: string }) {
  const marca = await marcaDaSaida(null);
  const modelo = modeloDe(params.tipo);
  const html = montarTemplateDeAcesso(modelo, marca)
    .split("{{ .RedirectTo }}").join(params.redirectTo)
    .split("{{ .TokenHash }}").join(params.token);
  return sendEmail({ to: params.para, subject: assuntoDoModelo(modelo, marca), html });
}
