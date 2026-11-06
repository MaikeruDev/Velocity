-- Rolle im Profil (Plan 009): 'dev' bekommt im Spiel einen eigenen Namens-Effekt + DEV-Abzeichen.
-- Öffentlich lesbar (Spalten-Grant SELECT), aber kein Client darf sie schreiben: UPDATE ist nur auf
-- display_name gewährt, der Insert-Trigger setzt den Default. Vergeben wird die Rolle nur per SQL im
-- Dashboard bzw. mit der Service-Rolle, z. B.:
--   update public.profiles set role = 'dev' where id = '<auth.users.id>';

alter table public.profiles
  add column role text not null default 'player'
  constraint profiles_role_check check (role in ('player', 'dev'));

grant select (role) on public.profiles to anon, authenticated;

-- Bestenlisten-Funktionen liefern die Rolle mit. Rückgabetyp ändert sich → neu anlegen.
drop function public.get_leaderboard(text, text, integer, integer, integer);
drop function public.get_rank_around(text, text, integer, uuid, integer);

create function public.get_leaderboard(p_level text, p_level_hash text, p_physics integer, p_limit integer default 10, p_offset integer default 0)
returns table(rank bigint, user_id uuid, display_name text, avatar_url text, role text, time_ms integer, run_id uuid, achieved_at timestamptz, total bigint)
language sql
stable
set search_path = ''
as $function$
  with board as (
    select b.user_id, b.time_ms, b.run_id, b.achieved_at,
           row_number() over (order by b.time_ms, b.achieved_at, b.user_id) as rk,
           count(*) over () as tot
    from public.best_runs b
    where b.level_id = p_level and b.level_hash = p_level_hash and b.physics_version = p_physics and not b.hidden
  )
  select board.rk, board.user_id, p.display_name, p.avatar_url, p.role, board.time_ms, board.run_id, board.achieved_at, board.tot
  from board
  join public.profiles p on p.id = board.user_id
  order by board.rk
  limit least(greatest(coalesce(p_limit, 10), 0), 100)
  offset greatest(coalesce(p_offset, 0), 0);
$function$;

create function public.get_rank_around(p_level text, p_level_hash text, p_physics integer, p_user uuid, p_radius integer default 3)
returns table(rank bigint, user_id uuid, display_name text, avatar_url text, role text, time_ms integer, run_id uuid, achieved_at timestamptz, total bigint)
language sql
stable
set search_path = ''
as $function$
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
  select board.rk, board.user_id, p.display_name, p.avatar_url, p.role, board.time_ms, board.run_id, board.achieved_at, board.tot
  from board
  cross join me
  join public.profiles p on p.id = board.user_id
  where board.rk between me.rk - least(greatest(coalesce(p_radius, 3), 0), 50)
                     and me.rk + least(greatest(coalesce(p_radius, 3), 0), 50)
  order by board.rk;
$function$;

revoke all on function public.get_leaderboard(text, text, integer, integer, integer) from public;
revoke all on function public.get_rank_around(text, text, integer, uuid, integer) from public;
grant execute on function public.get_leaderboard(text, text, integer, integer, integer) to anon, authenticated, service_role;
grant execute on function public.get_rank_around(text, text, integer, uuid, integer) to anon, authenticated, service_role;
