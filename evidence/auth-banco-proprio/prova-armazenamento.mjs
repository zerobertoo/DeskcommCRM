// Prova pela API autenticada: upload do logo cai em disco e o link público serve o arquivo.
// Uso: node evidence/auth-banco-proprio/prova-armazenamento.mjs  (app em http://localhost:3000, dono já criado)
import { chromium } from "@playwright/test";
import { existsSync } from "node:fs";

const BASE = "http://localhost:3000";
const falhas = [];
const confere = (ok, msg) => { console.log(`${ok ? "OK  " : "FALHA"} ${msg}`); if (!ok) falhas.push(msg); };

// PNG 1x1 válido
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const navegador = await chromium.launch();
const pagina = await (await navegador.newContext()).newPage();
await pagina.goto(`${BASE}/login`);
await pagina.fill("#email", process.env.OWNER_EMAIL ?? "dono@prova.local");
await pagina.fill("#password", process.env.OWNER_PASSWORD ?? "Prova-Forte-2026!");
await pagina.click('button[type="submit"]');
await pagina.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 });

const res = await pagina.request.post(`${BASE}/api/v1/marca/logo`, {
  multipart: { file: { name: "logo.png", mimeType: "image/png", buffer: PNG }, escopo: "organizacao", tema: "claro" },
});
const corpo = await res.json().catch(() => ({}));
console.log(res.status(), JSON.stringify(corpo).slice(0, 300));
confere(res.status() === 200 || res.status() === 201, `upload do logo aceito (${res.status()})`);

const url = corpo?.data?.url ?? corpo?.data?.logo_url ?? JSON.stringify(corpo).match(/https?:[^"\\]+storage\/v1\/object\/public\/[^"\\]+/)?.[0];
confere(!!url && url.includes("/storage/v1/object/public/brand-logos/"), `URL pública no caminho do Storage (${url})`);
if (url) {
  const anonima = await (await navegador.newContext()).request.get(url);
  confere(anonima.status() === 200 && anonima.headers()["content-type"] === "image/png", `link público serve o PNG sem login (${anonima.status()} ${anonima.headers()["content-type"]})`);
  confere((await anonima.body()).equals(PNG), "os bytes servidos são os enviados");
  const privado = await (await navegador.newContext()).request.get(url.replace("/public/brand-logos/", "/public/whatsapp-media/"));
  confere(privado.status() === 403, `bucket privado sem assinatura: ${privado.status()}`);
  const fuga = await (await navegador.newContext()).request.get(`${BASE}/storage/v1/object/public/brand-logos/..%2F..%2F.env.local`);
  confere([400, 404].includes(fuga.status()), `tentativa de sair do bucket: ${fuga.status()}`);
}
confere(existsSync(".storage/brand-logos"), "o arquivo está em disco (.storage/brand-logos)");

await navegador.close();
console.log(falhas.length ? `\n${falhas.length} falha(s)` : "\nTudo verde");
process.exit(falhas.length ? 1 : 0);
