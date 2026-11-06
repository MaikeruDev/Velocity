-- VELOCITY Online (Plan 009, Supabase): Läufe und Bestenlisten-Tabellen (Funktionen: *_online_runs_functions.sql).
--
-- Schreiben ausschließlich durch die Edge Function submit-run (service_role, nach dem Nachspielen des
-- Replays mit dem Spiel-Verifier). Clients haben weder INSERT/UPDATE/DELETE-Grants noch Policies dafür.
-- Lesen: öffentlich (anon + authenticated) — Läufe sind Metadaten (Zeit, Level, Einstellungen), nichts Privates.
--
-- Wertung: je (level_id, level_hash, physics_version) eine eigene Tafel — ein Level-Retuning (anderer Hash)
-- oder ein Physik-Patch (PHYSICS_VERSION) macht alte Replays unprüfbar, also eigene Bestenliste (Plan 009 §6.5).
-- Rang = row_number über (time_ms, achieved_at, user_id): Gleichstand gewinnt, wer zuerst da war.

create table public.runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  level_id text not null check (level_id ~ '^[A-Za-z0-9_-]{1,32}$'),
  level_hash text not null check (char_length(level_hash) between 1 and 64),
  physics_version integer not null check (physics_version > 0),
  time_ms integer not null check (time_ms > 0),
  ticks integer not null check (ticks > 0),
  splits integer[] not null default '{}' check (cardinality(splits) <= 64),
  -- Storage-Pfad im Bucket 'replays' (nur bei persönlicher Bestzeit hochgeladen, sonst null).
  replay_path text check (replay_path is null or char_length(replay_path) <= 128),
  replay_bytes integer check (replay_bytes is null or replay_bytes between 1 and 262144),
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

comment on table public.runs is 'VELOCITY: jeder angenommene (serverseitig verifizierte) Lauf. Nur die Edge Function schreibt.';

create index runs_user_created_idx on public.runs (user_id, created_at desc);
create index runs_board_time_idx on public.runs (level_id, level_hash, time_ms);

create table public.best_runs (
  user_id uuid not null references public.profiles (id) on delete cascade,
  level_id text not null,
  level_hash text not null,
  physics_version integer not null,
  run_id uuid not null references public.runs (id) on delete cascade,
  time_ms integer not null check (time_ms > 0),
  achieved_at timestamptz not null,
  primary key (user_id, level_id, level_hash, physics_version)
);

comment on table public.best_runs is 'VELOCITY: bester Lauf je Spieler und Tafel (level_id, level_hash, physics_version). Nur die Edge Function schreibt.';

create index best_runs_board_idx on public.best_runs (level_id, level_hash, physics_version, time_ms, achieved_at, user_id);
create index best_runs_run_idx on public.best_runs (run_id);

alter table public.runs enable row level security;
alter table public.best_runs enable row level security;

revoke all on table public.runs from public, anon, authenticated;
revoke all on table public.best_runs from public, anon, authenticated;
grant select on table public.runs to anon, authenticated;
grant select on table public.best_runs to anon, authenticated;
grant all on table public.runs to service_role;
grant all on table public.best_runs to service_role;

create policy runs_select_public on public.runs
  for select to anon, authenticated
  using (true);

create policy best_runs_select_public on public.best_runs
  for select to anon, authenticated
  using (true);

-- Rate-Limit-Protokoll (später durch private.submit_counters ersetzt, siehe *_online_drop_submit_attempts.sql).
create table private.submit_attempts (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  at timestamptz not null default now()
);
create index submit_attempts_user_at_idx on private.submit_attempts (user_id, at);
alter table private.submit_attempts enable row level security;
revoke all on table private.submit_attempts from public, anon, authenticated;
grant usage on schema private to service_role;
grant select, insert, delete on table private.submit_attempts to service_role;

