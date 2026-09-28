/**
 * T7 SURF: HALTEN — an der Rampe bleiben (Plan 007; Prototyp lessonSurf, v2-Entwurf §3 T7).
 *
 * Eine lange Surf-Rampe Richtung −Z (60°-Flanken, 768 breit, 6000 lang, Achsgefälle 3°). Einstieg von einer
 * Startplattform östlich des Firsts, 120 u darunter: wer am Ende (z = 0) abläuft, fällt ~40 u auf die
 * Ostflanke (v2-Messung: tiefer oder mit mehr Fall bleibt keine Reaktionszeit, am First kriecht man auf den
 * begehbaren Grat). Darunter ein Auffangboden 32 u unter dem Rampenfuß (Gefälle wie die Rampe), Banden, und
 * im Süden eine begehbare Rampe zurück auf die Startplattform — oder sofort F.
 *   HALTEN     3 s ununterbrochen surfen (Lücken ≤ 0.15 s zählen weiter).
 *   LÄNGER     6 s — öffnet das Tor zum Portal am Nordende des Auffangbodens.
 *   Bonus      WESTFLANKE: von der Westplattform, durch drei Messzonen auf der Westflanke (A statt D).
 *   Meister    OBEN: durch vier obere Marken (≤ 260 u unter dem First) mit ≥ 300 u/s — die Grundtechnik
 *              hält sich, rutscht aber tief und kriecht (100–250 u/s); oben und schnell bleibt nur, wer den
 *              Blick sauber entlang der Rampe hält.
 * Luftlenkung (W) wirkt an Flanken nicht (Plan 007 A8) — nur die Taste in die Rampe hält.
 */
import type { LevelFile } from '../../../src/world/level/LevelFormat';
import { Frame } from '../lib';
import { routeHand, surfHand } from './drivers';
import { ENV_ADVANCED, LessonBuilder, TC } from './lessonLib';
import type { LessonCheck } from './lessonLib';

const DEG = Math.PI / 180;
export const APEX = 600;
export const LEN = 6000;
export const SLOPE = 3;
const WIDTH = 768;
const FLANK = 60;
/** Einstieg: Plattform-Oberkante so tief unter dem First, Fall bis zur Flanke. */
const ENTRY = 120;
const DROP = 40;
const PLAT_Y = APEX - ENTRY;
/** Innenkante der Startplattform (x): dort liegt die Flanke DROP u unter der Plattform. */
const X_IN = (ENTRY + DROP) / Math.tan(FLANK * DEG);
const PLAT_X: readonly [number, number] = [Math.round(X_IN + 16), Math.round(X_IN + 320)];
/** Plattform reicht nach Süden bis zum Rückweg. */
const PLAT_Z1 = 2200;
const HALF = 1400;
const HEIGHT = (WIDTH / 2) * Math.tan(FLANK * DEG);
const apexAt = (s: number): number => APEX - s * Math.tan(SLOPE * DEG);
/** Auffangboden 32 u unter dem Rampenfuß, gleiches Gefälle (s entlang −Z, auch negativ = südlich). */
const pitAt = (s: number): number => Math.round(apexAt(s) - HEIGHT - 32);
const PIT_S: readonly [number, number] = [-PLAT_Z1, LEN + 900];
const WALL_TOP = APEX + 400;
/** Füße unter dieser Höhe = unten in der Grube (Surf-Hand drückt F). */
export const PIT_Y = PLAT_Y - 200;
/** Index des letzten Surf-Knotens der Route (Portal, Steg, Plattform, Spawn, Kante, dann 7 Surf-Knoten). */
const T7_LAST = 4 + Math.floor((LEN - 800) / 800) + 1;

export function buildT7(): LevelFile {
  const B = new LessonBuilder({ id: 't7', name: 'SURF: HALTEN', subtitle: 'An der Rampe bleiben.', lesson: 7, group: 'advanced', killY: pitAt(PIT_S[1]) - 600, environment: ENV_ADVANCED });
  const L = B.L;
  const z = (s: number): number => -s;
  const f = Frame.at([0, 0], 0);
  const ramp = L.surfRamp({ start: [0, 0], yaw: 0, length: LEN, apex: APEX, apexEnd: apexAt(LEN), width: WIDTH, flankDeg: FLANK, tag: 'rampe' });
  // Auffangboden (walkbar, 3°) unter der Rampe und südlich davon bis zum Rückweg.
  L.ramp(f, [PIT_S[0], PIT_S[1]], [-HALF, HALF], pitAt(PIT_S[0]), pitAt(PIT_S[1]), { mat: 'metal', tag: 'auffang', thick: 96 });
  // Banden
  const t = 64;
  const low = pitAt(PIT_S[1]) - 96;
  L.box([-HALF - t, low, z(PIT_S[1])], [-HALF, WALL_TOP, z(PIT_S[0])], { mat: 'wall', tag: 'bande-w' });
  L.box([HALF, low, z(PIT_S[1])], [HALF + t, WALL_TOP, z(PIT_S[0])], { mat: 'wall', tag: 'bande-o' });
  L.box([-HALF - t, low, z(PIT_S[1] + t)], [HALF + t, WALL_TOP, z(PIT_S[1])], { mat: 'wall', tag: 'bande-n' });
  // Startplattformen Ost (Pflicht) und West (Bonus), Rückweg, Quersteg, Portal-Nische im Süden hinter 'ausgang'.
  const south = B.surfSouth({ platY: PLAT_Y, platX: PLAT_X, west: true, pitAt, half: HALF, low, wallTop: WALL_TOP });
  // Zonen: Westflanke (Bonus) und Grube (Tipp).
  const west = [1500, 3000, 4500];
  west.forEach((s, i) => B.zone(`west${i}`, [-WIDTH / 2, apexAt(s) - HEIGHT, z(s + 120)], [-8, apexAt(s) + 8, z(s - 120)]));
  // Meister: obere Marken (Füße höchstens 260 u unter dem First) an der Ostflanke.
  const high = [1200, 2400, 3600, 4800];
  high.forEach((s, i) => B.zone(`hoch${i}`, [8, apexAt(s) - 260, z(s + 150)], [Math.round(260 / Math.tan(FLANK * DEG)) + 16, apexAt(s) + 8, z(s - 150)]));
  B.zone('grube', [-HALF, pitAt(PIT_S[1]) - 8, z(LEN)], [HALF, pitAt(0) + 100, z(0)]);
  // Markierungen: Pfeile auf der Plattform Richtung Rampe.
  for (let k = 0; k < 3; k++) {
    L.chevron([(PLAT_X[0] + PLAT_X[1]) / 2, PLAT_Y, z(-500 + k * 140)], 0, { tint: TC.lime, arm: 64 });
    L.chevron([-(PLAT_X[0] + PLAT_X[1]) / 2, PLAT_Y, z(-500 + k * 140)], 0, { tint: TC.magenta, arm: 64 });
  }
  const sx = PLAT_X[0] + 32;
  L.spawn([sx, PLAT_Y, 560], 0);

  // Route: Portal → Quersteg → Plattform (so berührt sie das Ziel), dann Spawn, Absprung, Surf-Knoten Ostflanke.
  L.node(south.portal, { note: 'portal' });
  L.node([sx, PLAT_Y, south.steg[2]]); // 1
  L.node([sx, PLAT_Y, 1800]); // 2
  L.node([sx, PLAT_Y, 560], { note: 'spawn' }); // 3
  L.node([sx, PLAT_Y, 40]); // 4
  let last = 4;
  for (let s = 400; s <= LEN - 400; s += 800, last++) L.node(ramp.riderPos(s, 1, 150), { surf: true }); // 5 …
  /** Vorführung und RouteFollower: ab dem Spawn (3) bis zum letzten Surf-Knoten. */
  const demo = { kind: 'route', from: 3, to: last, seconds: 14 } as const;
  B.stage({
    id: 'halten3',
    title: 'HALTEN',
    text: 'LAUF AB, DANN A IN DIE RAMPE\nW LOS, BLICK ENTLANG DER RAMPE',
    task: { kind: 'surfHold', seconds: 3 },
    spawn: { pos: [sx, PLAT_Y, 560], yaw: 0 },
    demo,
    tips: [
      { on: 'surf', after: 0.4, text: 'JETZT A HALTEN: DIE TASTE\nZUR RAMPE HIN HÄLT DICH OBEN' },
      { on: 'zone', zone: 'grube', text: 'RUNTERGERUTSCHT? A SCHON IM FALL\nDRÜCKEN. [F] = ZURÜCK NACH OBEN' },
    ],
  });
  B.stage({
    id: 'halten6',
    title: 'LÄNGER',
    text: '6 SEKUNDEN AM STÜCK SURFEN\nRUHIG BLEIBEN, NICHT LENKEN',
    task: { kind: 'surfHold', seconds: 6 },
    opens: ['ausgang'],
    demo,
    tips: [{ on: 'zone', zone: 'grube', text: 'A GEDRÜCKT HALTEN BIS ZUM ENDE\n[F] = ZURÜCK NACH OBEN' }],
  });
  B.stage({
    id: 'west',
    title: 'WESTFLANKE',
    text: 'BONUS: VON DER WESTPLATTFORM\nJETZT MIT D DURCH DIE DREI MARKEN',
    task: { kind: 'course', zones: west.map((_, i) => `west${i}`), minSpeed: 200, airborne: true, groundGrace: 0.1 },
    rank: 'bonus',
    spawn: { pos: [-sx, PLAT_Y, 560], yaw: 0 },
  });
  B.stage({
    id: 'oben',
    title: 'MEISTER: OBEN',
    text: 'MEISTER: HOCH UND SCHNELL SURFEN\nDURCH DIE 4 OBEREN MARKEN, ÜBER 300',
    task: { kind: 'course', zones: high.map((_, i) => `hoch${i}`), minSpeed: 300, airborne: true, groundGrace: 0.1 },
    rank: 'master',
    spawn: { pos: [sx, PLAT_Y, 560], yaw: 0 },
  });
  return B.build();
}

export const T7_CHECK: LessonCheck = {
  rows: [
    // Pflicht: Grundtechnik (Taste in die Rampe, Blick entlang mit Zielfehler, Reaktion nach Kontakt).
    { model: 'Grundtechnik ±6° / 0.6 s', from: 'halten3', to: 'halten6', make: surfHand('grund', 6, 0.6, PIT_Y), expect: { min: 20 }, level: 'error', seconds: 120 },
    { model: 'Grundtechnik ±3° / 0.3 s', from: 'halten3', to: 'halten6', make: surfHand('grund', 3, 0.3, PIT_Y), expect: { min: 20 }, level: 'error', seconds: 120 },
    { model: 'W + A (Strafe-Assist)', from: 'halten3', to: 'halten6', make: surfHand('wa', 3, 0.3, PIT_Y), expect: { min: 18 }, level: 'warning', seconds: 120 },
    { model: 'Fehler: nur W', from: 'halten3', make: surfHand('w', 3, 0.3, PIT_Y), expect: { max: 0 }, level: 'error', seconds: 60 },
    { model: 'Fehler: nichts drücken', from: 'halten3', make: surfHand('nichts', 3, 0.3, PIT_Y), expect: { max: 0 }, level: 'error', seconds: 60 },
    { model: 'Fehler: Taste von der Rampe weg', from: 'halten3', make: surfHand('weg', 3, 0.3, PIT_Y), expect: { max: 0 }, level: 'error', seconds: 60 },
    { model: 'RouteFollower 5°', from: 'halten3', to: 'halten6', make: routeHand({ from: 3, to: T7_LAST, noise: 5, retry: true }), expect: { min: 18 }, level: 'warning', seconds: 120 },
    { model: 'Grundtechnik ±3° / 0.3 s (Bonus West)', from: 'west', make: surfHand('grund', 3, 0.3, PIT_Y), expect: { min: 18 }, level: 'warning', seconds: 120 },
    { model: 'Grundtechnik ±3° / 0.3 s (Meister)', from: 'oben', make: surfHand('grund', 3, 0.3, PIT_Y), expect: { min: 0 }, level: 'info', seconds: 120 },
    { model: 'Grundtechnik ±1° / 0.1 s (Meister)', from: 'oben', make: surfHand('grund', 1, 0.1, PIT_Y), expect: { min: 0 }, level: 'info', seconds: 120 },
    { model: 'RouteFollower 2° (Meister)', from: 'oben', make: routeHand({ from: 3, to: T7_LAST, noise: 2, retry: true }), expect: { min: 10 }, level: 'warning', seconds: 120 },
  ],
};
