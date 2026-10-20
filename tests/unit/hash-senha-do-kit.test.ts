/**
 * O instalador cria o dono com um hash gerado por `hostgator-setup-kit/hash-senha.mjs`
 * (a VPS não tem Node). Se os parâmetros do scrypt divergirem dos do Better Auth, o
 * dono recém-criado não consegue entrar: este teste confere o hash do kit contra o
 * `verifyPassword` do próprio Better Auth.
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { verifyPassword } from "better-auth/crypto";
import { describe, expect, it } from "vitest";

const script = resolve(__dirname, "../../hostgator-setup-kit/hash-senha.mjs");
const gerar = (senha: string) =>
  execFileSync(process.execPath, [script], { env: { ...process.env, SENHA: senha }, encoding: "utf8" }).trim();

describe("hash-senha.mjs do kit", () => {
  it("o Better Auth aceita a senha que o instalador hasheou", async () => {
    const hash = gerar("Sénha-Forte!2026");
    expect(await verifyPassword({ hash, password: "Sénha-Forte!2026" })).toBe(true);
    expect(await verifyPassword({ hash, password: "outra" })).toBe(false);
  });

  it("recusa senha vazia em vez de gravar um hash de nada", () => {
    expect(() => execFileSync(process.execPath, [script], { env: { ...process.env, SENHA: "" }, stdio: "pipe" })).toThrow();
  });
});
