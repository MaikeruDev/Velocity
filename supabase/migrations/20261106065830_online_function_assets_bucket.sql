-- VELOCITY Online (Plan 009, Supabase): privater Bucket für Function-Artefakte.
--
-- Warum: das Verifier-Bundle der Edge Function submit-run (verifier.bundle.js, ~680 KB, davon ~610 KB Level-JSON)
-- ist zu groß, um es über die MCP-Deploy-Schnittstelle als Text zu übertragen. index.ts (klein) lädt es beim
-- Kaltstart von hier (service_role) und prüft den SHA-256 gegen den in index.ts fest eingetragenen Wert — ein
-- fremdes/verändertes Bundle wird nie ausgeführt. Pfad: submit-run/verifier-<sha256>.js (inhaltsadressiert).
-- Privat, keine Policies: lesen/schreiben nur service_role (tools/online/upload-bundle.mjs mit Secret-Key).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('function-assets', 'function-assets', false, 4194304, array['text/javascript'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
