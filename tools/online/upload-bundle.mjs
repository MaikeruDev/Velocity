/**
 * Verifier-Bundle der Edge Function `submit-run` hochladen und in index.ts pinnen (Plan 009).
 *
 *   SUPABASE_SECRET_KEY=sb_secret_… node tools/online/upload-bundle.mjs
 *   (oder SUPABASE_SERVICE_ROLE_KEY=…; URL aus SUPABASE_URL bzw. VITE_SUPABASE_URL in .env.local)
 *
 * 1. node tools/online/build-function.mjs (Bundle bauen) — dieses Skript ruft es NICHT selbst auf.
 * 2. SHA-256 von supabase/functions/submit-run/verifier.bundle.js → Objekt
 *    function-assets/submit-run/verifier-<sha256>.js (privater Bucket, inhaltsadressiert, kein Überschreiben).
 * 3. BUNDLE_SHA256 in supabase/functions/submit-run/index.ts auf den neuen Wert setzen.
 * 4. Danach index.ts deployen: `npx supabase functions deploy submit-run` oder MCP deploy_edge_function.
 *
 * Der Secret-Key bleibt in der Umgebung dieses Aufrufs — nie in .env.local/VITE_* (das landet im Browser-Bundle).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const fnDir = join(root, 'supabase', 'functions', 'submit-run');
const bundlePath = join(fnDir, 'verifier.bundle.js');
const indexPath = join(fnDir, 'index.ts');

function envLocal(name) {
  const p = join(root, '.env.local');
  if (!existsSync(p)) return undefined;
  const line = readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .find((l) => l.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1).trim() : undefined;
}

const url = process.env.SUPABASE_URL ?? envLocal('VITE_SUPABASE_URL');
const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('SUPABASE_URL (oder VITE_SUPABASE_URL in .env.local) und SUPABASE_SECRET_KEY/SUPABASE_SERVICE_ROLE_KEY setzen.');
  process.exit(2);
}

const bytes = readFileSync(bundlePath);
const sha = createHash('sha256').update(bytes).digest('hex');
const objectPath = `submit-run/verifier-${sha}.js`;
// Neue Secret-Keys (sb_secret_) sind keine JWTs: nur im apikey-Header; Legacy-Keys zusätzlich als Bearer.
const headers = { apikey: key, 'Content-Type': 'text/javascript', 'x-upsert': 'false' };
if (!key.startsWith('sb_')) headers.Authorization = `Bearer ${key}`;
const res = await fetch(`${url}/storage/v1/object/function-assets/${objectPath}`, { method: 'POST', headers, body: bytes });
const text = await res.text();
if (!res.ok && !(res.status === 400 && /exists|Duplicate/i.test(text)) && res.status !== 409) {
  console.error(`Upload fehlgeschlagen (${res.status}): ${text}`);
  process.exit(1);
}
console.log(res.ok ? `hochgeladen: function-assets/${objectPath} (${bytes.length} B)` : `schon vorhanden: function-assets/${objectPath}`);

const src = readFileSync(indexPath, 'utf8');
const next = src.replace(/const BUNDLE_SHA256 = '[0-9a-f]{64}';/, `const BUNDLE_SHA256 = '${sha}';`);
if (next === src && !src.includes(sha)) {
  console.error('BUNDLE_SHA256 in index.ts nicht gefunden');
  process.exit(1);
}
writeFileSync(indexPath, next);
console.log(`index.ts: BUNDLE_SHA256 = ${sha}`);
console.log('Jetzt index.ts deployen (npx supabase functions deploy submit-run  bzw. MCP deploy_edge_function).');
