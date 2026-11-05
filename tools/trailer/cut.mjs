/**
 * Clips aus den Takes schneiden (tools/trailer/takes.mjs): Frame-Bereich → MP4 (H.264, yuv420p, CRF 14,
 * 60 fps, 1920×1080, Nearest-Upscale 4×), dazu media/footage/clips.json (Beschreibung, Highlights,
 * Kick-Raster 132 BPM), Prüf-Frames je Clip (6 Stück aus dem fertigen MP4) und media/footage/contact.png.
 *
 *   node tools/trailer/cut.mjs [clipId …]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { BPM, FPS, FRAMES_DIR, FRAMES_PER_BEAT } from './lib.mjs';

const OUT = 'media/footage';
const CHECK = `${OUT}/check`;
/** Frames, die die Film-Uhr vor Frame 0 des Takes schon lief (Vorlauf) — für das Kick-Raster. */
const CLOCK_OFFSET = { handCard: 130, handKnife: 130, handCan: 130 };

const CLIPS = [
  {
    id: '01a_l1_bhop_kette',
    take: 'l1',
    from: 150,
    to: 630,
    cosmetics: 'Neon-Handschuh + Sammelkarte',
    desc: 'L1 GRUNDKURS: Bhop-Kette vom Start über die Hop-Reihe. Speedometer grün, +Gain-Popups je Hop, Kette ×2 → ×13, SYNC 100 %, Speed-Streifen setzen ein, Karten-Tricks (tossSpin, vanish).',
  },
  {
    id: '01b_l1_bhop_1000',
    take: 'l1',
    from: 600,
    to: 1110,
    cosmetics: 'Neon-Handschuh + Sammelkarte',
    desc: 'L1 GRUNDKURS: Crouch-Kante, Kurve über die Inseln und Slalom — Kette ×13 → ×24, Speed knackt 1000 u/s (Tempostufe 3, Trims heißer), Karten-Fächer.',
  },
  {
    id: '02a_l2_ring_ausfahrt_surf',
    take: 'l2',
    from: 300,
    to: 780,
    cosmetics: 'Gold-Handschuh + Butterfly-Messer',
    desc: 'L2 SCHLEIFE: Außenbahn des Rings (Bhop, Gold-Hand, Messer-Aerials), Ausfahrt mit Drop in die Surf-Kette — FOV-Kick, Speed-Streifen, über 1000 u/s, Messer im Surf-Heli.',
  },
  {
    id: '02b_l2_surf_ziel',
    take: 'l2',
    from: 640,
    to: 976,
    cosmetics: 'Gold-Handschuh + Butterfly-Messer',
    desc: 'L2 SCHLEIFE: Surf-Kette bis zum Launch und Ziel-Durchflug (Blitz, "ZIEL 00:14.09 NEUE BESTZEIT").',
  },
  {
    id: '03a_l3_brandung_kehre',
    take: 'l3',
    from: 140,
    to: 640,
    cosmetics: 'Standard-Handschuh + Dose',
    desc: 'L3 BRANDUNG: lange Surf-Linie durch die Kehre, Kamera neigt sich mit der Rampe, Speed 380 → 1130 u/s, Dose im Surf-Balance.',
  },
  {
    id: '03b_l3_brandung_finale',
    take: 'l3',
    from: 560,
    to: 1015,
    cosmetics: 'Standard-Handschuh + Dose',
    desc: 'L3 BRANDUNG: schnellster Abschnitt — Mond, Tore, Flanken-Wechsel bis 1347 u/s und Sprung ins Ziel (NEUE BESTZEIT).',
  },
  {
    id: '04a_l4_turm_aufstieg',
    take: 'l4',
    from: 770,
    to: 955,
    cosmetics: 'Neon-Handschuh + Handy',
    desc: 'L4 TURM: Aufstieg die Wendel hoch, Bhop mit Kette, sauberer Crouch-Jump über die ↑C-Kante (+57).',
  },
  {
    id: '04b_l4_turm_abfahrt',
    take: 'l4',
    from: 1240,
    to: 1600,
    cosmetics: 'Neon-Handschuh + Handy',
    desc: 'L4 TURM: Surf-Abfahrt vom Turm — Flanken-Kette 720 → 1210 u/s, Mond, Speed-Streifen, bis kurz vor dem Ziel.',
  },
  {
    id: '05_rutschen_slidehop',
    take: 'slide',
    from: 120,
    to: 457,
    cosmetics: 'Gold-Handschuh + Dose',
    desc: 'L1 Startgerade: Anlauf, Rutschen (Kamera tief), Slide-Hop, Air-Strafe, geduckt landen → Lande-Gnade → sofort wieder rutschen. Kette aus 5 Rutschen bis auf das Plateau.',
  },
  {
    id: '06a_hand_karte',
    take: 'handCard',
    from: 0,
    to: 430,
    cosmetics: 'Neon-Handschuh + Sammelkarte',
    desc: 'Hand-Showcase im Stand (L1-Start, Sonnenuntergang, langsamer Schwenk): Karten-Twirl, Vanish (Poof), Toss-Spin, Fächer.',
  },
  {
    id: '06b_hand_messer',
    take: 'handKnife',
    from: 0,
    to: 380,
    cosmetics: 'Gold-Handschuh + Butterfly-Messer',
    desc: 'Hand-Showcase im Stand (L2-Start): Butterfly öffnen, Rollover, Aerial, Double-Aerial, schließen.',
  },
  {
    id: '06c_hand_dose',
    take: 'handCan',
    from: 0,
    to: 430,
    cosmetics: 'Standard-Handschuh + Dose',
    desc: 'Hand-Showcase im Stand (L3-Start, Mondlicht): Dose knacken (Crack), Schluck, Flip, Twirl.',
  },
  {
    id: '07a_ziel_selfie_l4',
    take: 'l4',
    from: 1440,
    to: 1660,
    cosmetics: 'Neon-Handschuh + Handy',
    desc: 'Ziel-Moment L4: letzte Flanke, Durchflug durchs Ziel-Tor (Blitz), "ZIEL 00:25.71 NEUE BESTZEIT", Handy hoch zum Selfie, Stempel "FOTO".',
  },
  {
    id: '07b_ziel_l1',
    take: 'l1',
    from: 1150,
    to: 1348,
    cosmetics: 'Neon-Handschuh + Sammelkarte',
    desc: 'Ziel-Moment L1: Surf-Rutsche, Launch und Flug ins Ziel (Blitz, "NEUE BESTZEIT", Karten-Vanish).',
  },
  {
    id: '08a_establishing_l1_sonnenuntergang',
    take: 'flyL1',
    from: 0,
    to: 540,
    cosmetics: 'ohne HUD und Hand',
    desc: 'Kameraflug hoch über dem L1-Start in die Sonne, sinkt über die Startgerade. Trims pulsen auf 132 BPM.',
  },
  {
    id: '08b_establishing_l3_leuchtturm',
    take: 'flyL3',
    from: 0,
    to: 540,
    cosmetics: 'ohne HUD und Hand',
    desc: 'Kamerabogen um die Surf-Kehre von L3 mit dem Leuchtturm in der Mitte, Mond oben links.',
  },
];

const want = process.argv.slice(2);
const clips = want.length > 0 ? CLIPS.filter((c) => want.includes(c.id)) : CLIPS;
mkdirSync(CHECK, { recursive: true });

const ff = (args) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
const tele = {};
const teleOf = (take) => (tele[take] ??= JSON.parse(readFileSync(`${FRAMES_DIR}/${take}/telemetry.json`, 'utf8')));

/** Highlights aus der Telemetrie (Frame relativ zum Clip). */
function highlights(c) {
  const t = teleOf(c.take).slice(c.from, c.to);
  const out = [];
  const add = (i, what) => out.push({ frame: i, time: +(i / FPS).toFixed(2), what });
  let peak = 0;
  for (let i = 0; i < t.length; i++) if (t[i].sp > t[peak].sp) peak = i;
  for (let i = 1; i < t.length; i++) {
    const a = t[i - 1];
    const b = t[i];
    for (const m of [500, 750, 1000, 1250]) if (a.sp < m && b.sp >= m) add(i, `${m} u/s erreicht`);
    if (b.cp > a.cp) add(i, `Checkpoint ${b.cp}`);
    if (!a.surf && b.surf) add(i, 'Surf-Kontakt');
    if (!a.slide && b.slide) add(i, 'Rutschen beginnt');
    if (a.slide && !b.slide && !b.g) add(i, 'Slide-Hop');
    if (!a.fin && b.fin) add(i, `ZIEL ${b.fin.time.toFixed(2)} s${b.fin.isBest ? ' — NEUE BESTZEIT' : ''}`);
    if (b.trick !== a.trick && b.trick && b.trick !== 'none') add(i, `Trick ${b.trick}`);
    if (b.hop > a.hop && b.hop % 5 === 0 && b.hop > 0) add(i, `Hop-Kette ×${b.hop}`);
  }
  if (t[peak].sp > 0) add(peak, `Spitzentempo ${t[peak].sp} u/s`);
  return out.sort((a, b) => a.frame - b.frame);
}

function encode(c) {
  const file = `${OUT}/${c.id}.mp4`;
  ff([
    '-framerate', String(FPS),
    '-start_number', String(c.from),
    '-i', `${FRAMES_DIR}/${c.take}/%05d.png`,
    '-frames:v', String(c.to - c.from),
    '-vf', 'scale=1920:1080:flags=neighbor:out_color_matrix=bt709,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-g', '60',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-movflags', '+faststart', '-an',
    file,
  ]);
  return file;
}

/** 6 Prüf-Frames aus dem fertigen MP4 (gleichmäßig), als ein Blatt 3×2 in halber Größe. */
function checkSheet(c, file) {
  const n = c.to - c.from;
  const picks = [0, 1, 2, 3, 4, 5].map((k) => Math.min(n - 1, Math.round((k * (n - 1)) / 5)));
  const sel = picks.map((p) => `eq(n\\,${p})`).join('+');
  ff(['-i', file, '-vf', `select='${sel}',scale=960:540:flags=neighbor,tile=3x2`, '-frames:v', '1', '-fps_mode', 'passthrough', `${CHECK}/${c.id}.png`]);
}

const meta = [];
for (const c of clips) {
  if (!existsSync(`${FRAMES_DIR}/${c.take}/telemetry.json`)) throw new Error(`Take ${c.take} fehlt — erst takes.mjs`);
  const file = encode(c);
  checkSheet(c, file);
  const off = CLOCK_OFFSET[c.take] ?? 0;
  // Kick genau auf Film-Uhr-Frame k·FRAMES_PER_BEAT; erster Kick im Clip:
  const clockAt = c.from + off;
  const firstKick = +(Math.ceil(clockAt / FRAMES_PER_BEAT - 1e-9) * FRAMES_PER_BEAT - clockAt).toFixed(2);
  const frames = c.to - c.from;
  meta.push({
    file: `${c.id}.mp4`,
    id: c.id,
    seconds: +(frames / FPS).toFixed(2),
    frames,
    source: { take: c.take, fromFrame: c.from, toFrame: c.to },
    cosmetics: c.cosmetics,
    description: c.desc,
    highlights: highlights(c),
    kick: { bpm: BPM, framesPerBeat: +FRAMES_PER_BEAT.toFixed(4), firstKickFrame: firstKick, note: 'Trims/Void-Gitter pulsen auf diesem Raster (Frame im Clip, 60 fps).' },
  });
  console.log(`${file}  ${(frames / FPS).toFixed(2)} s`);
}

// clips.json zusammenführen (Teil-Läufe ersetzen nur ihre Clips)
const jsonPath = `${OUT}/clips.json`;
const old = existsSync(jsonPath) ? JSON.parse(readFileSync(jsonPath, 'utf8')).clips : [];
const merged = CLIPS.map((c) => meta.find((m) => m.id === c.id) ?? old.find((m) => m.id === c.id)).filter(Boolean);
writeFileSync(
  jsonPath,
  JSON.stringify(
    {
      project: 'VELOCITY — Gameplay-Footage für 30-s-Spot',
      format: '1920×1080, 60 fps, H.264 yuv420p (BT.709), CRF 14, Nearest-Upscale 4× aus 480×270, ohne Ton',
      capture: 'deterministisch: je Videoframe genau 1/60 s Spielzeit (__vel.film/advanceFrame), Kick der Trims aus simulierter 132-BPM-Uhr',
      clips: merged,
    },
    null,
    2,
  ),
);

// Kontaktblatt: je Clip eine Zeile aus 4 Frames (Low-Res 1:1) mit Beschriftung
const rows = [];
const tmp = `${CHECK}/_rows`;
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
for (const c of CLIPS) {
  if (!existsSync(`${OUT}/${c.id}.mp4`)) continue;
  const n = c.to - c.from;
  const picks = [0.1, 0.37, 0.63, 0.9].map((u) => c.from + Math.round(u * (n - 1)));
  const inputs = picks.flatMap((f) => ['-i', `${FRAMES_DIR}/${c.take}/${String(f).padStart(5, '0')}.png`]);
  const label = c.id.replace(/_/g, ' ');
  const row = `${tmp}/${c.id}.png`;
  ff([
    ...inputs,
    '-filter_complex',
    `[0][1][2][3]hstack=inputs=4,pad=iw:ih+24:0:24:color=0x101018,drawtext=fontfile='C\\:/Windows/Fonts/consola.ttf':text='${label}':fontcolor=white:fontsize=16:x=8:y=4`,
    row,
  ]);
  rows.push(row);
}
ff([...rows.flatMap((r) => ['-i', r]), '-filter_complex', `vstack=inputs=${rows.length}`, `${OUT}/contact.png`]);
rmSync(tmp, { recursive: true, force: true });
console.log(`${OUT}/contact.png, ${jsonPath}`);
