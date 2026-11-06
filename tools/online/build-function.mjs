/**
 * Baut das Verifier-Bundle der Supabase Edge Function `submit-run` (Plan 009).
 *
 *   node tools/online/build-function.mjs            → supabase/functions/submit-run/verifier.bundle.js
 *   node tools/online/build-function.mjs --check    → zusätzlich die größten Anteile am Bundle ausgeben
 *   node tools/online/build-function.mjs --out f.js → woanders hin (tests/submitFunction.test.ts)
 *
 * Eine ESM-Datei (platform neutral, kein Node-API), darin: tools/online/function-entry.ts → SubmissionVerifier
 * (src/engine/replay/verify.ts + Physik + compileLevel + three, tree-shaken) und die Level aus public/levels
 * (index.json; virtuelles Modul `velocity:levels`). Deno lädt das Bundle aus index.ts (der Handler). Nach jeder
 * Änderung an Physik/Leveln/Replay neu bauen UND neu deployen — sonst prüft der Server mit altem Stand.
 */
import { build } from 'esbuild';
import { readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const levelDir = join(root, 'public', 'levels');
const outArg = process.argv.indexOf('--out');
/** --out <datei>: woanders hin bauen (Test: frisches Bundle mit dem eingecheckten vergleichen). */
const outFile = outArg >= 0 ? resolve(process.argv[outArg + 1]) : join(root, 'supabase', 'functions', 'submit-run', 'verifier.bundle.js');

const index = JSON.parse(readFileSync(join(levelDir, 'index.json'), 'utf8'));
const entries = index.map((e) => ({ id: e.id, file: e.file }));

/** `import levels from 'velocity:levels'` → { level1: <json>, … } aus index.json. */
const levelsPlugin = {
  name: 'velocity-levels',
  setup(b) {
    b.onResolve({ filter: /^velocity:levels$/ }, () => ({ path: 'velocity:levels', namespace: 'velocity-levels' }));
    b.onLoad({ filter: /.*/, namespace: 'velocity-levels' }, () => ({
      contents:
        entries.map((e, i) => `import l${i} from ${JSON.stringify(join(levelDir, e.file).replace(/\\/g, '/'))};`).join('\n') +
        `\nexport default { ${entries.map((e, i) => `${JSON.stringify(e.id)}: l${i}`).join(', ')} };\n`,
      resolveDir: levelDir,
      loader: 'js',
    }));
  },
};

/**
 * `three` → nur die Mathe-Klassen, die die Prüfkette wirklich nutzt (Vector3, Box3). Das Paket-Hauptmodul hat
 * Seiteneffekte (Renderer-Registrierung) und bliebe sonst mit ~250 KB im Bundle. Braucht der Code später eine
 * weitere three-Klasse, scheitert der Build hier laut (fehlender Export) — dann unten ergänzen.
 */
const threeMathPlugin = {
  name: 'three-math-only',
  setup(b) {
    b.onResolve({ filter: /^three$/ }, () => ({ path: 'three-math', namespace: 'three-math' }));
    b.onLoad({ filter: /.*/, namespace: 'three-math' }, () => ({
      contents: ["export { Vector3 } from 'three/src/math/Vector3.js';", "export { Box3 } from 'three/src/math/Box3.js';"].join('\n'),
      resolveDir: root,
      loader: 'js',
    }));
  },
};

const res = await build({
  entryPoints: [join(root, 'tools', 'online', 'function-entry.ts')],
  outfile: outFile,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  mainFields: ['module', 'main'],
  conditions: ['import', 'module'],
  minify: true,
  legalComments: 'none',
  // Kein import.meta.env im Server — Vite-Variablen gibt es dort nicht.
  define: { 'import.meta.env': '{}' },
  banner: { js: `// GENERIERT von tools/online/build-function.mjs — nicht von Hand ändern. Level: ${entries.map((e) => e.id).join(', ')}` },
  plugins: [levelsPlugin, threeMathPlugin],
  metafile: true,
  logLevel: 'warning',
});

const size = statSync(outFile).size;
console.log(`${basename(outFile)}: ${(size / 1024).toFixed(0)} KB, Level: ${entries.map((e) => e.id).join(', ')}`);
if (process.argv.includes('--check')) {
  // Anteil je Quelle AM BUNDLE (nach Tree-Shaking/Minify), nicht die Quellgröße.
  const out = Object.values(res.metafile.outputs)[0];
  const inputs = Object.entries(out.inputs)
    .map(([k, v]) => [k, v.bytesInOutput])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  for (const [k, n] of inputs) console.log(`  ${(n / 1024).toFixed(0).padStart(5)} KB  ${k}`);
}
