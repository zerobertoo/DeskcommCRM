/**
 * Links de e-mail (confirmar conta, redefinir senha) sobre `auth.verifications`.
 *
 * O link leva o token em claro (`token_hash=` na URL, o nome que o app e os
 * e-mails já usam); o banco guarda só o SHA-256 dele, como o GoTrue fazia. Uso
 * único: consumir apaga a linha.
 */

import { createHash, randomBytes } from "node:crypto";
import { poolDeAuth } from "@/lib/auth/better-auth";
import { assuntoDoModelo, montarTemplateDeAcesso, type ModeloDeAcesso } from "@/lib/email/templates/acesso-gotrue";
import { marcaDaSaida } from "@/lib/branding/saida";
import { sendEmail } from "@/lib/email/roteador";

export type TipoDeLink = "signup" | "invite" | "recovery";

const VALIDADE_EM_MINUTOS: Record<TipoDeLink, number> = { signup: 60 * 24, invite: 60 * 24, recovery: 60 };

const hashDe = (token: string) => createHash("sha256").update(token).digest("hex");

/** Grava um token novo e devolve o valor em claro (vai no link, nunca ao banco). */
export async function emitirLink(tipo: TipoDeLink, userId: string, email: string): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await poolDeAuth().query(
    `insert into auth.verifications (identifier, value, expires_at)
     values ($1, $2, now() + make_interval(mins => $3))`,
    [`${tipo}:${hashDe(token)}`, JSON.stringify({ userId, email }), VALIDADE_EM_MINUTOS[tipo]],
  );
  return token;
}

/** Gasta o token: devolve o dono se ele existe e não venceu; null caso contrário. */
export async function consumirLink(
  tipos: TipoDeLink[],
  token: string,
): Promise<{ userId: string; email: string; tipo: TipoDeLink } | null> {
  const { rows } = await poolDeAuth().query<{ identifier: string; value: string }>(
    `delete from auth.verifications
      where identifier = any($1::text[]) and expires_at > now()
      returning identifier, value`,
    [tipos.map((t) => `${t}:${hashDe(token)}`)],
  );
  if (!rows[0]) return null;
  const dono = JSON.parse(rows[0].value) as { userId: string; email: string };
  return { ...dono, tipo: rows[0].identifier.split(":")[0] as TipoDeLink };
}

/** Descarta os links pendentes do mesmo tipo: um pedido novo invalida o anterior. */
export async function descartarLinksPendentes(tipo: TipoDeLink, userId: string): Promise<void> {
  await poolDeAuth().query(
    "delete from auth.verifications where identifier like $1 and value::jsonb ->> 'userId' = $2",
    [`${tipo}:%`, userId],
  );
}

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
