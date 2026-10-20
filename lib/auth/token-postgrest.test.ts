// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import {
  VALIDADE_TOKEN_USUARIO_SEGUNDOS,
  emitirTokenDoUsuario,
  verificarToken,
} from "./token-postgrest";

const SEGREDO = "s".repeat(40);
const DADOS = { userId: "11111111-1111-4111-8111-111111111111", sessionId: "22222222-2222-4222-8222-222222222222", aal: "aal2" as const };

describe("token do PostgREST", () => {
  const original = process.env.PGRST_JWT_SECRET;
  beforeEach(() => {
    process.env.PGRST_JWT_SECRET = SEGREDO;
  });
  afterEach(() => {
    process.env.PGRST_JWT_SECRET = original;
  });

  it("leva papel, sub, sessão e aal que as policies leem", async () => {
    const { token, expiraEm } = await emitirTokenDoUsuario(DADOS);
    const claims = await verificarToken(token);
    expect(claims).toMatchObject({ role: "authenticated", sub: DADOS.userId, session_id: DADOS.sessionId, aal: "aal2" });
    expect(expiraEm - (claims.iat as number)).toBe(VALIDADE_TOKEN_USUARIO_SEGUNDOS);
  });

  it("recusa token assinado com outro segredo", async () => {
    const falso = await new SignJWT({ role: "service_role" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("deskcomm")
      .sign(new TextEncoder().encode("x".repeat(40)));
    await expect(verificarToken(falso)).rejects.toThrow();
  });

  it("recusa token vencido", async () => {
    const vencido = await new SignJWT({ role: "authenticated" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("deskcomm")
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(new TextEncoder().encode(SEGREDO));
    await expect(verificarToken(vencido)).rejects.toThrow();
  });

  it("não emite sem segredo de 32 caracteres", async () => {
    process.env.PGRST_JWT_SECRET = "curto";
    await expect(emitirTokenDoUsuario(DADOS)).rejects.toThrow(/PGRST_JWT_SECRET/);
  });
});
