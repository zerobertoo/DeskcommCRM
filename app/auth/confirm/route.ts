import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";
import { ensureTenantForUser } from "@/lib/auth/provision";
import { decidirConviteDoSignup } from "@/lib/auth/convite-no-signup";
import { modoDeCadastro } from "@/lib/auth/politica-de-cadastro";
import { aplicarConvite } from "@/lib/auth/aplicar-convite";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";

/**
 * GET /auth/confirm — troca o token do e-mail por uma sessão.
 *
 * Destino único dos links de e-mail: confirmação de cadastro, convite e
 * redefinição de senha. O link traz `token_hash` + `type` (gerados em
 * `lib/auth/compat/verificacao.ts`); não há mais formato `code`/PKCE.
 *
 * - type=signup  → provisiona o tenant (org + membership admin) e entra no
 *                  onboarding. Provisionamento é idempotente (link clicado 2x).
 * - type=recovery → sessão de recovery estabelecida; segue para /login/reset
 *                  onde o usuário define a senha nova.
 *
 * ── ABRIR O LINK NÃO GASTA O TOKEN ──────────────────────────────────────────
 *
 * O `token_hash` é de uso único, e quem abre o link primeiro fica com ele.
 * Verificadores de link (Microsoft Safe Links, gateways de e-mail, antivírus)
 * visitam o link na entrega e consumiriam o token antes do clique de verdade.
 *
 * Por isso o GET NÃO gasta o token: leva a `/login/continuar`, que mostra um
 * botão. Quem gasta é o POST desse botão — verificador automático segue link,
 * não aperta botão de formulário.
 */
export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type");

  if (tokenHash && type) {
    const continuar = new URL("/login/continuar", env.NEXT_PUBLIC_APP_URL);
    continuar.searchParams.set("type", type);
    continuar.searchParams.set("token_hash", tokenHash);
    return NextResponse.redirect(continuar);
  }

  return NextResponse.redirect(new URL("/login?error=link_invalido", env.NEXT_PUBLIC_APP_URL), 307);
}

/** O botão "Continuar" de `/login/continuar` — o único caminho que gasta o `token_hash`. */
export async function POST(request: NextRequest) {
  const form = await request.formData().catch(() => null);
  const campo = (nome: string) => {
    const valor = form?.get(nome);
    return typeof valor === "string" && valor.length > 0 ? valor : null;
  };
  // 303 e não 307: o 307 repetiria o POST no destino (`/login/reset`, `/app`…).
  return confirmar({
    tokenHash: campo("token_hash"),
    type: campo("type") as EmailOtpType | null,
    request,
    status: 303,
  });
}

async function confirmar({
  tokenHash,
  type,
  request,
  status,
}: {
  tokenHash: string | null;
  type: EmailOtpType | null;
  request: NextRequest;
  status: 303 | 307;
}) {
  const requestId = request.headers.get("x-request-id");

  // NUNCA usar url.origin aqui: é derivado do header Host, que o proxy/container
  // pode entregar como o bind interno (ex.: 0.0.0.0:3000) em vez do domínio
  // público — o link de recovery quebra silenciosamente para o usuário final.
  const redirectTo = (path: string) => NextResponse.redirect(new URL(path, env.NEXT_PUBLIC_APP_URL), status);

  if (!(tokenHash && type)) {
    return redirectTo("/login?error=link_invalido");
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });

  // CLICAR DUAS VEZES NO MESMO LINK não é motivo para expulsar ninguém.
  // O token é de uso único: o segundo clique cai aqui com "Email link is
  // invalid or has expired" — e a pessoa está logada, porque o PRIMEIRO clique
  // firmou a sessão. Medido em 2026-09-10, no rig e numa instalação real:
  // `@supabase/ssr` NÃO apaga o cookie de sessão quando o `verifyOtp` falha
  // (o cookie continua na jar e o `getUser()` seguinte devolve o usuário).
  // Mandar essa pessoa para `/login?error=link_invalido` era, medido, o que
  // fazia dois convidados reais reentrarem pela senha e perderem o fio do
  // convite — terminando dentro do CRM sem organização e sem menu.
  let usuario = data?.user ?? null;
  let sessaoPreservada = false;
  if (error || !usuario) {
    const { data: jaAutenticado } = await supabase.auth.getUser();
    if (jaAutenticado.user) {
      usuario = jaAutenticado.user;
      sessaoPreservada = true;
    }
  }

  if (!usuario) {
    await audit({
      action: "auth.email_link_rejected",
      metadata: { type, reason: error?.message ?? "no_user" },
      requestId,
    });
    return redirectTo("/login?error=link_invalido");
  }

  if (sessaoPreservada) {
    // O link falhou — isso continua sendo fato e continua auditado. O que muda
    // é o desfecho: seguimos com a sessão que já existia, e o `formato` mais o
    // `sessao_preservada` deixam a triagem distinguir este caso do outro sem
    // adivinhar.
    await audit({
      action: "auth.email_link_rejected",
      actorUserId: usuario.id,
      metadata: {
        type,

        reason: error?.message ?? "no_user",
        sessao_preservada: true,
      },
      requestId,
    });
  }

  if (type === "recovery") {
    return redirectTo("/login/reset");
  }

  // Foi convidado? Então NÃO ganha organização própria. Sem esta bifurcação,
  // quem clica no link do convite sem ter conta cria uma, cai aqui sem vínculo
  // nenhum, e `ensureTenantForUser` faz o que faria com qualquer visitante:
  // abre uma empresa e o torna admin dela. A pessoa fica com uma organização
  // fantasma, um wizard que não é dela e o gate de MFA de administrador.
  const decisao = decidirConviteDoSignup(usuario);

  if (decisao.tipo === "recusar") {
    // Falha FECHADA: havia convite e ele não vale (expirado ou de outra pessoa).
    // Provisionar aqui seria devolver o defeito com um conserto por cima.
    await audit({
      action: "auth.signup_provision_recusado",
      actorUserId: usuario.id,
      metadata: { motivo: decisao.motivo },
      requestId,
    });
    return redirectTo("/login?error=convite_invalido");
  }

  if (decisao.tipo === "convite") {
    // TERMINAR O SERVIÇO. Aqui já se sabe tudo o que o botão "Aceitar convite"
    // exigia — e com garantia mais forte: o token verificou (via
    // `decidirConviteDoSignup`) e o e-mail do convite bate com o que o PROVEDOR
    // DE AUTH acabou de confirmar, não com o que a sessão diz.
    //
    // Daqui saía um redirect para uma tela com um botão. Medido em duas
    // tentativas reais de um mesmo convidado: ninguém chegava a apertá-lo — na
    // primeira o segundo clique no e-mail derrubou o fluxo, na segunda a tela
    // veio pedindo login — e a pessoa terminava autenticada, sem organização e
    // sem menu, porque o VÍNCULO é o que dá as duas coisas.
    const aceite = await aplicarConvite({
      userId: usuario.id,
      payload: decisao.payload,
      requestId,
    });
    if (aceite.ok) return redirectTo("/app");

    // Convite revogado, ou banco fora: a tela de aceite continua existindo e
    // sabe explicar cada caso. Degradar para ela preserva exatamente o
    // comportamento anterior, em vez de deixar a pessoa sem saída.
    return redirectTo(`/team/accept-invite/${decisao.token}`);
  }

  // A TRAVA QUE MAIS IMPORTA. Aqui é onde a organização nasce, e este ponto
  // pega inclusive a conta que nasceu FORA da tela de cadastro — por uma chamada
  // direta à server action, ou por uma conta criada pela admin API do GoTrue.
  // Sem ele, fechar o cadastro seria decoração: bastaria pular a tela.
  //
  // Depois de `decidirConviteDoSignup`, de propósito: quem tem convite válido já
  // saiu acima, então esta guarda só alcança quem chegou sem convite nenhum.
  const modo = await modoDeCadastro();
  if (modo === "so_convite") {
    await audit({
      action: "auth.signup_provision_recusado",
      actorUserId: usuario.id,
      metadata: { motivo: "somente_convite" },
      requestId,
    });
    return redirectTo("/login?error=cadastro_por_convite");
  }

  // COM APROVAÇÃO (migration 0383): a empresa NÃO nasce aqui. O pedido é
  // enviado em `/get-started`, que é onde já chega quem ficou sem empresa por
  // qualquer outro caminho — uma porta só, e a trava mora na action dela
  // (`recoverOrganization`), não nesta rota.
  if (modo === "com_aprovacao") return redirectTo("/get-started");

  try {
    await ensureTenantForUser(usuario);
  } catch (e) {
    await audit({
      action: "auth.signup_provision_failed",
      actorUserId: usuario.id,
      metadata: { reason: e instanceof Error ? e.message : String(e) },
      requestId,
    });
    // A sessão JÁ está firmada (o `verifyOtp` acima
    // passou). Mandar para `/login` deixava a pessoa logada e sem organização,
    // sem nenhum caminho de volta — ver `app/actions/auth/recoverOrganization.ts`.
    return redirectTo("/get-started");
  }

  void audit({
    action: "auth.signup_confirmed",
    actorUserId: usuario.id,
    metadata: {},
    requestId,
  });

  return redirectTo("/onboarding/welcome");
}
