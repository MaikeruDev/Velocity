-- VELOCITY Online (Plan 009 §15): Entwickler-Werkzeuge (Moderation).
--
-- Wer: NUR profiles.role = 'dev' (nicht gebannt). role ist für Clients nicht schreibbar (Spalten-Grant nur
-- display_name). JEDE Admin-Funktion prüft das serverseitig als erste Anweisung (private.require_dev) — der
-- Client blendet die Werkzeuge nur aus, Sicherheit hängt nie daran.
--
--   admin_list_runs / admin_list_players / admin_set_ban / admin_rename_player / admin_audit_log
--       SECURITY DEFINER (lesen is_banned/discord_name, schreiben profiles), fester search_path, prüfen auth.uid().
--       EXECUTE nur authenticated (+ service_role); PUBLIC/anon zurückgenommen.
--   admin_delete_run(p_actor, …)
--       NUR service_role: aufgerufen von der Edge Function `admin` NACH auth.getUser(jwt) → p_actor = verifizierte
--       Nutzer-ID; prüft p_actor trotzdem selbst. Die Function löscht danach das Replay über die Storage-API
--       (nie direkt aus storage.objects).
--   private.admin_audit
--       Protokoll wer/was/wem/wann; nicht exponiertes Schema, RLS an, keine Grants — lesen nur über admin_audit_log.
--
-- Fehler (SQLSTATE, vom Client gemappt): 42501 = kein Dev, 22023 = ungültige Eingabe, P0002 = Ziel unbekannt.

alter table public.profiles
  add column ban_reason text check (ban_reason is null or char_length(ban_reason) <= 200),
  add column banned_at timestamptz;
-- Bewusst KEINE Spalten-Grants für ban_reason/banned_at (Spalten-Grants auf profiles sind explizit, s. online_profiles).

create table private.admin_audit (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  -- Ohne FK: das Protokoll überlebt gelöschte Konten/Läufe.
  actor uuid not null,
  action text not null check (action in ('ban', 'unban', 'rename', 'delete_run')),
  target_user uuid,
  target_run uuid,
  detail jsonb not null default '{}'::jsonb
);
create index admin_audit_at_idx on private.admin_audit (at desc, id desc);
create index admin_audit_target_idx on private.admin_audit (target_user, at desc);
alter table private.admin_audit enable row level security;
revoke all on table private.admin_audit from public, anon, authenticated, service_role;

-- "Neueste zuerst" für admin_list_runs.
create index runs_created_idx on public.runs (created_at desc, id desc);

-- Rollenprüfung: Dev und nicht gebannt, sonst 42501.
create function private.require_dev(p_uid uuid)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_uid is null or not exists (
    select 1 from public.profiles p where p.id = p_uid and p.role = 'dev' and not p.is_banned
  ) then
    raise exception 'forbidden: dev role required' using errcode = '42501';
  end if;
end;
$$;
revoke all on function private.require_dev(uuid) from public, anon, authenticated;

-- Begründung säubern: getrimmt, 1–200 Zeichen; leer → null (bzw. Fehler, wenn Pflicht).
create function private.clean_reason(p_reason text, p_required boolean)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  r text := nullif(btrim(regexp_replace(coalesce(p_reason, ''), '[[:cntrl:]]', ' ', 'g')), '');
begin
  if r is null and p_required then
    raise exception 'invalid: reason required' using errcode = '22023';
  end if;
  if r is not null and char_length(r) > 200 then
    raise exception 'invalid: reason longer than 200 characters' using errcode = '22023';
  end if;
  return r;
end;
$$;
revoke all on function private.clean_reason(text, boolean) from public, anon, authenticated;

-- Spielerzeilen für die Admin-Sicht (gemeinsam für Liste, Bann, Umbenennen). Ohne eigene Rollenprüfung —
-- nur aus den geprüften public.admin_*-Funktionen aufrufen (private ist nicht exponiert, EXECUTE niemandem).
create function private.admin_player_rows(p_user uuid, p_search text, p_banned_only boolean, p_limit integer, p_offset integer)
returns table (
  user_id uuid, display_name text, discord_name text, avatar_url text, role text,
  is_banned boolean, ban_reason text, banned_at timestamptz, created_at timestamptz, runs bigint, total bigint
)
language sql
stable
set search_path = ''
as $$
  with hit as (
    select p.*
    from public.profiles p
    where (p_user is null or p.id = p_user)
      and (not coalesce(p_banned_only, false) or p.is_banned)
      and (nullif(btrim(coalesce(p_search, '')), '') is null
           or position(lower(btrim(p_search)) in lower(p.display_name)) > 0
           or position(lower(btrim(p_search)) in lower(coalesce(p.discord_name, ''))) > 0
           or p.id::text = btrim(p_search))
  )
  select h.id, h.display_name, h.discord_name, h.avatar_url, h.role, h.is_banned, h.ban_reason, h.banned_at, h.created_at,
         (select count(*) from public.runs r where r.user_id = h.id),
         count(*) over ()
  from hit h
  order by h.created_at desc, h.id
  limit least(greatest(coalesce(p_limit, 50), 0), 200)
  offset greatest(coalesce(p_offset, 0), 0);
$$;
revoke all on function private.admin_player_rows(uuid, text, boolean, integer, integer) from public, anon, authenticated;

-- ------------------------------------------------------------------ öffentliche Admin-RPCs (nur Devs)

-- Läufe, neueste zuerst; Filter Level und/oder Spieler. total = Treffer insgesamt (für Seiten).
create function public.admin_list_runs(p_level text default null, p_user uuid default null, p_limit integer default 50, p_offset integer default 0)
returns table (
  run_id uuid, user_id uuid, display_name text, role text, is_banned boolean,
  level_id text, level_hash text, physics_version integer, time_ms integer, ticks integer,
  created_at timestamptz, replay_path text, replay_bytes integer, is_best boolean, total bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_dev((select auth.uid()));
  return query
    select r.id, r.user_id, p.display_name, p.role, p.is_banned,
           r.level_id, r.level_hash, r.physics_version, r.time_ms, r.ticks,
           r.created_at, r.replay_path, r.replay_bytes,
           exists (select 1 from public.best_runs b where b.run_id = r.id),
           count(*) over ()
    from public.runs r
    join public.profiles p on p.id = r.user_id
    where (p_level is null or r.level_id = p_level)
      and (p_user is null or r.user_id = p_user)
    order by r.created_at desc, r.id desc
    limit least(greatest(coalesce(p_limit, 50), 0), 200)
    offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

-- Spieler (auch gebannte), Suche in Anzeige-/Discord-Name oder exakte ID.
create function public.admin_list_players(p_search text default null, p_banned_only boolean default false, p_limit integer default 50, p_offset integer default 0)
returns table (
  user_id uuid, display_name text, discord_name text, avatar_url text, role text,
  is_banned boolean, ban_reason text, banned_at timestamptz, created_at timestamptz, runs bigint, total bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_dev((select auth.uid()));
  return query select * from private.admin_player_rows(null, p_search, p_banned_only, p_limit, p_offset);
end;
$$;

-- Bannen/Entbannen. Bann braucht eine Begründung; sich selbst oder andere Devs bannen geht nicht.
-- Der Trigger profiles_apply_ban blendet die best_runs aus/ein, claim_submit_slot lehnt Einreichungen ab.
create function public.admin_set_ban(p_user uuid, p_banned boolean, p_reason text default null)
returns table (
  user_id uuid, display_name text, discord_name text, avatar_url text, role text,
  is_banned boolean, ban_reason text, banned_at timestamptz, created_at timestamptz, runs bigint, total bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := (select auth.uid());
  target public.profiles%rowtype;
  reason text;
begin
  perform private.require_dev(actor);
  if p_banned is null then
    raise exception 'invalid: banned flag required' using errcode = '22023';
  end if;
  reason := private.clean_reason(p_reason, p_banned);
  select * into target from public.profiles p where p.id = p_user for update;
  if not found then
    raise exception 'not found: player' using errcode = 'P0002';
  end if;
  if p_banned and target.id = actor then
    raise exception 'invalid: cannot ban yourself' using errcode = '22023';
  end if;
  if p_banned and target.role = 'dev' then
    raise exception 'invalid: cannot ban a dev' using errcode = '22023';
  end if;
  if target.is_banned is distinct from p_banned or (p_banned and target.ban_reason is distinct from reason) then
    update public.profiles p
      set is_banned = p_banned,
          ban_reason = case when p_banned then reason else null end,
          banned_at = case when p_banned then coalesce(case when target.is_banned then target.banned_at end, now()) else null end
      where p.id = p_user;
    insert into private.admin_audit (actor, action, target_user, detail)
    values (actor, case when p_banned then 'ban' else 'unban' end, p_user,
            jsonb_build_object('reason', reason, 'previous_reason', target.ban_reason, 'was_banned', target.is_banned));
  end if;
  return query select * from private.admin_player_rows(p_user, null, false, 1, 0);
end;
$$;

-- Anzeigenamen moderieren. Gleiche Regeln wie display_name (private.clean_display_name: 2–16 Zeichen,
-- Buchstaben/Ziffern/Leerzeichen/_-.); die bereinigte Form wird gespeichert, null → 22023.
create function public.admin_rename_player(p_user uuid, p_name text, p_reason text default null)
returns table (
  user_id uuid, display_name text, discord_name text, avatar_url text, role text,
  is_banned boolean, ban_reason text, banned_at timestamptz, created_at timestamptz, runs bigint, total bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor uuid := (select auth.uid());
  old_name text;
  clean text;
  reason text;
begin
  perform private.require_dev(actor);
  reason := private.clean_reason(p_reason, false);
  clean := private.clean_display_name(p_name);
  if clean is null then
    raise exception 'invalid: name (2-16 letters, digits, space, _ - .)' using errcode = '22023';
  end if;
  select p.display_name into old_name from public.profiles p where p.id = p_user for update;
  if not found then
    raise exception 'not found: player' using errcode = 'P0002';
  end if;
  if old_name is distinct from clean then
    update public.profiles p set display_name = clean where p.id = p_user;
    insert into private.admin_audit (actor, action, target_user, detail)
    values (actor, 'rename', p_user, jsonb_build_object('from', old_name, 'to', clean, 'reason', reason));
  end if;
  return query select * from private.admin_player_rows(p_user, null, false, 1, 0);
end;
$$;

-- Protokoll, neueste zuerst; optional nur Einträge zu einem Spieler.
create function public.admin_audit_log(p_limit integer default 50, p_offset integer default 0, p_user uuid default null)
returns table (
  id bigint, at timestamptz, actor_id uuid, actor_name text, action text,
  target_user uuid, target_name text, target_run uuid, detail jsonb, total bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_dev((select auth.uid()));
  return query
    select a.id, a.at, a.actor, pa.display_name, a.action, a.target_user, pt.display_name, a.target_run, a.detail,
           count(*) over ()
    from private.admin_audit a
    left join public.profiles pa on pa.id = a.actor
    left join public.profiles pt on pt.id = a.target_user
    where p_user is null or a.target_user = p_user or a.actor = p_user
    order by a.at desc, a.id desc
    limit least(greatest(coalesce(p_limit, 50), 0), 200)
    offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

-- Lauf löschen (Cheat/Bug). NUR service_role (Edge Function `admin`), p_actor = per auth.getUser verifizierte ID.
-- Löscht den Lauf; war er die Bestzeit seiner Tafel, wird best_runs aus den restlichen Läufen derselben Tafel neu
-- bestimmt (schnellster, bei Gleichstand der frühere) oder entfällt. Rückgabe: replay_path → die Function löscht
-- das Objekt über die Storage-API. Hinweis: Replays gibt es nur für Läufe, die beim Einreichen PB waren — die neue
-- Bestzeit kann daher ohne Ghost sein (getGhost → notFound).
create function public.admin_delete_run(p_actor uuid, p_run uuid, p_reason text)
returns table (user_id uuid, level_id text, replay_path text, was_best boolean, new_best_run_id uuid, new_best_ms integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  r public.runs%rowtype;
  reason text;
  best boolean;
  nb public.runs%rowtype;
  banned boolean;
begin
  perform private.require_dev(p_actor);
  reason := private.clean_reason(p_reason, true);
  select * into r from public.runs x where x.id = p_run;
  if not found then
    raise exception 'not found: run' using errcode = 'P0002';
  end if;
  -- Gleiche Sperre wie record_verified_run: kein gleichzeitiges Einreichen desselben Spielers dazwischen.
  perform pg_advisory_xact_lock(hashtextextended('vel-record:' || r.user_id::text, 0));
  best := exists (select 1 from public.best_runs b where b.run_id = r.id);
  delete from public.runs x where x.id = r.id; -- best_runs-Zeile fällt per FK-Cascade mit
  nb := null;
  if best then
    select * into nb from public.runs x
      where x.user_id = r.user_id and x.level_id = r.level_id and x.level_hash = r.level_hash and x.physics_version = r.physics_version
      order by x.time_ms, x.created_at, x.id
      limit 1;
    if found then
      select p.is_banned into banned from public.profiles p where p.id = r.user_id;
      insert into public.best_runs (user_id, level_id, level_hash, physics_version, run_id, time_ms, achieved_at, hidden)
      values (r.user_id, r.level_id, r.level_hash, r.physics_version, nb.id, nb.time_ms, nb.created_at, coalesce(banned, false));
    end if;
  end if;
  insert into private.admin_audit (actor, action, target_user, target_run, detail)
  values (p_actor, 'delete_run', r.user_id, r.id, jsonb_build_object(
    'reason', reason, 'level_id', r.level_id, 'level_hash', r.level_hash, 'physics_version', r.physics_version,
    'time_ms', r.time_ms, 'created_at', r.created_at, 'replay_path', r.replay_path, 'was_best', best,
    'new_best_run', nb.id, 'new_best_ms', nb.time_ms));
  return query select r.user_id, r.level_id, r.replay_path, best, nb.id, nb.time_ms;
end;
$$;

-- Grants: Supabase vergibt EXECUTE auf neue Funktionen per Default-Privileg an anon/authenticated — zurücknehmen.
revoke all on function public.admin_list_runs(text, uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.admin_list_players(text, boolean, integer, integer) from public, anon, authenticated;
revoke all on function public.admin_set_ban(uuid, boolean, text) from public, anon, authenticated;
revoke all on function public.admin_rename_player(uuid, text, text) from public, anon, authenticated;
revoke all on function public.admin_audit_log(integer, integer, uuid) from public, anon, authenticated;
revoke all on function public.admin_delete_run(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.admin_list_runs(text, uuid, integer, integer) to authenticated, service_role;
grant execute on function public.admin_list_players(text, boolean, integer, integer) to authenticated, service_role;
grant execute on function public.admin_set_ban(uuid, boolean, text) to authenticated, service_role;
grant execute on function public.admin_rename_player(uuid, text, text) to authenticated, service_role;
grant execute on function public.admin_audit_log(integer, integer, uuid) to authenticated, service_role;
grant execute on function public.admin_delete_run(uuid, uuid, text) to service_role;
