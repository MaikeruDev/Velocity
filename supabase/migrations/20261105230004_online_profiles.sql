-- VELOCITY Online (Plan 009, Supabase): Spielerprofile aus Discord-Login.
--
-- Zugriff:
--   anon/authenticated  SELECT nur (id, display_name, avatar_url, created_at) — discord_name und is_banned bleiben intern
--   authenticated       UPDATE nur display_name, nur eigene Zeile, nicht gebannt
--   service_role        alles (Edge Function submit-run, Moderation im Dashboard)
-- Angelegt/aktualisiert wird die Zeile ausschließlich vom Trigger auf auth.users.
--
-- Achtung: raw_user_meta_data ist vom Nutzer änderbar (auth.updateUser({ data })). Deshalb wird hier nur
-- bereinigt übernommen (Name gefiltert/gekürzt, Avatar nur von cdn.discordapp.com) und display_name nach dem
-- ersten Anlegen nie wieder aus den Metadaten überschrieben. Keine Autorisierung hängt an diesen Feldern.

create schema if not exists private;
revoke all on schema private from public;
revoke all on schema private from anon, authenticated;

-- Name wie im Client (online/types.sanitizeName): Buchstaben/Ziffern/Leerzeichen/_-. , 2–16 Zeichen, sonst null.
create or replace function private.clean_display_name(raw text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when char_length(c) >= 2 then c else null end
  from (
    select rtrim(left(btrim(regexp_replace(regexp_replace(coalesce(raw, ''), '[^[:alnum:] _.-]', '', 'g'), '\s+', ' ', 'g')), 16)) as c
  ) s;
$$;

-- "SPIELER-3F2A" wie online/types.displayName.
create or replace function private.fallback_name(uid uuid)
returns text
language sql
immutable
set search_path = ''
as $$
  select 'SPIELER-' || upper(right(replace(uid::text, '-', ''), 4));
$$;

-- Nur Discord-CDN-Avatare (Metadaten sind nutzerseitig änderbar — keine fremden URLs in die Bestenliste).
create or replace function private.clean_avatar(raw text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when raw ~ '^https://cdn\.discordapp\.com/[A-Za-z0-9_./?=&-]{1,200}$' then raw
    else null
  end;
$$;

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null
    constraint profiles_display_name_check
    check (char_length(display_name) between 2 and 16 and display_name ~ '^[[:alnum:] _.-]+$' and display_name = btrim(display_name)),
  discord_name text check (discord_name is null or char_length(discord_name) <= 64),
  avatar_url text check (avatar_url is null or char_length(avatar_url) <= 256),
  is_banned boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is 'VELOCITY: Spielerprofil (1:1 auth.users, aus Discord-Metadaten). Öffentlich lesbar: id, display_name, avatar_url, created_at.';

alter table public.profiles enable row level security;

-- Grants: Supabase gibt anon/authenticated per Default-Privileg ALLES auf neue Tabellen in public — zurücknehmen
-- und spaltengenau neu vergeben.
revoke all on table public.profiles from public, anon, authenticated;
grant select (id, display_name, avatar_url, created_at) on table public.profiles to anon, authenticated;
grant update (display_name) on table public.profiles to authenticated;
grant all on table public.profiles to service_role;

create policy profiles_select_public on public.profiles
  for select to anon, authenticated
  using (true);

create policy profiles_update_own_name on public.profiles
  for update to authenticated
  using ((select auth.uid()) = id and not is_banned)
  with check ((select auth.uid()) = id and not is_banned);

-- updated_at pflegen
create or replace function private.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function private.touch_updated_at();

-- auth.users → profiles. SECURITY DEFINER (läuft als Eigentümer, weil supabase_auth_admin keine Rechte auf
-- public.profiles hat), fester search_path, im nicht exponierten Schema private, EXECUTE niemandem gegeben.
create or replace function private.handle_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  global_name text := coalesce(meta #>> '{custom_claims,global_name}', meta ->> 'full_name', meta ->> 'name', meta ->> 'user_name');
  handle text := left(regexp_replace(coalesce(meta ->> 'name', meta ->> 'user_name', meta ->> 'full_name', ''), '#0$', ''), 64);
  avatar text := private.clean_avatar(coalesce(meta ->> 'avatar_url', meta ->> 'picture'));
begin
  if tg_op = 'INSERT' then
    insert into public.profiles (id, display_name, discord_name, avatar_url)
    values (
      new.id,
      coalesce(private.clean_display_name(global_name), private.clean_display_name(handle), private.fallback_name(new.id)),
      nullif(handle, ''),
      avatar
    )
    on conflict (id) do nothing;
  elsif new.raw_user_meta_data is distinct from old.raw_user_meta_data then
    -- Bei jedem Login frischt Supabase die Discord-Metadaten auf: Avatar/Handle nachziehen, display_name NIE.
    update public.profiles
      set discord_name = nullif(handle, ''), avatar_url = avatar
      where id = new.id
        and (discord_name is distinct from nullif(handle, '') or avatar_url is distinct from avatar);
  end if;
  return new;
end;
$$;

revoke all on function private.handle_auth_user() from public, anon, authenticated;
revoke all on function private.clean_display_name(text) from public, anon, authenticated;
revoke all on function private.fallback_name(uuid) from public, anon, authenticated;
revoke all on function private.clean_avatar(text) from public, anon, authenticated;
revoke all on function private.touch_updated_at() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_auth_user();

create trigger on_auth_user_updated
  after update of raw_user_meta_data on auth.users
  for each row execute function private.handle_auth_user();
