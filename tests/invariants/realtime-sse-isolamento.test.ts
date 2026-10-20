/**
 * Tempo real próprio (migration 0704): evento da organização B não chega ao usuário da A.
 *
 * Duas camadas, as duas provadas aqui contra o Postgres real:
 *  1. o aviso do trigger carrega SÓ identificadores — nunca o conteúdo da linha;
 *  2. a releitura que a rota SSE faz com o token do usuário (papel `authenticated` + claims)
 *     é filtrada pela RLS: o usuário da A não vê a linha da B.
 * A regra de DELETE (que não relê) está em tests/unit/realtime-regras.test.ts.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

const url = `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`;
const pool = new pg.Pool({ connectionString: url, max: 2 });

const orgA = randomUUID();
const orgB = randomUUID();
const usuarioA = randomUUID();
const contatoB = randomUUID();
const sessaoB = randomUUID();
const conversaB = randomUUID();

beforeAll(async () => {
  for (const [id, nome] of [[orgA, "rt-a"], [orgB, "rt-b"]] as const) {
    await pool.query("insert into organizations(id, slug, display_name, legal_name) values ($1, $2::text, $2::text, $2::text)", [id, `${nome}-${id}`]);
  }
  await pool.query("insert into auth.users(id) values ($1)", [usuarioA]);
  await pool.query("insert into user_organizations(user_id, organization_id, role) values ($1, $2, 'admin')", [usuarioA, orgA]);
  await pool.query("insert into contacts(id, organization_id) values ($1, $2)", [contatoB, orgB]);
  await pool.query(
    "insert into channel_sessions(id, organization_id, provider, waha_session_name, webhook_secret_encrypted) values ($1, $2, 'waha', $3, '\\x00')",
    [sessaoB, orgB, `rt-${sessaoB}`],
  );
});

afterAll(async () => {
  await pool.query("delete from conversations where id = $1", [conversaB]);
  await pool.query("delete from organizations where id = any($1)", [[orgA, orgB]]);
  await pool.query("delete from auth.users where id = $1", [usuarioA]);
  await pool.end();
});

it("o aviso do trigger carrega só tabela, operação, id e organização — nunca a linha", async () => {
  const ouvinte = new pg.Client({ connectionString: url });
  await ouvinte.connect();
  await ouvinte.query("listen realtime");
  const recebido = new Promise<Record<string, unknown>>((resolve) =>
    ouvinte.on("notification", (m) => {
      const aviso = JSON.parse(m.payload ?? "{}");
      if (aviso.id === conversaB) resolve(aviso);
    }),
  );

  await pool.query("insert into conversations(id, organization_id, contact_id, channel_session_id) values ($1, $2, $3, $4)", [
    conversaB,
    orgB,
    contatoB,
    sessaoB,
  ]);

  const aviso = await recebido;
  await ouvinte.end();
  expect(aviso).toEqual({ table: "conversations", op: "INSERT", id: conversaB, organization_id: orgB });
});

it("a releitura com o token do usuário da A não enxerga a conversa da B (RLS)", async () => {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: usuarioA, role: "authenticated" })]);
    const { rows } = await c.query("select * from conversations where id = $1", [conversaB]);
    expect(rows).toHaveLength(0);
    await c.query("rollback");
  } finally {
    c.release();
  }
});

it("controle: o dono da organização B (outro usuário) enxerga a mesma conversa", async () => {
  const usuarioB = randomUUID();
  await pool.query("insert into auth.users(id) values ($1)", [usuarioB]);
  await pool.query("insert into user_organizations(user_id, organization_id, role) values ($1, $2, 'admin')", [usuarioB, orgB]);
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: usuarioB, role: "authenticated" })]);
    const { rows } = await c.query("select id from conversations where id = $1", [conversaB]);
    expect(rows).toEqual([{ id: conversaB }]);
    await c.query("rollback");
  } finally {
    c.release();
    await pool.query("delete from user_organizations where user_id = $1", [usuarioB]);
    await pool.query("delete from auth.users where id = $1", [usuarioB]);
  }
});

it("fn_realtime_broadcast só é executável pelo service_role", async () => {
  const { rows } = await pool.query(
    `select has_function_privilege('anon', 'public.fn_realtime_broadcast(text,text,jsonb)', 'execute') as anon,
            has_function_privilege('authenticated', 'public.fn_realtime_broadcast(text,text,jsonb)', 'execute') as auth,
            has_function_privilege('service_role', 'public.fn_realtime_broadcast(text,text,jsonb)', 'execute') as srv`,
  );
  expect(rows[0]).toEqual({ anon: false, auth: false, srv: true });
});
