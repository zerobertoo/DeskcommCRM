// Prova pela tela: entrada com senha sobre o Better Auth + banco próprio (sem Supabase).
// Uso: node evidence/auth-banco-proprio/prova.mjs  (app em http://localhost:3000)
import { chromium } from "@playwright/test";

const BASE = "http://localhost:3000";
const EMAIL = process.env.OWNER_EMAIL ?? "dono@prova.local";
const SENHA = process.env.OWNER_PASSWORD ?? "Prova-Forte-2026!";
const pasta = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const navegador = await chromium.launch();
const pagina = await (await navegador.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
const falhas = [];
const confere = (ok, msg) => { console.log(`${ok ? "OK  " : "FALHA"} ${msg}`); if (!ok) falhas.push(msg); };

// 1. senha errada: mensagem na tela, continua no login
await pagina.goto(`${BASE}/login`);
await pagina.fill("#email", EMAIL);
await pagina.fill("#password", "senha-errada-123");
await pagina.click('button[type="submit"]');
await pagina.waitForTimeout(2500);
confere(pagina.url().includes("/login"), `senha errada fica em /login (${pagina.url()})`);
await pagina.screenshot({ path: `${pasta}01-senha-errada.png` });

// 2. senha certa: entra no app
await pagina.fill("#password", SENHA);
await pagina.click('button[type="submit"]');
await pagina.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 }).catch(() => {});
await pagina.waitForTimeout(2500);
confere(/\/(app|onboarding)/.test(pagina.url()), `senha certa entra no app (${pagina.url()})`);
await pagina.screenshot({ path: `${pasta}02-logado.png` });

// 3. cookie de sessão é HttpOnly + Strict
const cookies = await pagina.context().cookies();
const sessao = cookies.find((c) => c.name.includes("session_token"));
confere(!!sessao && sessao.httpOnly && sessao.sameSite === "Strict", `cookie de sessão HttpOnly+Strict (${sessao?.name} ${sessao?.sameSite})`);

// 4. token do PostgREST emitido para a sessão e aceito pelo gateway (RLS: vê a própria org)
const token = await pagina.evaluate(async () => (await fetch("/api/auth/token")).json());
const jwt = token?.data?.access_token;
confere(!!jwt, "GET /api/auth/token devolve access_token");
if (jwt) {
  const r = await pagina.evaluate(async (t) => {
    const res = await fetch("/rest/v1/organizations?select=id,slug", { headers: { Authorization: `Bearer ${t}` } });
    return { status: res.status, corpo: await res.json() };
  }, jwt);
  confere(r.status === 200 && Array.isArray(r.corpo) && r.corpo.length === 1, `PostgREST com o token: ${r.status}, ${JSON.stringify(r.corpo)}`);
}

// 5. sem cookie, o token recusa
const anonima = await (await navegador.newContext()).newPage();
const semSessao = await anonima.request.get(`${BASE}/api/auth/token`);
confere(semSessao.status() === 401, `token sem sessão: ${semSessao.status()}`);

await navegador.close();
console.log(falhas.length ? `\n${falhas.length} falha(s)` : "\nTudo verde");
process.exit(falhas.length ? 1 : 0);
