import { NextResponse } from "next/server";
import { obterUsuarioAtual } from "@/lib/auth/sessao";
import { emitirTokenDoUsuario } from "@/lib/auth/token-postgrest";

/**
 * Token para o cliente do navegador falar com o PostgREST. O cookie de sessão é
 * httpOnly, então o browser não assina nada sozinho: pede aqui, guarda em
 * memória e renova antes de vencer.
 */
export async function GET() {
  const usuario = await obterUsuarioAtual();
  if (!usuario) {
    return NextResponse.json(
      { error: { code: "unauthenticated", message: "Sessão ausente ou vencida." } },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }
  const { token, expiraEm } = await emitirTokenDoUsuario({
    userId: usuario.id,
    sessionId: usuario.sessionId,
    aal: usuario.aal,
  });
  return NextResponse.json(
    { data: { access_token: token, expires_at: expiraEm } },
    { headers: { "Cache-Control": "no-store" } },
  );
}
