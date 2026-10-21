/**
 * Migração do Supabase (Task 8): o usuário com hash bcrypt do GoTrue entra com a senha antiga,
 * o TOTP com o segredo antigo continua valendo, e rodar duas vezes não duplica nada.
 * A "origem" é um schema à parte no mesmo cluster, com as colunas do GoTrue que o script lê.
 */
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { Secret, TOTP } from "otpauth";
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { migrarAuth } from "../../scripts/migrar-do-supabase";
import { verificarSenha } from "@/lib/auth/senha-legada";

const pool = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`, max: 2 });
const usuario = randomUUID();
const googleSub = `g-${randomUUID()}`;
const segredo = new Secret({ size: 20 }).base32;
const hashAntigo = bcrypt.hashSync("senha-do-supabase", 4).replace(/^\$2b\$/, "$2a$");

beforeAll(async () => {
  await pool.query("create schema if not exists origem_teste");
  await pool.query(`create table origem_teste.users (id uuid, email text, email_confirmed_at timestamptz, raw_user_meta_data jsonb,
    raw_app_meta_data jsonb, created_at timestamptz, updated_at timestamptz, last_sign_in_at timestamptz, encrypted_password text)`);
  await pool.query("create table origem_teste.identities (user_id uuid, provider text, provider_id text, identity_data jsonb)");
  await pool.query(`create table origem_teste.mfa_factors (id uuid, user_id uuid, secret text, friendly_name text, created_at timestamptz,
    factor_type text, status text)`);
  await pool.query("insert into origem_teste.users values ($1, $2, now(), '{\"full_name\":\"Maria\"}', '{}', now(), now(), null, $3)",
    [usuario, `mig-${usuario}@teste.local`, hashAntigo]);
  await pool.query("insert into origem_teste.identities values ($1, 'google', $2, '{}')", [usuario, googleSub]);
  await pool.query("insert into origem_teste.mfa_factors values ($1, $2, $3, 'celular', now(), 'totp', 'verified')", [randomUUID(), usuario, segredo]);
  await pool.query("insert into origem_teste.mfa_factors values ($1, $2, 'naoverificado', null, now(), 'totp', 'unverified')", [randomUUID(), usuario]);
});

afterAll(async () => {
  await pool.query("delete from auth.users where id = $1", [usuario]);
  await pool.query("drop schema origem_teste cascade");
  await pool.end();
});

it("traz usuário, senha bcrypt, conta Google e só o TOTP verificado — e é idempotente", async () => {
  const primeira = await migrarAuth(pool, pool, "origem_teste");
  expect(primeira).toMatchObject({ contasDeSenha: 1, contasGoogle: 1, fatoresTotp: 1 });
  const segunda = await migrarAuth(pool, pool, "origem_teste");
  expect(segunda).toMatchObject({ contasDeSenha: 0, contasGoogle: 0, fatoresTotp: 0 });

  const { rows: u } = await pool.query("select name, email_verified from auth.users where id = $1", [usuario]);
  expect(u[0]).toEqual({ name: "Maria", email_verified: true });

  const { rows: conta } = await pool.query("select password from auth.accounts where user_id = $1 and provider_id = 'credential'", [usuario]);
  expect(await verificarSenha({ hash: conta[0].password, password: "senha-do-supabase" })).toBe(true);
  expect(await verificarSenha({ hash: conta[0].password, password: "errada" })).toBe(false);

  const { rows: g } = await pool.query("select account_id from auth.accounts where user_id = $1 and provider_id = 'google'", [usuario]);
  expect(g[0].account_id).toBe(googleSub);

  const { rows: f } = await pool.query("select secret from auth.mfa_factors where user_id = $1", [usuario]);
  expect(f).toHaveLength(1);
  const totp = new TOTP({ algorithm: "SHA1", digits: 6, period: 30, secret: Secret.fromBase32(f[0].secret) });
  expect(totp.validate({ token: totp.generate(), window: 1 })).not.toBeNull();
});
