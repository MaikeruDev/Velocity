/**
 * T8 SURF: SPEED — Höhe in Tempo verwandeln (Plan 007; v2-Entwurf §3 T8).
 *
 * Zwei Rampen hintereinander (L2-Profil: 768 breit, 60°-Flanken): 2400 u mit 10°, dann als Drop 3000 u mit 14° —
 * sie beginnt 96 u vor dem Ende der ersten, 128 u tiefer (level-design Regel 5 — keine Stirnfläche, egal wie tief
 * oder schnell). Einstieg wie T7 von einer Plattform 120 u unter dem First (40 u Fall auf die Ostflanke), darunter
 * ein Auffangboden 32 u unter dem Fuß der zweiten Rampe (unter Rampe 1 und im Süden 10°, unter Rampe 2 14° — ein
 * durchgehender 14°-Boden läge im Süden über der Startplattform), Rückweg im Süden, F.
 *   800        beim Surfen 800 u/s erreichen.
 *   DROP       auf der zweiten Rampe ankommen (surfend über den Drop; Leuchtstreifen quer über ihre Flanke).
 *   1000       beim Surfen 1000 u/s — öffnet das Tor zum Portal im Süden.
 *   Bonus 1200 / Meister 1300 (T8_BONUS/T8_MASTER, aus der Messung).
 * Messung (T8_DEFAULT, Grundtechnik-Hand, 40 Fahrten ab dem Spawn, Anteil ≥ 1000 u/s): die T7-Referenz ±6°/0.6 s
 * schaffte mit 2 × 10°/2400 nur 15 % ihrer Fahrten (die Rampe endet bei 700–900 u/s; 12/20 in 120 s, 117× F), mit
 * 10°/3000 18 %, 12°/3000 28 %, 14°/3000 43 %. Die Leiter bleibt: ±3° ≥ 1200 70 %, ±1° ≥ 1300 98 %, ±3° ≥ 1300 15 %.
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
const WALL_TOP = APEX + 400;
export const PIT_Y = PLAT_Y - 300;
/** Tempo-Ziele (u/s). Bonus/Meister aus der Messung (Kopf, check.ts t8). */
export const T8_BONUS = 1200;
export const T8_MASTER = 1300;
/** Zu langsam an der Flanke: fast immer der Blick in die Rampe (die Wunschrichtung zeigt dann nach hinten). */
const SLOW_TIP = 'ZU LANGSAM? NICHT IN DIE RAMPE\nSCHAUEN: BLICK GENAU ENTLANG';

/** Stellschrauben der Geometrie (Messung: tools/levels/training/check.ts t8). */
export interface T8Params {
  /** Länge der ersten und der zweiten Rampe (u). */
  readonly l1: number;
  readonly l2: number;
  /** Achsgefälle der zweiten Rampe (Grad). */
  readonly slope2: number;
}

export const T8_DEFAULT: T8Params = { l1: 2400, l2: 3000, slope2: 14 };

/** Surf-Knoten der zweiten Rampe (alle 600 u ab 400, dazu 250 vor dem Ende). */
const ramp2Nodes = (l2: number): number[] => {
  const out: number[] = [];
  for (let s = 400; s < l2 - 250; s += 600) out.push(s);
  out.push(l2 - 250);
  return out;
};
/** Index des letzten Surf-Knotens der Route (Portal, Steg, Plattform, Spawn, Kante, 4 Knoten Rampe 1, dann Rampe 2). */
const lastNode = (p: T8Params): number => 4 + 4 + ramp2Nodes(p.l2).length;

export function buildT8(p: T8Params = T8_DEFAULT): LevelFile {
  const L1 = p.l1;
  const L2 = p.l2;
  const TAN2 = Math.tan(p.slope2 * DEG);
  const s2 = L1 - OVERLAP;
  /** Firstlinie der zweiten Rampe (s entlang −Z); südlich ihres Anfangs mit dem Gefälle der ersten verlängert. */
  const apex2At = (s: number): number => APEX - s2 * TAN - DROP_H - (s - s2) * (s < s2 ? TAN : TAN2);
  /** Auffangboden: 32 u unter dem Fuß der zweiten Rampe, Knick bei s2. */
  const pitAt = (s: number): number => Math.round(apex2At(s) - HEIGHT - 32);
  const PIT_S: readonly [number, number] = [-PLAT_Z1, L1 - OVERLAP + L2 + 1000];
  const B = new LessonBuilder({ id: 't8', name: 'SURF: SPEED', subtitle: 'Höhe wird Tempo.', lesson: 8, group: 'advanced', killY: pitAt(PIT_S[1]) - 600, environment: ENV_ADVANCED });
  const L = B.L;
  const z = (s: number): number => -s;
  const f = Frame.at([0, 0], 0);
  const r1 = L.surfRamp({ start: [0, 0], yaw: 0, length: L1, apex: APEX, apexEnd: APEX - L1 * TAN, width: WIDTH, flankDeg: FLANK, tag: 'rampe1' });
  const r2 = L.surfDrop(r1, { overlap: OVERLAP, drop: DROP_H, length: L2, slopeDeg: p.slope2, tag: 'rampe2' });
  L.ramp(f, [PIT_S[0], s2], [-HALF, HALF], pitAt(PIT_S[0]), pitAt(s2), { mat: 'metal', tag: 'auffang', thick: 96 });
  L.ramp(f, [s2, PIT_S[1]], [-HALF, HALF], pitAt(s2), pitAt(PIT_S[1]), { mat: 'metal', tag: 'auffang2', thick: 96 });
  const t = 64;
  const low = pitAt(PIT_S[1]) - 96;
  L.box([-HALF - t, low, z(PIT_S[1])], [-HALF, WALL_TOP, z(PIT_S[0])], { mat: 'wall', tag: 'bande-w' });
  L.box([HALF, low, z(PIT_S[1])], [HALF + t, WALL_TOP, z(PIT_S[0])], { mat: 'wall', tag: 'bande-o' });
  L.box([-HALF - t, low, z(PIT_S[1] + t)], [HALF + t, WALL_TOP, z(PIT_S[1])], { mat: 'wall', tag: 'bande-n' });
  // Startplattform, Rückweg, Quersteg, Portal-Nische im Süden hinter 'ausgang'.
  const south = B.surfSouth({ platY: PLAT_Y, platX: PLAT_X, west: false, pitAt, half: HALF, low, wallTop: WALL_TOP });
  // Zone auf der zweiten Rampe (hinter der Überlappung, obere 400 u der Ostflanke).
  B.zone('rampe2', [8, apex2At(s2 + 500) - 400, z(s2 + 500)], [WIDTH / 2, apex2At(s2 + 100) + 8, z(s2 + 100)]);
  B.zone('grube', [-HALF, pitAt(PIT_S[1]) - 8, z(PIT_S[1])], [HALF, pitAt(0) + 100, z(0)]);
  // Markierung: grüner Bogen über der zweiten Rampe am Anfang der Zone 'rampe2' (hier ist man "drüben"; Bildsprache
  // der Surf-Level L1–L3, Pfosten auf dem Auffangboden), dazu Pfeile auf der Plattform Richtung Rampe.
  // Sturz 120 über dem First der ERSTEN Rampe (endet 4 u davor): wer oben von ihr abfliegt, fliegt unter ihm durch.
  const dropS = s2 + 100;
  const dropBase = pitAt(dropS - 16) + 1;
  B.markArch(f, dropS, [-WIDTH / 2 - 96, WIDTH / 2 + 96], dropBase, Math.round(APEX - L1 * TAN + 120), TC.lime, 32, 'drop-bogen');
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
  for (const s of [400, 1000, 1600, L1 - 250]) L.node(r1.riderPos(s, 1, 180), { surf: true }); // 5..8
  for (const s of ramp2Nodes(L2)) L.node(r2.riderPos(s, 1, 200), { surf: true }); // 9..
  const demo = { kind: 'route', from: 3, to: lastNode(p), seconds: 12 } as const;

  B.stage({
    id: 'v800',
    title: 'TEMPO 800',
    // Der Blick entscheidet (Grundtechnik ±3°, fester Fehler): 3° in die Rampe 5/20, 4° 0/20 — die Flanke hinab bis
    // 6° 20/20. "TIEFER AN DER FLANKE = SCHNELLER" lud zum Überziehen ein und nannte den häufigen Fehler nicht.
    text: 'SURFEN WIE IN T7, DIE RAMPE FÄLLT:\nBLICK ENTLANG, NICHT IN DIE RAMPE',
    task: { kind: 'surfSpeed', min: 800 },
    spawn: { pos: [sx, PLAT_Y, 560], yaw: 0 },
    demo,
    tips: [
      { on: 'land', zone: 'grube', text: 'RUNTERGEFALLEN? TASTE IN DIE RAMPE,\nBLICK ENTLANG. [F] = ZURÜCK NACH OBEN' },
      { on: 'stuck', after: 15, text: SLOW_TIP },
    ],
  });
  B.stage({
    id: 'drop',
    title: 'DER DROP',
    text: 'AM ENDE WEITERSURFEN: DIE NÄCHSTE\nRAMPE IST TIEFER, DURCH DEN GRÜNEN BOGEN',
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
    tips: [{ on: 'stuck', after: 15, text: SLOW_TIP }],
  });
  B.stage({
    id: 'bonus',
    title: `BONUS ${T8_BONUS}`,
    text: `BONUS: SCHNELLER ALS ${T8_BONUS}\nRUHIG ENTLANG, NICHT GEGENLENKEN`,
    task: { kind: 'surfSpeed', min: T8_BONUS },
    rank: 'bonus',
    demo,
  });
  B.stage({
    id: 'meister',
    title: `MEISTER ${T8_MASTER}`,
    text: `MEISTER: SCHNELLER ALS ${T8_MASTER}\nSAUBERE LINIE ÜBER BEIDE RAMPEN`,
    task: { kind: 'surfSpeed', min: T8_MASTER },
    rank: 'master',
    demo,
  });
  return B.build();
}

export const T8_CHECK: LessonCheck = {
  rows: [
    // Pflicht: der T7-Absolvent (Grundtechnik ±6° / 0.6 s ist dort die Abnahme) — "SURFEN WIE IN T7".
    { model: 'Grundtechnik ±6° / 0.6 s (T7-Referenz)', from: 'v800', to: 'v1000', make: surfHand('grund', 6, 0.6, PIT_Y), expect: { min: 18 }, level: 'error', seconds: 120 },
    { model: 'Grundtechnik ±3° / 0.3 s', from: 'v800', to: 'v1000', make: surfHand('grund', 3, 0.3, PIT_Y), expect: { min: 20 }, level: 'warning', seconds: 120 },
    { model: 'Grundtechnik ±6° / 0.6 s (800)', from: 'v800', make: surfHand('grund', 6, 0.6, PIT_Y), expect: { min: 0 }, level: 'info', seconds: 120 },
    // RouteFollower regelt an der Flanke auf seine Knotenlinie und strafet dort: kein Tempo-Modell für T8 (Median 613 u/s).
    { model: 'RouteFollower 5° (nur Info)', from: 'v800', to: 'v1000', make: routeHand({ from: 3, to: lastNode(T8_DEFAULT), noise: 5, retry: true }), expect: { min: 0 }, level: 'info', seconds: 120 },
    { model: 'Fehler: nur W', from: 'v800', make: surfHand('w', 3, 0.3, PIT_Y), expect: { max: 0 }, level: 'error', seconds: 60 },
    { model: 'Fehler: nichts drücken', from: 'v800', make: surfHand('nichts', 3, 0.3, PIT_Y), expect: { max: 0 }, level: 'error', seconds: 60 },
    { model: 'Fehler: Taste von der Rampe weg', from: 'v800', make: surfHand('weg', 3, 0.3, PIT_Y), expect: { max: 0 }, level: 'error', seconds: 60 },
    // Toleranzband des Blicks (fester Fehler an der Flanke, + = in die Rampe): hier kippt die Lektion schon bei 3–4° in
    // die Rampe (5/20 bzw. 0/20) — Text und Tipps nennen genau das. Die Flanke hinab bis 6° trägt (Review rv-tc3).
    { model: 'Grundtechnik ±3° / 0.3 s, Blick 2° in die Rampe', from: 'v800', to: 'v1000', make: surfHand('grund', 3, 0.3, PIT_Y, 2), expect: { min: 14 }, level: 'warning', seconds: 120 },
    { model: 'Grundtechnik ±3° / 0.3 s, Blick 4° in die Rampe', from: 'v800', to: 'v1000', make: surfHand('grund', 3, 0.3, PIT_Y, 4), expect: { min: 0 }, level: 'info', seconds: 120 },
    { model: 'Grundtechnik ±3° / 0.3 s, Blick 4° die Flanke hinab', from: 'v800', to: 'v1000', make: surfHand('grund', 3, 0.3, PIT_Y, -4), expect: { min: 18 }, level: 'warning', seconds: 120 },
    // Bonus: wer sauberer zielt (±3°); Meister: präzise (±1°). Die Stufe darunter schafft es seltener.
    { model: 'Grundtechnik ±3° / 0.3 s (Bonus)', from: 'bonus', make: surfHand('grund', 3, 0.3, PIT_Y), expect: { min: 15 }, level: 'warning', seconds: 120 },
    { model: 'Grundtechnik ±6° / 0.6 s (Bonus)', from: 'bonus', make: surfHand('grund', 6, 0.6, PIT_Y), expect: { min: 0 }, level: 'info', seconds: 120 },
    { model: 'Grundtechnik ±1° / 0.1 s (Meister)', from: 'meister', make: surfHand('grund', 1, 0.1, PIT_Y), expect: { min: 15 }, level: 'warning', seconds: 120 },
    { model: 'Grundtechnik ±2° / 0.2 s (Meister)', from: 'meister', make: surfHand('grund', 2, 0.2, PIT_Y), expect: { min: 0 }, level: 'info', seconds: 120 },
    { model: 'Grundtechnik ±3° / 0.3 s (Meister)', from: 'meister', make: surfHand('grund', 3, 0.3, PIT_Y), expect: { min: 0 }, level: 'info', seconds: 120 },
  ],
};
