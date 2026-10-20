// Prova pela tela: cadastro do TOTP em Configurações › Segurança e login com segundo fator (aal1 → aal2).
// Uso: node evidence/auth-banco-proprio/prova-mfa.mjs  (app em http://localhost:3000, dono já criado)
import { chromium } from "@playwright/test";
import { Secret, TOTP } from "otpauth";

const BASE = "http://localhost:3000";
const EMAIL = process.env.OWNER_EMAIL ?? "dono@prova.local";
const SENHA = process.env.OWNER_PASSWORD ?? "Prova-Forte-2026!";
const pasta = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const falhas = [];
const confere = (ok, msg) => { console.log(`${ok ? "OK  " : "FALHA"} ${msg}`); if (!ok) falhas.push(msg); };
const codigo = (segredo) => new TOTP({ secret: Secret.fromBase32(segredo), digits: 6, period: 30 }).generate();
const nivel = async (pagina) => {
  const r = await pagina.evaluate(async () => (await fetch("/api/auth/token")).json());
  const corpo = r?.data?.access_token?.split(".")[1];
  return corpo ? JSON.parse(Buffer.from(corpo, "base64url").toString()).aal : null;
};

async function entrar(pagina) {
  await pagina.goto(`${BASE}/login`);
  await pagina.fill("#email", EMAIL);
  await pagina.fill("#password", SENHA);
  await pagina.click('button[type="submit"]');
  await pagina.waitForURL((u) => !u.pathname.startsWith("/login") || u.pathname.startsWith("/login/mfa"), { timeout: 20000 });
  await pagina.waitForTimeout(1500);
}

const navegador = await chromium.launch();
const contexto = await navegador.newContext({ viewport: { width: 1280, height: 900 } });
const pagina = await contexto.newPage();

// 1. entra e cadastra o TOTP pela tela
await entrar(pagina);
confere(!pagina.url().includes("/login/mfa"), `sem fator, a senha basta (${pagina.url()})`);
confere((await nivel(pagina)) === "aal1", "sessão nasce aal1");

await pagina.goto(`${BASE}/app/settings/security`);
await pagina.getByRole("button", { name: /^ativar$/i }).first().click();
await pagina.getByRole("button", { name: /iniciar configuração/i }).click();
const modal = pagina.getByRole("dialog");
await modal.locator("code").first().waitFor({ state: "attached", timeout: 15000 });
// o segredo manual fica num <details> fechado: lê o texto sem exigir visibilidade
const segredo = ((await modal.locator("code").first().textContent()) ?? "").trim();
confere(/^[A-Z2-7]{16,}$/.test(segredo), `segredo base32 exibido (${segredo.length} chars)`);
await pagina.screenshot({ path: `${pasta}03-mfa-qr.png` });

await modal.locator("input").first().click();
await pagina.keyboard.type(codigo(segredo), { delay: 40 });
// o campo envia sozinho ao completar os 6 dígitos
await pagina.getByText(/códigos de recuperação/i).first().waitFor({ timeout: 15000 });
confere(true, "código aceito e códigos de recuperação exibidos");
await pagina.screenshot({ path: `${pasta}04-mfa-recuperacao.png` });
confere((await nivel(pagina)) === "aal2", "cadastrar o fator promove a sessão a aal2");

// 2. contexto novo (outro navegador): a senha sozinha não basta
const outro = await (await navegador.newContext()).newPage();
await entrar(outro);
confere(outro.url().includes("/login/mfa"), `com fator, pede o segundo passo (${outro.url()})`);
await outro.screenshot({ path: `${pasta}05-pede-mfa.png` });
confere((await nivel(outro)) === "aal1", "antes do código a sessão é aal1");

// 2a. código errado é recusado
await outro.locator("input").first().click();
await outro.keyboard.type("000000", { delay: 40 });
await outro.waitForTimeout(2500);
confere(outro.url().includes("/login/mfa"), "código errado não passa");

// 2b. código certo promove a aal2 e entra
await outro.reload();
await outro.locator("input").first().click();
await outro.keyboard.type(codigo(segredo), { delay: 40 });
await outro.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 }).catch(() => {});
await outro.waitForTimeout(1500);
confere(!outro.url().includes("/login"), `código certo entra (${outro.url()})`);
confere((await nivel(outro)) === "aal2", "depois do código a sessão é aal2");
await outro.screenshot({ path: `${pasta}06-logado-aal2.png` });

await navegador.close();
console.log(falhas.length ? `\n${falhas.length} falha(s)` : "\nTudo verde");
process.exit(falhas.length ? 1 : 0);
