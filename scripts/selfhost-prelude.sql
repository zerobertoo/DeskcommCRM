-- selfhost-prelude.sql — stubs de compatibilidade para rodar o baseline num
-- POSTGRES PURO (sem Supabase): roles anon/authenticated/service_role, schemas
-- auth/extensions/storage com stubs mínimos, e as extensões que o dump supõe
-- (uuid-ossp, pgcrypto, vector, citext, pg_trgm).
--
-- QUANDO USAR: no Postgres do próprio compose (fork sem a plataforma Supabase),
-- aplicado ANTES do baseline, no install e em todo update. É também o prelude
-- do gate de CI: `scripts/test-db.sh` e `scripts/test-update-com-dados.sh`
-- aplicam ESTE arquivo — fonte única, vigiada por
-- `tests/unit/prelude-fonte-unica.test.ts`. O invariante
-- `selfhost-prelude-aplica-o-baseline` aplica este arquivo + o baseline num
-- banco vazio e reprova quando eles se separam.
--
-- Idempotente: o update re-aplica sem quebrar nem duplicar.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
  -- Papel com que o PostgREST conecta; ele só assume os três acima, pelo `role`
  -- do JWT. A senha é gravada pelo init do compose, nunca aqui.
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator noinherit login;
  end if;
end
$$;
grant anon, authenticated, service_role to authenticator;

-- O DEFAULT ACL QUE TODO PROJETO SUPABASE JÁ TEM ANTES DE QUALQUER SQL NOSSO.
--
-- Sem estas 4 linhas o Postgres efêmero NÃO é o banco do produto, e a diferença
-- não é cosmética: ela apaga uma classe inteira de defeito do campo de visão do
-- job `invariants`.
--
-- O `pg_dump` do baseline emite, na linha ~3960, o `ALTER DEFAULT PRIVILEGES ...
-- GRANT ALL ON FUNCTIONS TO anon` — mas ele só o emite PORQUE a entrada já
-- existia no projeto de origem. Num Supabase de verdade (nuvem, que é o que o
-- `hostgator-setup-kit/install.sh` manda o cliente usar, ou a CLI local) essa
-- entrada em `pg_default_acl` é gravada pelo bootstrap do Supabase, ANTES de
-- `install.sh`/`update.sh` rodarem. Consequência: toda função que o baseline cria
-- — inclusive as ~27 do CORPO do dump — nasce com EXECUTE para anon.
--
-- Num Postgres cru, ao contrário, a entrada só passa a existir NA linha 3960 — e
-- as funções do corpo, criadas antes dela, nascem limpas. Medido em 2026-08-08,
-- pg17 descartável, baseline @9249e6f2 aplicado com e sem este bloco:
--
--     sem  -> 0 de 27 SECURITY DEFINER de public executáveis por anon
--     com  -> 6 de 27  (activate_kb_version, fn_decrypt_oauth, fn_encrypt_oauth,
--                       fn_lgpd_cascade_redact_contact, fn_update_budget_consumption,
--                       retrieve_top_k_chunks)
--
-- As mesmas 6, exatamente, que `select ... has_function_privilege('anon', ...)`
-- devolve no `supabase_db_deskcomm-crm` desta máquina hoje. Ou seja: o gate estava
-- verde medindo um universo onde o defeito não pode existir.
--
-- `revoke execute ... from public` no default também é fiel ao produto: no
-- Supabase real o `proacl` das definer de public NÃO tem `=X` (grant a PUBLIC),
-- então lá a exposição vem do grant DIRETO a anon — o caminho que
-- `revoke from public` sozinho não fecha.
alter default privileges for role postgres in schema public grant all on functions to anon;
alter default privileges for role postgres in schema public grant all on functions to authenticated;
alter default privileges for role postgres in schema public grant all on functions to service_role;
alter default privileges for role postgres in schema public revoke execute on functions from public;

-- O MESMO DEFAULT ACL, PARA TABELAS (issue #887).
--
-- O bloco acima cobria só funções, e o gate ficava cego para privilégio das
-- tabelas do CORPO do dump. Num Supabase de verdade toda tabela criada em
-- `public` nasce com privilégio total para anon, authenticated e service_role, e
-- o `GRANT` que o dump enumera depois só ACRESCENTA — não revoga nada. Aqui, sem
-- estas linhas, a tabela do corpo nascia só com o que o dump concede, e um
-- invariante do tipo "o papel X não tem o privilégio Y na tabela Z" sobre ela
-- ficava verde por construção. As tabelas do apêndice nunca tiveram o problema:
-- nascem depois do `ALTER DEFAULT PRIVILEGES … ON TABLES` que o próprio dump grava.
-- Foi assim que o `service_role` seguia apagando e reescrevendo linhas de
-- `api_audit_log` com este gate verde, até a migration 0258.
--
-- Medido em 2026-09-17 no `pg_default_acl` de um Supabase local
-- (supabase/postgres:17.6.1.106):
--
--     postgres | public | TABLES | {postgres=arwdDxtm,anon=arwdDxtm,
--                                   authenticated=arwdDxtm,service_role=arwdDxtm}
--
-- `grant all` reproduz as duas majors: o `m` (MAINTAIN) só existe no pg17.
--
-- `scripts/test-update-com-dados.sh` extrai este bloco inteiro, então as linhas
-- abaixo valem para os dois scripts.
alter default privileges for role postgres in schema public grant all on tables to anon;
alter default privileges for role postgres in schema public grant all on tables to authenticated;
alter default privileges for role postgres in schema public grant all on tables to service_role;

create schema if not exists auth;
create schema if not exists extensions;

-- O baseline referencia extensions.uuid_generate_v4/gen_random_bytes e os tipos
-- public.vector/public.citext + gin_trgm_ops, mas não cria as extensões (pg_dump).
create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists vector with schema public;
create extension if not exists citext with schema public;
create extension if not exists pg_trgm with schema public;

-- Stubs de storage (o apêndice do baseline cria buckets + policies em storage.objects).
create schema if not exists storage;
create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz not null default now()
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text,
  owner uuid,
  metadata jsonb,
  created_at timestamptz not null default now()
);

-- Stub de auth.users (FKs do baseline apontam pra cá).
--
-- `raw_user_meta_data` é o nome real da coluna no GoTrue; o baseline a lê
-- (fn_conversation_assign, backfill de conversations.assigned_to_user_name).
-- O `alter` alcança quem aplicou uma versão anterior deste prelude.
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
alter table auth.users add column if not exists raw_user_meta_data jsonb not null default '{}'::jsonb;

-- Contrato Supabase usado pelo suporte: sessão é do Auth, nunca do produto.
create table if not exists auth.sessions (
 id uuid primary key, user_id uuid not null references auth.users(id),
 aal text, not_after timestamptz
);
create table if not exists auth.mfa_factors (
 id uuid primary key, user_id uuid not null references auth.users(id), status text, factor_type text default 'totp'
);
-- Better Auth sobre o shim (fork sem a plataforma Supabase): ele grava usuário e
-- sessão nestas mesmas tabelas, com uuid gerado pelo banco. Os nomes das colunas
-- novas são mapeados em lib/auth/better-auth.ts. Segredo (hash de senha, TOTP)
-- mora em accounts (e `mfa_factors.secret`), que NÃO recebem grant: nenhum papel do PostgREST
-- as alcança, só o dono do banco (a conexão do Better Auth).
alter table auth.users add column if not exists name text not null default '';
alter table auth.users add column if not exists email_verified boolean not null default false;
alter table auth.users add column if not exists image text;
alter table auth.users add column if not exists updated_at timestamptz not null default now();
alter table auth.users add column if not exists role text;
alter table auth.users add column if not exists banned boolean not null default false;
alter table auth.users add column if not exists ban_reason text;
alter table auth.users add column if not exists ban_expires timestamptz;
alter table auth.users add column if not exists raw_app_meta_data jsonb not null default '{}'::jsonb;
alter table auth.users add column if not exists email_confirmed_at timestamptz;
alter table auth.users add column if not exists last_sign_in_at timestamptz;

-- GoTrue apaga sessão e fator junto com o usuário; sem o cascade, remover um
-- usuário (teste, LGPD) falha na FK.
alter table auth.sessions drop constraint if exists sessions_user_id_fkey;
alter table auth.sessions add constraint sessions_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade;
alter table auth.mfa_factors drop constraint if exists mfa_factors_user_id_fkey;
alter table auth.mfa_factors add constraint mfa_factors_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade;
alter table auth.sessions alter column id set default gen_random_uuid();
alter table auth.sessions add column if not exists token text unique;
alter table auth.sessions add column if not exists ip_address text;
alter table auth.sessions add column if not exists user_agent text;
alter table auth.sessions add column if not exists created_at timestamptz not null default now();
alter table auth.sessions add column if not exists updated_at timestamptz not null default now();
alter table auth.sessions add column if not exists impersonated_by text;

create table if not exists auth.accounts (
  id uuid primary key default gen_random_uuid(),
  account_id text not null,
  provider_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  access_token text, refresh_token text, id_token text,
  access_token_expires_at timestamptz, refresh_token_expires_at timestamptz,
  scope text, password text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists auth.verifications (
  id uuid primary key default gen_random_uuid(),
  identifier text not null, value text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- TOTP é nosso (lib/auth/compat/mfa.ts), não o plugin twoFactor: o segredo mora
-- aqui e, como em accounts, nenhum papel do PostgREST o lê.
alter table auth.mfa_factors add column if not exists secret text;
alter table auth.mfa_factors add column if not exists friendly_name text;
alter table auth.mfa_factors add column if not exists created_at timestamptz not null default now();
create unique index if not exists mfa_factors_user_friendly_name_key
  on auth.mfa_factors (user_id, friendly_name) where friendly_name is not null;

-- O baseline lê `raw_user_meta_data->>'full_name'`; o Better Auth grava `name`.
create or replace function auth.fn_users_full_name() returns trigger
  language plpgsql as $fn$
begin
  if coalesce(new.name, '') <> '' then
    new.raw_user_meta_data := coalesce(new.raw_user_meta_data, '{}'::jsonb)
      || jsonb_build_object('full_name', new.name);
  end if;
  return new;
end $fn$;
drop trigger if exists trg_users_full_name on auth.users;
create trigger trg_users_full_name before insert or update of name on auth.users
  for each row execute function auth.fn_users_full_name();

create or replace function auth.jwt() returns jsonb language sql stable as $$
 select coalesce(nullif(current_setting('request.jwt.claim',true),''),nullif(current_setting('request.jwt.claims',true),''))::jsonb;
$$;

-- Stub de auth.uid() — mesmo corpo do Supabase (o `nullif` protege o CAST:
-- GUC já tocado na sessão vale '' e não NULL).
create or replace function auth.uid() returns uuid
  language sql stable
  as $fn$
    select coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    )::uuid
  $fn$;

-- Mesmo contrato do Supabase: o papel que o PostgREST assumiu pelo JWT.
create or replace function auth.role() returns text
  language sql stable
  as $fn$
    select coalesce(
      nullif(current_setting('request.jwt.claim.role', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
    )::text
  $fn$;

grant usage on schema auth, extensions, storage to anon, authenticated, service_role;
grant select on auth.users to anon, authenticated, service_role;
