// Gera o hash de senha no formato do Better Auth (scrypt, "salt:chave" em hex).
// Roda em `node:22-alpine` pelo install.sh — a VPS não tem Node — e lê a senha da
// env SENHA, nunca de argumento (não aparece em `ps`). Mesmos parâmetros de
// @better-auth/utils/password; tests/unit/hash-senha-do-kit.test.ts os confere.
import { randomBytes, scrypt } from "node:crypto";

const senha = process.env.SENHA;
if (!senha) {
  console.error("SENHA vazia");
  process.exit(1);
}

const N = 16384, r = 16, p = 1, dkLen = 64;
const salt = randomBytes(16).toString("hex");
scrypt(senha.normalize("NFKC"), salt, dkLen, { N, r, p, maxmem: 128 * N * r * 2 }, (erro, chave) => {
  if (erro) {
    console.error(erro.message);
    process.exit(1);
  }
  console.log(`${salt}:${chave.toString("hex")}`);
});
