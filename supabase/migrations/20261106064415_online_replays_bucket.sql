-- VELOCITY Online (Plan 009, Supabase): Storage-Bucket für Replays (Ghosts).
--
-- Öffentlich LESBAR über die Public-URL (/storage/v1/object/public/replays/<level>/<run>.vrp), damit Ghosts
-- ohne Login ladbar sind. Bewusst KEINE Policies auf storage.objects: ohne SELECT-Policy kann niemand den
-- Bucket auflisten, ohne INSERT/UPDATE/DELETE-Policy schreibt nur service_role (Edge Function submit-run).
-- Limit 256 KB (ein 20-min-Lauf liegt gepackt bei ~250 KB, typische Läufe bei 2–15 KB).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('replays', 'replays', true, 262144, array['application/octet-stream'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
