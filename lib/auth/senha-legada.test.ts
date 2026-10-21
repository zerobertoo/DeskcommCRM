import bcrypt from "bcryptjs";
import { hashPassword } from "better-auth/crypto";
import { describe, expect, it } from "vitest";
import { ehHashBcrypt, verificarSenha } from "@/lib/auth/senha-legada";

describe("verificarSenha", () => {
  it("aceita o bcrypt do GoTrue com a senha antiga e recusa outra", async () => {
    const hash = bcrypt.hashSync("senha-antiga", 4).replace(/^\$2b\$/, "$2a$");
    expect(ehHashBcrypt(hash)).toBe(true);
    expect(await verificarSenha({ hash, password: "senha-antiga" })).toBe(true);
    expect(await verificarSenha({ hash, password: "outra" })).toBe(false);
  });

  it("segue aceitando o formato nativo", async () => {
    const hash = await hashPassword("nativa");
    expect(ehHashBcrypt(hash)).toBe(false);
    expect(await verificarSenha({ hash, password: "nativa" })).toBe(true);
    expect(await verificarSenha({ hash, password: "errada" })).toBe(false);
  });
});
