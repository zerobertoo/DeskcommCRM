/**
 * Migra uma instalação que roda no Supabase para o banco próprio (Postgres + PostgREST + Better Auth).
 *
 * Uso (o destino é o banco do `.env`; a origem é a connection string do Supabase):
 *   npx tsx scripts/migrar-do-supabase.ts --origem <SUPABASE_DB_URL> \
 *     --supabase-url https://xxxx.supabase.co --service-key <service_role>
 *
 * O que migra: dados de `public`, usuários (com a senha bcrypt, que o Better Auth
 * aceita e regrava no 1º login), identidades Google, fatores TOTP verificados e os
 * arquivos dos buckets. Sessões NÃO migram: todos entram de novo.
 * Precisa de `pg_dump` e `psql` no PATH. Idempotente: rodar de novo não duplica.
 */

import { spawnSync } from "node:child_process";
import { Pool } from "pg";

interface Consultavel {
  query<T extends object = Record<string, unknown>>(sql: string, valores?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
}

export interface ResumoDaMigracaoDeAuth {
  usuarios: number;
  contasDeSenha: number;
  contasGoogle: number;
  fatoresTotp: number;
}

/**
 * Copia usuários, contas e fatores TOTP de `schemaOrigem` (o `auth` do GoTrue) para o `auth` do destino.
 * `ponytail:` o `secret` do TOTP é copiado como está; GoTrue com criptografia de coluna ligada
 * exigiria decifrar antes (o padrão do Supabase hospedado é texto base32).
 */
export async function migrarAuth(origem: Consultavel, destino: Consultavel, schemaOrigem = "auth"): Promise<ResumoDaMigracaoDeAuth> {
  if (!/^[a-z_][a-z0-9_]*$/.test(schemaOrigem)) throw new Error("schema de origem inválido");
  const o = schemaOrigem;

  const usuarios = await origem.query<{
    id: string; email: string | null; email_confirmed_at: Date | null; raw_user_meta_data: object | null;
    raw_app_meta_data: object | null; created_at: Date; updated_at: Date | null; last_sign_in_at: Date | null;
    encrypted_password: string | null;
  }>(
    `select id, email, email_confirmed_at, raw_user_meta_data, raw_app_meta_data, created_at, updated_at,
            last_sign_in_at, encrypted_password from ${o}.users order by created_at`,
  );
  let contasDeSenha = 0;
  for (const u of usuarios.rows) {
    await destino.query(
      `insert into auth.users (id, email, email_confirmed_at, email_verified, raw_user_meta_data, raw_app_meta_data,
                               created_at, updated_at, last_sign_in_at, name)
       values ($1, $2, $3::timestamptz, $3::timestamptz is not null, $4::jsonb, $5::jsonb, $6::timestamptz,
               coalesce($7::timestamptz, $6::timestamptz), $8, coalesce($4::jsonb->>'full_name', ''))
       on conflict (id) do nothing`,
      [u.id, u.email, u.email_confirmed_at, JSON.stringify(u.raw_user_meta_data ?? {}), JSON.stringify(u.raw_app_meta_data ?? {}),
       u.created_at, u.updated_at, u.last_sign_in_at],
    );
    if (u.encrypted_password) {
      const r = await destino.query(
        `insert into auth.accounts (account_id, provider_id, user_id, password)
         select $1::text, 'credential', $1::uuid, $2
         where not exists (select 1 from auth.accounts where user_id = $1::uuid and provider_id = 'credential')`,
        [u.id, u.encrypted_password],
      );
      contasDeSenha += r.rowCount ?? 0;
    }
  }

  const identidades = await origem.query<{ user_id: string; conta: string }>(
    `select user_id, coalesce(provider_id, identity_data->>'sub') as conta from ${o}.identities where provider = 'google'`,
  );
  let contasGoogle = 0;
  for (const i of identidades.rows) {
    const r = await destino.query(
      `insert into auth.accounts (account_id, provider_id, user_id)
       select $1::text, 'google', $2::uuid
       where not exists (select 1 from auth.accounts where user_id = $2::uuid and provider_id = 'google')`,
      [i.conta, i.user_id],
    );
    contasGoogle += r.rowCount ?? 0;
  }

  const fatores = await origem.query<{ id: string; user_id: string; secret: string; friendly_name: string | null; created_at: Date }>(
    `select id, user_id, secret, friendly_name, created_at from ${o}.mfa_factors
      where factor_type = 'totp' and status = 'verified' and secret is not null`,
  );
  let fatoresTotp = 0;
  for (const f of fatores.rows) {
    const r = await destino.query(
      `insert into auth.mfa_factors (id, user_id, status, factor_type, secret, friendly_name, created_at)
       values ($1, $2, 'verified', 'totp', $3, $4, $5) on conflict do nothing`,
      [f.id, f.user_id, f.secret, f.friendly_name, f.created_at],
    );
    fatoresTotp += r.rowCount ?? 0;
  }

  return { usuarios: usuarios.rows.length, contasDeSenha, contasGoogle, fatoresTotp };
}

/** `pg_dump --data-only` do `public` da origem restaurado no destino pelo `psql`. */
function copiarDadosDePublic(urlOrigem: string, urlDestino: string): void {
  const dump = spawnSync("pg_dump", ["--data-only", "--schema=public", "--disable-triggers", "--no-owner", urlOrigem], {
    encoding: "buffer", maxBuffer: 1024 * 1024 * 1024,
  });
  if (dump.status !== 0) throw new Error(`pg_dump falhou: ${dump.stderr?.toString() ?? dump.error?.message}`);
  const restore = spawnSync("psql", ["-v", "ON_ERROR_STOP=1", "--single-transaction", urlDestino], { input: dump.stdout, encoding: "buffer" });
  if (restore.status !== 0) throw new Error(`psql falhou: ${restore.stderr?.toString()}`);
}

/** Baixa os objetos de cada bucket pela API do Storage e grava no armazenamento em disco. */
export async function copiarArquivosDosBuckets(supabaseUrl: string, serviceKey: string): Promise<number> {
  const { armazenamento } = await import("@/lib/armazenamento/disco");
  const cabecalho = { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey };
  const base = `${supabaseUrl.replace(/\/$/, "")}/storage/v1`;
  const buckets = (await (await fetch(`${base}/bucket`, { headers: cabecalho })).json()) as { id: string }[];
  let copiados = 0;

  async function percorrer(bucket: string, prefixo: string): Promise<void> {
    for (let offset = 0; ; offset += 100) {
      const r = await fetch(`${base}/object/list/${bucket}`, {
        method: "POST",
        headers: { ...cabecalho, "content-type": "application/json" },
        body: JSON.stringify({ prefix: prefixo, limit: 100, offset }),
      });
      const itens = (await r.json()) as { name: string; id: string | null; metadata?: { mimetype?: string } }[];
      for (const item of itens) {
        const caminho = prefixo ? `${prefixo}/${item.name}` : item.name;
        if (item.id === null) { await percorrer(bucket, caminho); continue; } // pasta
        const arq = await fetch(`${base}/object/${bucket}/${caminho.split("/").map(encodeURIComponent).join("/")}`, { headers: cabecalho });
        if (!arq.ok) throw new Error(`falha ao baixar ${bucket}/${caminho}: ${arq.status}`);
        const { error } = await armazenamento.from(bucket).upload(caminho, Buffer.from(await arq.arrayBuffer()), {
          contentType: item.metadata?.mimetype ?? arq.headers.get("content-type") ?? undefined, upsert: true,
        });
        if (error) throw new Error(`falha ao gravar ${bucket}/${caminho}: ${error.message}`);
        copiados++;
      }
      if (itens.length < 100) return;
    }
  }
  for (const b of buckets) await percorrer(b.id, "");
  return copiados;
}

function argumento(nome: string): string {
  const i = process.argv.indexOf(`--${nome}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (!v) throw new Error(`falta --${nome}`);
  return v;
}

async function principal(): Promise<void> {
  const urlOrigem = argumento("origem");
  const urlDestino = process.env.AUTH_DB_URL || process.env.SUPABASE_DB_URL;
  if (!urlDestino) throw new Error("defina AUTH_DB_URL (ou SUPABASE_DB_URL) do banco de destino");
  const origem = new Pool({ connectionString: urlOrigem, max: 1 });
  const destino = new Pool({ connectionString: urlDestino, max: 1 });
  try {
    // usuários primeiro: as linhas de `public` apontam para auth.users
    console.info("auth:", await migrarAuth(origem, destino));
    copiarDadosDePublic(urlOrigem, urlDestino);
    console.info("public: copiado");
    console.info("arquivos:", await copiarArquivosDosBuckets(argumento("supabase-url"), argumento("service-key")));
  } finally {
    await origem.end();
    await destino.end();
  }
}

if (process.argv[1]?.includes("migrar-do-supabase")) {
  principal().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
