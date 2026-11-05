/**
 * VELOCITY — 30-s-Werbespot, reproduzierbarer Schnitt.
 *
 *   node tools/trailer/edit.mjs [schritte…] [--vertical]
 *   Schritte: segments overlay audio final check   (ohne Angabe: alle)
 *
 * Alles hängt am Beat-Raster der Musik (132 BPM, 27.27 Frames/Beat bei 60 fps): Schnitte, Supers, Flashes
 * und SFX stehen in Beats. Ein Beat b liegt auf Frame round(b · 27.27) → maximal ½ Frame neben dem Raster.
 * Footage-Startframes werden (wo nicht ein Ereignis verankert ist) auf das Kick-Raster des Clips gelegt,
 * damit die im Spiel auf 132 BPM pulsenden Trims mit der Musik mitschlagen.
 *
 * Zwischenstände liegen in os.tmpdir()/velocity_trailer (groß, nicht im Repo).
 * Ausgabe: media/velocity_trailer_30s.mp4 (bzw. _vertical), Prüfmaterial unter media/trailer_check/.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const P = (...p) => join(ROOT, ...p);
const FPS = 60;
const BPM = 132;
const FPB = (FPS * 60) / BPM; // 27.2727 Frames pro Beat
const BEAT_S = 60 / BPM;
const TOTAL_BEATS = 66; // 66 · 0.4545 s = 30.0 s
const TOTAL_F = Math.round(TOTAL_BEATS * FPB); // 1800
const F = (b) => Math.round(b * FPB);
const T = (b) => b * BEAT_S;

const VERTICAL = process.argv.includes('--vertical');
const W = VERTICAL ? 1080 : 1920;
const H = VERTICAL ? 1920 : 1080;
const TAG = VERTICAL ? 'vertical' : 'main';
const BUILD = join(tmpdir(), 'velocity_trailer', TAG);
const OUT = P('media', VERTICAL ? 'velocity_trailer_30s_vertical.mp4' : 'velocity_trailer_30s.mp4');
const CHECK = P('media', 'trailer_check');

const clips = JSON.parse(readFileSync(P('media/footage/clips.json'), 'utf8')).clips;
const clipById = Object.fromEntries(clips.map((c) => [c.id.slice(0, 3).replace(/_$/, ''), c]));
const clip = (k) => clipById[k] ?? clips.find((c) => c.id.startsWith(k));

// ---------------------------------------------------------------------------------------------
// SCHNITTLISTE (Beats). src = Quellzeit (s) am Schnitt; anchor = [Quellzeit, Beat] verankert ein
// Ereignis exakt auf einem Beat (überschreibt src, kein Kick-Snap). speed < 1 = Zeitlupe.
// crop = Ausschnitt [x, y, w, h] in 1080p (Vielfache von 4 → Nearest bleibt ganzzahlig: 2× = 8 px/Spielpixel).
// ---------------------------------------------------------------------------------------------
const HAND = {
  knife: [960, 400, 960, 540], // Butterfly: Speedometer-„0“ (x≈960, y≈350) liegt außerhalb
  card: [900, 380, 960, 540],
  can: [840, 520, 960, 540],
};
const CUTS = [
  // Intro: Establishing L1-Sonnenuntergang, Supers zentriert.
  { b: [0, 8], c: '08a', src: 0.3, note: 'Establishing L1 Sonnenuntergang' },
  // Build: Hand-Inserts, je 1 Beat, Trick kurz nach dem Schnitt.
  { b: [8, 9], c: '06b', anchor: [0.5, 8.25], crop: HAND.knife, note: 'Butterfly öffnen (Insert 2×)' },
  { b: [9, 10], c: '06a', anchor: [4.25, 9.3], crop: HAND.card, note: 'Karte Toss-Spin (Insert 2×)' },
  { b: [10, 11], c: '06c', anchor: [0.5, 10.25], crop: HAND.can, note: 'Dose knacken (Insert 2×)' },
  { b: [11, 12], c: '05', src: 0.25, note: 'Rutschen → Slide-Hop' },
  // Surf-Breakdown: 03a so gelegt, dass 1000 u/s exakt auf dem Drop fällt.
  { b: [12, 16], c: '03a', anchor: [6.67, 16], note: 'L3 Surf mit Kameraneigung, 875 → 1000' },
  // DROP: gleiche Einstellung läuft unter dem Logo-Slam weiter, Punch-in 1.25× (5 px/Spielpixel).
  { b: [16, 18], c: '03a', anchor: [6.67, 16], crop: [192, 108, 1536, 864], note: 'Logo-Slam (03a weiter, Punch-in)' },
  // Montage, Schnitte alle 1–2 Beats, Speedometer 950→1000 / 900→1000.
  { b: [18, 20], c: '01b', src: 1.45, note: 'L1 Bhop knackt 1000 u/s' },
  { b: [20, 22], c: '02a', src: 4.95, note: 'L2 Ring-Ausfahrt → Drop in Surf, 1000' },
  { b: [22, 23], c: '04b', src: 2.5, note: 'L4 Turm-Abfahrt, 1000+' },
  { b: [23, 24], c: '07a', src: 0.85, note: 'L4 Flanke 1100' },
  // Höchste Stufe: ½-Beat-Schnitte, Speed-Ramp.
  { b: [24, 25], c: '02b', src: 1.55, note: 'L2 Surf + Messer-Heli' },
  { b: [25, 26], c: '03a', src: 2.6, note: 'L3 Surf-Kontakt, Neigung' },
  { b: [26, 27], c: '02a', src: 3.7, speed: 0.4, snap: false, note: 'Speed-Ramp: Messer-Aerial in Zeitlupe' },
  { b: [27, 28], c: '02a', src: 3.7 + 0.4 * BEAT_S, snap: false, note: '… Normalzeit auf dem Beat, Checkpoint' },
  { b: [28, 28.5], c: '04b', src: 4.3, note: 'L4 Flanke' },
  { b: [28.5, 29], c: '01a', src: 6.6, note: 'L1 Sonnenuntergang 880' },
  { b: [29, 29.5], c: '03a', src: 7.2, note: 'L3 1050' },
  { b: [29.5, 30], c: '02b', src: 2.7, note: 'L2 Surf 1090' },
  { b: [30, 32], c: '01b', src: 7.55, note: 'L1 Spitzentempo 1210, Kette ×24' },
  // Phrase: Abwechslung.
  { b: [32, 36], c: '01a', src: 2.0, note: 'Bhop-Kette mit grünen Gain-Popups' },
  { b: [36, 38], c: '06b', anchor: [3.65, 36.4], crop: HAND.knife, note: 'Butterfly Double-Aerial (Insert)' },
  { b: [38, 39], c: '04a', src: 1.75, note: 'L4 Crouch-Jump über die ↑C-Kante' },
  { b: [39, 41], c: '07b', anchor: [2.23, 40], note: 'L1 Ziel-Durchflug auf dem Akzent 18.18' },
  { b: [41, 44], c: '02a', src: 1.0, note: 'L2 Ring-Bhop, Messer-Aerials' },
  { b: [44, 45], c: '01b', src: 5.0, note: '4 LEVELS: L1' },
  { b: [45, 46], c: '02b', src: 0.4, note: '4 LEVELS: L2' },
  { b: [46, 47], c: '03b', src: 0.9, note: '4 LEVELS: L3' },
  { b: [47, 48], c: '04b', src: 0.8, note: '4 LEVELS: L4' },
  // Breakdown: L3-Finale unter dem Mond, Ziel exakt auf dem IMPACT (Beat 56 = 25.455 s).
  // Steigerung per ganzzahligem Punch-in (5 bzw. 6 px/Spielpixel), Speedometer bleibt im Bild.
  { b: [48, 52], c: '03b', anchor: [391 / 60, 56], note: 'L3-Finale 1250 → 1300, Mond' },
  { b: [52, 54], c: '03b', anchor: [391 / 60, 56], crop: [192, 108, 1536, 864], note: 'Punch-in 1.25×' },
  { b: [54, 56], c: '03b', anchor: [391 / 60, 56], crop: [320, 180, 1280, 720], note: 'Punch-in 1.5×, Ziel auf IMPACT' },
  { b: [56, 58], c: '03b', anchor: [391 / 60, 56], note: 'NEUE BESTZEIT' },
  // Endkarte: L3-Leuchtturm als grobes Mosaik („defokussiert“, aber pixelhart), abgedunkelt im Overlay.
  { b: [58, 66], c: '08b', src: 1.0, mosaic: 12, snap: false, note: 'Endkarte (08b Mosaik)' },
];

// ---------------------------------------------------------------------------------------------
// GRAFIK-TIMELINE (Beats) — Supers unten links (nie über Speedometer/Uhr), Intro/Endkarte mittig.
// ---------------------------------------------------------------------------------------------
const C = { cyan: '#33f0ff', magenta: '#ff3fd0', text: '#f1edff', gold: '#ffd84a', gain: '#5dff9a' };
const two = (key, a, b, colA = C.cyan, colB = C.text) => ({
  key,
  lines: [
    { t: a, m: 3, color: colA },
    { t: b, m: 3, color: colB },
  ],
});
const TIMELINE = [
  { type: 'fade', dir: 'in', t0: 0.15, t1: T(1.5) },
  { type: 'super', b0: 2, b1: 4, pos: 'center', key: 'i1', lines: [{ t: 'NO GUNS.', m: 4, color: C.text }] },
  { type: 'super', b0: 4, b1: 6, pos: 'center', key: 'i2', lines: [{ t: 'NO BRAKES.', m: 4, color: C.text }] },
  { type: 'super', b0: 6, b1: 8, pos: 'center', key: 'i3', lines: [{ t: 'JUST SPEED.', m: 5, color: C.cyan }] },
  { type: 'flash', b: 8, size: 'small' },
  { type: 'flash', b: 12, size: 'small' },
  // Breakdown: ein Wort pro halbem Beat, stapelt sich.
  { type: 'shade', b0: 14, b1: 16, region: 'll', a: 0.55 },
  { type: 'super', b0: 14, b1: 16, key: 'w1', lines: [{ t: 'BHOP.', m: 3, color: C.text }], yOff: 2 },
  { type: 'super', b0: 14.5, b1: 16, key: 'w2', lines: [{ t: 'STRAFE.', m: 3, color: C.text }], yOff: 1 },
  { type: 'super', b0: 15, b1: 16, key: 'w3', lines: [{ t: 'SURF.', m: 3, color: C.cyan }], yOff: 0 },
  // DROP
  { type: 'flash', b: 16, size: 'big' },
  { type: 'slam', b0: 16, b1: 18 },
  { type: 'flash', b: 24, size: 'small' },
  { type: 'shade', b0: 24, b1: 27, region: 'll', a: 0.55 },
  { type: 'super', b0: 24, b1: 27, ...two('s1', '128 TICK', 'MOVEMENT') },
  { type: 'shade', b0: 30, b1: 32, region: 'll', a: 0.55 },
  { type: 'super', b0: 30, b1: 32, ...two('s2', 'SKILL =', 'SPEED', C.text, C.cyan) },
  { type: 'flash', b: 32, size: 'small' },
  { type: 'shade', b0: 33, b1: 36, region: 'll', a: 0.55 },
  { type: 'super', b0: 33, b1: 36, ...two('s3', 'TRAINING', 'MODE') },
  { type: 'shade', b0: 36, b1: 38, region: 'll', a: 0.55 },
  { type: 'super', b0: 36, b1: 38, ...two('s4', 'UNLOCK', 'TRICKS', C.magenta, C.text), shadow: C.cyan },
  { type: 'flash', b: 40, size: 'small', gain: 0.6 },
  { type: 'shade', b0: 44, b1: 48, region: 'll', a: 0.55 },
  ...[1, 2, 3, 4].map((n) => ({
    type: 'super',
    b0: 43 + n,
    b1: 44 + n,
    noGlitch: n > 1,
    key: `lv${n}`,
    lines: [
      { t: `LEVEL ${n}/4`, m: 2, color: C.gold, gap: 3 },
      { t: '4 LEVELS', m: 3, color: C.cyan },
    ],
  })),
  { type: 'flash', b: 52, size: 'small', gain: 0.5 },
  { type: 'flash', b: 54, size: 'small', gain: 0.7 },
  // IMPACT
  { type: 'flash', b: 56, size: 'big' },
  { type: 'flash', b: 58, size: 'small' },
  {
    type: 'end',
    b0: 58,
    pulseUntil: 64,
    tagline: 'NO GUNS. JUST SPEED.',
    cta: 'WISHLIST ON STEAM',
  },
  { type: 'fade', dir: 'out', t0: 29.25, t1: 29.97 },
];

// RGB-Split auf dem Spielbild (ffmpeg rgbashift), Frames ab Beat.
const RGB_HITS = [
  { b: 16, frames: 6, px: 14 },
  { b: 56, frames: 6, px: 14 },
  { b: 52, frames: 2, px: 6 },
  { b: 54, frames: 3, px: 8 },
  { b: 24, frames: 3, px: 6 },
  { b: 32, frames: 3, px: 6 },
  { b: 58, frames: 3, px: 8 },
];

// ---------------------------------------------------------------------------------------------
// SFX (Sekunden im Spot). Whoosh-Oneshots haben ihren Höhepunkt bei ~1.04 s → vor den Schnitt gelegt.
// ---------------------------------------------------------------------------------------------
const WHOOSH_PEAK = 1.04;
// [Beat, dB] — groß auf Abschnittswechseln, klein im Montage-Raster.
const WHOOSH = [
  [8, -9], [10, -15], [12, -9], [18, -12], [20, -15], [22, -15], [24, -10], [26, -15], [28, -15],
  [30, -13], [36, -10], [39, -13], [41, -15], [44, -12], [46, -15], [48, -10], [58, -13],
];
const HOPS = {
  // Absprung-Frames im Clip (aus media/footage/frames/l1/telemetry.json, Hop-Zähler) → Kettenstufe.
  '01a': [[128, 5], [159, 6], [199, 7], [245, 8], [290, 9], [335, 10], [381, 11], [426, 12], [457, 13]],
  '01b': [[7, 13], [53, 14], [98, 15], [144, 16], [189, 17], [234, 18], [279, 19], [325, 20], [370, 21], [415, 22], [461, 23], [506, 24]],
};
// Tempo-Marken im Clip (Quellzeit) → Zap-Sound, wenn sie im Bild sind.
const ZAPS = [
  ['01b', 2.17, 'zap_1000'],
  ['02a', 5.47, 'zap_1000'],
  ['04b', 2.65, 'zap_1000'],
  ['03b', 2.88, 'zap_1250'],
];

// ---------------------------------------------------------------------------------------------

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28, ...opts });
  if (r.status !== 0) {
    console.error(r.stderr?.slice(-4000));
    throw new Error(`${cmd} fehlgeschlagen`);
  }
  return r;
}

/** Schnittliste auflösen: Startframe im Clip (Kick-Snap), Länge, Abweichungen. */
function resolveCuts() {
  return CUTS.map((cut, i) => {
    const c = clip(cut.c);
    const [b0, b1] = cut.b;
    const n = F(b1) - F(b0);
    const speed = cut.speed ?? 1;
    let s;
    if (cut.anchor) {
      const [srcT, atB] = cut.anchor;
      // Quellframe so wählen, dass srcT auf Spot-Frame F(atB) liegt.
      s = Math.round(srcT * FPS - (F(atB) - F(b0)) * speed);
    } else {
      s = Math.round(cut.src * FPS);
      if (cut.snap !== false && c.kick) {
        // Kick-Raster: Clip-Kick k0 + m·FPB soll auf dem Schnitt (= Beat) liegen.
        const k0 = c.kick.firstKickFrame;
        let m = Math.round((s - k0) / FPB);
        // Am Clip-Ende lieber einen Kick früher als Standbild.
        while (m > 0 && Math.round(k0 + m * FPB) + Math.ceil(n * speed) > c.frames) m--;
        s = Math.round(k0 + m * FPB);
      }
    }
    s = Math.max(0, s);
    const need = s + Math.ceil(n * speed);
    if (need > c.frames) console.warn(`! Schnitt ${i} (${cut.c}) braucht Frame ${need} > ${c.frames}`);
    return { ...cut, i, file: c.file, id: c.id, s, n, f0: F(b0), f1: F(b1), speed };
  });
}

/** Quellzeit → Spotzeit, falls im Schnitt sichtbar. */
function srcToSpot(cuts, key, srcT) {
  const out = [];
  for (const cu of cuts) {
    if (!cu.id.startsWith(key)) continue;
    const df = (srcT * FPS - cu.s) / cu.speed;
    if (df >= 0 && df < cu.n) out.push((cu.f0 + df) / FPS);
  }
  return out;
}

// ---------- Segmente ----------
/** Hochformat-Hintergrund: 9:16-Fenster als grobes Mosaik (24-px-Blöcke, ganzzahlig), abgedunkelt. */
const V_MOSAIC = 'crop=576:1024:672:28,scale=45:80:flags=area,scale=1080:1920:flags=neighbor';

function segmentFilter(cu) {
  if (!VERTICAL) {
    if (cu.mosaic)
      return [`scale=${Math.round(1920 / cu.mosaic)}:${Math.round(1080 / cu.mosaic)}:flags=area`, `scale=${W}:${H}:flags=neighbor`];
    if (cu.crop) return [`crop=${cu.crop[2]}:${cu.crop[3]}:${cu.crop[0]}:${cu.crop[1]}`, `scale=${W}:${H}:flags=neighbor`];
    return [];
  }
  if (cu.mosaic) return [V_MOSAIC];
  if (cu.crop && cu.crop[2] === 960) {
    // Hand-Insert: 540×960-Fenster auf die Hand, ×2 → Vollbild hoch (Speedometer-„0“ bleibt draußen).
    const cx = cu.crop[0] + 480;
    const x = Math.max(0, Math.min(1920 - 540, Math.round((cx - 270) / 4) * 4));
    return [`crop=540:960:${x}:120`, 'scale=1080:1920:flags=neighbor'];
  }
  // Gameplay: mittiges Quadrat 1:1 (bzw. Punch-in ganzzahlig), darunter Mosaik derselben Einstellung.
  const z = cu.crop ? 1920 / cu.crop[2] : 1;
  const side = Math.round(1080 / z / 4) * 4;
  const x = Math.round((1920 - side) / 2 / 4) * 4;
  const y = Math.round((1080 - side) / 2 / 4) * 4;
  return [
    `split[a][b];[a]${V_MOSAIC},lutyuv=y=val*0.42[bg];[b]crop=${side}:${side}:${x}:${y},scale=1080:1080:flags=neighbor[fg];[bg][fg]overlay=0:${V_SQ_Y}`,
  ];
}
const V_SQ_Y = 420;

function segment(cu) {
  const out = join(BUILD, 'seg', `${String(cu.i).padStart(2, '0')}.mp4`);
  const vf = [];
  if (cu.speed === 1) vf.push(`trim=start_frame=${cu.s}:end_frame=${cu.s + cu.n}`, 'setpts=PTS-STARTPTS');
  else
    vf.push(
      `trim=start_frame=${cu.s}:end_frame=${cu.s + Math.ceil(cu.n * cu.speed) + 2}`,
      `setpts=(PTS-STARTPTS)/${cu.speed}`,
      `fps=${FPS}`,
    );
  vf.push(...segmentFilter(cu));
  vf.push('tpad=stop_mode=clone:stop_duration=2', 'setsar=1', 'format=yuv420p');
  sh('ffmpeg', [
    '-v', 'error', '-y',
    '-i', P('media/footage', cu.file),
    '-vf', vf.join(','),
    '-frames:v', String(cu.n),
    '-r', String(FPS),
    '-c:v', 'libx264', '-qp', '0', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    out,
  ]);
  return out;
}

function stepSegments(cuts) {
  rmSync(join(BUILD, 'seg'), { recursive: true, force: true });
  mkdirSync(join(BUILD, 'seg'), { recursive: true });
  const list = [];
  for (const cu of cuts) {
    list.push(`file '${segment(cu).replace(/\\/g, '/')}'`);
    process.stdout.write('.');
  }
  writeFileSync(join(BUILD, 'concat.txt'), list.join('\n'));
  sh('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', join(BUILD, 'concat.txt'), '-c', 'copy', join(BUILD, 'base.mp4')]);
  const n = sh('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', join(BUILD, 'base.mp4')]).stdout.trim();
  console.log(`\nbase.mp4: ${n} Frames (Soll ${TOTAL_F})`);
  if (Number(n) !== TOTAL_F) throw new Error('Framezahl stimmt nicht');
}

// ---------- Overlay (Playwright) ----------
function layout() {
  if (!VERTICAL)
    return {
      llx: 96,
      lly: 1000,
      logoCx: 960,
      logoCy: 520,
      logoW: 1500,
      endLogoCx: 960,
      endLogoCy: 390,
      endLogoW: 1380,
      endTagY: 628,
      endBtnCy: 800,
    };
  return {
    llx: 64,
    lly: 1830,
    logoCx: 540,
    logoCy: 960,
    logoW: 1020,
    endLogoCx: 540,
    endLogoCy: 780,
    endLogoW: 1000,
    endTagY: 1010,
    endBtnCy: 1200,
    bandCy: 230,
    bandW: 760,
  };
}

async function stepOverlay() {
  const { launchBrowser } = await import('../lib/devServer.mjs');
  const dir = join(BUILD, 'ov');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    page.on('pageerror', (e) => console.error('pageerror', e.message));
    page.on('console', (m) => m.type() === 'error' && console.error('console', m.text()));
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.addScriptTag({ path: P('tools/trailer/overlay.js') });
    const fontB64 = (f) => readFileSync(P('node_modules/@fontsource', f)).toString('base64');
    const timeline = TIMELINE.map((el) => (el.type === 'super' && el.yOff != null ? { ...el } : el));
    await page.evaluate((c) => window.ov.setup(c), {
      W,
      H,
      fps: FPS,
      fpb: FPB,
      layout: layout(),
      timeline: stackWords(VERTICAL ? [{ type: 'band', b0: 18, b1: 56 }, ...timeline] : timeline),
      fonts: [
        ['Silkscreen', fontB64('silkscreen/files/silkscreen-latin-700-normal.woff2'), '700'],
        ['Silkscreen', fontB64('silkscreen/files/silkscreen-latin-400-normal.woff2'), '400'],
      ],
      logo: `data:image/png;base64,${readFileSync(P('media/velocity_font.png')).toString('base64')}`,
    });
    const empty = join(dir, 'empty.png');
    sh('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=black@0.0:s=${W}x${H},format=rgba`, '-frames:v', '1', empty]);
    let drawn = 0;
    for (let f = 0; f < TOTAL_F; f++) {
      const url = await page.evaluate((k) => window.ov.frame(k), f);
      const file = join(dir, `${String(f).padStart(5, '0')}.png`);
      if (url) {
        writeFileSync(file, Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
        drawn++;
      } else copyFileSync(empty, file);
      if (f % 120 === 0) process.stdout.write(`${f} `);
    }
    console.log(`\nOverlay: ${drawn} gezeichnete Frames`);
  } finally {
    await browser.close();
  }
}

/** Gestapelte Breakdown-Wörter: yOff = Zeilen über der Grundlinie. */
function stackWords(tl) {
  const L = layout();
  return tl.map((raw) => {
    // Hochformat: zentrierte Supers auf m ≤ 3 begrenzen (m = 4/5 ist breiter als 1080 px).
    const el = VERTICAL && raw.type === 'super' && raw.pos === 'center' ? { ...raw, key: `${raw.key}v`, lines: raw.lines.map((l) => ({ ...l, m: Math.min(l.m, 3) })) } : raw;
    if (el.type !== 'super' || el.yOff == null) return el;
    // Zeilenabstand: 8·m Raster-Pixel Glyphzeile + Luft, m = 3 → 27 Raster-Pixel.
    return { ...el, pos: 'abs', absLly: L.lly - el.yOff * 27 * 4 };
  });
}

// ---------- Audio ----------
function sfxEvents(cuts) {
  const ev = [];
  const add = (t, file, db, note) => ev.push({ t, file, db, note });
  // Whooshes auf ausgewählten Schnitten (Höhepunkt auf dem Schnitt), L/R abwechselnd. Nicht auf jeden
  // ½-Beat-Schnitt: die Datei ist 1.6 s lang, dicht gesetzt verschwimmt sie zu Rauschen.
  WHOOSH.forEach(([b, db], k) => add(T(b) - WHOOSH_PEAK, `whoosh_pass_${k % 2 ? 'R' : 'L'}`, db, `Whoosh Beat ${b}`));
  // Dose: Crack im Clip bei 0.5 s; Datei-Onset 0.02 s.
  for (const t of srcToSpot(cuts, '06c', 0.5)) add(t - 0.02, 'can_pssht', -5, 'Dose knacken');
  // Bhop-Blips an den echten Absprüngen.
  for (const [k, list] of Object.entries(HOPS))
    for (const [fr, chain] of list)
      for (const t of srcToSpot(cuts, k, fr / FPS)) add(t, `hop_chain${String(Math.min(12, chain)).padStart(2, '0')}`, -11, `Hop ×${chain}`);
  for (const [k, srcT, file] of ZAPS) for (const t of srcToSpot(cuts, k, srcT)) add(t, file, -12, file);
  // Checkpoint im Ramp-Schnitt (02a CP2 bei 4.08 s).
  for (const t of srcToSpot(cuts, '02a', 4.08)) add(t, 'checkpoint_chime', -12, 'Checkpoint');
  add(T(16), 'land_hard', -4, 'Drop');
  add(T(40), 'finish_stab', -14, 'L1-Ziel (leise)');
  add(T(56), 'finish_stab', -3, 'IMPACT');
  add(T(56), 'land_hard', -3, 'IMPACT');
  return ev.sort((a, b) => a.t - b.t);
}

function stepAudio(cuts) {
  const ev = sfxEvents(cuts);
  writeFileSync(join(BUILD, 'sfx.json'), JSON.stringify(ev, null, 1));
  const inputs = ['-i', P('media/audio/trailer_music.wav'), '-i', P('media/audio/stems/sfx_wind_surf_synced.wav')];
  const fc = [];
  // Wind/Surf-Stem leise unterlegen, nur wo Tempo im Bild ist (ab Build bis IMPACT).
  fc.push(`[1:a]volume='if(lt(t,3.5),0,if(lt(t,25.3),0.32,max(0,0.32*(1-(t-25.3)/0.8))))':eval=frame[wind]`);
  const labels = ['[0:a]', '[wind]'];
  ev.forEach((e, i) => {
    inputs.push('-i', P('media/audio/stems/oneshots', `${e.file}.wav`));
    const ms = Math.max(0, Math.round(e.t * 1000));
    fc.push(`[${i + 2}:a]volume=${e.db}dB,adelay=${ms}|${ms}[e${i}]`);
    labels.push(`[e${i}]`);
  });
  fc.push(`${labels.join('')}amix=inputs=${labels.length}:normalize=0:duration=first,atrim=0:30,alimiter=limit=0.84:level=false[mix]`);
  const mix = join(BUILD, 'mix.wav');
  sh('ffmpeg', ['-v', 'error', '-y', ...inputs, '-filter_complex', fc.join(';'), '-map', '[mix]', '-ar', '48000', '-c:a', 'pcm_s24le', mix]);
  // Loudness: zweistufig, linear auf −14 LUFS / −1 dBTP.
  const m = sh('ffmpeg', ['-hide_banner', '-i', mix, '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-']).stderr;
  const j = JSON.parse(m.slice(m.lastIndexOf('{'), m.lastIndexOf('}') + 1));
  const ln = `loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=${j.input_i}:measured_TP=${j.input_tp}:measured_LRA=${j.input_lra}:measured_thresh=${j.input_thresh}:offset=${j.target_offset}:linear=true`;
  sh('ffmpeg', ['-v', 'error', '-y', '-i', mix, '-af', `${ln},aresample=48000,atrim=0:30`, '-c:a', 'pcm_s24le', join(BUILD, 'master.wav')]);
  console.log(`Audio: ${ev.length} SFX, Mix gemessen ${j.input_i} LUFS / ${j.input_tp} dBTP`);
}

// ---------- Final ----------
function stepFinal() {
  const hits = RGB_HITS.map((h) => {
    const a = F(h.b);
    return `rgbashift=rh=-${h.px}:bh=${h.px}:enable='between(n,${a},${a + h.frames - 1})'`;
  });
  // Dezente Vignette auf dem Spielbild (nicht auf der Endkarte, die hat ihr eigenes Abdunkeln).
  const vf = [
    `[0:v]format=gbrp,${hits.join(',')},vignette=angle=0.42:enable='lt(n,${F(58)})'[g]`,
    `[1:v]format=rgba[o]`,
    `[g][o]overlay=format=auto:shortest=1,format=yuv420p,setsar=1[v]`,
  ].join(';');
  sh('ffmpeg', [
    '-v', 'error', '-y',
    '-i', join(BUILD, 'base.mp4'),
    '-framerate', String(FPS), '-start_number', '0', '-i', join(BUILD, 'ov', '%05d.png'),
    '-i', join(BUILD, 'master.wav'),
    '-filter_complex', vf,
    '-map', '[v]', '-map', '2:a',
    '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
    '-r', String(FPS), '-frames:v', String(TOTAL_F),
    '-c:a', 'aac', '-b:a', '320k', '-ar', '48000',
    '-t', '30', '-movflags', '+faststart',
    OUT,
  ]);
  console.log(`→ ${OUT}`);
}

// ---------- Prüfen ----------
function stepCheck(cuts) {
  mkdirSync(CHECK, { recursive: true });
  const tag = VERTICAL ? '_vertical' : '';
  const probe = sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,profile,width,height,pix_fmt,r_frame_rate,nb_frames,sample_rate,bit_rate', '-of', 'compact', OUT]).stdout;
  console.log(probe.trim());
  // Kontaktblatt: 1 Frame pro 0.5 s.
  const cw = VERTICAL ? 180 : 320;
  const ch = VERTICAL ? 320 : 180;
  const cols = VERTICAL ? 12 : 6;
  sh('ffmpeg', ['-v', 'error', '-y', '-i', OUT, '-vf', `select='not(mod(n\\,30))',scale=${cw}:${ch}:flags=area,drawtext=fontfile='C\\:/Windows/Fonts/consola.ttf':text='%{eif\\:n*0.5\\:d}.%{eif\\:mod(n*5\\,10)\\:d}':x=4:y=4:fontsize=16:fontcolor=yellow:box=1:boxcolor=black@0.6,tile=${cols}x${Math.ceil(60 / cols)}`, '-frames:v', '1', P('media', `trailer_contact${tag}.png`)]);
  // Schlüsselframes.
  const keys = { drop0: F(16), drop3: F(16) + 3, drop12: F(16) + 12, b14: F(15.2), impact0: F(56), impact4: F(56) + 4, best: F(57.5), end1: F(59.5), end2: F(63), last: TOTAL_F - 40 };
  for (const [k, f] of Object.entries(keys))
    sh('ffmpeg', ['-v', 'error', '-y', '-i', OUT, '-vf', `select='eq(n\\,${f})'`, '-frames:v', '1', join(CHECK, `${TAG}_${k}.png`)]);
  // Schnitt-Prüfung: Szenen-Score je Frame auf base.mp4 (ohne Grafik). Ein Schnitt sitzt richtig, wenn
  // das lokale Maximum (±4 Frames) genau auf dem Soll-Frame liegt.
  const sc = spawnSync('ffmpeg', ['-hide_banner', '-i', join(BUILD, 'base.mp4'), '-vf', "select='gte(scene,0)',metadata=print:key=lavfi.scene_score", '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 28 }).stderr;
  const score = [...sc.matchAll(/lavfi\.scene_score=([\d.]+)/g)].map((m) => Number(m[1]));
  const want = cuts
    .filter((c, i) => i > 0 && !(c.c === cuts[i - 1].c && c.s === cuts[i - 1].s + Math.round(cuts[i - 1].n * cuts[i - 1].speed)))
    .map((c) => c.f0);
  let bad = 0;
  const rows = want.map((f) => {
    let best = f;
    for (let d = -4; d <= 4; d++) if ((score[f + d] ?? 0) > (score[best] ?? 0)) best = f + d;
    // Abstand zum nächsten Halb-Beat (die ½-Beat-Schnitte liegen auf Achteln).
    const beatErr = f - (Math.round((f / FPB) * 2) / 2) * FPB;
    const ok = best === f;
    if (!ok) bad++;
    return `  f${String(f).padStart(4)}  ${(f / FPS).toFixed(3)} s  Beat ${(f / FPB).toFixed(3)} (Raster-Δ ${beatErr.toFixed(2)} f)  Score ${(score[f] ?? 0).toFixed(3)}  ${ok ? 'OK' : `Max bei f${best}`}`;
  });
  console.log(`Schnitte (${want.length}, Frames ab 0; Szenen-Score auf base.mp4):\n${rows.join('\n')}`);
  console.log(`  ${bad} Schnitte ohne lokales Maximum am Soll-Frame.`);
  // Loudness des fertigen MP4.
  const lr = spawnSync('ffmpeg', ['-hide_banner', '-i', OUT, '-af', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 26 }).stderr;
  const sum = lr.slice(lr.lastIndexOf('Summary:'));
  console.log(sum.replace(/\n\s*\n/g, '\n'));
}

function printCuts(cuts) {
  console.log('Schnittliste:');
  for (const c of cuts)
    console.log(
      `  ${String(c.i).padStart(2)}  Beat ${String(c.b[0]).padStart(4)}–${String(c.b[1]).padEnd(4)} f${String(c.f0).padStart(4)}–${String(c.f1).padEnd(4)} ${(c.f0 / FPS).toFixed(3).padStart(6)} s  ${c.id.padEnd(36)} ab ${(c.s / FPS).toFixed(2)} s${c.speed !== 1 ? ` ×${c.speed}` : ''}  ${c.note}`,
    );
}

// ---------- main ----------
const steps = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const all = steps.length === 0;
mkdirSync(BUILD, { recursive: true });
const cuts = resolveCuts();
printCuts(cuts);
if (all || steps.includes('segments')) stepSegments(cuts);
if (all || steps.includes('overlay')) await stepOverlay();
if (all || steps.includes('audio')) stepAudio(cuts);
if (all || steps.includes('final')) stepFinal();
if (all || steps.includes('check')) stepCheck(cuts);
