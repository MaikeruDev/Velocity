-- VELOCITY Online (Plan 009, Supabase): Rate-Limit, Einreichen, Bestenliste, Bann.
--
-- claim_submit_slot / record_verified_run: nur service_role (Edge Function submit-run), EXECUTE von
-- PUBLIC/anon/authenticated zurückgenommen (Postgres gibt EXECUTE sonst standardmäßig PUBLIC).
-- get_leaderboard / get_rank_around: öffentlich, SECURITY INVOKER (lesen nur, was anon ohnehin darf).
-- Wertung: row_number über (time_ms, achieved_at, user_id) — Gleichstand gewinnt, wer zuerst da war.

-- Bann blendet aus statt zu löschen (umkehrbar, Läufe bleiben nachvollziehbar).
alter table public.best_runs add column hidden boolean not null default false;

-- Rate-Limit: feste Fenster je Nutzer (Minute/Tag), eine Zeile je Nutzer statt Protokoll.
create table private.submit_counters (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  minute_start timestamptz not null,
  minute_count integer not null,
  day_start timestamptz not null,
  day_count integer not null
);
alter table private.submit_counters enable row level security;
revoke all on table private.submit_counters from public, anon, authenticated;
grant select, insert, update on table private.submit_counters to service_role;

-- Ban-Check + Rate-Limit in einem Aufruf (atomar je Nutzer über ein Advisory-Lock).
-- Rückgabe: 'ok' | 'banned' | 'noprofile' | 'minute' | 'day'. Nur service_role.
create or replace function public.claim_submit_slot(p_user uuid, p_per_minute integer, p_per_day integer)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  banned boolean;
  c private.submit_counters%rowtype;
  t timestamptz := now();
begin
  select p.is_banned into banned from public.profiles p where p.id = p_user;
  if not found then
    return 'noprofile';
  end if;
  if banned then
    return 'banned';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('vel-submit:' || p_user::text, 0));
  select * into c from private.submit_counters x where x.user_id = p_user;
  if not found then
    insert into private.submit_counters (user_id, minute_start, minute_count, day_start, day_count)
    values (p_user, t, 1, t, 1);
    return 'ok';
  end if;
  if t - c.minute_start >= interval '1 minute' then
    c.minute_start := t;
    c.minute_count := 0;
  end if;
  if t - c.day_start >= interval '1 day' then
    c.day_start := t;
    c.day_count := 0;
  end if;
  if c.minute_count >= p_per_minute then
    return 'minute';
  end if;
  if c.day_count >= p_per_day then
    return 'day';
  end if;
  update private.submit_counters x
    set minute_start = c.minute_start, minute_count = c.minute_count + 1,
        day_start = c.day_start, day_count = c.day_count + 1
    where x.user_id = p_user;
  return 'ok';
end;
$$;

-- Verifizierten Lauf ablegen, Bestzeit nur bei Verbesserung ersetzen, Rang/Gesamtzahl liefern. Nur service_role.
create or replace function public.record_verified_run(
  p_run_id uuid,
  p_user uuid,
  p_level text,
  p_level_hash text,
  p_physics integer,
  p_time_ms integer,
  p_ticks integer,
  p_splits integer[],
  p_replay_path text,
  p_replay_bytes integer,
  p_settings jsonb
)
returns table (rank bigint, total bigint, personal_best boolean, improved boolean, previous_ms integer, best_ms integer, best_run_id uuid)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  prev public.best_runs%rowtype;
  had_prev boolean;
  is_pb boolean;
  b public.best_runs%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended('vel-record:' || p_user::text, 0));
  insert into public.runs (id, user_id, level_id, level_hash, physics_version, time_ms, ticks, splits, replay_path, replay_bytes, settings)
  values (p_run_id, p_user, p_level, p_level_hash, p_physics, p_time_ms, p_ticks, coalesce(p_splits, '{}'), p_replay_path, p_replay_bytes, coalesce(p_settings, '{}'::jsonb));

  select * into prev from public.best_runs x
    where x.user_id = p_user and x.level_id = p_level and x.level_hash = p_level_hash and x.physics_version = p_physics;
  had_prev := found;
  is_pb := not had_prev or p_time_ms < prev.time_ms;
  if is_pb then
    insert into public.best_runs (user_id, level_id, level_hash, physics_version, run_id, time_ms, achieved_at)
    values (p_user, p_level, p_level_hash, p_physics, p_run_id, p_time_ms, now())
    on conflict (user_id, level_id, level_hash, physics_version) do update
      set run_id = excluded.run_id, time_ms = excluded.time_ms, achieved_at = excluded.achieved_at
      where excluded.time_ms < public.best_runs.time_ms;
  end if;

  select * into b from public.best_runs x
    where x.user_id = p_user and x.level_id = p_level and x.level_hash = p_level_hash and x.physics_version = p_physics;

  return query
    select
      (select count(*) + 1 from public.best_runs o
        where o.level_id = p_level and o.level_hash = p_level_hash and o.physics_version = p_physics and not o.hidden
          and (o.time_ms, o.achieved_at, o.user_id) < (b.time_ms, b.achieved_at, b.user_id)),
      (select count(*) from public.best_runs o
        where o.level_id = p_level and o.level_hash = p_level_hash and o.physics_version = p_physics and not o.hidden),
      is_pb,
      is_pb and had_prev,
      case when had_prev then prev.time_ms else null end,
      b.time_ms,
      b.run_id;
end;
$$;

revoke all on function public.claim_submit_slot(uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.record_verified_run(uuid, uuid, text, text, integer, integer, integer, integer[], text, integer, jsonb) from public, anon, authenticated;
grant execute on function public.claim_submit_slot(uuid, integer, integer) to service_role;
grant execute on function public.record_verified_run(uuid, uuid, text, text, integer, integer, integer, integer[], text, integer, jsonb) to service_role;

-- Top-Ausschnitt einer Tafel (öffentlich). total = Spieler in der Tafel (in jeder Zeile gleich).
create or replace function public.get_leaderboard(
  p_level text,
  p_level_hash text,
  p_physics integer,
  p_limit integer default 10,
  p_offset integer default 0
)
returns table (rank bigint, user_id uuid, display_name text, avatar_url text, time_ms integer, run_id uuid, achieved_at timestamptz, total bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  with board as (
    select b.user_id, b.time_ms, b.run_id, b.achieved_at,
           row_number() over (order by b.time_ms, b.achieved_at, b.user_id) as rk,
           count(*) over () as tot
    from public.best_runs b
    where b.level_id = p_level and b.level_hash = p_level_hash and b.physics_version = p_physics and not b.hidden
  )
  select board.rk, board.user_id, p.display_name, p.avatar_url, board.time_ms, board.run_id, board.achieved_at, board.tot
  from board
  join public.profiles p on p.id = board.user_id
  order by board.rk
  limit least(greatest(coalesce(p_limit, 10), 0), 100)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

-- Ausschnitt ±p_radius um einen Spieler (öffentlich; leer, wenn er in der Tafel keinen Lauf hat).
create or replace function public.get_rank_around(
  p_level text,
  p_level_hash text,
  p_physics integer,
  p_user uuid,
  p_radius integer default 3
)
returns table (rank bigint, user_id uuid, display_name text, avatar_url text, time_ms integer, run_id uuid, achieved_at timestamptz, total bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  with board as (
    select b.user_id, b.time_ms, b.run_id, b.achieved_at,
           row_number() over (order by b.time_ms, b.achieved_at, b.user_id) as rk,
           count(*) over () as tot
    from public.best_runs b
    where b.level_id = p_level and b.level_hash = p_level_hash and b.physics_version = p_physics and not b.hidden
  ),
  me as (
    select board.rk from board where board.user_id = p_user
  )
  select board.rk, board.user_id, p.display_name, p.avatar_url, board.time_ms, board.run_id, board.achieved_at, board.tot
  from board
  cross join me
  join public.profiles p on p.id = board.user_id
  where board.rk between me.rk - least(greatest(coalesce(p_radius, 3), 0), 50)
                     and me.rk + least(greatest(coalesce(p_radius, 3), 0), 50)
  order by board.rk;
$$;

revoke all on function public.get_leaderboard(text, text, integer, integer, integer) from public;
revoke all on function public.get_rank_around(text, text, integer, uuid, integer) from public;
grant execute on function public.get_leaderboard(text, text, integer, integer, integer) to anon, authenticated, service_role;
grant execute on function public.get_rank_around(text, text, integer, uuid, integer) to anon, authenticated, service_role;

-- Bann (is_banned setzt nur service_role/Dashboard): Einträge ausblenden; Entbannen blendet wieder ein.
create or replace function private.apply_ban()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.is_banned is distinct from old.is_banned then
    update public.best_runs b set hidden = new.is_banned where b.user_id = new.id;
  end if;
  return new;
end;
$$;

revoke all on function private.apply_ban() from public, anon, authenticated;

create trigger profiles_apply_ban
  after update of is_banned on public.profiles
  for each row execute function private.apply_ban();
