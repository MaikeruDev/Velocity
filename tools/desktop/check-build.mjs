/**
 * Prüft das Desktop-Paket nach electron-builder (Plan 011 Phase 4, letzter Schritt von `npm run desktop:build`):
 *  - steam_appid.txt NIE im Build (gehört nur zu desktop:dev): nicht in dist/, out/, release/win-unpacked — auch
 *    nicht im app.asar. Ausgeliefert nagelte sie die App-ID fest und hebelte den Start über Steam aus.
 *  - steam_api64.dll neben der exe; steamworks-Binding + DLL entpackt (app.asar.unpacked), sonst lädt Windows sie nicht.
 *  - aus node_modules nur steamworks.js (package.json, index.js, win64) — three/supabase stecken im Vite-Bundle,
 *    @types/node (Abhängigkeit von steamworks.js) gehört nicht ins Spiel.
 *
 *   node tools/desktop/check-build.mjs [release/win-unpacked]    → Exit 1 bei Verstoß
 */
import { existsSync, openSync, readSync, closeSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const out = resolve(root, process.argv[2] ?? 'release/win-unpacked');
const APPID = 'steam_appid.txt';
const BINDING = 'node_modules/steamworks.js/dist/win64/steamworksjs.win32-x64-msvc.node';
const DLL = 'node_modules/steamworks.js/dist/win64/steam_api64.dll';
const ALLOWED_MODULES = new Set(['node_modules/steamworks.js/package.json', 'node_modules/steamworks.js/index.js', BINDING, DLL]);

const errors = [];
const fail = (msg) => errors.push(msg);

/** Alle Dateien unter dir (relativ, mit /). */
function walk(dir, base = dir) {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files.push(...walk(p, base));
    else files.push(relative(base, p).split('\\').join('/'));
  }
  return files;
}

/**
 * Dateiliste eines asar-Archivs ohne Zusatzpaket: Kopf = Pickle [4][Kopfgröße], dann Pickle [Nutzlast][Länge][JSON].
 * Rückgabe: Pfade mit Merker, ob die Datei entpackt (app.asar.unpacked) liegt.
 */
function asarFiles(file) {
  const fd = openSync(file, 'r');
  try {
    const head = Buffer.alloc(16);
    readSync(fd, head, 0, 16, 0);
    const len = head.readUInt32LE(12);
    const json = Buffer.alloc(len);
    readSync(fd, json, 0, len, 16);
    const tree = JSON.parse(json.toString('utf8'));
    const list = [];
    const visit = (node, prefix) => {
      for (const [name, child] of Object.entries(node.files ?? {})) {
        const p = prefix ? `${prefix}/${name}` : name;
        if (child.files) visit(child, p);
        else list.push({ path: p, unpacked: child.unpacked === true });
      }
    };
    visit(tree, '');
    return list;
  } finally {
    closeSync(fd);
  }
}

// 1) steam_appid.txt nirgends im Build (und nicht in den Eingaben des asar)
for (const [label, dir] of [['dist/', join(root, 'dist')], ['out/', join(root, 'out')], ['release/win-unpacked/', out]]) {
  for (const f of walk(dir)) if (f.split('/').pop()?.toLowerCase() === APPID) fail(`${APPID} in ${label}${f} — gehört nur zu desktop:dev`);
}
const asar = join(out, 'resources', 'app.asar');
if (!existsSync(asar)) fail(`${relative(root, asar)} fehlt — erst electron-builder`);
else {
  const inAsar = asarFiles(asar);
  for (const f of inAsar) if (f.path.split('/').pop()?.toLowerCase() === APPID) fail(`${APPID} im app.asar (${f.path})`);
  // 2) node_modules: nur steamworks.js, Binding + DLL entpackt
  const mods = inAsar.filter((f) => f.path.startsWith('node_modules/'));
  for (const f of mods) if (!ALLOWED_MODULES.has(f.path)) fail(`unerwartet im app.asar: ${f.path}`);
  for (const need of ALLOWED_MODULES) if (!mods.some((f) => f.path === need)) fail(`fehlt im app.asar: ${need}`);
  for (const p of [BINDING, DLL]) {
    const e = mods.find((f) => f.path === p);
    if (e && !e.unpacked) fail(`${p} liegt gepackt im asar (Windows lädt es dort nicht)`);
    if (!existsSync(join(out, 'resources', 'app.asar.unpacked', ...p.split('/')))) fail(`app.asar.unpacked/${p} fehlt`);
  }
  console.log(`app.asar: ${inAsar.length} Dateien, davon node_modules: ${mods.map((f) => f.path.replace('node_modules/', '') + (f.unpacked ? ' (entpackt)' : '')).join(', ')}`);
}
// 3) DLL neben der exe
if (!existsSync(join(out, 'VELOCITY.exe'))) fail('VELOCITY.exe fehlt');
if (!existsSync(join(out, 'steam_api64.dll'))) fail('steam_api64.dll fehlt neben VELOCITY.exe');

if (errors.length) {
  console.error(`check-build: ${errors.length} Verstoß/Verstöße\n  - ${errors.join('\n  - ')}`);
  process.exit(1);
}
console.log(`check-build: ok — kein ${APPID}, steam_api64.dll neben der exe, Binding entpackt (${relative(root, out)})`);
