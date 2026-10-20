/**
 * Emite o JWT que o PostgREST valida no lugar do token do GoTrue.
 *
 * O app autentica o usuário pelo Better Auth (cookie de sessão) e, a cada
 * requisição ao banco, assina aqui um token HS256 de vida curta com o mesmo
 * segredo do PostgREST (`PGRST_JWT_SECRET`). As policies RLS leem `sub`,
 * `session_id` e `aal` por `auth.uid()` / `auth.jwt()`.
 */

import { SignJWT, jwtVerify } from "jose";

/** Vida do token de usuário: curta, porque a renovação é a cada requisição. */
export const VALIDADE_TOKEN_USUARIO_SEGUNDOS = 10 * 60;

export type NivelDeAutenticacao = "aal1" | "aal2";

export interface DadosDoToken {
  userId: string;
  sessionId: string;
  aal: NivelDeAutenticacao;
}

/** Segredo lido na hora: o módulo é importado em testes que trocam o env. */
function segredo(): Uint8Array {
  const valor = process.env.PGRST_JWT_SECRET ?? "";
  if (valor.length < 32) {
    throw new Error("PGRST_JWT_SECRET ausente ou com menos de 32 caracteres.");
  }
  return new TextEncoder().encode(valor);
}

/**
 * Token do usuário logado (`role: authenticated`).
 *
 * @returns o JWT e o instante de expiração (epoch em segundos), para o cliente
 * do navegador saber quando renovar.
 */
export async function emitirTokenDoUsuario(
  dados: DadosDoToken,
): Promise<{ token: string; expiraEm: number }> {
  const agora = Math.floor(Date.now() / 1000);
  const expiraEm = agora + VALIDADE_TOKEN_USUARIO_SEGUNDOS;
  const token = await new SignJWT({
    role: "authenticated",
    session_id: dados.sessionId,
    aal: dados.aal,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(dados.userId)
    .setIssuer("crm")
    .setIssuedAt(agora)
    .setExpirationTime(expiraEm)
    .sign(segredo());
  return { token, expiraEm };
}

/** Confere assinatura, emissor e validade; devolve os claims ou lança. */
export async function verificarToken(token: string) {
  const { payload } = await jwtVerify(token, segredo(), { issuer: "crm", algorithms: ["HS256"] });
  return payload;
}
