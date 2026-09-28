/**
 * T8 SURF: SPEED — Höhe in Tempo verwandeln (Plan 007; v2-Entwurf §3 T8).
 *
 * Zwei 10°-Rampen hintereinander (L2-Profil: 768 breit, 60°-Flanken), die zweite als Drop: sie beginnt 96 u vor
 * dem Ende der ersten, 128 u tiefer (level-design Regel 5 — keine Stirnfläche, egal wie tief oder schnell).
 * Einstieg wie T7 von einer Plattform 120 u unter dem First (40 u Fall auf die Ostflanke), darunter ein
 * Auffangboden (10°, 32 u unter dem Fuß der zweiten Rampe), Rückweg im Süden, F.
 *   800        beim Surfen 800 u/s erreichen.
 *   DROP       auf der zweiten Rampe ankommen (surfend über den Drop).
 *   1000       beim Surfen 1000 u/s — öffnet das Tor zum Portal am Nordende.
 *   Bonus/Meister: höheres Tempo (Werte aus der Messung, s. T8_BONUS/T8_MASTER).
 * Keine Zeit-Aufgaben auf fallenden Rampen (v2-Messung: "6 s halten" auf 10° schafft niemand, das Ende
 * kommt vorher).
 */
import type { LevelFile } from '../../../src/world/level/LevelFormat';
import { Frame } from '../lib';
import { routeHand, surfHand } from './drivers';
import { ENV_ADVANCED, LessonBuilder, TC } from './lessonLib';
import type { LessonCheck } from './lessonLib';

const DEG = Math.PI / 180;
const APEX = 1200;
const L1 = 2400;
const L2 = 2400;
const SLOPE = 10;
const WIDTH = 768;
const FLANK = 60;
const OVERLAP = 96;
const DROP_H = 128;
const ENTRY = 120;
const FALL = 40;
const PLAT_Y = APEX - ENTRY;
const X_IN = (ENTRY + FALL) / Math.tan(FLANK * DEG);
const PLAT_X: readonly [number, number] = [Math.round(X_IN + 16), Math.round(X_IN + 320)];
const PLAT_Z1 = 2200;
const HALF = 1400;
const HEIGHT = (WIDTH / 2) * Math.tan(FLANK * DEG);
const TAN = Math.tan(SLOPE * DEG);
/** Firstlinie der zweiten Rampe, nach Süden verlängert (s entlang −Z). */
const apex2At = (s: number): number => APEX - (L1 - OVERLAP) * TAN - DROP_H - (s - (L1 - OVERLAP)) * TAN;
/** Auffangboden: 32 u unter dem Fuß der zweiten Rampe, gleiches Gefälle. */
const pitAt = (s: number): number => Math.round(apex2At(s) - HEIGHT - 32);
const PIT_S: readonly [number, number] = [-PLAT_Z1, L1 - OVERLAP + L2 + 1000];
const WALL_TOP = APEX + 400;
export const PIT_Y = PLAT_Y - 300;
/** Tempo-Ziele (u/s). Bonus/Meister aus der Messung (check.ts t8). */
export const T8_BONUS = 1100;
export const T8_MASTER = 1200;

export function buildT8(): LevelFile {
  const B = new LessonBuilder({ id: 't8', name: 'SURF: SPEED', subtitle: 'Höhe wird Tempo.', lesson: 8, group: 'advanced', killY: pitAt(PIT_S[1]) - 600, environment: ENV_ADVANCED });
  const L = B.L;
  const z = (s: number): number => -s;
  const f = Frame.at([0, 0], 0);
  const r1 = L.surfRamp({ start: [0, 0], yaw: 0, length: L1, apex: APEX, apexEnd: APEX - L1 * TAN, width: WIDTH, flankDeg: FLANK, tag: 'rampe1' });
  const r2 = L.surfDrop(r1, { overlap: OVERLAP, drop: DROP_H, length: L2, slopeDeg: SLOPE, tag: 'rampe2' });
  L.ramp(f, [PIT_S[0], PIT_S[1]], [-HALF, HALF], pitAt(PIT_S[0]), pitAt(PIT_S[1]), { mat: 'metal', tag: 'auffang', thick: 96 });
  const t = 64;
  const low = pitAt(PIT_S[1]) - 96;
  L.box([-HALF - t, low, z(PIT_S[1])], [-HALF, WALL_TOP, z(PIT_S[0])], { mat: 'wall', tag: 'bande-w' });
  L.box([HALF, low, z(PIT_S[1])], [HALF + t, WALL_TOP, z(PIT_S[0])], { mat: 'wall', tag: 'bande-o' });
  L.box([-HALF - t, low, z(PIT_S[1] + t)], [HALF + t, WALL_TOP, z(PIT_S[1])], { mat: 'wall', tag: 'bande-n' });
  // Startplattform, Rückweg, Quersteg, Portal-Nische im Süden hinter 'ausgang'.
  const south = B.surfSouth({ platY: PLAT_Y, platX: PLAT_X, west: false, pitAt, half: HALF, low, wallTop: WALL_TOP });
  // Zone auf der zweiten Rampe (hinter der Überlappung, obere 400 u der Ostflanke).
  const s2 = L1 - OVERLAP;
  B.zone('rampe2', [8, apex2At(s2 + 500) - 400, z(s2 + 500)], [WIDTH / 2, apex2At(s2 + 100) + 8, z(s2 + 100)]);
  B.zone('grube', [-HALF, pitAt(PIT_S[1]) - 8, z(PIT_S[1])], [HALF, pitAt(0) + 100, z(0)]);
  // Markierung: Drop-Kante (Leuchtband quer über den First der zweiten Rampe am Überlappungs-Ende).
  L.chevron([(PLAT_X[0] + PLAT_X[1]) / 2, PLAT_Y, z(-360)], 0, { tint: TC.lime, arm: 64 });
  L.chevron([(PLAT_X[0] + PLAT_X[1]) / 2, PLAT_Y, z(-220)], 0, { tint: TC.lime, arm: 64 });
  const sx = PLAT_X[0] + 32;
  L.spawn([sx, PLAT_Y, 560], 0);

  // Route: Portal → Quersteg → Plattform (berührt das Ziel), Spawn, Absprung, Surf-Knoten Ostflanke beider Rampen.
  L.node(south.portal, { note: 'portal' });
  L.node([sx, PLAT_Y, south.steg[2]]); // 1
  L.node([sx, PLAT_Y, 1800]); // 2
  L.node([sx, PLAT_Y, 560], { note: 'spawn' }); // 3
  L.node([sx, PLAT_Y, 40]); // 4
  for (const s of [400, 1000, 1600, 2150]) L.node(r1.riderPos(s, 1, 180), { surf: true }); // 5..8
  for (const s of [400, 1000, 1600, 2150]) L.node(r2.riderPos(s, 1, 200), { surf: true }); // 9..12
  const demo = { kind: 'route', from: 3, to: 12, seconds: 12 } as const;

  B.stage({
    id: 'v800',
    title: 'TEMPO 800',
    text: 'SURFEN WIE IN T7, DIE RAMPE FÄLLT:\nTIEFER AN DER FLANKE = SCHNELLER',
    task: { kind: 'surfSpeed', min: 800 },
    spawn: { pos: [sx, PLAT_Y, 560], yaw: 0 },
    demo,
    tips: [{ on: 'land', zone: 'grube', text: 'TASTE IN DIE RAMPE HALTEN\n[F] = ZURÜCK NACH OBEN' }],
  });
  B.stage({
    id: 'drop',
    title: 'DER DROP',
    text: 'AM ENDE WEITERSURFEN: DIE NÄCHSTE\nRAMPE BEGINNT TIEFER, EINFACH FALLEN',
    task: { kind: 'reach', zone: 'rampe2' },
    demo,
  });
  B.stage({
    id: 'v1000',
    title: 'TEMPO 1000',
    text: 'BEIDE RAMPEN IN EINEM ZUG\nSURFE SCHNELLER ALS 1000',
    task: { kind: 'surfSpeed', min: 1000 },
    opens: ['ausgang'],
    demo,
  });
  B.stage({
    id: 'bonus',
    title: `BONUS ${T8_BONUS}`,
    text: `BONUS: SCHNELLER ALS ${T8_BONUS}\nRUHIG ENTLANG, NICHT GEGENLENKEN`,
    task: { kind: 'surfSpeed', min: T8_BONUS },
    rank: 'bonus',
  });
  B.stage({
    id: 'meister',
    title: `MEISTER ${T8_MASTER}`,
    text: `MEISTER: SCHNELLER ALS ${T8_MASTER}\nSAUBERE LINIE ÜBER BEIDE RAMPEN`,
    task: { kind: 'surfSpeed', min: T8_MASTER },
    rank: 'master',
  });
  return B.build();
}

export const T8_CHECK: LessonCheck = {
  rows: [
    { model: 'Grundtechnik ±3° / 0.3 s', from: 'v800', to: 'v1000', make: surfHand('grund', 3, 0.3, PIT_Y), expect: { min: 18 }, level: 'error', seconds: 120 },
    { model: 'Grundtechnik ±6° / 0.6 s', from: 'v800', to: 'v1000', make: surfHand('grund', 6, 0.6, PIT_Y), expect: { min: 0 }, level: 'info', seconds: 120 },
    { model: 'Grundtechnik ±6° / 0.6 s (800)', from: 'v800', make: surfHand('grund', 6, 0.6, PIT_Y), expect: { min: 0 }, level: 'info', seconds: 120 },
    // RouteFollower regelt an der Flanke auf seine Knotenlinie und strafet dort: kein Tempo-Modell für T8 (Median 613 u/s).
    { model: 'RouteFollower 5° (nur Info)', from: 'v800', to: 'v1000', make: routeHand({ from: 3, to: 12, noise: 5, retry: true }), expect: { min: 0 }, level: 'info', seconds: 120 },
    { model: 'Fehler: nur W', from: 'v800', make: surfHand('w', 3, 0.3, PIT_Y), expect: { max: 0 }, level: 'error', seconds: 60 },
    { model: 'Fehler: nichts drücken', from: 'v800', make: surfHand('nichts', 3, 0.3, PIT_Y), expect: { max: 0 }, level: 'error', seconds: 60 },
    { model: 'Fehler: Taste von der Rampe weg', from: 'v800', make: surfHand('weg', 3, 0.3, PIT_Y), expect: { max: 0 }, level: 'error', seconds: 60 },
    { model: 'Grundtechnik ±3° / 0.3 s (Bonus)', from: 'bonus', make: surfHand('grund', 3, 0.3, PIT_Y), expect: { min: 0 }, level: 'info', seconds: 120 },
    { model: 'Grundtechnik ±1° / 0.1 s (Bonus)', from: 'bonus', make: surfHand('grund', 1, 0.1, PIT_Y), expect: { min: 15 }, level: 'warning', seconds: 120 },
    { model: 'Grundtechnik ±1° / 0.1 s (Meister)', from: 'meister', make: surfHand('grund', 1, 0.1, PIT_Y), expect: { min: 5 }, level: 'warning', seconds: 120 },
    { model: 'Grundtechnik ±3° / 0.3 s (Meister)', from: 'meister', make: surfHand('grund', 3, 0.3, PIT_Y), expect: { min: 0 }, level: 'info', seconds: 120 },
  ],
};
