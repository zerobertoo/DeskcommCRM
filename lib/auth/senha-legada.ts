/**
 * Conferência de senha que também aceita o bcrypt do GoTrue.
 *
 * Instalação migrada do Supabase traz `encrypted_password` em bcrypt (`$2a$`/`$2b$`/`$2y$`);
 * o Better Auth grava scrypt. Os dois valem até o primeiro login, quando o
 * hash é regravado no formato nativo (ver `signInWithPassword`).
 */

import bcrypt from "bcryptjs";
import { verifyPassword } from "better-auth/crypto";

/** True quando o hash é bcrypt (formato do GoTrue), não o scrypt nativo. */
export function ehHashBcrypt(hash: string): boolean {
  return /^\$2[aby]\$/.test(hash);
}

/** `password.verify` do Better Auth: bcrypt para o legado, scrypt para o resto. */
export async function verificarSenha({ hash, password }: { hash: string; password: string }): Promise<boolean> {
  if (ehHashBcrypt(hash)) return bcrypt.compare(password, hash);
  return verifyPassword({ hash, password });
}
