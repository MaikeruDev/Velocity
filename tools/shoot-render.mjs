/**
 * Screenshots der Render-Vorschau (dev/render.html) nach shots/render/.
 *
 *   node tools/shoot-render.mjs            alle Perspektiven + Benchmark
 *   node tools/shoot-render.mjs start hop  nur Shots, deren Name einen der Filter enthält
 *   node tools/shoot-render.mjs --no-bench
 *   node tools/shoot-render.mjs --crop <name> "<query>" x y w h   Ausschnitt in Originalpixeln
 *   node tools/shoot-render.mjs --trim-sweep [--defaults] [--query "snap=1"]
 *                                             Trim-Kanten im Anlauf (Exit 1 bei Lücken)
 *   node tools/shoot-render.mjs --fx [--only r1,r2,r4,r5,id] [--save DIR] [--compare DIR]
 *                                             Messungen der Game-Feel-Effekte (Plan 003, Strang render):
 *                                             Speed-Streifen, Trim-Welle/Tempostufe, Ghost, Niedrige Latenz,
 *                                             Pixelgleichheit gegen gespeicherte Rohbilder (--save/--compare)
 *   node tools/shoot-render.mjs --flow [--node 33]
 *                                             Kick-Puls/Gesamtbild-Schwankung im echten Spiel (Bot bis Route-
 *                                             Knoten N im schnellen Teil, eingefroren; measure-pulse-Methode
 *                                             aus tools/critique/look)
 *
 * Eigener Port 5181, per RENDER_PORT änderbar (parallele Stränge nutzen andere Ports).
 * Bricht mit Exit 1 ab, wenn die Browser-Konsole WebGL-/Shader-Fehler meldet.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, startDevServer } from './lib/devServer.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

const PORT = Number(process.env.RENDER_PORT ?? 5181);
const OUT = 'shots/render';
const W = 1920;
const H = 1080;

/** --fx: Blickpunkte in echten Leveln (Augenposition, Grad). Vor dem Dispatch unten definiert (TDZ). */
const FX_VIEWS = {
  start: { level: 'level1', pos: [0, 64, 224], yaw: 0, pitch: -5 },
  hops: { level: 'level1', pos: [0, 192, -1880], yaw: 0, pitch: -8 },
  kehre: { level: 'level1', pos: [-92, 256, -5245], yaw: 35, pitch: -8 },
  fall: { level: 'level1', pos: [0, 700, -3000], yaw: 0, pitch: -55 },
  l2: { level: 'level2', pos: [-2528, 224, 1280], yaw: -90, pitch: -6 },
  sbhops: { level: 'sandbox', pos: [0, 64, -700], yaw: 0, pitch: -10 },
};

/** t fest → Kick/Scanlines/Sterne reproduzierbar. kick fest auf mittleren Wert. */
const SHOTS = [
  { name: '01-start', q: 'pos=0,64,180&yaw=0&pitch=-8' },
  { name: '02-hops', q: 'pos=0,64,-700&yaw=0&pitch=-10&speed=0.45' },
  { name: '03-surf-side', q: 'pos=-280,40,330&yaw=158&pitch=-14' },
  { name: '04-surf-on', q: 'pos=-540,-50,480&yaw=180&pitch=-12&speed=0.7' },
  { name: '05-fall-grid', q: 'pos=200,250,-2650&yaw=0&pitch=-50&speed=0.6' },
  { name: '06-speed1', q: 'pos=0,64,-280&yaw=0&pitch=-6&speed=1' },
  { name: '07-ph240', q: 'pos=0,64,180&yaw=0&pitch=-8&ph=240' },
  { name: '08-ph360', q: 'pos=0,64,180&yaw=0&pitch=-8&ph=360' },
  { name: '09-yard', q: 'pos=150,110,720&yaw=-48&pitch=-12' },
  { name: '10-overview', q: 'pos=-1300,900,1500&yaw=-36&pitch=-18' },
  { name: '11-hud-flash', q: 'pos=0,64,180&yaw=0&pitch=-8&hud=1&flash=0.25' },
  { name: '12-sunset', q: 'pos=0,64,-2176&yaw=-30&pitch=4' },
  { name: '16-l1-start', q: 'level=level1&pos=0,64,224&yaw=0&pitch=-5' },
  { name: '17-l1-cp1', q: 'level=level1&pos=0,200,-1450&yaw=0&pitch=-8&speed=0.5' },
  { name: '18-l1-overview', q: 'level=level1&pos=1500,1500,1500&yaw=26&pitch=-17' },
  { name: '19-l1-cp2', q: 'level=level1&pos=0,260,-4000&yaw=40&pitch=-6' },
  // Respawn-/Spawn-Blicke: Chevrons müssen in Laufrichtung zeigen (CP3 yaw 180, level2 yaw −90).
  { name: '21-l1-cp3-respawn', q: 'level=level1&pos=-1493,256,-4167&yaw=180&pitch=-30' },
  { name: '22-l2-spawn-down', q: 'level=level2&pos=-2528,224,1280&yaw=-90&pitch=-45' },
  { name: '23-l2-spawn', q: 'level=level2&pos=-2528,224,1280&yaw=-90&pitch=-6' },
  { name: '13-materials', q: 'level=__materials&pos=1700,420,900&yaw=0&pitch=-24' },
  { name: '14-mat-close', q: 'level=__materials&pos=600,120,380&yaw=0&pitch=-18' },
  { name: '15-mat-row2', q: 'level=__materials&pos=1400,200,-100&yaw=20&pitch=-22' },
];

const args = process.argv.slice(2);

if (args[0] === '--fx') process.exit(await fxMode(args.slice(1)));
if (args[0] === '--flow') process.exit(await flowMode(Number(optArg(args, '--node') ?? 33)));

if (args[0] === '--crop') {
  // Einzelner Ausschnitt in Originalpixeln — zum genauen Ansehen von Kanten/Dithering.
  const [, name, query, x, y, w, h] = args;
  mkdirSync(OUT, { recursive: true });
  const srv = await startDevServer(PORT);
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    const q = query.includes('t=') ? query : `${query}&t=1.23&kick=0.4`;
    await page.goto(`${srv.url}dev/render.html?${q}`);
    await page.waitForFunction(() => window.__renderReady === true || typeof window.__renderError === 'string', null, {
      timeout: 60000,
    });
    await page.screenshot({ path: `${OUT}/${name}.png`, clip: { x: +x, y: +y, width: +w, height: +h } });
    console.log(`${OUT}/${name}.png`);
  } finally {
    await browser.close();
    await srv.close();
  }
  process.exit(0);
}

if (args[0] === '--trim-sweep') {
  // Trim-Lesbarkeit im Anlauf: Kamera läuft in 4-u-Schritten entlang −Z (z −100 … −1100,
  // Nah-Fall auf hop2 selbst bis −1500),
  // pro Position wird geprüft, ob die Kante als durchgehende Linie im Bild steht.
  // '#' = volle Linie, '+' = Lücke. Default dither=0/bits=8 (wie im Review);
  // --defaults prüft mit den Spiel-Einstellungen, --query "snap=1&ph=360" hängt an.
  const defaults = args.includes('--defaults');
  const qi = args.indexOf('--query');
  const userQuery = qi >= 0 ? `&${args[qi + 1]}` : '';
  const srv = await startDevServer(PORT);
  const browser = await launchBrowser();
  let bad = 0;
  try {
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    const problems = [];
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') problems.push(m.text());
    });
    const extra = (defaults ? '' : '&dither=0&bits=8') + userQuery;
    await page.goto(`${srv.url}dev/render.html?pos=0,64,0&t=1.23&kick=0.4${extra}`);
    await page.waitForFunction(() => window.__renderReady === true, null, { timeout: 60000 });
    const cyan = '#33f0ff';
    const back = { a: [-128, 0, -1600], b: [128, 0, -1600] };
    const cases = [
      { name: 'hop2 hinten', ...back },
      { name: 'hop2 hinten pitch -10', ...back, pitch: -10 },
      { name: 'hop2 hinten Sprung y=121', ...back, y: 121 },
      { name: 'hop2 hinten geduckt y=46', ...back, y: 46 },
      { name: 'hop2 hinten x=70 yaw 8', ...back, x: 70, yaw: 8 },
      { name: 'hop2 hinten nah (auf hop2)', ...back, zFrom: -1100, zTo: -1500 },
      { name: 'hop2 vorn', a: [-128, 0, -1344], b: [128, 0, -1344] },
      { name: 'hop2 rechts (Seite)', a: [128, 0, -1352], b: [128, 0, -1592] },
      { name: 'hop2 links, x=-60 yaw -6', a: [-128, 0, -1352], b: [-128, 0, -1592], x: -60, yaw: -6 },
      { name: 'hop3 hinten (Checkpoint)', a: [-128, 0, -2176], b: [128, 0, -2176], color: '#ffc23d' },
    ];
    for (const c of cases) {
      let pattern = '';
      let full = 0;
      let n = 0;
      let worst = 0;
      let thick = 0;
      let cols = 0;
      for (let z = c.zFrom ?? -100; z >= (c.zTo ?? -1100); z -= 4) {
        const r = await page.evaluate((p) => window.__renderEdgeCoverage(p), {
          pos: [c.x ?? 0, c.y ?? 64, z],
          yaw: c.yaw ?? 0,
          pitch: c.pitch ?? 0,
          a: c.a,
          b: c.b,
          color: c.color ?? cyan,
        });
        // Kante kürzer als die Randauslassung (fern, seitlich): nichts zu prüfen.
        if (r.columns > 0) n++;
        if (r.maxGap === 0 && r.columns > 0) full++;
        worst = Math.max(worst, r.maxGap);
        thick += r.thick;
        cols += r.columns;
        pattern += r.columns === 0 ? '.' : r.maxGap === 0 ? '#' : '+';
      }
      const thickPct = cols ? ((100 * thick) / cols).toFixed(0) : '-';
      console.log(`${c.name.padEnd(28)} volle Linie ${full}/${n}, größte Lücke ${worst} px, >1 px dick ${thickPct} %`);
      for (let i = 0; i < pattern.length; i += 84) console.log(`   ${pattern.slice(i, i + 84)}`);
      if (full !== n) bad++;
    }
    if (problems.length) {
      console.error(`Konsole: ${problems.join(' | ')}`);
      bad++;
    }
  } finally {
    await browser.close();
    await srv.close();
  }
  process.exit(bad ? 1 : 0);
}

const filters = args.filter((a) => !a.startsWith('--'));
const bench = !args.includes('--no-bench');
const shots = filters.length ? SHOTS.filter((s) => filters.some((f) => s.name.includes(f))) : SHOTS;

mkdirSync(OUT, { recursive: true });
const srv = await startDevServer(PORT);
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const problems = [];
page.on('console', (m) => {
  const type = m.type();
  if (type === 'error' || type === 'warning') problems.push(`[${type}] ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));

let failed = false;
try {
  for (const s of shots) {
    const q = s.q.includes('t=') ? s.q : `${s.q}&t=1.23&kick=0.4`;
    await page.goto(`${srv.url}dev/render.html?${q}`);
    await page.waitForFunction(() => window.__renderReady === true || typeof window.__renderError === 'string', null, {
      timeout: 60000,
    });
    const err = await page.evaluate(() => window.__renderError ?? null);
    if (err) {
      console.error(`${s.name}: ${err}`);
      failed = true;
      continue;
    }
    await page.screenshot({ path: `${OUT}/${s.name}.png` });
    const st = await page.evaluate(() => window.__renderStats);
    const loadMs = await page.evaluate(() => window.__renderLoadMs ?? 0);
    console.log(
      `${s.name.padEnd(14)} low ${st.lowW}x${st.lowH} ×${st.scale}  calls ${st.sceneCalls}+1  tris ${st.sceneTriangles}  setLevel ${loadMs.toFixed(0)} ms`,
    );
  }

  if (bench) {
    await page.goto(`${srv.url}dev/render.html?pos=0,64,180&yaw=0&pitch=-8&speed=1`);
    await page.waitForFunction(() => window.__renderReady === true, null, { timeout: 60000 });
    await page.evaluate(() => window.__renderBench(60));
    const ms = await page.evaluate(() => window.__renderBench(600));
    const ms360 = await (async () => {
      await page.goto(`${srv.url}dev/render.html?pos=-1300,900,1500&yaw=-36&pitch=-18&ph=448`);
      await page.waitForFunction(() => window.__renderReady === true, null, { timeout: 60000 });
      await page.evaluate(() => window.__renderBench(60));
      return page.evaluate(() => window.__renderBench(600));
    })();
    console.log(`bench 1920x1080 ph270 start: ${ms.toFixed(3)} ms/frame (${(1000 / ms).toFixed(0)} fps, GPU-synchron)`);
    console.log(`bench 1920x1080 ph448 overview: ${ms360.toFixed(3)} ms/frame (${(1000 / ms360).toFixed(0)} fps)`);
  }

  // Lebenszyklus: setLevel mehrfach (kein Leck), setSettings live (Target-Größe).
  await page.goto(`${srv.url}dev/render.html?pos=0,64,180&yaw=0&pitch=-8`);
  await page.waitForFunction(() => window.__renderReady === true, null, { timeout: 60000 });
  const nextFrame = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await nextFrame();
  const before = await page.evaluate(() => window.__renderStats);
  await page.evaluate(() => window.__renderReload(6));
  await nextFrame();
  const after = await page.evaluate(() => window.__renderStats);
  const leak =
    after.geometries !== before.geometries || after.textures !== before.textures || after.programs !== before.programs;
  console.log(
    `setLevel ×6: geometries ${before.geometries}→${after.geometries}, textures ${before.textures}→${after.textures}, programs ${before.programs}→${after.programs} ${leak ? 'LECK!' : 'ok'}`,
  );
  if (leak) failed = true;
  const disposed = await page.evaluate(() => window.__renderDisposeTest());
  console.log(`dispose: zweite Instanz gebaut, gerendert, entsorgt ${disposed ? 'ok' : 'FEHLER'}`);
  if (!disposed) failed = true;
  // Flugmodus mit laufender Zeit (Smoke-Test Animation/Kick).
  await page.goto(`${srv.url}dev/render.html?level=sandbox&fly=1&speed=0.8&hud=1`);
  await page.waitForFunction(() => window.__renderReady === true, null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/20-fly-live.png` });
  console.log('fly: 1,5 s live gerendert → 20-fly-live.png');
  await page.goto(`${srv.url}dev/render.html?pos=0,64,180&yaw=0&pitch=-8`);
  await page.waitForFunction(() => window.__renderReady === true, null, { timeout: 60000 });
  for (const ph of [360, 224, 448, 270]) {
    await page.evaluate((p) => window.__renderSet({ pixelHeight: p }), ph);
    await nextFrame();
    const st = await page.evaluate(() => window.__renderStats);
    const css = await page.evaluate(() => {
      const c = document.querySelector('canvas');
      return { w: c.width, h: c.height, cw: c.style.width, ch: c.style.height };
    });
    // Erwartung exakt nach Formel: s = max(1, ceil(H / ph)), lowH = ceil(H / s) ≤ ph, lowW = ceil(W / s).
    const s = Math.max(1, Math.ceil(H / ph));
    const ok =
      css.w === st.lowW &&
      css.h === st.lowH &&
      st.scale === s &&
      st.lowH === Math.ceil(H / s) &&
      st.lowH <= ph &&
      st.lowW === Math.ceil(W / s) &&
      css.cw === `${st.lowW * s}px` &&
      css.ch === `${st.lowH * s}px`;
    console.log(
      `setSettings ph=${ph}: low ${st.lowW}x${st.lowH} ×${st.scale}, canvas ${css.w}x${css.h}, css ${css.cw}x${css.ch} ${ok ? 'ok' : 'FALSCH'}`,
    );
    if (!ok) failed = true;
  }
} finally {
  await browser.close();
  await srv.close();
}

const relevant = problems.filter((p) => !p.includes('favicon'));
if (relevant.length) {
  console.error(`Konsole meldet ${relevant.length} Probleme:`);
  for (const p of relevant) console.error(`  ${p}`);
  failed = true;
} else {
  console.log('Konsole sauber (keine WebGL-/Shader-Fehler oder Warnungen).');
}
process.exit(failed ? 1 : 0);

// ================================================================== --fx / --flow (Plan 003, Strang render)

function optArg(list, key) {
  const i = list.indexOf(key);
  return i >= 0 ? list[i + 1] : undefined;
}

function nextFrames(page) {
  return page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

/** 250..1100 u/s → speed01 wie Game.ts (SPEED01_LO/HI). */
function speed01(v) {
  return Math.min(1, Math.max(0, (v - 250) / 850));
}


function viewQuery(v) {
  return `level=${v.level}&pos=${v.pos.join(',')}&yaw=${v.yaw}&pitch=${v.pitch}`;
}

/**
 * Läuft IM BROWSER (per page.evaluate serialisiert): hängt sich an PS2Renderer.prototype.render
 * (dasselbe Modul, das die Seite geladen hat) und stellt Mess-Helfer bereit. window.__fxPatch
 * überschreibt Felder des RenderFx im nächsten render() — so lassen sich die neuen Felder
 * (landPos, speedTier …) setzen, bevor Game.ts sie verdrahtet.
 */
async function installFxHelpers() {
  const m = await import('/src/render/PS2Renderer.ts');
  const P = m.PS2Renderer.prototype;
  if (!P.__fxPatched) {
    P.__fxPatched = true;
    const orig = P.render;
    P.render = function (cam, fx) {
      if (!window.__R) {
        window.__R = this;
        window.__cam = cam;
        window.__fx = fx;
      }
      if (this === window.__R) {
        if (window.__fxHook) window.__fxHook(fx);
        if (window.__fxPatch) Object.assign(fx, window.__fxPatch);
      }
      return orig.call(this, cam, fx);
    };
  }
  window.__fxPatch = {};
  const D = Math.PI / 180;
  const luma = (p, i) => (0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2]) / 255;
  const rAt = (x, y, w, h) => Math.hypot((x + 0.5 - w / 2) / (h / 2), (y + 0.5 - h / 2) / (h / 2)) / Math.hypot(w / h, 1);
  const quant = (xs, f) => {
    if (!xs.length) return null;
    const s = Float64Array.from(xs).sort();
    return s[Math.min(s.length - 1, Math.floor((s.length - 1) * f))];
  };
  const r2 = (v) => (v === null || v === undefined ? null : Math.round(v * 1000) / 1000);
  window.__fxh = {
    luma,
    rAt,
    quant,
    r2,
    setCam(pos, yaw, pitch) {
      window.__cam.position.set(pos[0], pos[1], pos[2]);
      window.__cam.rotation.set(pitch * D, yaw * D, 0, 'YXZ');
    },
    /** Synchron rendern (inkl. __fxPatch) und das Low-Res-Bild lesen. */
    grab(r = window.__R) {
      r.render(window.__cam, window.__fx);
      const gl = r.canvas.getContext('webgl2');
      const w = r.lowResWidth;
      const h = r.lowResHeight;
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return { w, h, px };
    },
    /** Maske der Pixel, die sich ändern, wenn nur `obj` ausgeblendet wird. */
    maskOf(obj) {
      const a = this.grab();
      obj.visible = false;
      const b = this.grab();
      obj.visible = true;
      const m = new Uint8Array(a.w * a.h);
      for (let i = 0, j = 0; j < m.length; i += 4, j++) {
        if (a.px[i] !== b.px[i] || a.px[i + 1] !== b.px[i + 1] || a.px[i + 2] !== b.px[i + 2]) m[j] = 1;
      }
      return m;
    },
    trimMask() {
      return this.maskOf(window.__R.levelGroup.children.find((c) => c.name === 'trims'));
    },
    gridMask() {
      return this.maskOf(window.__R.voidGrid.mesh);
    },
    /**
     * Lokaler Kontrast der Trims gegen ihre Umgebung: je Trim-Pixel der Mittelwert der
     * Nicht-Trim-Pixel im 5×5-Fenster als Hintergrund; ΔE76 (Lab, D65) und |ΔLuma|.
     * Lesbarkeit der Kanten = wie stark sich die Linie vom Dahinter abhebt.
     */
    edgeContrast(img, M, w, h) {
      const lin = (c) => {
        const v = c / 255;
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      };
      const lab = (r, g, b) => {
        const R = lin(r);
        const G = lin(g);
        const B = lin(b);
        const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
        const X = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047);
        const Y = f(0.2126 * R + 0.7152 * G + 0.0722 * B);
        const Z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
        return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
      };
      let n = 0;
      let dE = 0;
      let dL = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const j = y * w + x;
          if (!M[j]) continue;
          let br = 0;
          let bg = 0;
          let bb = 0;
          let bn = 0;
          for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
              const xx = x + dx;
              const yy = y + dy;
              if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
              const k = yy * w + xx;
              if (M[k]) continue;
              br += img.px[k * 4];
              bg += img.px[k * 4 + 1];
              bb += img.px[k * 4 + 2];
              bn++;
            }
          }
          if (!bn) continue;
          const i = j * 4;
          const a = lab(img.px[i], img.px[i + 1], img.px[i + 2]);
          const b = lab(br / bn, bg / bn, bb / bn);
          dE += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
          dL += Math.abs(luma(img.px, i) - (0.2126 * br + 0.7152 * bg + 0.0722 * bb) / bn / 255);
          n++;
        }
      }
      return { pixels: n, deltaE: r2(dE / Math.max(1, n)), dLuma: r2(dL / Math.max(1, n)) };
    },
    /** Maske um r Pixel (Chebyshev) aufweiten. */
    dilate(m, w, h, r) {
      const o = new Uint8Array(m.length);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (!m[y * w + x]) continue;
          for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
              const xx = x + dx;
              const yy = y + dy;
              if (xx >= 0 && yy >= 0 && xx < w && yy < h) o[yy * w + xx] = 1;
            }
          }
        }
      }
      return o;
    },
    /** Differenz A→B in einer Region, Luma-Differenz der geänderten Pixel in 5-Bit-Stufen (1/31). */
    diff(A, B, region) {
      const { w, h } = A;
      const d = [];
      let n = 0;
      let changed = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const j = y * w + x;
          if (!region(x, y, j)) continue;
          n++;
          const i = j * 4;
          if (A.px[i] === B.px[i] && A.px[i + 1] === B.px[i + 1] && A.px[i + 2] === B.px[i + 2]) continue;
          changed++;
          d.push(Math.abs(luma(B.px, i) - luma(A.px, i)) * 31);
        }
      }
      const mean = d.length ? d.reduce((s, v) => s + v, 0) / d.length : 0;
      return {
        n,
        changed,
        changedFrac: r2(changed / Math.max(1, n)),
        stepsMean: r2(mean),
        stepsMedian: r2(quant(d, 0.5)),
        stepsP90: r2(quant(d, 0.9)),
        stepsMax: r2(quant(d, 1)),
      };
    },
    /** Mittlere Luma und RGB über eine Maske. */
    meanOver(img, mask) {
      let n = 0;
      let l = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let j = 0; j < mask.length; j++) {
        if (!mask[j]) continue;
        const i = j * 4;
        n++;
        l += luma(img.px, i);
        r += img.px[i];
        g += img.px[i + 1];
        b += img.px[i + 2];
      }
      return n ? { n, luma: r2(l / n), rgb: [Math.round(r / n), Math.round(g / n), Math.round(b / n)] } : { n: 0, luma: null, rgb: null };
    },
    b64(px) {
      let s = '';
      for (let i = 0; i < px.length; i += 0x8000) s += String.fromCharCode.apply(null, px.subarray(i, i + 0x8000));
      return btoa(s);
    },
  };
}

async function fxMode(list) {
  const only = (optArg(list, '--only') ?? 'id,r1,r2,r5,r4').split(',');
  const saveDir = optArg(list, '--save');
  const cmpDir = optArg(list, '--compare');
  const OUTFX = `${OUT}/fx`;
  mkdirSync(OUTFX, { recursive: true });
  if (saveDir) mkdirSync(saveDir, { recursive: true });
  const srv = await startDevServer(PORT);
  const browser = await launchBrowser();
  const problems = [];
  const res = {};
  let bad = 0;
  try {
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${m.type()}] ${m.text()}`);
    });
    page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
    const open = async (view, extra = '') => {
      await page.goto(`${srv.url}dev/render.html?${viewQuery(view)}&t=1.23&kick=0.4${extra}`);
      await page.waitForFunction(() => window.__renderReady === true || typeof window.__renderError === 'string', null, {
        timeout: 60000,
      });
      const err = await page.evaluate(() => window.__renderError ?? null);
      if (err) throw new Error(err);
      await page.evaluate(installFxHelpers);
      await nextFrames(page);
      await page.evaluate(() => {
        // Zeit/Kick fest: auch die eigenen synchronen Frames sind reproduzierbar.
        window.__fxPatch = { time: 1.23, kick: 0.4 };
      });
    };
    const ctx = { page, open, OUTFX, saveDir, cmpDir };
    if (only.includes('id')) bad += await fxIdentity(ctx, res);
    if (only.includes('r1')) bad += await fxStreaks(ctx, res);
    if (only.includes('r2')) bad += await fxWave(ctx, res);
    if (only.includes('r5')) bad += await fxGhost(ctx, res);
    if (only.includes('r4')) bad += await fxLowLatency(ctx, res);
  } finally {
    await browser.close();
    await srv.close();
  }
  writeFileSync(`${OUTFX}/metrics.json`, JSON.stringify(res, null, 1));
  console.log(`→ ${OUTFX}/metrics.json`);
  const relevant = problems.filter((p) => !p.includes('favicon'));
  if (relevant.length) {
    console.error(`Konsole meldet ${relevant.length} Probleme:`);
    for (const p of relevant.slice(0, 20)) console.error(`  ${p}`);
    bad++;
  } else console.log('Konsole sauber.');
  return bad ? 1 : 0;
}

/** Rohbilder bei Ruhe (speed 0, keine Welle, Stufe 0) speichern bzw. pixelgenau vergleichen. */
async function fxIdentity({ page, open, saveDir, cmpDir }, res) {
  let bad = 0;
  const out = {};
  for (const [name, view] of Object.entries(FX_VIEWS)) {
    await open(view);
    for (const scan of [0, 0.25]) {
      const key = `${name}-scan${scan}`;
      const b64 = await page.evaluate((s) => {
        window.__renderSet({ scanlines: s });
        const g = window.__fxh.grab();
        return `${g.w}x${g.h}:${window.__fxh.b64(g.px)}`;
      }, scan);
      if (saveDir) writeFileSync(`${saveDir}/${key}.b64`, b64);
      if (cmpDir) {
        let ref;
        try {
          ref = readFileSync(`${cmpDir}/${key}.b64`, 'utf8');
        } catch {
          out[key] = 'keine Referenz';
          continue;
        }
        const [dimA, dataA] = ref.split(':');
        const [dimB, dataB] = b64.split(':');
        if (dimA !== dimB) {
          out[key] = `Größe ${dimA} → ${dimB}`;
          bad++;
          continue;
        }
        const a = Buffer.from(dataA, 'base64');
        const b = Buffer.from(dataB, 'base64');
        const w = Number(dimA.split('x')[0]);
        let diff = 0;
        let oddRows = 0;
        let maxd = 0;
        for (let i = 0; i < a.length; i += 4) {
          const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
          if (d === 0) continue;
          diff++;
          maxd = Math.max(maxd, d);
          if (Math.floor(i / 4 / w) % 2 === 1) oddRows++;
        }
        out[key] = { differingPixels: diff, onOddRows: oddRows, maxSumDiff: maxd, total: a.length / 4 };
      }
    }
  }
  if (cmpDir) {
    console.log('Pixelgleichheit gegen', cmpDir);
    for (const [k, v] of Object.entries(out)) console.log(`  ${k.padEnd(18)} ${JSON.stringify(v)}`);
  }
  if (saveDir) console.log(`Rohbilder gespeichert → ${saveDir}`);
  res.identity = out;
  return bad;
}

/** R1: Speed-Streifen gegen dieselbe Szene ohne Streifen (speedLines 0) und gegen Tempo 0. */
async function fxStreaks({ page, open, OUTFX }, res) {
  const out = {};
  const speeds = [0, 350, 380, 500, 800, 1100];
  for (const name of ['hops', 'start']) {
    await open(FX_VIEWS[name]);
    for (const ca of [0, 0.5]) {
      const r = await page.evaluate(
        ({ ca, speeds }) => {
          const h = window.__fxh;
          const sp = (v) => Math.min(1, Math.max(0, (v - 250) / 850));
          window.__renderSet({ chromatic: ca, speedLines: 1 });
          const on = {};
          const off = {};
          for (const v of speeds) {
            window.__fxPatch.speed01 = sp(v);
            on[v] = h.grab();
            window.__renderSet({ speedLines: 0 });
            off[v] = h.grab();
            window.__renderSet({ speedLines: 1 });
          }
          const W0 = on[0].w;
          const H0 = on[0].h;
          const outer = (x, y) => h.rAt(x, y, W0, H0) >= 0.55;
          const inner = (x, y) => !outer(x, y);
          const o = {};
          for (const v of speeds) {
            o[v] = {
              streakOnVsOff: { outer: h.diff(off[v], on[v], outer), inner: h.diff(off[v], on[v], inner) },
              vsRest: { outer: h.diff(on[0], on[v], outer), inner: h.diff(on[0], on[v], inner) },
            };
          }
          // Kick-Modulation bei 800 u/s: Streifen gegen ohne, Kick 0 / 1.
          for (const k of [0, 1]) {
            window.__fxPatch.speed01 = sp(800);
            window.__fxPatch.kick = k;
            const a = h.grab();
            window.__renderSet({ speedLines: 0 });
            const b = h.grab();
            window.__renderSet({ speedLines: 1 });
            o[`800-kick${k}`] = h.diff(b, a, outer);
          }
          window.__fxPatch.kick = 0.4;
          window.__fxPatch.speed01 = 0;
          window.__renderSet({ chromatic: 0.5 });
          return o;
        },
        { ca, speeds },
      );
      out[`${name}-ca${ca}`] = r;
      const s = (v) => r[v].streakOnVsOff.outer;
      const z = (v) => r[v].vsRest.outer;
      console.log(
        `R1 ${name} ca${ca}: 800 Streifen an/aus außen ${s(800).changed} px, Median ${s(800).stepsMedian} Stufen (vs Tempo 0: ${z(800).changed} px, Median ${z(800).stepsMedian}); innen an/aus ${r[800].streakOnVsOff.inner.changed} px, vs Tempo 0 ${r[800].vsRest.inner.changed} px; 350: an/aus ${s(350).changed} px, vs 0 ${z(350).changed} px; Kick0/1 Median ${r['800-kick0'].stepsMedian}/${r['800-kick1'].stepsMedian}`,
      );
    }
    for (const v of [0, 800, 1100]) {
      await page.evaluate((s) => {
        window.__fxPatch.speed01 = s;
      }, speed01(v));
      await nextFrames(page);
      await page.screenshot({ path: `${OUTFX}/r1-${name}-v${v}.png` });
      await page.screenshot({ path: `${OUTFX}/r1-${name}-v${v}-corner.png`, clip: { x: 0, y: 0, width: 640, height: 360 } });
    }
  }
  res.r1 = out;
  return 0;
}

/** R2: Lichtwelle auf den Trims (landPos/landTime/landPower), Tempostufe, Void-Gitter mit Tempo. */
async function fxWave({ page, open, OUTFX }, res) {
  const out = { wave: {} };
  // Sandbox ändert sich nicht (stabile Referenz), Level 1 wird parallel umgebaut (fallen.md #30).
  for (const vname of ['sbhops', 'hops']) {
  await open(FX_VIEWS[vname]);
  const cam = FX_VIEWS[vname].pos;
  const land = [cam[0], cam[1] - 64, cam[2]];
  out.wave[vname] = await page.evaluate(
    ({ land }) => {
      const h = window.__fxh;
      const V = window.__cam.position.constructor;
      const lp = new V(land[0], land[1], land[2]);
      const M = h.trimMask();
      const W0 = window.__R.lowResWidth;
      const H0 = window.__R.lowResHeight;
      const M2 = h.dilate(M, W0, H0, 2);
      const outM = (x, y, j) => M[j] !== 1;
      const outM2 = (x, y, j) => M2[j] !== 1;
      const o = { trimPixels: M.reduce((s, v) => s + v, 0) };
      window.__fxPatch.landPos = lp;
      for (const age of [0.02, 0.05, 0.1, 0.15, 0.2, 0.25, 0.35]) {
        window.__fxPatch.landTime = 1.23 - age;
        window.__fxPatch.landPower = 0;
        const A = h.grab();
        window.__fxPatch.landPower = 1;
        const B = h.grab();
        // Ring = Trim-Pixel, die die Welle verändert. Licht = Luma-Summe im Ring
        // inkl. der Pixel, um die das Band aufgeweitet wird (Ring ∪ Aufweitung).
        const ring = new Uint8Array(M.length);
        const lit = new Uint8Array(M.length);
        let rn = 0;
        for (let j = 0, i = 0; j < M.length; j++, i += 4) {
          const ch = A.px[i] !== B.px[i] || A.px[i + 1] !== B.px[i + 1] || A.px[i + 2] !== B.px[i + 2];
          if (!ch) continue;
          lit[j] = 1;
          if (!M[j]) continue;
          ring[j] = 1;
          rn++;
        }
        const a = h.meanOver(A, ring);
        const b = h.meanOver(B, ring);
        const la = h.meanOver(A, lit);
        const lb = h.meanOver(B, lit);
        const aM = h.meanOver(A, M);
        const bM = h.meanOver(B, M);
        // Lichtsumme: Trim-Pixel im Ring vorher gegen alle geänderten Pixel nachher.
        const lightBefore = (a.luma ?? 0) * rn;
        const lightAfter = (lb.luma ?? 0) * lb.n;
        o[`age${age}`] = {
          ringPixels: rn,
          ringLumaBefore: a.luma,
          ringLumaAfter: b.luma,
          ringLumaGain: a.luma ? h.r2(b.luma / a.luma - 1) : null,
          ringLightGain: lightBefore ? h.r2(lightAfter / lightBefore - 1) : null,
          allTrimsLumaGain: aM.luma ? h.r2(bM.luma / aM.luma - 1) : null,
          changedOutsideTrims: h.diff(A, B, outM).changed,
          changedOutsideTrimsPlus2px: h.diff(A, B, outM2).changed,
        };
      }
      window.__fxPatch.landPower = 0;
      return o;
    },
    { land },
  );
  for (const [k, v] of Object.entries(out.wave[vname])) if (typeof v === 'object') console.log(`R2 Welle ${vname} ${k}: ${JSON.stringify(v)}`);
  for (const age of [0.05, 0.12, 0.2]) {
    await page.evaluate(
      ({ land, age }) => {
        const V = window.__cam.position.constructor;
        Object.assign(window.__fxPatch, { landPos: new V(land[0], land[1], land[2]), landTime: 1.23 - age, landPower: 1 });
      },
      { land, age },
    );
    await nextFrames(page);
    await page.screenshot({ path: `${OUTFX}/r2-wave-${vname}-age${age}.png` });
  }
  await page.evaluate(() => {
    window.__fxPatch.landPower = 0;
  });
  }

  // Tempostufen: Trim-Farbe (nur Level-trimColor-Trims), nichts außerhalb der Trims,
  // lokaler Kanten-Kontrast (Lesbarkeit) je Stufe in mehreren Blicken beider Level.
  out.tier = {};
  for (const name of ['sbhops', 'hops', 'kehre', 'l2']) {
    await open(FX_VIEWS[name]);
    const r = await page.evaluate(() => {
      const h = window.__fxh;
      const M = h.trimMask();
      const W0 = window.__R.lowResWidth;
      const H0 = window.__R.lowResHeight;
      const outM = (x, y, j) => M[j] !== 1;
      window.__fxPatch.speedTier = 0;
      const T0 = h.grab();
      const o = {};
      for (const t of [0, 1, 2, 3]) {
        window.__fxPatch.speedTier = t;
        const T = h.grab();
        o[`tier${t}`] = { trims: h.meanOver(T, M), contrast: h.edgeContrast(T, M, W0, H0), changedOutsideTrims: h.diff(T0, T, outM).changed };
      }
      window.__fxPatch.speedTier = 0;
      return o;
    });
    out.tier[name] = r;
    for (const [k, v] of Object.entries(r)) console.log(`R2 ${name} ${k}: ${JSON.stringify(v)}`);
  }
  for (const t of [1, 2, 3]) {
    await page.evaluate((tt) => {
      window.__fxPatch.speedTier = tt;
    }, t);
    await nextFrames(page);
    await page.screenshot({ path: `${OUTFX}/r2-tier${t}.png` });
  }
  await page.evaluate(() => {
    window.__fxPatch.speedTier = 0;
  });

  // Void-Gitter: Luma der Gitter-Pixel über eine Kick-Periode, Tempo 0 gegen 1.
  await open(FX_VIEWS.fall);
  out.grid = await page.evaluate(() => {
    const h = window.__fxh;
    const G = h.gridMask();
    const o = { gridPixels: G.reduce((s, v) => s + v, 0) };
    for (const s of [0, 0.5, 1]) {
      const ls = [];
      const fl = [];
      // Kick-Einsatz bei t = 10 simulieren, dann eine Beat-Periode (132 BPM) abtasten.
      window.__fxPatch = { time: 9.9, kick: 0.02, speed01: s };
      h.grab();
      for (let k = 0; k <= 22; k++) {
        const age = k * (60 / 132 / 22);
        window.__fxPatch.time = 10 + age;
        window.__fxPatch.kick = Math.exp(-age * 7 * (132 / 60));
        const img = h.grab();
        ls.push(h.meanOver(img, G).luma);
        let all = 0;
        for (let i = 0; i < img.px.length; i += 4) all += h.luma(img.px, i);
        fl.push(all / (img.px.length / 4));
      }
      const sw = (xs) => h.r2((Math.max(...xs) - Math.min(...xs)) / h.quant(xs, 0.5));
      o[`speed${s}`] = { gridLumaMin: Math.min(...ls), gridLumaMax: Math.max(...ls), gridSwing: sw(ls), frameSwing: sw(fl) };
    }
    window.__fxPatch = { time: 1.23, kick: 0.4 };
    return o;
  });
  for (const [k, v] of Object.entries(out.grid)) console.log(`R2 Gitter ${k}: ${JSON.stringify(v)}`);
  for (const [s, age] of [
    [0, 0.12],
    [1, 0.12],
  ]) {
    await page.evaluate(
      ({ s, age }) => {
        const h = window.__fxh;
        window.__fxPatch = { time: 9.9, kick: 0.02, speed01: s };
        h.grab();
        window.__fxPatch = { time: 10 + age, kick: Math.exp(-age * 7 * 2.2), speed01: s };
      },
      { s, age },
    );
    await nextFrames(page);
    await page.screenshot({ path: `${OUTFX}/r2-grid-speed${s}.png` });
  }
  res.r2 = out;
  return 0;
}

/** R5: Ghost sichtbar an Position, unsichtbar mit null, nah an der Kamera ausgeblendet, keine Allokation. */
async function fxGhost({ page, open, OUTFX }, res) {
  await open(FX_VIEWS.hops);
  const has = await page.evaluate(() => typeof window.__R.setGhost === 'function');
  if (!has) {
    console.log('R5: setGhost fehlt (alter Stand)');
    res.r5 = { missing: true };
    return 0;
  }
  const cam = FX_VIEWS.hops.pos;
  const cases = {
    ahead300: [cam[0], cam[1] - 64, cam[2] - 300, 0],
    ahead150side: [cam[0] + 60, cam[1] - 64, cam[2] - 150, 30],
    far900: [cam[0], cam[1] - 64, cam[2] - 900, 0],
    atCamera: [cam[0], cam[1] - 64, cam[2], 0],
    near60: [cam[0], cam[1] - 64, cam[2] - 60, 0],
  };
  const out = await page.evaluate((cases) => {
    const h = window.__fxh;
    const V = window.__cam.position.constructor;
    const R = window.__R;
    R.setGhost(null, 0);
    const base = h.grab();
    const all = () => true;
    const o = {};
    for (const [k, c] of Object.entries(cases)) {
      R.setGhost(new V(c[0], c[1], c[2]), (c[3] * Math.PI) / 180);
      const img = h.grab();
      const d = h.diff(base, img, all);
      o[k] = { changedPixels: d.changed, stepsMedian: d.stepsMedian };
    }
    R.setGhost(null, 0);
    o.nullAgain = { changedPixels: h.diff(base, h.grab(), all).changed };
    return o;
  }, cases);
  for (const [k, v] of Object.entries(out)) console.log(`R5 ${k}: ${JSON.stringify(v)}`);
  for (const [k, c] of Object.entries(cases)) {
    if (k === 'atCamera') continue;
    await page.evaluate((c) => {
      const V = window.__cam.position.constructor;
      window.__R.setGhost(new V(c[0], c[1], c[2]), (c[3] * Math.PI) / 180);
    }, c);
    await nextFrames(page);
    await page.screenshot({ path: `${OUTFX}/r5-ghost-${k}.png` });
  }
  await page.evaluate(() => window.__R.setGhost(null, 0));

  // Allokation: je 3000 Frames ohne Ghost, mit stehendem Ghost (einmal gesetzt) und mit
  // bewegtem (setGhost pro Frame). CDP-Heap-Sampling inkl. eingesammeltem Müll.
  // bewegt − stehend = Kosten von setGhost; stehend − ohne = ein Draw-Call mehr in three.js.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.enable');
  const sample = async (mode) => {
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('HeapProfiler.startSampling', {
      samplingInterval: 64,
      includeObjectsCollectedByMinorGC: true,
      includeObjectsCollectedByMajorGC: true,
    });
    await page.evaluate(
      ({ mode, cam }) => {
        const V = window.__cam.position.constructor;
        const v = new V(cam[0], cam[1] - 64, cam[2] - 300);
        const R = window.__R;
        R.setGhost(mode === 'none' ? null : v, 0.3);
        for (let i = 0; i < 3000; i++) {
          if (mode === 'moving') {
            v.set(cam[0] + Math.sin(i * 0.01) * 100, cam[1] - 64, cam[2] - 300 + i * 0.05);
            R.setGhost(v, i * 0.01);
          }
          R.render(window.__cam, window.__fx);
        }
        R.setGhost(null, 0);
      },
      { mode, cam },
    );
    const { profile } = await cdp.send('HeapProfiler.stopSampling');
    let total = 0;
    const byFn = new Map();
    const walk = (n) => {
      total += n.selfSize;
      const key = `${n.callFrame.functionName || '(anonym)'} ${n.callFrame.url.replace(/^.*\/(src|node_modules)\//, '$1/').replace(/\?.*$/, '')}:${n.callFrame.lineNumber + 1}`;
      byFn.set(key, (byFn.get(key) ?? 0) + n.selfSize);
      for (const c of n.children) walk(c);
    };
    walk(profile.head);
    const top = [...byFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${v} B`);
    return { bytesPerFrame: Math.round((total / 3000) * 10) / 10, top };
  };
  const alloc = {};
  // Zweimal je Modus, der erste Durchlauf wärmt JIT/Programme an (nur der zweite zählt).
  for (const mode of ['none', 'static', 'moving', 'none', 'static', 'moving']) alloc[mode] = await sample(mode);
  console.log(
    `R5 Allokation (B/Frame): ohne ${alloc.none.bytesPerFrame}, stehend ${alloc.static.bytesPerFrame}, bewegt (setGhost je Frame) ${alloc.moving.bytesPerFrame}`,
  );
  console.log(`   Top (bewegt): ${alloc.moving.top.join(' | ')}`);
  res.r5 = { ...out, alloc };
  return 0;
}

/** R4: Kontext mit desynchronized gegen ohne — gleiche Pixel, keine Konsolenfehler. */
async function fxLowLatency({ page, open, OUTFX }, res) {
  const out = {};
  let bad = 0;
  for (const name of ['start', 'hops', 'kehre', 'l2']) {
    const view = FX_VIEWS[name];
    await open(view);
    const r = await page.evaluate(async (levelId) => {
      const m = await import('/src/render/PS2Renderer.ts');
      const lv = await import('/src/world/level/compileLevel.ts');
      const level = await lv.loadLevel(`/levels/${levelId}.json`);
      const h = window.__fxh;
      const shots = {};
      const attrs = {};
      for (const ll of [false, true]) {
        const c = document.createElement('canvas');
        c.dataset.fxll = String(ll);
        document.body.appendChild(c);
        const r = new m.PS2Renderer(c, { lowLatency: ll });
        r.setLevel(level);
        r.resize(window.innerWidth, window.innerHeight);
        const img = h.grab(r);
        const a = c.getContext('webgl2').getContextAttributes();
        attrs[ll] = { desynchronized: a.desynchronized ?? null, antialias: a.antialias, alpha: a.alpha, depth: a.depth };
        shots[ll] = img;
        window[`__fxLL${ll}`] = r;
      }
      let diff = 0;
      const A = shots.false.px;
      const B = shots.true.px;
      for (let i = 0; i < A.length; i++) if (A[i] !== B[i]) diff++;
      return { attrs, sameSize: A.length === B.length, differingBytes: diff, size: `${shots.true.w}x${shots.true.h}` };
    }, view.level);
    out[name] = r;
    console.log(`R4 ${name}: ${JSON.stringify(r)}`);
    if (!r.sameSize || r.differingBytes !== 0) bad++;
    // Sichtprüfung: nur die desynchronisierte Leinwand zeigen und fotografieren (Compositing ok?).
    await page.evaluate(() => {
      for (const c of document.querySelectorAll('canvas')) c.style.visibility = c.dataset.fxll === 'true' ? 'visible' : 'hidden';
      const r = window.__fxLLtrue;
      const loop = () => {
        r.render(window.__cam, window.__fx);
        window.__fxLLraf = requestAnimationFrame(loop);
      };
      loop();
    });
    await nextFrames(page);
    await page.screenshot({ path: `${OUTFX}/r4-lowlatency-${name}.png` });
    await page.evaluate(() => {
      cancelAnimationFrame(window.__fxLLraf);
      window.__fxLLtrue.dispose();
      window.__fxLLfalse.dispose();
    });
  }
  res.r4 = out;
  return bad;
}

/**
 * Kick-Puls im echten Spiel (measure-pulse-Methode, tools/critique/look/measure.mjs):
 * Bot (sync 1, Seed 11) fährt Level 1 bis Route-Knoten `node`, dann eingefroren; 150 Frames
 * Trim-, Gitter- und Gesamt-Luma gegen die Kick-Hüllkurve. Trims und Gitter über
 * Masken (Mesh ausblenden) statt Farbklassen — die Tempostufe färbt die Trims um.
 * Die Game-Verdrahtung (S1) wird nachgestellt: speedTier aus dem Tempo
 * (500/750/1000), Landewelle aus 'jump'-Events (perfect && sync > 0.8).
 */
async function flowMode(node) {
  const srv = await startDevServer(PORT);
  const browser = await launchBrowser();
  const problems = [];
  const out = {};
  const OUTFX = `${OUT}/fx`;
  mkdirSync(OUTFX, { recursive: true });
  try {
    const p = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    p.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    p.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console: ${m.text()}`);
    });
    await p.goto(srv.url, { waitUntil: 'load' });
    await p.waitForFunction(() => window.__vel?.ready === true);
    await p.evaluate(async () => {
      await document.fonts.ready;
    });
    await p.evaluate(() => window.__vel.setRenderSettings({ pixelHeight: 270 }));
    await p.evaluate(installFxHelpers);
    await p.evaluate(() => {
      window.__fxPatch = null;
      let lastT = -1;
      window.__fxWaves = 0;
      window.__fxHook = (fx) => {
        const sp = 250 + fx.speed01 * 850;
        fx.speedTier = sp >= 1000 ? 3 : sp >= 750 ? 2 : sp >= 500 ? 1 : 0;
        const ev = window.__vel.events();
        for (const e of ev) {
          if (e.t <= lastT) continue;
          lastT = e.t;
          if (e.type === 'jump' && e.perfect && e.sync > 0.8) {
            const s = window.__vel.state();
            const V = window.__cam.position.constructor;
            fx.landPos = fx.landPos ?? new V();
            fx.landPos.set(s.pos.x, s.pos.y, s.pos.z);
            fx.landTime = fx.time;
            fx.landPower = Math.min(1, e.sync * Math.min(1, Math.max(0, e.gain) / 30));
            window.__fxWaves++;
          }
        }
      };
    });
    await p.evaluate(() => window.__vel.start('level1', { lockless: true }));
    await p.evaluate(() => window.__vel.useBot('route', { sync: 1, seed: 11 }));
    for (let k = 0; k < 1200; k++) {
      const s = await p.evaluate(() => window.__vel.state());
      if ((s.bot?.nextIndex ?? 0) >= node || s.gameState === 'finished') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await p.screenshot({ path: `${OUTFX}/flow-kehre-live.png` });
    await p.evaluate(() => window.__vel.freeze(true));
    await new Promise((r) => setTimeout(r, 300));
    const st = await p.evaluate(() => {
      const s = window.__vel.state();
      return { node: s.bot?.nextIndex ?? null, speed: Math.round(s.speed), speed01: window.__fx.speed01, speedTier: window.__fx.speedTier ?? null, energy: window.__vel.beat().energy, waves: window.__fxWaves };
    });
    out.state = st;
    // Masken synchron (eingefroren, gleiche Kamera).
    await p.evaluate(() => {
      window.__fxTrimM = window.__fxh.trimMask();
      window.__fxGridM = window.__fxh.gridMask();
    });
    const samples = await p.evaluate(async () => {
      const h = window.__fxh;
      const TM = window.__fxTrimM;
      const GM = window.__fxGridM;
      const grab = () =>
        new Promise((res) => {
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              const c = window.__R.canvas;
              const cv = window.__gcv ?? (window.__gcv = document.createElement('canvas'));
              cv.width = c.width;
              cv.height = c.height;
              const x = cv.getContext('2d', { willReadFrequently: true });
              x.drawImage(c, 0, 0);
              res(x.getImageData(0, 0, c.width, c.height));
            }),
          );
        });
      const o = [];
      for (let k = 0; k < 150; k++) {
        const d = await grab();
        const a = d.data;
        const W0 = d.width;
        const H0 = d.height;
        let tn = 0;
        let tl = 0;
        let cn = 0;
        let cl = 0;
        let gn = 0;
        let gl = 0;
        let all = 0;
        for (let y = 0; y < H0; y++) {
          for (let x = 0; x < W0; x++) {
            const i = (y * W0 + x) * 4;
            // readPixels-Masken sind unten-links, ImageData oben-links.
            const j = (H0 - 1 - y) * W0 + x;
            const L = h.luma(a, i);
            all += L;
            if (TM[j]) {
              tn++;
              tl += L;
            } else if (GM[j]) {
              gn++;
              gl += L;
            }
            const r = a[i] / 255;
            const g = a[i + 1] / 255;
            const b = a[i + 2] / 255;
            if (b > 0.55 && g > 0.5 && r < 0.6 && b - r > 0.3) {
              cn++;
              cl += L;
            }
          }
        }
        const bt = window.__vel.beat();
        o.push({ kick: bt.kick, energy: bt.energy, trimL: tn ? tl / tn : 0, trimN: tn, cyanL: cn ? cl / cn : 0, gridL: gn ? gl / gn : 0, frameL: all / (W0 * H0) });
      }
      return o;
    });
    const q = (xs, f) => {
      const s = [...xs].sort((a, b) => a - b);
      return s[Math.floor((s.length - 1) * f)];
    };
    const corr = (xs, ys) => {
      const n = xs.length;
      const mx = xs.reduce((a, b) => a + b, 0) / n;
      const my = ys.reduce((a, b) => a + b, 0) / n;
      let sxy = 0;
      let sxx = 0;
      let syy = 0;
      for (let i = 0; i < n; i++) {
        sxy += (xs[i] - mx) * (ys[i] - my);
        sxx += (xs[i] - mx) ** 2;
        syy += (ys[i] - my) ** 2;
      }
      return +(sxy / Math.sqrt(sxx * syy)).toFixed(3);
    };
    const sw = (xs) => +((q(xs, 0.95) - q(xs, 0.05)) / q(xs, 0.5)).toFixed(4);
    const kicks = samples.map((s) => s.kick);
    const pick = (k) => samples.map((s) => s[k]);
    out.pulse = {
      frames: samples.length,
      energyMean: +(samples.reduce((a, s) => a + s.energy, 0) / samples.length).toFixed(3),
      trimPixels: samples[0].trimN,
      trimLuma: { p5: +q(pick('trimL'), 0.05).toFixed(4), p95: +q(pick('trimL'), 0.95).toFixed(4), relSwing: sw(pick('trimL')), corr: corr(kicks, pick('trimL')) },
      cyanClassLuma: { relSwing: sw(pick('cyanL')), corr: corr(kicks, pick('cyanL')) },
      gridLuma: { p5: +q(pick('gridL'), 0.05).toFixed(4), p95: +q(pick('gridL'), 0.95).toFixed(4), relSwing: sw(pick('gridL')), corr: corr(kicks, pick('gridL')) },
      frameLuma: { p5: +q(pick('frameL'), 0.05).toFixed(4), p95: +q(pick('frameL'), 0.95).toFixed(4), relSwing: sw(pick('frameL')), corr: corr(kicks, pick('frameL')) },
    };
    // Landewelle im echten Bild: eingefroren, Welle 0.05 s alt vom Standpunkt aus.
    out.wave = await p.evaluate(() => {
      const h = window.__fxh;
      const fx = window.__fx;
      const s = window.__vel.state();
      const V = window.__cam.position.constructor;
      const TM = window.__fxTrimM;
      window.__fxHook = null;
      window.__fxPatch = { landPos: new V(s.pos.x, s.pos.y, s.pos.z), landTime: fx.time - 0.05, landPower: 0 };
      const A = h.grab();
      window.__fxPatch.landPower = 1;
      const B = h.grab();
      window.__fxPatch = null;
      const ring = new Uint8Array(TM.length);
      let rn = 0;
      for (let j = 0, i = 0; j < TM.length; j++, i += 4) {
        if (TM[j] && (A.px[i] !== B.px[i] || A.px[i + 1] !== B.px[i + 1] || A.px[i + 2] !== B.px[i + 2])) {
          ring[j] = 1;
          rn++;
        }
      }
      const a = h.meanOver(A, ring);
      const b = h.meanOver(B, ring);
      let fa = 0;
      let fb = 0;
      for (let i = 0; i < A.px.length; i += 4) {
        fa += h.luma(A.px, i);
        fb += h.luma(B.px, i);
      }
      return {
        ringPixels: rn,
        ringLumaBefore: a.luma,
        ringLumaAfter: b.luma,
        ringLumaGain: a.luma ? h.r2(b.luma / a.luma - 1) : null,
        frameLumaGain: h.r2(fb / fa - 1),
        changedOutsideTrims: h.diff(A, B, (x, y, j) => TM[j] !== 1).changed,
      };
    });
    console.log('FLOW', JSON.stringify(out));
    await p.screenshot({ path: `${OUTFX}/flow-kehre-frozen.png` });
  } finally {
    await browser.close();
    await srv.close();
  }
  writeFileSync(`${OUTFX}/flow.json`, JSON.stringify(out, null, 1));
  if (problems.length) {
    console.error(problems.slice(0, 10).join('\n'));
    return 1;
  }
  return 0;
}
