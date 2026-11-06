-- VELOCITY Online (Plan 009): Profile NUR für Discord-Konten (Verteidigung in der Tiefe).
--
-- Das Spiel meldet ausschließlich per Discord an. Bleibt im Dashboard aber z. B. der E-Mail-Anbieter an, könnte sich
-- jeder mit dem öffentlichen anon-Key per auth.signUp ein Konto anlegen. Ohne Profil gibt claim_submit_slot
-- 'noprofile' zurück → die Edge Function lehnt ab (403). Maßgeblich ist raw_app_meta_data (nur vom Auth-Server
-- gesetzt, NICHT vom Nutzer änderbar), nicht raw_user_meta_data.
create or replace function private.handle_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  app jsonb := coalesce(new.raw_app_meta_data, '{}'::jsonb);
  is_discord boolean := app ->> 'provider' = 'discord' or coalesce(app -> 'providers', '[]'::jsonb) ? 'discord';
  global_name text := coalesce(meta #>> '{custom_claims,global_name}', meta ->> 'full_name', meta ->> 'name', meta ->> 'user_name');
  handle text := left(regexp_replace(coalesce(meta ->> 'name', meta ->> 'user_name', meta ->> 'full_name', ''), '#0$', ''), 64);
  avatar text := private.clean_avatar(coalesce(meta ->> 'avatar_url', meta ->> 'picture'));
begin
  if not is_discord then
    return new;
  end if;
  insert into public.profiles (id, display_name, discord_name, avatar_url)
  values (
    new.id,
    coalesce(private.clean_display_name(global_name), private.clean_display_name(handle), private.fallback_name(new.id)),
    nullif(handle, ''),
    avatar
  )
  on conflict (id) do update
    -- Bei jedem Login frischt Supabase die Discord-Metadaten auf: Avatar/Handle nachziehen, display_name NIE.
    set discord_name = excluded.discord_name, avatar_url = excluded.avatar_url
    where public.profiles.discord_name is distinct from excluded.discord_name
       or public.profiles.avatar_url is distinct from excluded.avatar_url;
  return new;
end;
$$;

revoke all on function private.handle_auth_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_updated on auth.users;
create trigger on_auth_user_updated
  after update of raw_user_meta_data, raw_app_meta_data on auth.users
  for each row execute function private.handle_auth_user();
