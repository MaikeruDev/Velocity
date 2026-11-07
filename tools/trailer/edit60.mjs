/**
 * VELOCITY — 60-s-Steam-Trailer, reproduzierbarer Schnitt (Nachfolger von edit.mjs).
 *
 *   node tools/trailer/edit60.mjs [segments overlay audio final check] [--vertical]
 *
 * Quellen sind die ganzen Takes (media/footage/frames/<take>/NNNNN.png + telemetry.json, 480×270) — jeder Schnitt
 * wird Frame für Frame aus den PNGs gebaut (Hardlinks → image2), dadurch sind Zeitlupe, Rampen und Tape-Stop
 * frame-genau. Alles hängt am Raster der Musik (media/audio/trailer60_music.wav, 132 BPM): b = Beat, 132 Beats = 60 s.
 *
 * Ausgabe: media/velocity_trailer_60s.mp4 (bzw. _vertical), Prüfmaterial unter media/trailer60_check/.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const P = (...p) => join(ROOT, ...p);
const FPS = 60;
const BPM = 132;
const FPB = (FPS * 60) / BPM;
const BEAT_S = 60 / BPM;
const VERTICAL = process.argv.includes('--vertical');
/** --cut30: 30-s-Schnitt auf der 30-s-Musik (Social/Spot), sonst der 60-s-Steam-Trailer. */
const CUT30 = process.argv.includes('--cut30');
const TOTAL_BEATS = CUT30 ? 66 : 132;
const TOTAL_F = Math.round(TOTAL_BEATS * FPB);
const F = (b) => Math.round(b * FPB);
const T = (b) => b * BEAT_S;

const W = VERTICAL ? 1080 : 1920;
const H = VERTICAL ? 1920 : 1080;
const TAG = `${CUT30 ? '30' : '60'}${VERTICAL ? '_vertical' : ''}`;
const BUILD = join(tmpdir(), 'velocity_trailer60', TAG);
const OUT = P('media', `velocity_trailer_${CUT30 ? '30' : '60'}s${VERTICAL ? '_vertical' : ''}.mp4`);
const CHECK = P('media', 'trailer60_check');
const FRAMES = P('media/footage/frames');

/** Film-Uhr der Takes: Kick auf Frame 0 (Film-Modus direkt vor der Aufnahme), Hand-Takes mit 130 Frames Vorlauf. */
const TAKE_KICK = { handCard: 6.36, handKnife: 6.36, handCan: 6.36 };
const teleCache = new Map();
function tele(take) {
  if (!teleCache.has(take)) teleCache.set(take, JSON.parse(readFileSync(join(FRAMES, take, 'telemetry.json'), 'utf8')));
  return teleCache.get(take);
}

// ---------------------------------------------------------------------------------------------
// SCHNITTLISTE (Beats). t = Take, src = Quellzeit (s) am Schnitt, anchor = [Quellzeit, Beat] (Ereignis exakt auf
// dem Beat), speed (konstant) bzw. ramp = [von, bis] (Rate linear über den Schnitt; 0 = Standbild), crop =
// [x, y, w, h] in 1080p (Vielfache von 4), mosaic = Blockgröße. snap: Quellstart aufs Kick-Raster (Default an).
// ---------------------------------------------------------------------------------------------
const HAND = {
  knife: [960, 400, 960, 540],
  card: [900, 380, 960, 540],
  can: [840, 520, 960, 540],
};
const PUNCH1 = [192, 108, 1536, 864];
const PUNCH2 = [320, 180, 1280, 720];
const CUTS60 = [
  // ---- COLD OPEN (L4 gedämpft "aus dem Nebenraum"): die schnellsten Momente, je 1 Beat, letzter als Tape-Stop.
  { b: [0, 1], t: 'fpL3', src: 14.0, note: 'Cold: L3 Ego 1300 unter dem Mond (erstes Bild)' },
  { b: [1, 2], t: 'chaseL3', src: 13.4, note: 'Cold: L3 Surf unter dem Mond (Verfolger)' },
  { b: [2, 3], t: 'chaseL1', src: 9.6, note: 'Cold: L1 Sonnenuntergang (Verfolger)' },
  { b: [3, 4], t: 'fpL1', src: 18.0, note: 'Cold: L1 Ego 1200' },
  { b: [4, 5], t: 'chaseL1', src: 19.0, note: 'Cold: L1 Sonnenuntergang 1220 (Verfolger)' },
  { b: [5, 6], t: 'fpL1', src: 12.0, note: 'Cold: L1 Ego 1000' },
  { b: [6, 7], t: 'chaseL1', src: 4.2, note: 'Cold: L1 Hop-Reihe Sonnenuntergang' },
  { b: [7, 8], t: 'chaseL3', src: 9.0, ramp: [1, 0], snap: false, note: 'Cold: Tape-Stop (Zeitlupe bis Standbild)' },
  // ---- INTRO (ruhig): Sonnenuntergang, Letterbox, Supers.
  { b: [8, 16], t: 'flyL1', src: 0.6, note: 'Intro: L1 Establishing Sonnenuntergang' },
  // ---- BUILD: erste Hops.
  { b: [16, 18], t: 'fpL1', src: 1.6, note: 'Build: Anlauf + erste Hops' },
  { b: [18, 20], t: 'chaseL1', src: 2.6, note: 'Build: Hop-Reihe von hinten' },
  // ---- BREAKDOWN 1: BHOP. STRAFE. SURF.
  { b: [20, 22], t: 'fpL1', src: 4.4, note: 'BD1: Bhop-Kette, Gain-Popups' },
  { b: [22, 24], t: 'chaseL3', src: 2.3, note: 'BD1: Einstieg in die Surf-Rampe' },
  // ---- DROP 1 + LOGO
  { b: [24, 26], t: 'chaseL3', src: 2.3 + 2 * BEAT_S, snap: false, crop: PUNCH1, note: 'DROP 1: Logo-Slam, Rampe weiter (Punch-in)' },
  { b: [26, 28], t: 'fpL3', src: 6.0, note: 'Groove: L3 Ego Surf mit Neigung' },
  { b: [28, 30], t: 'fpL1', src: 6.6, note: 'Groove: L1 Bhop ×8, grün' },
  { b: [30, 32], t: 'handKnife', anchor: [0.5, 30.25], crop: HAND.knife, note: 'Insert: Butterfly öffnen' },
  { b: [32, 34], t: 'flyL2', src: 0.2, note: 'Groove: L2 Ring von oben' },
  { b: [34, 36], t: 'chaseL2', src: 5.6, note: 'Groove: L2 Ring (Verfolger)' },
  { b: [36, 38], t: 'fpL2', src: 6.2, note: 'Groove: L2 Ring Ego, Messer' },
  { b: [38, 40], t: 'handCard', anchor: [4.25, 38.3], crop: HAND.card, note: 'Insert: Karte Toss-Spin' },
  // ---- OVERDRIVE L4
  { b: [40, 42], t: 'chaseL3', src: 8.3, note: 'Overdrive: L3 Kehre, Brücke (Verfolger)' },
  { b: [42, 44], t: 'fpL3', src: 9.0, note: 'Overdrive: L3 Ego 1000+' },
  { b: [44, 45], t: 'chaseL3', src: 15.0, note: 'L3 Mond-Gerade (Verfolger)' },
  { b: [45, 46], t: 'fpL3', src: 14.6, note: 'L3 Ego 1320' },
  { b: [46, 48], t: 'flyL4', src: 2.5, note: 'L4 Turm (Kameraflug)' },
  { b: [48, 50], t: 'slide', src: 2.3, note: 'Rutschen → Slide-Hop' },
  { b: [50, 52], t: 'handCan', anchor: [0.5, 50.25], crop: HAND.can, note: 'Insert: Dose knacken' },
  { b: [52, 56], t: 'chaseL1', src: 12.6, note: 'L1 Inseln + Slalom (Verfolger)' },
  // ---- GHOST
  { b: [56, 64], t: 'ghostL1', src: 4.0, note: 'Ghost-Rennen: Hologramm direkt vor dir (600 → 820)' },
  // ---- BREAKDOWN 2: Zeitlupe + Riesen-Tacho
  { b: [64, 68], t: 'chaseL3', src: 12.9, speed: 0.4, snap: false, note: 'BD2: Zeitlupe L3 Surf, Mond' },
  { b: [68, 70], t: 'chaseL3', src: 12.9 + 4 * BEAT_S * 0.4, snap: false, note: 'BD2: dieselbe Einstellung in Normaltempo, Tacho steigt weiter' },
  { b: [70, 72], t: 'bulletL1', src: 0.25, snap: false, note: 'BD2: Bullet-Time über den L1-Inseln (Zeit steht, Kamera kreist)' },
  // ---- DROP 2: Montage L4+
  { b: [72, 74], t: 'fpL3', src: 12.4, note: 'DROP 2: L3 Ego Mond 1230' },
  { b: [74, 75], t: 'chaseL1', src: 14.0, note: 'L1 Verfolger 1060' },
  { b: [75, 76], t: 'fpL1', src: 15.4, note: 'L1 Ego 1100' },
  { b: [76, 78], t: 'fpL4', src: 24.6, note: 'L4 Abfahrt Ego' },
  { b: [78, 80], t: 'fpL1', src: 13.0, note: 'L1 1050 Ego' },
  { b: [80, 84], t: 'chaseL1', src: 17.6, note: 'L1 Spitzentempo (Verfolger)' },
  { b: [84, 85], t: 'chaseL1', src: 7.2, note: '4 LEVELS: L1' },
  { b: [85, 86], t: 'chaseL2', src: 7.4, note: '4 LEVELS: L2' },
  { b: [86, 87], t: 'chaseL3', src: 10.4, note: '4 LEVELS: L3' },
  { b: [87, 88], t: 'chaseL4', src: 21.2, note: '4 LEVELS: L4' },
  { b: [88, 89], t: 'fpL1', src: 19.0, note: 'Halbe Beats: L1' },
  { b: [89, 90], t: 'fpL2', src: 13.6, note: 'L2' },
  { b: [90, 91], t: 'chaseL3', src: 12.2, note: 'L3 (Verfolger)' },
  { b: [91, 92], t: 'fpL3', src: 13.2, note: 'L3' },
  { b: [92, 94], t: 'chaseL3', src: 14.4, note: 'L3 Finale (Verfolger)' },
  { b: [94, 96], t: 'handKnife', anchor: [3.65, 94.4], crop: HAND.knife, note: 'Insert: Butterfly Double-Aerial' },
  { b: [96, 98], t: 'chaseL3', src: 14.6, note: 'L3 Mond-Gerade (Verfolger)' },
  { b: [98, 100], t: 'fpL4', src: 26.0, note: 'L4 Ziel-Anflug' },
  { b: [100, 104], t: 'chaseL1', src: 18.4, note: 'L1 Spitzentempo bis Ziel (Verfolger)' },
  // ---- BREAKDOWN 3 → IMPACT: L3-Finale, Ziel exakt auf Beat 112.
  { b: [104, 108], t: 'fpL3', anchor: ['fin', 112], note: 'BD3: L3-Finale' },
  { b: [108, 110], t: 'fpL3', anchor: ['fin', 112], crop: PUNCH1, note: 'Punch-in 1.25×' },
  { b: [110, 112], t: 'fpL3', anchor: ['fin', 112], crop: PUNCH2, note: 'Punch-in 1.5×, Ziel auf IMPACT' },
  { b: [112, 116], t: 'fpL3', anchor: ['fin', 112], note: 'IMPACT: NEUE BESTZEIT' },
  // ---- ENDKARTE
  { b: [116, 132], t: 'flyL3', src: 1.0, mosaic: 12, snap: false, note: 'Endkarte (L3-Leuchtturm als Mosaik)' },
];

// ---------------------------------------------------------------------------------------------
// GRAFIK-TIMELINE (Beats)
// ---------------------------------------------------------------------------------------------
const C = { cyan: '#33f0ff', magenta: '#ff3fd0', text: '#f1edff', gold: '#ffd84a', gain: '#5dff9a' };
const two = (key, a, b, colA = C.cyan, colB = C.text) => ({
  key,
  lines: [
    { t: a, m: 3, color: colA },
    { t: b, m: 3, color: colB },
  ],
});
const TIMELINE60 = [
  // Cold Open: ohne Aufblende — Frame 0 ist schon Spielbild (Steam-Vorschau startet stumm mitten im Tempo).
  // Intro: Kino-Balken, Supers mittig.
  { type: 'letterbox', b0: 8, b1: 24, h: 138 },
  { type: 'super', b0: 9, b1: 11, pos: 'center', key: 'i1', lines: [{ t: 'NO GUNS.', m: 4, color: C.text }] },
  { type: 'super', b0: 11, b1: 13, pos: 'center', key: 'i2', lines: [{ t: 'NO BRAKES.', m: 4, color: C.text }] },
  { type: 'super', b0: 13, b1: 16, pos: 'center', key: 'i3', lines: [{ t: 'JUST SPEED.', m: 5, color: C.cyan }] },
  { type: 'flash', b: 16, size: 'small', gain: 0.6 },
  // Breakdown 1: ein Wort je Beat, gestapelt, groß.
  { type: 'shade', b0: 20, b1: 24, region: 'center', a: 0.45 },
  { type: 'super', b0: 20, b1: 24, pos: 'center', cyOff: -200, key: 'w1', lines: [{ t: 'BHOP.', m: 5, color: C.text }] },
  { type: 'super', b0: 21, b1: 24, pos: 'center', cyOff: 0, key: 'w2', lines: [{ t: 'STRAFE.', m: 5, color: C.text }] },
  { type: 'super', b0: 22, b1: 24, pos: 'center', cyOff: 200, key: 'w3', lines: [{ t: 'SURF.', m: 5, color: C.cyan }] },
  // DROP 1
  { type: 'flash', b: 24, size: 'big' },
  { type: 'slam', b0: 24, b1: 26 },
  { type: 'shade', b0: 28, b1: 32, region: 'll', a: 0.55 },
  { type: 'super', b0: 28, b1: 32, ...two('s1', '128-TICK', 'AIR STRAFING') },
  { type: 'flash', b: 32, size: 'small' },
  { type: 'shade', b0: 36, b1: 40, region: 'll', a: 0.55 },
  { type: 'super', b0: 36, b1: 40, ...two('s2', 'SKILL =', 'SPEED', C.text, C.cyan) },
  // Overdrive
  { type: 'flash', b: 40, size: 'small' },
  { type: 'shade', b0: 46, b1: 48, region: 'll', a: 0.55 },
  { type: 'super', b0: 46, b1: 48, ...two('s3', 'HAND-BUILT', 'LEVELS', C.gold, C.text) },
  { type: 'shade', b0: 48, b1: 52, region: 'll', a: 0.55 },
  { type: 'super', b0: 48, b1: 52, ...two('s4', 'SLIDE. HOP.', 'UNLOCK TRICKS.', C.text, C.magenta), shadow: C.cyan },
  { type: 'flash', b: 56, size: 'small', gain: 0.7 },
  { type: 'shade', b0: 58, b1: 64, region: 'll', a: 0.55 },
  { type: 'super', b0: 58, b1: 64, ...two('s5', 'RACE', 'YOUR GHOST', C.magenta, C.text), shadow: C.cyan },
  // Breakdown 2: Kino-Balken + Riesen-Tacho
  { type: 'letterbox', b0: 64, b1: 72, h: 138 },
  { type: 'speed', b0: 64, b1: 70 },
  // DROP 2
  { type: 'flash', b: 72, size: 'big' },
  { type: 'shade', b0: 76, b1: 84, region: 'll', a: 0.55 },
  { type: 'super', b0: 76, b1: 80, ...two('s6', 'EVERY RUN', 'VERIFIED.', C.text, C.cyan) },
  { type: 'super', b0: 80, b1: 84, ...two('s7', 'GLOBAL', 'LEADERBOARDS.', C.gold, C.text) },
  { type: 'flash', b: 84, size: 'small', gain: 0.6 },
  { type: 'shade', b0: 84, b1: 88, region: 'll', a: 0.55 },
  ...[1, 2, 3, 4].map((n) => ({
    type: 'super',
    b0: 83 + n,
    b1: 84 + n,
    noGlitch: n > 1,
    key: `lv${n}`,
    lines: [
      { t: `LEVEL ${n}/4`, m: 2, color: C.gold, gap: 3 },
      { t: 'NO TWO ALIKE', m: 3, color: C.cyan },
    ],
  })),
  { type: 'flash', b: 88, size: 'small', gain: 0.5 },
  { type: 'flash', b: 96, size: 'small', gain: 0.6 },
  // Breakdown 3 → IMPACT
  { type: 'letterbox', b0: 104, b1: 112, h: 138 },
  { type: 'flash', b: 108, size: 'small', gain: 0.5 },
  { type: 'flash', b: 110, size: 'small', gain: 0.7 },
  { type: 'flash', b: 112, size: 'big' },
  { type: 'flash', b: 116, size: 'small' },
  { type: 'end', b0: 116, pulseUntil: 128, tagline: 'NO GUNS. JUST SPEED.', cta: 'WISHLIST ON STEAM', features: '4 LEVELS  ·  TRAINING  ·  GHOST RACES  ·  LEADERBOARDS', featuresAt: 118 },
  { type: 'fade', dir: 'out', t0: TOTAL_BEATS * BEAT_S - 0.8, t1: TOTAL_BEATS * BEAT_S - 0.03 },
];

const RGB_HITS60 = [
  { b: 7.5, frames: 14, px: 6 },
  { b: 24, frames: 6, px: 14 },
  { b: 40, frames: 3, px: 6 },
  { b: 56, frames: 3, px: 6 },
  { b: 72, frames: 6, px: 14 },
  { b: 84, frames: 3, px: 6 },
  { b: 96, frames: 3, px: 6 },
  { b: 108, frames: 2, px: 6 },
  { b: 110, frames: 3, px: 8 },
  { b: 112, frames: 6, px: 14 },
  { b: 116, frames: 3, px: 8 },
];

// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// 30-s-SCHNITT (Social/Spot) auf der 30-s-Musik (media/audio/trailer_music.wav): Intro b0–8, Build b8–12,
// Surf-Breakdown b12–16, DROP b16, Overdrive b24, Phrase b32, Akzent b40, Breakdown b48–56, IMPACT b56, Endkarte b58.
// ---------------------------------------------------------------------------------------------
const CUTS30 = [
  { b: [0, 2], t: 'fpL3', src: 13.6, note: 'Hook: L3 Ego 1300 unter dem Mond (erstes Bild)' },
  { b: [2, 4], t: 'chaseL1', src: 18.6, note: 'Hook: L1 Sonnenuntergang 1200 (Verfolger)' },
  { b: [4, 6], t: 'chaseL1', src: 3.3, note: 'L1 Hop-Reihe Sonnenuntergang' },
  { b: [6, 8], t: 'flyL1', src: 2.0, note: 'L1 Establishing' },
  { b: [8, 10], t: 'fpL1', src: 4.4, note: 'Build: Bhop-Kette' },
  { b: [10, 12], t: 'chaseL2', src: 5.6, note: 'Build: L2 Ring (Verfolger)' },
  { b: [12, 16], t: 'chaseL3', src: 2.3, note: 'BD1: Einstieg Surf-Rampe' },
  { b: [16, 18], t: 'chaseL3', src: 2.3 + 4 * BEAT_S, snap: false, crop: PUNCH1, note: 'DROP: Logo-Slam' },
  { b: [18, 20], t: 'fpL3', src: 6.0, note: 'L3 Ego Surf' },
  { b: [20, 21], t: 'handKnife', anchor: [0.5, 20.25], crop: HAND.knife, note: 'Insert: Butterfly' },
  { b: [21, 22], t: 'handCard', anchor: [4.25, 21.3], crop: HAND.card, note: 'Insert: Karte' },
  { b: [22, 24], t: 'fpL1', src: 9.4, note: 'L1 Bhop 900' },
  { b: [24, 26], t: 'chaseL3', src: 8.3, note: 'Overdrive: L3 Kehre (Verfolger)' },
  { b: [26, 27], t: 'fpL3', src: 14.6, note: 'L3 Ego 1320' },
  { b: [27, 28], t: 'chaseL4', src: 22.6, note: 'L4 Surf (Verfolger)' },
  { b: [28, 30], t: 'flyL2', src: 0.2, note: 'L2 Ring von oben' },
  { b: [30, 32], t: 'slide', src: 2.3, note: 'Rutschen' },
  { b: [32, 36], t: 'ghostL1', src: 1.5, note: 'Ghost-Rennen' },
  { b: [36, 40], t: 'chaseL1', src: 16.6, note: 'L1 Spitzentempo (Verfolger)' },
  { b: [40, 41], t: 'chaseL1', src: 7.2, note: '4 LEVELS: L1' },
  { b: [41, 42], t: 'chaseL2', src: 7.4, note: '4 LEVELS: L2' },
  { b: [42, 43], t: 'chaseL3', src: 10.4, note: '4 LEVELS: L3' },
  { b: [43, 44], t: 'chaseL4', src: 21.2, note: '4 LEVELS: L4' },
  { b: [44, 45], t: 'fpL1', src: 19.0, note: 'L1' },
  { b: [45, 46], t: 'fpL2', src: 13.6, note: 'L2' },
  { b: [46, 47], t: 'fpL4', src: 25.6, note: 'L4' },
  { b: [47, 48], t: 'chaseL3', src: 15.0, note: 'L3 Mond-Gerade' },
  { b: [48, 52], t: 'fpL3', anchor: ['fin', 56], note: 'BD2: L3-Finale' },
  { b: [52, 54], t: 'fpL3', anchor: ['fin', 56], crop: PUNCH1, note: 'Punch-in' },
  { b: [54, 56], t: 'fpL3', anchor: ['fin', 56], crop: PUNCH2, note: 'Punch-in, Ziel auf IMPACT' },
  { b: [56, 58], t: 'fpL3', anchor: ['fin', 56], note: 'NEUE BESTZEIT' },
  { b: [58, 66], t: 'flyL3', src: 1.0, mosaic: 12, snap: false, note: 'Endkarte' },
];
const TIMELINE30 = [
  { type: 'letterbox', b0: 0, b1: 16, h: 138 },
  { type: 'super', b0: 1, b1: 3, pos: 'center', key: 'i1', lines: [{ t: 'NO GUNS.', m: 4, color: C.text }] },
  { type: 'super', b0: 3, b1: 5, pos: 'center', key: 'i2', lines: [{ t: 'NO BRAKES.', m: 4, color: C.text }] },
  { type: 'super', b0: 5, b1: 8, pos: 'center', key: 'i3', lines: [{ t: 'JUST SPEED.', m: 5, color: C.cyan }] },
  { type: 'flash', b: 8, size: 'small' },
  { type: 'shade', b0: 12, b1: 16, region: 'center', a: 0.45 },
  { type: 'super', b0: 12, b1: 16, pos: 'center', cyOff: -200, key: 'w1', lines: [{ t: 'BHOP.', m: 5, color: C.text }] },
  { type: 'super', b0: 13, b1: 16, pos: 'center', cyOff: 0, key: 'w2', lines: [{ t: 'STRAFE.', m: 5, color: C.text }] },
  { type: 'super', b0: 14, b1: 16, pos: 'center', cyOff: 200, key: 'w3', lines: [{ t: 'SURF.', m: 5, color: C.cyan }] },
  { type: 'flash', b: 16, size: 'big' },
  { type: 'slam', b0: 16, b1: 18 },
  { type: 'flash', b: 24, size: 'small' },
  { type: 'shade', b0: 24, b1: 28, region: 'll', a: 0.55 },
  { type: 'super', b0: 24, b1: 28, ...two('s1', '128-TICK', 'AIR STRAFING') },
  { type: 'flash', b: 32, size: 'small' },
  { type: 'shade', b0: 32, b1: 40, region: 'll', a: 0.55 },
  { type: 'super', b0: 32, b1: 36, ...two('s5', 'RACE', 'YOUR GHOST', C.magenta, C.text), shadow: C.cyan },
  { type: 'super', b0: 36, b1: 40, ...two('s7', 'GLOBAL', 'LEADERBOARDS.', C.gold, C.text) },
  { type: 'flash', b: 40, size: 'small', gain: 0.6 },
  { type: 'shade', b0: 40, b1: 44, region: 'll', a: 0.55 },
  ...[1, 2, 3, 4].map((n) => ({
    type: 'super',
    b0: 39 + n,
    b1: 40 + n,
    noGlitch: n > 1,
    key: `lv${n}`,
    lines: [
      { t: `LEVEL ${n}/4`, m: 2, color: C.gold, gap: 3 },
      { t: 'NO TWO ALIKE', m: 3, color: C.cyan },
    ],
  })),
  { type: 'letterbox', b0: 48, b1: 56, h: 138 },
  { type: 'flash', b: 52, size: 'small', gain: 0.5 },
  { type: 'flash', b: 54, size: 'small', gain: 0.7 },
  { type: 'flash', b: 56, size: 'big' },
  { type: 'flash', b: 58, size: 'small' },
  { type: 'end', b0: 58, pulseUntil: 64, tagline: 'NO GUNS. JUST SPEED.', cta: 'WISHLIST ON STEAM' },
  { type: 'fade', dir: 'out', t0: 29.25, t1: 29.97 },
];
const RGB_HITS30 = [
  { b: 16, frames: 6, px: 14 },
  { b: 24, frames: 3, px: 6 },
  { b: 32, frames: 3, px: 6 },
  { b: 52, frames: 2, px: 6 },
  { b: 54, frames: 3, px: 8 },
  { b: 56, frames: 6, px: 14 },
  { b: 58, frames: 3, px: 8 },
];
const WHOOSH30 = [
  [2, -14], [4, -14], [6, -14], [8, -10], [12, -10], [16, -8], [18, -13], [20, -15], [22, -14], [24, -10], [28, -13],
  [30, -14], [32, -11], [36, -12], [40, -11], [44, -13], [48, -10], [58, -13],
];

/** Aktiver Schnitt: Musik, Abschnitte (Beats) und Listen. Wird nach WHOOSH60 belegt (siehe unten). */
let SPEC = null;
function pickSpec() {
  SPEC = CUT30
    ? { cuts: CUTS30, timeline: TIMELINE30, rgb: RGB_HITS30, whoosh: WHOOSH30, music: 'media/audio/trailer_music.wav', wind: 'media/audio/stems/sfx_wind_surf_synced.wav', windFrom: 8, impact: 56, drops: [16], end: 58, coldUntil: 0, band: [18, 56] }
    : { cuts: CUTS60, timeline: TIMELINE60, rgb: RGB_HITS60, whoosh: WHOOSH60, music: 'media/audio/trailer60_music.wav', wind: 'media/audio/stems/sfx_wind_60.wav', windFrom: 16, impact: 112, drops: [24, 72], end: 116, coldUntil: 8, band: [26, 112] };
}

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28, ...opts });
  if (r.status !== 0) {
    console.error(r.stderr?.slice(-4000));
    throw new Error(`${cmd} fehlgeschlagen`);
  }
  return r;
}

/** Quellframe je Ausgabeframe (k = 0 … n−1). */
function frameMap(cu) {
  const out = [];
  let pos = cu.s;
  for (let k = 0; k < cu.n; k++) {
    out.push(Math.round(pos));
    const rate = cu.ramp ? cu.ramp[0] + (cu.ramp[1] - cu.ramp[0]) * (k / Math.max(1, cu.n - 1)) : cu.speed;
    pos += rate;
  }
  return out;
}

function resolveCuts() {
  return SPEC.cuts.map((cut, i) => {
    const tl = tele(cut.t);
    const frames = tl.length;
    const [b0, b1] = cut.b;
    const n = F(b1) - F(b0);
    const speed = cut.speed ?? 1;
    let s;
    if (cut.anchor) {
      let [srcT, atB] = cut.anchor;
      if (srcT === 'fin') srcT = tl.findIndex((x) => x.fin) / FPS;
      s = Math.round(srcT * FPS - (F(atB) - F(b0)) * speed);
    } else {
      s = Math.round(cut.src * FPS);
      if (cut.snap !== false && !cut.ramp) {
        const k0 = TAKE_KICK[cut.t] ?? 0;
        let m = Math.round((s - k0) / FPB);
        while (m > 0 && Math.round(k0 + m * FPB) + Math.ceil(n * speed) > frames) m--;
        s = Math.round(k0 + m * FPB);
      }
    }
    s = Math.max(0, s);
    const cu = { ...cut, i, s, n, f0: F(b0), f1: F(b1), speed };
    cu.map = frameMap(cu).map((x) => Math.min(frames - 1, x));
    const need = s + Math.ceil(n * speed);
    if (!cut.ramp && need > frames) console.warn(`! Schnitt ${i} (${cut.t}) braucht Frame ${need} > ${frames} (Standbild am Ende)`);
    return cu;
  });
}

/** Spot-Frame → Telemetrie des sichtbaren Quellframes (oder null). */
function teleAt(cuts, f) {
  const cu = cuts.find((c) => f >= c.f0 && f < c.f1);
  if (!cu) return null;
  return { cu, s: tele(cu.t)[cu.map[f - cu.f0]] };
}

// ---------- Segmente ----------
const V_MOSAIC = 'crop=576:1024:672:28,scale=45:80:flags=area,scale=1080:1920:flags=neighbor';
const V_SQ_Y = 420;

function segmentFilter(cu) {
  const up = 'scale=1920:1080:flags=neighbor';
  if (!VERTICAL) {
    if (cu.mosaic) return [`scale=${Math.round(1920 / cu.mosaic)}:${Math.round(1080 / cu.mosaic)}:flags=area`, `scale=${W}:${H}:flags=neighbor`];
    if (cu.crop) return [up, `crop=${cu.crop[2]}:${cu.crop[3]}:${cu.crop[0]}:${cu.crop[1]}`, `scale=${W}:${H}:flags=neighbor`];
    return [up];
  }
  if (cu.mosaic) return [up, V_MOSAIC];
  if (cu.crop && cu.crop[2] === 960) {
    const cx = cu.crop[0] + 480;
    const x = Math.max(0, Math.min(1920 - 540, Math.round((cx - 270) / 4) * 4));
    return [up, `crop=540:960:${x}:120`, 'scale=1080:1920:flags=neighbor'];
  }
  const z = cu.crop ? 1920 / cu.crop[2] : 1;
  const side = Math.round(1080 / z / 4) * 4;
  const x = Math.round((1920 - side) / 2 / 4) * 4;
  const y = Math.round((1080 - side) / 2 / 4) * 4;
  return [
    up,
    `split[a][b];[a]${V_MOSAIC},lutyuv=y=val*0.42[bg];[b]crop=${side}:${side}:${x}:${y},scale=1080:1080:flags=neighbor[fg];[bg][fg]overlay=0:${V_SQ_Y}`,
  ];
}

function segment(cu) {
  const dir = join(BUILD, 'segf', String(cu.i).padStart(2, '0'));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cu.map.forEach((src, k) => {
    const from = join(FRAMES, cu.t, `${String(src).padStart(5, '0')}.png`);
    const to = join(dir, `${String(k).padStart(5, '0')}.png`);
    try {
      linkSync(from, to);
    } catch {
      copyFileSync(from, to);
    }
  });
  const out = join(BUILD, 'seg', `${String(cu.i).padStart(2, '0')}.mp4`);
  sh('ffmpeg', [
    '-v', 'error', '-y',
    '-framerate', String(FPS), '-start_number', '0', '-i', join(dir, '%05d.png'),
    '-vf', [...segmentFilter(cu), 'setsar=1', 'format=yuv420p'].join(','),
    '-frames:v', String(cu.n), '-r', String(FPS),
    '-c:v', 'libx264', '-qp', '0', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    out,
  ]);
  rmSync(dir, { recursive: true, force: true });
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

// ---------- Overlay ----------
function layout() {
  if (!VERTICAL) return { llx: 96, lly: 1000, logoCx: 960, logoCy: 520, logoW: 1500, endLogoCx: 960, endLogoCy: 390, endLogoW: 1380, endTagY: 628, endBtnCy: 800, speedCy: 690, featY: 912 };
  return { llx: 64, lly: 1830, logoCx: 540, logoCy: 960, logoW: 1020, endLogoCx: 540, endLogoCy: 780, endLogoW: 1000, endTagY: 1010, endBtnCy: 1200, bandCy: 230, bandW: 760, speedCy: 1520, featY: 1330 };
}

function prepTimeline(cuts) {
  return SPEC.timeline.flatMap((raw) => {
    let el = raw;
    if (VERTICAL && el.type === 'super' && el.pos === 'center') el = { ...el, key: `${el.key}v`, lines: el.lines.map((l) => ({ ...l, m: Math.min(l.m, 3) })), cyOff: (el.cyOff ?? 0) * 0.6 };
    if (VERTICAL && el.type === 'letterbox') return [];
    if (el.type === 'speed') {
      const vals = [];
      for (let f = F(el.b0); f < F(el.b1); f++) vals.push(teleAt(cuts, f)?.s.sp ?? 0);
      el = { ...el, vals };
    }
    return [el];
  });
}

async function stepOverlay(cuts) {
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
    const tl = prepTimeline(cuts);
    await page.evaluate((c) => window.ov.setup(c), {
      W,
      H,
      fps: FPS,
      fpb: FPB,
      layout: layout(),
      timeline: VERTICAL ? [{ type: 'band', b0: SPEC.band[0], b1: SPEC.band[1] }, ...tl] : tl,
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
      if (f % 300 === 0) process.stdout.write(`${f} `);
    }
    console.log(`\nOverlay: ${drawn} gezeichnete Frames`);
  } finally {
    await browser.close();
  }
}

// ---------- Audio ----------
const WHOOSH_PEAK = 1.04;
const WHOOSH60 = [
  // Cold Open: jeder Schnitt ein leiser Vorbeizieher (die Musik ist dort gedämpft, die Whooshes nicht).
  [1, -15], [2, -16], [3, -15], [4, -16], [5, -15], [6, -16], [7, -14],
  [8, -10], [16, -12], [20, -13], [24, -8], [32, -14], [40, -10], [46, -14], [48, -13], [52, -14], [56, -11],
  [64, -10], [72, -8], [80, -14], [84, -12], [88, -13], [92, -14], [96, -12], [104, -10], [116, -12],
];

function sfxEvents(cuts) {
  const ev = [];
  const add = (t, file, db, note) => ev.push({ t, file, db, note });
  SPEC.whoosh.forEach(([b, db], k) => add(T(b) - WHOOSH_PEAK, `whoosh_pass_${k % 2 ? 'R' : 'L'}`, db, `Whoosh Beat ${b}`));
  // Ereignisse aus der Telemetrie des sichtbaren Bildes (nur Normaltempo, nicht im Cold Open = gedämpft).
  for (const cu of cuts) {
    if (cu.ramp || cu.speed !== 1 || cu.mosaic || cu.b[0] < SPEC.coldUntil) continue;
    const tl = tele(cu.t);
    const fpTake = cu.t.startsWith('fp') || /^l\d$/.test(cu.t) || cu.t === 'ghostL1' || cu.t === 'slide';
    for (let k = 1; k < cu.n; k++) {
      const a = tl[cu.map[k - 1]];
      const b = tl[cu.map[k]];
      const t = (cu.f0 + k) / FPS;
      if (fpTake && b.hop > a.hop && b.hop >= 2) add(t, `hop_chain${String(Math.min(12, b.hop)).padStart(2, '0')}`, -13, `Hop ×${b.hop} (${cu.t})`);
      for (const m of [1000, 1250]) if (a.sp < m && b.sp >= m) add(t, `zap_${m}`, -12, `${m} u/s (${cu.t})`);
      if (b.cp > a.cp && cu.b[0] < SPEC.impact - 8) add(t, 'checkpoint_chime', -13, `Checkpoint (${cu.t})`);
    }
  }
  for (const t of srcToSpot(cuts, 'handCan', 0.5)) add(t - 0.02, 'can_pssht', -6, 'Dose knacken');
  SPEC.drops.forEach((b, k) => add(T(b), 'land_hard', k === 0 ? -4 : -5, `DROP ${k + 1}`));
  add(T(SPEC.impact), 'finish_stab', -3, 'IMPACT');
  add(T(SPEC.impact), 'land_hard', -3, 'IMPACT');
  return ev.sort((a, b) => a.t - b.t);
}

function srcToSpot(cuts, take, srcT) {
  const out = [];
  for (const cu of cuts) {
    if (cu.t !== take) continue;
    const k = cu.map.indexOf(Math.round(srcT * FPS));
    if (k >= 0) out.push((cu.f0 + k) / FPS);
  }
  return out;
}

function stepAudio(cuts) {
  const ev = sfxEvents(cuts);
  writeFileSync(join(BUILD, 'sfx.json'), JSON.stringify(ev, null, 1));
  const dur = TOTAL_BEATS * BEAT_S;
  const inputs = ['-i', P(SPEC.music), '-i', P(SPEC.wind)];
  const fc = [];
  // Wind nur, wo Tempo im Bild ist (nicht Intro, nicht Endkarte).
  fc.push(`[1:a]volume='if(lt(t,${T(SPEC.windFrom)}),0,if(lt(t,${T(SPEC.impact)}),0.3,max(0,0.3*(1-(t-${T(SPEC.impact)})/0.8))))':eval=frame[wind]`);
  const labels = ['[0:a]', '[wind]'];
  ev.forEach((e, i) => {
    inputs.push('-i', P('media/audio/stems/oneshots', `${e.file}.wav`));
    const ms = Math.max(0, Math.round(e.t * 1000));
    fc.push(`[${i + 2}:a]volume=${e.db}dB,adelay=${ms}|${ms}[e${i}]`);
    labels.push(`[e${i}]`);
  });
  fc.push(`${labels.join('')}amix=inputs=${labels.length}:normalize=0:duration=first,atrim=0:${dur},alimiter=limit=0.84:level=false[mix]`);
  const mix = join(BUILD, 'mix.wav');
  sh('ffmpeg', ['-v', 'error', '-y', ...inputs, '-filter_complex', fc.join(';'), '-map', '[mix]', '-ar', '48000', '-c:a', 'pcm_s24le', mix]);
  const m = sh('ffmpeg', ['-hide_banner', '-i', mix, '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-']).stderr;
  const j = JSON.parse(m.slice(m.lastIndexOf('{'), m.lastIndexOf('}') + 1));
  const ln = `loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=${j.input_i}:measured_TP=${j.input_tp}:measured_LRA=${j.input_lra}:measured_thresh=${j.input_thresh}:offset=${j.target_offset}:linear=true`;
  sh('ffmpeg', ['-v', 'error', '-y', '-i', mix, '-af', `${ln},aresample=48000,atrim=0:${dur}`, '-c:a', 'pcm_s24le', join(BUILD, 'master.wav')]);
  console.log(`Audio: ${ev.length} SFX, Mix ${j.input_i} LUFS / ${j.input_tp} dBTP`);
}

// ---------- Final ----------
function stepFinal() {
  const hits = SPEC.rgb.filter((h) => F(h.b) < TOTAL_F).map((h) => {
    const a = F(h.b);
    return `rgbashift=rh=-${h.px}:bh=${h.px}:enable='between(n,${a},${a + h.frames - 1})'`;
  });
  const endF = F(SPEC.end);
  const vf = [
    `[0:v]format=gbrp,${hits.join(',')},vignette=angle=0.42:enable='lt(n,${endF})'[g]`,
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
    '-t', String(TOTAL_BEATS * BEAT_S), '-movflags', '+faststart',
    OUT,
  ]);
  console.log(`→ ${OUT}`);
}

// ---------- Prüfen ----------
function stepCheck() {
  mkdirSync(CHECK, { recursive: true });
  const tag = VERTICAL ? '_vertical' : '';
  console.log(sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,width,height,r_frame_rate,nb_frames', '-of', 'compact', OUT]).stdout.trim());
  const cw = VERTICAL ? 180 : 320;
  const ch = VERTICAL ? 320 : 180;
  const cols = VERTICAL ? 15 : 10;
  sh('ffmpeg', ['-v', 'error', '-y', '-i', OUT, '-vf', `select='not(mod(n\\,30))',scale=${cw}:${ch}:flags=area,drawtext=fontfile='C\\:/Windows/Fonts/consola.ttf':text='%{eif\\:n*0.5\\:d}.%{eif\\:mod(n*5\\,10)\\:d}':x=4:y=4:fontsize=16:fontcolor=yellow:box=1:boxcolor=black@0.6,tile=${cols}x${Math.ceil(TOTAL_F / 30 / cols)}`, '-frames:v', '1', join(CHECK, `contact_${TAG}.png`)]);
  const lr = spawnSync('ffmpeg', ['-hide_banner', '-i', OUT, '-af', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 26 }).stderr;
  console.log(lr.slice(lr.lastIndexOf('Summary:')).replace(/\n\s*\n/g, '\n'));
}

function printCuts(cuts) {
  for (const c of cuts)
    console.log(`  ${String(c.i).padStart(2)}  b${String(c.b[0]).padStart(4)}–${String(c.b[1]).padEnd(4)} ${(c.f0 / FPS).toFixed(2).padStart(6)} s  ${c.t.padEnd(10)} ab ${(c.s / FPS).toFixed(2)} s${c.speed !== 1 ? ` ×${c.speed}` : ''}${c.ramp ? ` Rampe ${c.ramp}` : ''}  ${c.note}`);
}

const steps = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const all = steps.length === 0;
mkdirSync(BUILD, { recursive: true });
pickSpec();
const cuts = resolveCuts().filter((c) => c.f0 < TOTAL_F);
printCuts(cuts);
if (all || steps.includes('segments')) stepSegments(cuts);
if (all || steps.includes('overlay')) await stepOverlay(cuts);
if (all || steps.includes('audio')) stepAudio(cuts);
if (all || steps.includes('final')) stepFinal();
if (all || steps.includes('check')) stepCheck();
if (!existsSync(OUT) && steps.includes('check')) console.warn('kein Video');
