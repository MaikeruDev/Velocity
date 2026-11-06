/**
 * Schreibt out/electron/desktop-config.json für den Electron-Hauptprozess (Plan 011 Phase 2):
 * die Supabase-Origin für die CSP (connect-src) aus .env.local / VITE_SUPABASE_URL — dieselbe Quelle wie der
 * Vite-Build, damit CSP und gebündelte URL nie auseinanderlaufen. Keine Schlüssel, nur die Origin.
 *
 *   node tools/desktop/config.mjs [mode]    (mode = production | development, Default production)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from 'vite';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const mode = process.argv[2] ?? 'production';
const env = loadEnv(mode, root, 'VITE_');

let supabaseOrigin = null;
try {
  const u = new URL(env.VITE_SUPABASE_URL ?? '');
  if (u.protocol === 'https:') supabaseOrigin = u.origin;
} catch {
  // keine URL → Online am Desktop aus (Spiel fällt auf offline zurück)
}
const outDir = join(root, 'out', 'electron');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'desktop-config.json'), `${JSON.stringify({ supabaseOrigin }, null, 2)}\n`);
console.log(`desktop-config: supabaseOrigin = ${supabaseOrigin ?? '(keine)'}`);
