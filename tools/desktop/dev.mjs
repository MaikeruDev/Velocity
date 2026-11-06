/**
 * desktop:dev — Electron gegen den Vite-Dev-Server (Port 5173, HMR), mit --dev (DevTools).
 * Kompiliert vorher electron/ (tsc) und die Desktop-Konfiguration. Schließt Vite, sobald Electron endet.
 *
 *   npm run desktop:dev [-- <weitere Electron-Schalter>]
 */
import { execFileSync, spawn } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const require = createRequire(import.meta.url);

let electronPath;
try {
  electronPath = require('electron');
} catch (e) {
  // Node < 22.12: electron/install.js lädt @electron/get (ESM) per require und scheitert still (fallen.md).
  console.error(`Electron-Binary fehlt: ${e instanceof Error ? e.message : e}\n` +
    '→ cd node_modules/electron && node --experimental-require-module install.js');
  process.exit(1);
}

execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'electron'], { cwd: root, stdio: 'inherit' });
execFileSync(process.execPath, ['tools/desktop/config.mjs', 'development'], { cwd: root, stdio: 'inherit' });

// Steam (Plan 011 Phase 4): steam_appid.txt NUR hier, im Arbeitsordner von Electron, und nur mit --steam — beim Ende
// wieder weg. Im Build ist sie verboten (tools/desktop/check-build.mjs): ausgeliefert nagelte sie die App-ID fest und
// hebelte den Neustart über Steam aus (SteamAPI_RestartAppIfNecessary gibt mit ihr immer false).
const extra = process.argv.slice(2);
const appIdFile = resolve(root, 'steam_appid.txt');
const wantsSteam = extra.includes('--steam') || process.env.VELOCITY_STEAM === '1';
if (wantsSteam) writeFileSync(appIdFile, '480\n');
const dropAppId = () => {
  if (wantsSteam) rmSync(appIdFile, { force: true });
};
process.on('exit', dropAppId);
// Strg+C beendet ohne 'exit'-Ereignis — die Datei soll trotzdem nicht liegen bleiben.
process.on('SIGINT', () => process.exit(130));

const vite = await createServer({ root, configFile: resolve(root, 'vite.config.ts') });
await vite.listen();
const url = 'http://localhost:5173/';
console.log(`Vite: ${url}`);

const child = spawn(electronPath, ['.', '--dev', `--dev-url=${url}`, ...extra], { cwd: root, stdio: 'inherit' });
child.on('exit', async (code) => {
  await vite.close();
  process.exit(code ?? 0);
});
