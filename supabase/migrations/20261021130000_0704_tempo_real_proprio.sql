-- manifest: tempo real próprio — trigger por linha avisa por pg_notify('realtime') só com identificadores (nunca a linha) nas tabelas da publicação, e fn_realtime_broadcast avisa por pg_notify('broadcast'); o app escuta e entrega por SSE
--
-- Sem o serviço Realtime do Supabase, quem escuta o banco é o app (lib/realtime/hub.ts).
-- O aviso carrega só tabela, operação, id e organization_id: a linha é relida pelo app
-- com o token do USUÁRIO, e é a RLS que decide se ele a recebe. Trigger nunca faz HTTP —
-- pg_notify é fila do próprio Postgres.

create or replace function public.fn_realtime_notificar()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v jsonb := to_jsonb(coalesce(new, old));
begin
  perform pg_notify(
    'realtime',
    jsonb_build_object(
      'table', tg_table_name,
      'op', tg_op,
      'id', v ->> 'id',
      'organization_id', v ->> 'organization_id'
    )::text
  );
  return null;
end;
$$;

revoke execute on function public.fn_realtime_notificar() from public, anon;

-- Broadcast de servidor para navegadores (canal + evento + carga). Só o servidor chama.
create or replace function public.fn_realtime_broadcast(p_channel text, p_event text, p_payload jsonb)
returns void
language sql
security definer
set search_path = public
as $$
  select pg_notify(
    'broadcast',
    jsonb_build_object('channel', p_channel, 'event', p_event, 'payload', coalesce(p_payload, '{}'::jsonb))::text
  );
$$;

revoke execute on function public.fn_realtime_broadcast(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.fn_realtime_broadcast(text, text, jsonb) to service_role;

-- O trigger entra em toda tabela da publicação supabase_realtime (a lista mora lá, no
-- baseline; tabela nova na publicação ganha o trigger na próxima aplicação do baseline).
do $$
declare
  t text;
begin
  for t in
    select tablename from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public'
  loop
    if not exists (
      select 1 from pg_trigger
      where tgrelid = format('public.%I', t)::regclass and tgname = 'trg_realtime_notificar'
    ) then
      execute format(
        'create trigger trg_realtime_notificar after insert or update or delete on public.%I
           for each row execute function public.fn_realtime_notificar()', t);
    end if;
  end loop;
end $$;
