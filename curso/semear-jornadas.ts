/** Estados fictícios das histórias; nunca chama IA, WAHA ou serviço externo.
 * Requer a base do curso já preparada e workers parados. Só altera IDs próprios.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { exigirHttpLocal } from "./seguranca";
import { exigir, semErro, type Contexto } from "./semear-demonstracao";
import { idDaHistoria, lerHistorias, receitas, evolucaoDoCaso, type Historia, type Receita } from "./receitas-jornadas";

export async function contextoDaBancada(): Promise<Contexto> {
  const url = exigirHttpLocal(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
  const chave = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!chave) throw new Error("defina SUPABASE_SERVICE_ROLE_KEY");
  const db = createClient(url, chave, { auth: { autoRefreshToken: false, persistSession: false } });
  const contas = JSON.parse(readFileSync(new URL("./saida/contas.json", import.meta.url), "utf8")) as Record<string, { email: string }>;
  const usuarios = await db.auth.admin.listUsers({ perPage: 1000 });
  semErro(usuarios, "contas da bancada");
  const usuario = (papel: string) => {
    const id = usuarios.data.users.find((u) => u.email === contas[papel]?.email)?.id;
    if (!id) throw new Error(`semeie a base primeiro: conta ${papel} ausente`);
    return id;
  };
  const pessoa = { helena: usuario("admin"), ana: usuario("agent"), carlos: usuario("manager") };
  const { organization_id: org } = exigir(await db.from("user_organizations").select("organization_id").eq("user_id", pessoa.helena).eq("role", "admin").single(), "organização da bancada") as { organization_id: string };
  const { id: sessao } = exigir(await db.from("channel_sessions").select("id").eq("organization_id", org).is("archived_at", null).order("created_at").limit(1).single(), "canal da bancada") as { id: string };
  const { id: agenteId } = exigir(await db.from("ai_agents").select("id").eq("organization_id", org).order("created_at").limit(1).single(), "agente da bancada") as { id: string };
  const { id: funilId } = exigir(await db.from("crm_pipelines").select("id").eq("organization_id", org).eq("is_default", true).single(), "funil da bancada") as { id: string };
  const etapas = exigir(await db.from("crm_stages").select("id").eq("pipeline_id", funilId).eq("organization_id", org).order("position"), "etapas") as Array<{ id: string }>;
  return { db, org, pessoa, sessao, agenteId, funil: { id: funilId, etapas: etapas.map((e) => e.id) } };
}

/** Dia seguinte relativo à captura, às 17h de São Paulo; não é uma promessa do produto. */
export function horarioDaHistoria(remarcado = false) {
  const sp = new Date(Date.now() - 3 * 3_600_000);
  return new Date(Date.UTC(sp.getUTCFullYear(), sp.getUTCMonth(), sp.getUTCDate() + (remarcado ? 2 : 1), 20)).toISOString();
}

export async function semearCena(ctx: Contexto, historia: Historia, receita: Receita, indice: number) {
  const { db, org, pessoa, sessao, agenteId, funil } = ctx;
  // Remove só histórias anteriores do curso, preservando pilotos, base e volumes.
  if (indice === 0) {
    for (const [tabela, entidade] of [["calendar_appointments", 3], ["crm_tasks", 4], ["crm_leads", 5], ["agent_cases", 6], ["conversations", 2], ["contacts", 1], ["channel_sessions", 9]] as const) {
      semErro(await db.from(tabela).delete().eq("organization_id", org).in("id", receitas.map((r) => idDaHistoria(r.jornada, entidade))), `limpar histórias anteriores em ${tabela}`);
    }
  }
  const cena = historia.cenas[indice]!;
  const id = (entidade: number) => idDaHistoria(historia.id, entidade);
  const conversa = id(2), tarefa = id(4), negocio = id(5), caso = id(6);
  let contato = id(1), sessaoDaHistoria = sessao;
  let contatoExistente = false;
  let compromisso = id(3);
  let inicioCompromisso: string | null = null;
  let fusoCompromisso = "America/Sao_Paulo", statusCompromisso = "confirmed";
  let responsavelAgenda = historia.id === "clinicas-remarcar-sessao" ? pessoa.ana : pessoa.helena;
  const titulo = historia.id === "clinicas-primeira-consulta" ? "Avaliação Postural — Marina Exemplo"
    : historia.id === "clinicas-remarcar-sessao" ? "Sessão de fisioterapia — Rui"
    : historia.id === "infoprodutos-acesso" ? "Erro 403 na aula 3 — Fotografia na Prática"
    : `${historia.titulo} — ${receita.pessoa}`;
  const casoTitulo = `${titulo} · demonstração`;
  const agora = Date.now();
  const em = (i: number) => new Date(agora - (10 - i) * 60_000).toISOString();
  const automatico = historia.id === "e-commerce-consultar-pedido" || historia.id === "infoprodutos-acesso"
    || (historia.id === "clinicas-primeira-consulta" && indice < 3);
  const empresa = historia.empresa.replace(/ \(fictícia\)$/, "");
  if (historia.id === "e-commerce-consultar-pedido") {
    // Mesmo identificador que a fonte espera; não reescreve o cadastro da prova nativa.
    const original = await db.from("contacts").select("id").eq("organization_id", org)
      .eq("phone_number", "+5511000000997").is("is_merged_into", null).maybeSingle();
    semErro(original, "contato da fonte fictícia");
    if (original.data) { contato = original.data.id; contatoExistente = true; }
    // Uma conversa por contato+canal: a reconstituição usa canal próprio parado,
    // sem alterar a conversa/canal originais e sem publicar outro agente.
    sessaoDaHistoria = id(9);
    semErro(await db.from("channel_sessions").upsert({ id: sessaoDaHistoria, organization_id: org,
      provider: "waha", waha_session_name: "curso-loja-reconstituicao", webhook_secret_encrypted: "\\x00",
      status: "STOPPED", display_name: "Casa das Trilhas · demonstração sem envio", phone_number: null,
    }), "canal exclusivo da reconstituição");
  }
  // Só modelos conhecidos da base: o seed antigo os repõe ao voltar às lições da clínica.
  semErro(await db.from("message_templates").delete().eq("organization_id", org).in("title", ["Horários da nutricionista", "Endereço da clínica", "Preparo para exame de sangue"]), "retirar respostas rápidas clínicas");
  semErro(await db.from("organizations").update({ display_name: empresa, legal_name: empresa }).eq("id", org), "nome fictício da história");
  if (sessaoDaHistoria === sessao) semErro(await db.from("channel_sessions").update({ display_name: `${empresa} · demonstração` }).eq("id", sessao).eq("organization_id", org), "nome do canal");
  semErro(await db.from("ai_agents").update({ name: `Assistente · ${empresa}` }).eq("id", agenteId).eq("organization_id", org), "nome do agente");
  if (!contatoExistente) semErro(await db.from("contacts").upsert({ id: contato, organization_id: org, name: receita.pessoa, phone_number: historia.id === "e-commerce-consultar-pedido" ? "+5511000000997" : `+551199900${String(receitas.indexOf(receita) + 1).padStart(4, "0")}`, tags: ["exemplo-ficticio"] }), "contato fictício");
  semErro(await db.from("conversations").upsert({ id: conversa, organization_id: org, contact_id: contato, channel_session_id: sessaoDaHistoria, status: "claimed", bot_silenced_until: "infinity" }), "conversa fictícia");
  semErro(await db.from("messages").delete().eq("organization_id", org).eq("conversation_id", conversa), "limpar mensagens da história");
  semErro(await db.from("conversation_notes").delete().eq("organization_id", org).eq("conversation_id", conversa), "limpar notas da história");
  // Mensagens encenadas versionadas, coerentes com os personagens; nunca atribuídas ao motor.
  for (const [i] of historia.cenas.slice(0, indice + 1).entries()) {
    semErro(await db.from("messages").insert({ organization_id: org, conversation_id: conversa, contact_id: contato, channel_session_id: sessaoDaHistoria,
      type: "text", body: receita.cenas[i]!.mensagem, direction: "inbound", status: "received", sent_via: "external_device", sent_at: em(i), created_at: em(i), metadata: { curso_roteiro: true } }), "mensagem fictícia");
    if (receita.cenas[i]!.resposta) semErro(await db.from("messages").insert({ organization_id: org, conversation_id: conversa, contact_id: contato, channel_session_id: sessaoDaHistoria,
      type: "text", body: receita.cenas[i]!.resposta, direction: "outbound", status: "read", sent_via: receita.cenas[i]!.resposta_observada ? "ai" : "user", sent_by_user_id: receita.cenas[i]!.resposta_observada ? null : pessoa.helena,
      sent_at: new Date(Date.parse(em(i)) + 10_000).toISOString(), created_at: new Date(Date.parse(em(i)) + 10_000).toISOString(), metadata: { curso_roteiro: true } }), "resposta humana encenada");
  }
  semErro(await db.rpc("fn_mark_conversation_message", { p_conv: conversa, p_direction: receita.cenas[indice]!.resposta ? "outbound" : "inbound", p_preview: receita.cenas[indice]!.resposta || receita.cenas[indice]!.mensagem, p_at: receita.cenas[indice]!.resposta ? new Date(Date.parse(em(indice)) + 10_000).toISOString() : em(indice) }), "resumo da conversa");
  if (!automatico) semErro(await db.rpc("fn_conversation_assign", { p_organization_id: org, p_conversation_id: conversa, p_to_user_id: pessoa.helena, p_reason: "claim" }), "responsável da história");
  semErro(await db.from("conversations").update({ ...(automatico ? { status: "ai_handling", assignee_kind: "ai", assigned_to_user_id: null, bot_silenced_until: null } : { bot_silenced_until: "infinity" }), unread_count_for_assignee: 0 }).eq("id", conversa).eq("organization_id", org), "pausa da demonstração");
  if (indice > 0) semErro(await db.from("conversation_notes").insert({ organization_id: org, conversation_id: conversa, created_by_user_id: pessoa.helena, created_by_name: "Helena Prado", body: `${receita.pessoa} · ${cena.titulo}\n${historia.contexto} Próximo passo: ${cena.valor}`, created_at: em(indice + 1) }), "nota da etapa");

  const superficies = receita.cenas.slice(0, indice + 1).map((c) => c.superficie);
  // Limpa só artefatos próprios desta história; evita o estado final da última rodada vazar na chegada.
  for (const [tabela, entidade] of [["crm_tasks", tarefa], ["crm_leads", negocio], ["agent_cases", caso]] as const) {
    semErro(await db.from(tabela).delete().eq("organization_id", org).eq("id", entidade), `repor ${tabela}`);
  }
  if (!superficies.includes("agenda")) semErro(await db.from("calendar_appointments").delete().eq("organization_id", org).eq("id", compromisso), "limpar compromisso próprio");
  if (superficies.includes("agenda")) {
    const comeca = historia.id === "clinicas-primeira-consulta" ? "2026-10-27T12:30:00.000Z" : horarioDaHistoria(historia.id === "clinicas-remarcar-sessao" && indice >= 2);
    inicioCompromisso = comeca;
    // O piloto real permanece intacto. Quando presente, a foto lê seu compromisso original.
    const piloto = historia.id === "clinicas-primeira-consulta"
      ? exigir(await db.from("calendar_appointments").select("id, owner_user_id, starts_at, time_zone, status").eq("organization_id", org).eq("title", titulo).eq("starts_at", comeca).in("status", ["confirmed", "pending"]).neq("id", compromisso), "compromisso do piloto") as Array<{ id: string; owner_user_id: string | null; starts_at: string; time_zone: string; status: string }>
      : [];
    if (piloto.length > 1) throw new Error("piloto clínico ambíguo: mais de um compromisso");
    if (piloto[0]) {
      compromisso = piloto[0].id;
      responsavelAgenda = piloto[0].owner_user_id ?? pessoa.helena;
      inicioCompromisso = piloto[0].starts_at;
      fusoCompromisso = piloto[0].time_zone;
      statusCompromisso = piloto[0].status;
    }
    else {
      const campos = { organization_id: org, contact_id: contato, title: titulo,
        starts_at: comeca, ends_at: new Date(Date.parse(comeca) + 30 * 60_000).toISOString(), time_zone: "America/Sao_Paulo", status: "confirmed",
        owner_user_id: responsavelAgenda,
        location_kind: "in_person", location_details: empresa, description: historia.contexto, notes: cena.operacao,
        created_by_kind: "user", created_by_user_id: pessoa.helena, source: "ui" };
      const existentes = exigir(await db.from("calendar_appointments").select("id").eq("organization_id", org).eq("id", compromisso), "compromisso próprio") as Array<{ id: string }>;
      semErro(existentes.length
        ? await db.from("calendar_appointments").update(campos).eq("organization_id", org).eq("id", compromisso)
        : await db.from("calendar_appointments").insert({ id: compromisso, ...campos }), "compromisso da história");
    }
  }
  if (superficies.includes("negocio")) {
    semErro(await db.from("crm_pipelines").update({ name: `${empresa} · oportunidades` }).eq("organization_id", org).eq("id", funil.id), "funil da história");
    for (const [i, nome] of ["Novo interesse", "Em análise", "Próximo passo", "Acompanhamento"].entries()) {
      if (funil.etapas[i]) semErro(await db.from("crm_stages").update({ name: nome }).eq("organization_id", org).eq("id", funil.etapas[i]), "etapa do funil");
    }
    semErro(await db.from("crm_leads").insert({ id: negocio, organization_id: org, pipeline_id: funil.id, stage_id: funil.etapas[indice >= 3 ? 2 : 0], contact_id: contato, title: titulo, status: "open", value_cents: 0, currency: "BRL" }), "negócio aberto");
  }
  const tarefaStatus = receita.cenas[indice]!.tarefa_status;
  if (superficies.includes("tarefa") && !tarefaStatus) throw new Error("receita sem situação da tarefa nesta cena");
  if (superficies.includes("tarefa")) semErro(await db.from("crm_tasks").insert({ id: tarefa, organization_id: org, title: titulo,
    description: cena.operacao, contact_id: contato, lead_id: superficies.includes("negocio") ? negocio : null, status: tarefaStatus, priority: "medium", assigned_to: pessoa.helena, created_by: pessoa.helena, due_date: horarioDaHistoria() }), "tarefa da equipe");
  if (superficies.includes("caso")) {
    const evolucao = evolucaoDoCaso(receita, indice);
    semErro(await db.from("agent_cases").insert({ id: caso, organization_id: org, conversation_id: conversa, agent_id: agenteId,
      status: evolucao.status, kind: "duvida", source: "agent", title: casoTitulo, summary: historia.contexto, blocker: historia.cenas[1]!.operacao,
      opened_at: em(1), closed_at: evolucao.fechado ? em(indice + 1) : null }), "caso demonstrativo");
    semErro(await db.from("agent_case_events").insert({ organization_id: org, case_id: caso, kind: "opened", actor_kind: "system", body: "Estado semeado para o roteiro demonstrativo; não é execução observada de IA.", created_at: em(1) }), "origem do exemplo");
    if (evolucao.eventos.length) semErro(await db.from("agent_case_events").insert(evolucao.eventos.map((evento, i) => ({
      organization_id: org, case_id: caso, kind: evento.kind, actor_kind: evento.actor_kind,
      actor_user_id: evento.actor_kind === "human" ? pessoa.helena : null,
      human_action: evento.human_action ?? null, body: evento.body,
      created_at: new Date(Date.parse(em(evento.cena)) + i * 1000).toISOString(),
    }))), "evolução demonstrativa do caso");
  }
  if (superficies.includes("configuracao-externa") || superficies.includes("fonte-externa")) {
    semErro(await db.from("platform_config").upsert({ chave: "MODULO_BANCO_EXTERNO", valor: "ligado", eh_segredo: false, semeado_do_env: false, updated_by: pessoa.helena }, { onConflict: "chave" }), "habilitar tela de configuração");
  }
  return { contato, conversa, compromisso, tarefa, negocio, caso, titulo, casoTitulo, empresa, responsavelAgenda, inicioCompromisso, fusoCompromisso, statusCompromisso, tarefaStatus };
}

async function main() {
  const historia = lerHistorias().find((h) => h.id === process.argv[2]);
  if (!historia) throw new Error("informe o ID de uma jornada");
  const receita = receitas.find((r) => r.jornada === historia.id)!;
  const indice = process.argv[3] ? historia.cenas.findIndex((c) => c.id === process.argv[3]) : 0;
  if (indice < 0) throw new Error("cena desconhecida");
  await semearCena(await contextoDaBancada(), historia, receita, indice);
  console.info(`estado semeado: ${historia.id}/${historia.cenas[indice]!.id}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch(() => { console.error("Falha ao semear jornada; confira a bancada local e o catálogo."); process.exitCode = 1; });
}
