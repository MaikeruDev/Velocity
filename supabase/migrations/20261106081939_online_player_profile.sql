-- VELOCITY Online (Plan 009 §15): öffentliche Profilseite.
--
-- 1) Gebannte Spieler verschwinden aus der öffentlichen Sicht: die SELECT-Policy auf profiles zeigt eine gebannte
--    Zeile nur noch ihrem Besitzer (für die eigene Kontozeile). Bestenlisten blenden gebannte Läufe schon über
--    best_runs.hidden aus; get_player_profile liefert für Gebannte null (= "unbekannt"). Moderatoren sehen
--    Gebannte über die Admin-RPCs (*_online_admin.sql). is_banned bleibt spaltengenau NICHT lesbar — Policies prüfen
--    Spalten ohne Spalten-Grant des Aufrufers.
-- 2) get_player_profile(p_user, p_boards): Profil + Bestzeiten NUR auf den Tafeln, die der Client als aktuell
--    übergibt (p_boards = [{level, level_hash, physics}], max. 64), Rang/Total wie get_leaderboard
--    (row_number über time_ms, achieved_at, user_id; ohne hidden), world_records = Anzahl Rang-1-Tafeln darunter.
--    SECURITY INVOKER: liest nur, was anon ohnehin lesen darf.

drop policy profiles_select_public on public.profiles;
create policy profiles_select_public on public.profiles
  for select to anon, authenticated
  using (not is_banned or (select auth.uid()) = id);

create function public.get_player_profile(p_user uuid, p_boards jsonb default '[]'::jsonb)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with prof as (
    select p.id, p.display_name, p.avatar_url, p.role, p.created_at
    from public.profiles p
    where p.id = p_user
  ),
  raw as (
    select t.b, t.n
    from jsonb_array_elements(case when jsonb_typeof(p_boards) = 'array' then p_boards else '[]'::jsonb end) with ordinality as t(b, n)
    where t.n <= 64 and jsonb_typeof(t.b) = 'object'
  ),
  boards as (
    select distinct
      raw.b ->> 'level' as level_id,
      raw.b ->> 'level_hash' as level_hash,
      case when (raw.b ->> 'physics') ~ '^[0-9]{1,9}$' then (raw.b ->> 'physics')::integer end as physics_version
    from raw
  ),
  mine as (
    select br.level_id, br.level_hash, br.physics_version, br.time_ms, br.run_id, br.achieved_at
    from boards bd
    join public.best_runs br
      on br.user_id = p_user and br.level_id = bd.level_id and br.level_hash = bd.level_hash and br.physics_version = bd.physics_version
    where bd.level_id is not null and bd.level_hash is not null and bd.physics_version is not null and not br.hidden
  ),
  ranked as (
    select m.level_id, m.level_hash, m.physics_version, m.time_ms, m.run_id, m.achieved_at,
      (select count(*) + 1 from public.best_runs o
        where o.level_id = m.level_id and o.level_hash = m.level_hash and o.physics_version = m.physics_version and not o.hidden
          and (o.time_ms, o.achieved_at, o.user_id) < (m.time_ms, m.achieved_at, p_user)) as rank,
      (select count(*) from public.best_runs o
        where o.level_id = m.level_id and o.level_hash = m.level_hash and o.physics_version = m.physics_version and not o.hidden) as total
    from mine m
  )
  select jsonb_build_object(
    'id', prof.id,
    'display_name', prof.display_name,
    'avatar_url', prof.avatar_url,
    'role', prof.role,
    'created_at', prof.created_at,
    'runs', (select count(*) from public.runs r where r.user_id = p_user),
    'world_records', (select count(*) from ranked where ranked.rank = 1),
    'bests', coalesce((
      select jsonb_agg(jsonb_build_object(
        'level_id', ranked.level_id, 'level_hash', ranked.level_hash, 'physics_version', ranked.physics_version,
        'time_ms', ranked.time_ms, 'run_id', ranked.run_id, 'achieved_at', ranked.achieved_at,
        'rank', ranked.rank, 'total', ranked.total
      ) order by ranked.level_id)
      from ranked
    ), '[]'::jsonb)
  )
  from prof;
$$;

revoke all on function public.get_player_profile(uuid, jsonb) from public;
grant execute on function public.get_player_profile(uuid, jsonb) to anon, authenticated, service_role;
