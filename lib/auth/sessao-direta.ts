/**
 * Plugin do Better Auth que abre uma sessão para um usuário JÁ autenticado por
 * outro meio (link de e-mail, cadastro com autoconfirmação).
 *
 * O endpoint não tem `path`: fica fora do roteador HTTP e só é alcançável por
 * `auth().api.abrirSessao(...)` no servidor. Quem chama é quem provou a posse do
 * e-mail (lib/auth/compat/verificacao.ts); este endpoint não prova nada sozinho.
 */

import { createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import * as z from "zod";

export const sessaoDireta = () => ({
  id: "sessao-direta",
  endpoints: {
    abrirSessao: createAuthEndpoint(
      { method: "POST", body: z.object({ userId: z.string() }) },
      async (ctx) => {
        const user = await ctx.context.internalAdapter.findUserById(ctx.body.userId);
        if (!user) throw new Error("usuário não encontrado");
        const session = await ctx.context.internalAdapter.createSession(user.id);
        await setSessionCookie(ctx, { session, user });
        return ctx.json({ sessionId: session.id, token: session.token });
      },
    ),
  },
});
