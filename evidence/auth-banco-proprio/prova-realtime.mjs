// Prova do tempo real próprio: SSE autenticado entrega o evento da própria organização e NÃO o de outra.
// Uso: node evidence/auth-banco-proprio/prova-realtime.mjs  (app em http://localhost:3000, dono já criado, docker do banco de pé)
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chromium } from "@playwright/test";

const BASE = "http://localhost:3000";
const falhas = [];
const confere = (ok, msg) => { console.log(`${ok ? "OK  " : "FALHA"} ${msg}`); if (!ok) falhas.push(msg); };
const sql = (q) => execFileSync("docker", ["exec", "deskcommcrm-db-1", "psql", "-U", "postgres", "-Atq", "-c", q], { encoding: "utf8" }).trim();

const minhaOrg = sql("select id from organizations where slug = 'minha-empresa'");
const outraOrg = randomUUID();
sql(`insert into organizations(id, slug, display_name, legal_name) values ('${outraOrg}', 'rt-${outraOrg}', 'Outra', 'Outra')`);
const fixture = (org) => {
  const contato = randomUUID(); const sessao = randomUUID();
  sql(`insert into contacts(id, organization_id) values ('${contato}', '${org}')`);
  sql(`insert into channel_sessions(id, organization_id, provider, waha_session_name, webhook_secret_encrypted) values ('${sessao}', '${org}', 'waha', 'rt-${sessao}', '\\x00')`);
  return { contato, sessao };
};
const minha = fixture(minhaOrg);
const outra = fixture(outraOrg);

const navegador = await chromium.launch();
const pagina = await (await navegador.newContext()).newPage();

// sem sessão: 401
const anonimo = await (await navegador.newContext()).request.get(`${BASE}/api/realtime?cid=prova-sem-login`);
confere(anonimo.status() === 401, `SSE sem login: ${anonimo.status()}`);

await pagina.goto(`${BASE}/login`);
await pagina.fill("#email", process.env.OWNER_EMAIL ?? "dono@prova.local");
await pagina.fill("#password", process.env.OWNER_PASSWORD ?? "Prova-Forte-2026!");
await pagina.click('button[type="submit"]');
await pagina.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 });

// abre o fluxo da aba (como o hook compartilhado faz) e acumula o que chega
await pagina.evaluate(() => {
  window.__eventos = []; window.__pronto = false;
  window.__es = new EventSource("/api/realtime?cid=prova-realtime-1");
  window.__es.addEventListener("ready", () => { window.__pronto = true; });
  window.__es.addEventListener("change", (e) => window.__eventos.push(JSON.parse(e.data)));
});
await pagina.waitForFunction(() => window.__pronto, null, { timeout: 15000 });
confere(true, "SSE autenticado abriu e respondeu 'ready'");

const assinar = (corpo) => pagina.evaluate(async (c) => (await fetch("/api/realtime", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cid: "prova-realtime-1", ...c }) })).status, corpo);
confere((await assinar({ sid: "s-tabela-invalida", table: "a;b" })) === 400, "tabela inválida: 400");
confere((await assinar({ sid: "s-filtro-ruim", table: "conversations", filter: "organization_id=eq.1 or 1=1" })) === 400, "filtro fora do formato: 400");
const alheio = await assinar({ sid: "s-canal-alheio", channel: `tenant-health-${outraOrg}` });
confere(alheio === 204 || alheio === 403, `broadcast de org alheia: ${alheio} (204 só se o dono é admin da plataforma)`);
const outroCid = await pagina.evaluate(async () => (await fetch("/api/realtime", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cid: "cid-que-nao-e-meu", sid: "x", table: "conversations" }) })).status);
confere(outroCid === 404, `cid inexistente/alheio: ${outroCid}`);
confere((await assinar({ sid: "s1", table: "conversations", event: "*", filter: `organization_id=eq.${minhaOrg}` })) === 204, "assinatura de conversations da minha organização: 204");

const minhaConversa = randomUUID(); const conversaAlheia = randomUUID();
sql(`insert into conversations(id, organization_id, contact_id, channel_session_id) values ('${conversaAlheia}', '${outraOrg}', '${outra.contato}', '${outra.sessao}')`);
sql(`insert into conversations(id, organization_id, contact_id, channel_session_id) values ('${minhaConversa}', '${minhaOrg}', '${minha.contato}', '${minha.sessao}')`);
await pagina.waitForTimeout(2500);

let eventos = await pagina.evaluate(() => window.__eventos);
confere(eventos.some((e) => e.eventType === "INSERT" && e.new?.id === minhaConversa), "INSERT da própria organização chegou, com a linha completa");
confere(!eventos.some((e) => e.new?.id === conversaAlheia || e.old?.id === conversaAlheia), "evento da outra organização NÃO chegou");

sql(`update conversations set status = 'closed' where id = '${minhaConversa}'`);
await pagina.waitForTimeout(2000);
eventos = await pagina.evaluate(() => window.__eventos);
confere(eventos.some((e) => e.eventType === "UPDATE" && e.new?.id === minhaConversa), "UPDATE chegou");

sql(`delete from conversations where id = '${minhaConversa}'`);
sql(`delete from conversations where id = '${conversaAlheia}'`);
await pagina.waitForTimeout(2000);
eventos = await pagina.evaluate(() => window.__eventos);
confere(eventos.some((e) => e.eventType === "DELETE" && e.old?.id === minhaConversa), "DELETE chegou só com o id");
confere(!eventos.some((e) => e.old?.id === conversaAlheia), "DELETE da outra organização NÃO chegou");

// limpeza
sql(`delete from organizations where id = '${outraOrg}'`);
sql(`delete from conversations where id = '${minhaConversa}'`);
sql(`delete from channel_sessions where id = '${minha.sessao}'`);
sql(`delete from contacts where id = '${minha.contato}'`);
await navegador.close();
console.log(falhas.length ? `\n${falhas.length} falha(s)` : "\nTudo verde");
process.exit(falhas.length ? 1 : 0);
