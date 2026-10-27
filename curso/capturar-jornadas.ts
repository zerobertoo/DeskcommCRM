/** Fotografa as receitas do catálogo, sem chamar o motor ou enviar mensagens.
 * CURSO_VERSAO_FOTOS=1.89.0 CURSO_URL=http://127.0.0.1:3460 pnpm exec tsx curso/capturar-jornadas.ts [jornada]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, expect, type Page } from "@playwright/test";
import { CSS_DE_FOTO, entrar, esperarCarregar, medir, tirarFocoDeClique, type Captura } from "./capturar";
import { exigirHttpLocal } from "./seguranca";
import { chaveDaCena, lerHistorias, receitas, ROTULO_ACAO_HUMANA, exigirVersaoDaFoto, type Historia, type Receita } from "./receitas-jornadas";
import { contextoDaBancada, semearCena } from "./semear-jornadas";
import type { Alvo } from "./licao";
import { navegarAgendaAte } from "./navegar-agenda";

const SAIDA = path.join(path.dirname(new URL(import.meta.url).pathname), "saida");
type Estado = Awaited<ReturnType<typeof semearCena>>;

/** Invalida a rodada antes de abrir a bancada; fotos anteriores não provam recaptura. */
export function abrirManifestoDaRodada(arquivo: string, chaves: string[]) {
  const manifesto: { largura: number; altura: number; capturas: Record<string, Captura>; falhas?: string[] } = existsSync(arquivo)
    ? JSON.parse(readFileSync(arquivo, "utf8")) : { largura: 1440, altura: 900, capturas: {} };
  manifesto.falhas = [...(manifesto.falhas ?? [])];
  for (const chave of chaves) if (!manifesto.falhas.includes(chave)) manifesto.falhas.push(chave);
  writeFileSync(arquivo, JSON.stringify(manifesto, null, 2));
  return async (chave: string, fotografar: () => Promise<Captura>) => {
    const captura = await fotografar(); // Inclui medição, JPEG e metadados; qualquer falha conserva a pendência.
    manifesto.capturas[chave] = captura;
    // Somente a chave concluída é liberada; captura/revogação de lições e outros recortes permanecem.
    manifesto.falhas = manifesto.falhas!.filter((falha) => falha !== chave);
    writeFileSync(arquivo, JSON.stringify(manifesto, null, 2));
  };
}

async function mostrar(page: Page, base: string, historia: Historia, receita: Receita, indice: number, estado: Estado): Promise<Alvo> {
  const superficie = receita.cenas[indice]!.superficie;
  if (["conversa", "nota", "passagem"].includes(superficie)) {
    await page.goto(`${base}/app/inbox?filter=all&id=${estado.conversa}`);
    await esperarCarregar(page);
    await page.getByRole("textbox", { name: "Buscar conversas", exact: true }).fill(receita.pessoa);
    await page.locator(`[data-conversation-id="${estado.conversa}"]`).waitFor({ state: "visible" });
    await page.getByTestId("message-bubble").filter({ hasText: receita.cenas[indice]!.mensagem }).first().waitFor({ state: "visible" });
    if (superficie === "nota") await page.getByText(`${receita.pessoa} · ${historia.cenas[indice]!.titulo}`, { exact: false }).waitFor({ state: "visible" });
    if (superficie === "nota") return { texto: `${receita.pessoa} · ${historia.cenas[indice]!.titulo}`, exato: false };
    return { css: "div[class~='group/conversa']" };
  }
  if (superficie === "agenda") {
    if (!estado.inicioCompromisso) throw new Error("cena de agenda sem compromisso semeado");
    await page.goto(`${base}/app/agenda`);
    await esperarCarregar(page);
    if (historia.id === "clinicas-primeira-consulta" && indice === 1) {
      await page.getByTestId(`botao-pessoa-${estado.responsavelAgenda}`).click();
      await esperarCarregar(page);
    }
    await navegarAgendaAte(page, estado.inicioCompromisso, estado.fusoCompromisso, estado.statusCompromisso);
    const linha = page.getByTestId(`linha-${estado.compromisso}`);
    await linha.waitFor({ state: "visible", timeout: 12_000 });
    if (indice === 2) {
      await linha.getByRole("link").click();
      // O Sheet já está visível enquanto a consulta ainda mostra "Carregando…".
      const detalhe = page.getByRole("dialog");
      await detalhe.getByRole("heading", { name: estado.titulo, exact: true }).waitFor({ state: "visible", timeout: 15_000 });
      const inicio = new Date(estado.inicioCompromisso);
      const data = new Intl.DateTimeFormat("pt-BR", { timeZone: estado.fusoCompromisso, dateStyle: "medium" }).format(inicio);
      const hora = new Intl.DateTimeFormat("pt-BR", { timeZone: estado.fusoCompromisso, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(inicio);
      await expect(detalhe.getByTestId("compromisso-horario")).toContainText(data, { timeout: 15_000 });
      await expect(detalhe.getByTestId("compromisso-horario")).toContainText(hora);
      const situacao = ({ pending: "Aguardando confirmação", confirmed: "Agendado", completed: "Compareceu", no_show: "Faltou", cancelled: "Cancelado" } as Record<string, string>)[estado.statusCompromisso];
      if (!situacao) throw new Error(`situação de compromisso sem rótulo de captura: ${estado.statusCompromisso}`);
      await detalhe.getByText(situacao, { exact: true }).waitFor({ state: "visible" });
      return { role: "dialog" };
    }
    return { testid: `linha-${estado.compromisso}` };
  }
  if (superficie === "tarefa") {
    await page.goto(`${base}/app/tasks`);
    await esperarCarregar(page);
    if (estado.tarefaStatus === "done") {
      await page.getByRole("combobox").filter({ hasText: "Em aberto" }).click();
      await page.getByRole("option", { name: "Concluída", exact: true }).click();
    }
    const linha = page.locator("div.group.rounded-lg").filter({ hasText: estado.titulo });
    if (estado.tarefaStatus === "done") await linha.getByRole("checkbox", { name: "Reabrir a tarefa", exact: true }).waitFor({ state: "visible" });
    await linha.scrollIntoViewIfNeeded();
    if (indice === 2) {
      await linha.hover();
      await linha.getByRole("button", { name: "Editar a tarefa", exact: true }).click();
      const formulario = page.getByRole("dialog", { name: "Editar tarefa", exact: true });
      await expect(formulario.getByRole("textbox", { name: "O que precisa ser feito", exact: true })).toHaveValue(estado.titulo);
      await expect(formulario.getByRole("textbox", { name: "Detalhes", exact: true })).toHaveValue(historia.cenas[indice]!.operacao);
      return { role: "dialog" };
    }
    return { css: `div.group.rounded-lg:has-text(${JSON.stringify(estado.titulo)})` };
  }
  if (superficie === "negocio") {
    await page.goto(`${base}/app/kanban`);
    await esperarCarregar(page);
    await page.locator("a[data-testid^='abrir-']").filter({ hasText: `${estado.empresa} · oportunidades` }).click();
    const cartao = page.getByRole("group", { name: `Lead: ${estado.titulo}`, exact: true });
    await cartao.waitFor({ state: "visible" });
    if (indice >= 3) {
      await cartao.getByRole("button", { name: estado.titulo, exact: true }).click();
      const dossie = page.getByRole("dialog", { name: estado.titulo, exact: true });
      await dossie.getByRole("heading", { name: estado.titulo, exact: true }).waitFor({ state: "visible" });
      await dossie.getByTestId("contato-do-negocio").getByText(receita.pessoa, { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
      return { role: "dialog" };
    }
    return { role: "group", nome: `Lead: ${estado.titulo}`, exato: true };
  }
  if (superficie === "caso") {
    await page.goto(`${base}/app/ai/cases`);
    await esperarCarregar(page);
    await page.getByTestId("case-item").filter({ hasText: estado.casoTitulo }).click();
    // O contêiner existe antes dos dados; o vínculo identifica o caso aberto.
    const detalhe = page.getByTestId("case-detail");
    await detalhe.getByRole("heading", { name: receita.pessoa, exact: true }).waitFor({ state: "visible", timeout: 15_000 });
    await expect(detalhe.getByRole("link", { name: "Ver conversa", exact: true })).toHaveAttribute("href", `/app/inbox/${estado.conversa}`);
    await detalhe.getByText(historia.contexto, { exact: true }).waitFor({ state: "visible" });
    await detalhe.getByRole("radiogroup", { name: "O que você quer fazer?", exact: true }).waitFor({ state: "visible" });
    const acao = receita.cenas[indice]!.acao_humana;
    if (acao) {
      await page.getByRole("radio").filter({ has: page.getByText(ROTULO_ACAO_HUMANA[acao], { exact: true }) }).click();
      return { role: "radiogroup", nome: "O que você quer fazer?" };
    }
    return { testid: "case-detail" };
  }
  if (superficie === "fonte-externa") {
    await page.goto(`${base}/app/integracao-dados/de100000-0000-4000-8000-000000000010`);
    await esperarCarregar(page);
    await page.getByRole("button", { name: "pedidos", exact: true }).click();
    await page.locator('td > div[title="CT-4729"]').waitFor({ state: "visible", timeout: 15_000 });
    return { css: 'tr:has(td > div[title="CT-4729"])' };
  }
  // Preparação explícita, sem executar Testar ou fingir leitura de uma origem inoperante.
  await page.goto(`${base}/app/integracao-dados`);
  await esperarCarregar(page);
  await page.getByRole("button", { name: "Nova conexão", exact: true }).click();
  await page.locator("#ext-label").fill(`${estado.empresa} · fonte autorizada`);
  return { role: "dialog" };
}

async function main() {
  const versao = exigirVersaoDaFoto(process.env.CURSO_VERSAO_FOTOS);
  const base = exigirHttpLocal(process.env.CURSO_URL ?? "http://127.0.0.1:3460");
  const historias = lerHistorias().filter((h) => !process.argv[2] || h.id === process.argv[2] || h.id.startsWith(`${process.argv[2]}-`));
  if (!historias.length) throw new Error("filtro sem jornadas");
  mkdirSync(path.join(SAIDA, "capturas"), { recursive: true });
  const arquivo = path.join(SAIDA, "capturas.json");
  const registrar = abrirManifestoDaRodada(arquivo, historias.flatMap((h) => h.cenas.map((c) => chaveDaCena(h.id, c.id))));
  const ctx = await contextoDaBancada();
  const browser = await chromium.launch({ channel: process.env.CURSO_BROWSER_CHANNEL || undefined, args: ["--lang=pt-BR"] });
  const contexto = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5, locale: "pt-BR", timezoneId: "America/Sao_Paulo" });
  const pagina = await contexto.newPage();
  try {
    await entrar(pagina, "admin", base);
    for (const historia of historias) {
      const receita = receitas.find((r) => r.jornada === historia.id)!;
      for (const [indice, cena] of historia.cenas.entries()) {
        const chave = chaveDaCena(historia.id, cena.id);
        await registrar(chave, async () => {
          const estado = await semearCena(ctx, historia, receita, indice);
          const alvo = await mostrar(pagina, base, historia, receita, indice, estado);
          await esperarCarregar(pagina);
          // O helper legado só avisa quando há skeleton: fotografia nova deve falhar.
          // As esperas de identidade acima evitam aceitar o vazio anterior à consulta.
          // A bolinha da sidebar pode pulsar por canal parado: é saúde da conexão,
          // não carregamento. A exceção só vale para esse span no link de Conexões.
          const pulsoDeConexao = "a[href='/app/connections'] > span[aria-label='Uma conexão caiu'][title='Uma conexão caiu']";
          await expect(pagina.locator(`[data-esqueleto]:visible, .animate-pulse:visible:not(${pulsoDeConexao}), [aria-busy='true']:visible`)).toHaveCount(0, { timeout: 15_000 });
          await expect(pagina.getByText(/^Carregando(?:\b|…|\.{3})/).filter({ visible: true })).toHaveCount(0, { timeout: 15_000 });
          await pagina.addStyleTag({ content: CSS_DE_FOTO });
          await tirarFocoDeClique(pagina);
          await pagina.mouse.move(0, 899);
          const caixa = await medir(pagina, alvo);
          const foto = `capturas/${chave}.jpg`;
          await pagina.screenshot({ path: path.join(SAIDA, foto), type: "jpeg", quality: 72 });
          const captura: Captura = { foto, clicar: null, destaques: [{ ...caixa, rotulo: cena.titulo, tipo: "caixa" }], versao, capturado_em: new Date().toISOString() };
          return captura;
        });
        console.info(`ok ${chave}`);
      }
    }
  } finally { await contexto.close(); await browser.close(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch(() => { console.error("Falha na captura das jornadas; confira a bancada local e recapture as cenas pendentes."); process.exitCode = 1; });
}
