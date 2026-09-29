/**
 * T1 ERSTE SCHRITTE — Laufen, Springen, Stufe, Rutschen (Plan 007; v2-Entwurf §3 T1, Rutschen neu).
 *
 * Gerade Bahn 768 breit Richtung −Z, vier Abschnitte, jeder hinter einem Tor:
 *   LAUFEN     700 u bis zur Linie
 *   SPRINGEN   drei Lücken 96/128/160 mit Auffangmulden (40 tief, wie L1) — nie ein Tod
 *   STUFE      48 u hoch: normal springen reicht (57)
 *   RUTSCHEN   auf Tempo C drücken (≥ 280 u/s) → das Tunneltor öffnet; Tunnel 60 hoch (Duck-Hull 54),
 *              192 lang (≤ 0.6 × Rutschweite ~345 u, movement.md Level-Regeln)
 * Danach ein 30°-Hang (600 lang, links offen, rechts eine überdachte Rutsch-Rinne, Dach 80 über dem Hang) und das
 * Portal. Bonus: mit ≥ 200 u/s durch den Tunnel (= spät genug gerutscht; Duck-Walk 85). Meister: durch
 * die Rinne mit Tempo — hinein kommt nur, wer geduckt ist; ein reines Tempo-Ziel am Hang schafft
 * W + Leertaste genauso (Hang-Landung A4: Hüpfen vom Grat bringt 456–629 u/s).
 */
import { VELOCITY_DEFAULT } from '../../../src/player/MovementConfig';
import type { LevelFile } from '../../../src/world/level/LevelFormat';
import { Frame } from '../lib';
import { naive, p2, routeHand, slider } from './drivers';
import { ENV_BASICS, LessonBuilder, TC } from './lessonLib';
import type { LessonCheck } from './lessonLib';

const W = 384;
const WALL_TOP = 320;
const SLOPE_DEG = 30;
/** Lichte Höhe der Rutsch-Rinne über dem Hang. */
const ROOF = 80;
/** Bahn läuft entlang u (Frame bei z = 0, Blick −Z): Weltpunkt z = −u. */
const U = {
  linie: 770,
  tor1: 1000,
  gap1: 1500,
  plat1: [1596, 1980] as const,
  gap2: 1980,
  plat2: [2108, 2492] as const,
  gap3: 2492,
  plat3: [2652, 3164] as const,
  tor2: 3164,
  step: 3800,
  stepEnd: 4500,
  tor3: 4500,
  tunnelGate: 5300,
  tunnel: [5324, 5516] as const,
  slope: [5900, 6500] as const,
  end: 7200,
};
const STEP = 48;
/** Rutschen ab diesem Tempo (Lehr-Config = VELOCITY). */
const SLIDE_MIN = VELOCITY_DEFAULT.slideMinSpeed;
const LOW = STEP - Math.round((U.slope[1] - U.slope[0]) * Math.tan((SLOPE_DEG * Math.PI) / 180));

export function buildT1(): LevelFile {
  const B = new LessonBuilder({ id: 't1', name: 'ERSTE SCHRITTE', subtitle: 'Laufen, springen, rutschen.', lesson: 1, group: 'basics', killY: LOW - 400, environment: ENV_BASICS });
  const L = B.L;
  const f = Frame.at([0, 0], 0);
  const z = (u: number): number => -u;
  // Böden
  L.platform(f, [-256, U.gap1], [-W, W], 0, { tag: 'start' });
  L.catchDip(f, [U.gap1, U.plat1[0]], [-W, W], 0, 40, { tag: 'mulde1' });
  L.platform(f, [U.plat1[0], U.plat1[1]], [-W, W], 0, { tag: 'insel1' });
  L.catchDip(f, [U.gap2, U.plat2[0]], [-W, W], 0, 40, { tag: 'mulde2' });
  L.platform(f, [U.plat2[0], U.plat2[1]], [-W, W], 0, { tag: 'insel2' });
  L.catchDip(f, [U.gap3, U.plat3[0]], [-W, W], 0, 40, { tag: 'mulde3' });
  L.platform(f, [U.plat3[0], U.step], [-W, W], 0, { tag: 'anlauf-stufe' });
  L.platform(f, [U.step, U.slope[0]], [-W, W], STEP, { tag: 'stufe', mat: 'accent', tint: '#2a3d7a' });
  L.ramp(f, [U.slope[0], U.slope[1]], [-W, W], STEP, LOW, { tag: 'hang' });
  // Rutsch-Rinne: Trennwand in der Mitte, rechte Hälfte überdacht. Die Hull ist eine achsparallele Box:
  // auf 30° braucht sie senkrecht Höhe + 32·tan30 (Duck 72.5, Stand 90.5) — Dach 80 über dem Hang lässt
  // nur Geduckte durch (bei 60/66 klemmte auch die Duck-Hull am Knick fest).
  const tan = Math.tan((SLOPE_DEG * Math.PI) / 180);
  const surf = (u: number): number => STEP - (u - U.slope[0]) * tan;
  // Trennwand 8 u innerhalb der Hang-Enden und mit eigener Unterkante: keine koplanaren Flächen mit dem Hang-Keil.
  L.box([-16, LOW - 56, z(U.slope[1] - 8)], [16, WALL_TOP, z(U.slope[0] + 8)], { mat: 'wall', tag: 'rinne-wand' });
  const roof: [number, number, number][] = [];
  for (const u of [U.slope[0], U.slope[1]]) for (const x of [16, W]) for (const dy of [ROOF, ROOF + 64]) roof.push([x, Math.round(surf(u) + dy), z(u)]);
  L.add({ type: 'hull', points: roof, mat: 'hazard', tag: 'rinne-dach' });
  L.platform(f, [U.slope[1], U.end], [-W, W], LOW, { tag: 'platz', mat: 'finish' });
  // Tunneldecke: 60 über dem Boden, ganze Breite; Stirn als Warnstreifen.
  L.box([-W, STEP + 60, z(U.tunnel[1])], [W, WALL_TOP, z(U.tunnel[0])], { mat: 'hazard', tag: 'tunnel' });
  // Banden
  L.box([-W - 64, LOW - 64, z(U.end)], [-W, WALL_TOP, z(-256)], { mat: 'wall', tag: 'bande-w' });
  L.box([W, LOW - 64, z(U.end)], [W + 64, WALL_TOP, z(-256)], { mat: 'wall', tag: 'bande-o' });
  L.box([-W - 64, LOW - 64, z(-256)], [W + 64, WALL_TOP, z(-320)], { mat: 'wall', tag: 'bande-s' });
  L.box([-W - 64, LOW - 64, z(U.end + 64)], [W + 64, WALL_TOP, z(U.end)], { mat: 'wall', tag: 'bande-n' });
  // Tore quer über die Bahn
  B.gate('tor1', [-W, 0, z(U.tor1 + 24)], [W, WALL_TOP, z(U.tor1)], TC.amber);
  B.gate('tor2', [-W, 0, z(U.tor2 + 24)], [W, WALL_TOP, z(U.tor2)], TC.amber);
  B.gate('tor3', [-W, STEP, z(U.tor3 + 24)], [W, WALL_TOP, z(U.tor3)], TC.amber);
  B.gate('tunnel', [-W, STEP, z(U.tunnelGate + 24)], [W, STEP + 60, z(U.tunnelGate)], TC.lime);
  // Zonen
  B.zone('linie', [-W, 0, z(U.linie + 50)], [W, 200, z(U.linie - 50)]);
  B.zone('drueben', [-W, 0, z(U.plat3[0] + 300)], [W, 200, z(U.plat3[0] + 100)]);
  B.zone('oben', [-W, STEP, z(U.step + 300)], [W, STEP + 200, z(U.step + 100)]);
  B.zone('tunnel-rein', [-W, STEP, z(U.tunnel[0] + 32)], [W, STEP + 60, z(U.tunnel[0])]);
  B.zone('tunnel-raus', [-W, STEP, z(U.tunnel[1])], [W, STEP + 60, z(U.tunnel[1] - 32)]);
  // Messzone tief in der Rinne (60–120 u vor dem Ende): dorthin kommt nur, wer geduckt hineinrutscht.
  B.zone('rinne-mess', [16, Math.round(surf(U.slope[1] - 60)), z(U.slope[1] - 60)], [W, Math.round(surf(U.slope[1] - 120) + ROOF), z(U.slope[1] - 120)]);
  // Markierungen: Linie, Absprungkanten, Rutsch-Strecke vor dem Tunnel
  L.marking(f, [[U.linie - 8, -W + 32], [U.linie + 8, -W + 32], [U.linie + 8, W - 32], [U.linie - 8, W - 32]], 0, TC.cyan, 'linie');
  for (const u of [U.gap1, U.gap2, U.gap3]) L.marking(f, [[u - 24, -W + 32], [u - 8, -W + 32], [u - 8, W - 32], [u - 24, W - 32]], 0, TC.amber, 'kante');
  for (let k = 0; k < 3; k++) L.chevron([0, STEP, z(U.tunnelGate - 380 + k * 110)], 0, { tint: TC.lime, arm: 80 });
  B.portalZ(0, z(U.end - 300), LOW, 320, TC.lime);
  L.spawn([0, 0, 0], 0);

  // Route (Vorführung LAUFEN/SPRINGEN/STUFE; danach nur für den Validator bis ins Portal)
  L.node([0, 0, 0]);
  L.node([0, 0, z(U.linie)], { note: 'linie' }); // 1
  L.node([0, 0, z(U.gap1 - 20)], { jump: true }); // 2
  L.node([0, 0, z(U.plat1[0] + 110)]); // 3
  L.node([0, 0, z(U.gap2 - 20)], { jump: true }); // 4
  L.node([0, 0, z(U.plat2[0] + 110)]); // 5
  L.node([0, 0, z(U.gap3 - 20)], { jump: true }); // 6
  L.node([0, 0, z(U.plat3[0] + 150)], { note: 'drueben' }); // 7
  // Absprung 110 u vor der Stufe, Landung 60 u dahinter: die Passbahn (Validator) trifft die Kante auch mit 1.2 × Tempo über 48 u.
  L.node([0, 0, z(U.step - 110)], { jump: true }); // 8
  L.node([0, STEP, z(U.step + 60)]); // 9
  L.node([0, STEP, z(U.step + 180)], { note: 'oben' }); // 10
  L.node([0, STEP, z(U.tor3 + 150)], { note: 'rutsch-start' }); // 11
  L.node([0, STEP, z(U.tunnel[0] + 96)], { note: 'tunnel' }); // 12
  // Weiter durch die Rutsch-Rinne (Meister-Vorführung 13→14): vor dem Hang auf die Rinnen-Seite, dann unten 40 u
  // hinter dem Hangfuß — die Rutsche führt durch die Messzone. Kein Knoten im Hang: unter dem Dach findet die
  // Boden-Sonde des Validators keinen Platz (Stand-Hull steckt, Duck-Hull 8.2–8.3 u über der Fläche).
  L.node([192, STEP, z(U.slope[0] - 40)]); // 13
  L.node([192, LOW, z(U.slope[1] + 40)], { note: 'rinne' }); // 14
  L.node([0, LOW, z(U.end - 300)], { note: 'portal' }); // 15

  B.stage({
    id: 'laufen',
    title: 'LAUFEN',
    text: 'MAUS = UMSEHEN, W = LAUFEN\nLAUF BIS ZUR LEUCHTLINIE',
    task: { kind: 'reach', zone: 'linie' },
    opens: ['tor1'],
    spawn: { pos: [0, 0, 0], yaw: 0 },
    // Vorführung wie die Anweisung: nur W laufen (vorher bhoppte der RouteFollower strafend mit ~500 u/s).
    demo: { kind: 'route', from: 0, to: 1, style: 'walk', seconds: 6 },
  });
  B.stage({
    id: 'springen',
    title: 'SPRINGEN',
    text: 'LEERTASTE = SPRINGEN\nSPRING ÜBER DIE DREI LÜCKEN',
    task: { kind: 'reach', zone: 'drueben' },
    opens: ['tor2'],
    spawn: { pos: [0, 0, z(U.tor1 + 150)], yaw: 0 },
    demo: { kind: 'route', from: 1, to: 7, seconds: 12 },
    tips: [{ on: 'stuck', after: 15, text: 'AN DER LEUCHTKANTE SPRINGEN\nZU KURZ? EINFACH WEITERLAUFEN' }],
  });
  B.stage({
    id: 'stufe',
    title: 'AUF DIE STUFE',
    text: 'SPRING AUF DIE STUFE\nNORMAL SPRINGEN REICHT HIER',
    task: { kind: 'reach', zone: 'oben' },
    opens: ['tor3'],
    spawn: { pos: [0, 0, z(U.tor2 + 150)], yaw: 0 },
    demo: { kind: 'route', from: 7, to: 10, seconds: 8 },
  });
  B.stage({
    id: 'rutschen',
    title: 'RUTSCHEN',
    // Ohne Sprint bleibt das Tempo bei 250 — unter der Rutsch-Schwelle (Sprint + C 20/20, ohne 0/20, Review rv-tc3).
    // Lektionen erzwingen deshalb Auto-Sprint (Game.applyLevel); Shift hieße dort "langsamer" — nicht erwähnen.
    text: 'VOLL ANLAUFEN, DANN C DRÜCKEN:\nSO RUTSCHST DU DURCH DEN TUNNEL',
    task: { kind: 'event', event: 'slideStart', count: 1 },
    opens: ['tunnel'],
    spawn: { pos: [0, STEP, z(U.tor3 + 150)], yaw: 0 },
    // Vorführung ('jump', Lektion ohne Drehbalken): läuft mit Sprint an und duckt vor der niedrigen Decke — Sprint + C.
    demo: { kind: 'route', from: 11, to: 12, seconds: 6 },
    tips: [{ on: 'stuck', after: 10, text: `ZU LANGSAM? RUTSCHEN ERST AB ${SLIDE_MIN} u/s:\nVOLL ANLAUFEN (OHNE SHIFT), DANN C` }],
  });
  B.stage({
    id: 'flink',
    title: 'FLINK DURCH',
    text: 'C ERST KURZ VOR DEM TUNNEL:\nMIT TEMPO DURCH DEN TUNNEL',
    task: { kind: 'course', zones: ['tunnel-rein', 'tunnel-raus'], minSpeed: 200 },
    rank: 'bonus',
    // Dieselbe Vorführung wie RUTSCHEN: sie duckt erst 0.35 s vor der Decke (DuckAhead) — genau "C erst kurz davor".
    demo: { kind: 'route', from: 11, to: 12, seconds: 6 },
  });
  B.stage({
    id: 'rinne',
    title: 'RUTSCH-RINNE',
    text: 'RECHTS DURCH DIE RINNE RUTSCHEN\nUNTEN SCHNELLER ALS 450',
    task: { kind: 'course', zones: ['rinne-mess'], minSpeed: 450 },
    rank: 'master',
    spawn: { pos: [192, STEP, z(U.tunnel[1] + 40)], yaw: 0 },
    // Vorführung ('jump', ohne A/D): läuft mit Sprint auf die Rinne zu, duckt vor dem Dach und rutscht den Hang hinab.
    demo: { kind: 'route', from: 13, to: 14, seconds: 8 },
    tips: [{ on: 'stuck', after: 15, text: 'ANLAUFEN, VOR DER RINNE C DRÜCKEN\nDER HANG MACHT DICH SCHNELLER' }],
  });
  return B.build();
}

const at = (u: number, y = 0): { x: number; z: number; y: number } => ({ x: 0, z: -u, y });

export const T1_CHECK: LessonCheck = {
  rows: [
    // NaiveBot 'hold' (W + Leertaste gehalten, Sprint): Ziel = Mitte der Stufen-Zone.
    { model: 'NaiveBot hold', from: 'laufen', make: naive(p2(0, at(U.linie).z)), expect: { min: 20 }, level: 'error', seconds: 30 },
    { model: 'NaiveBot hold', from: 'springen', make: naive(p2(0, at(U.plat3[0] + 200).z)), expect: { min: 20 }, level: 'error', seconds: 30 },
    { model: 'NaiveBot hold', from: 'stufe', make: naive(p2(0, at(U.step + 200).z)), expect: { min: 20 }, level: 'error', seconds: 30 },
    { model: 'RouteFollower 5°', from: 'laufen', make: routeHand({ from: 0, to: 1, noise: 5 }), expect: { min: 20 }, level: 'error', seconds: 30 },
    { model: 'RouteFollower 5°', from: 'springen', make: routeHand({ from: 1, to: 7, noise: 5 }), expect: { min: 20 }, level: 'error', seconds: 30 },
    { model: 'RouteFollower 5°', from: 'stufe', make: routeHand({ from: 7, to: 10, noise: 5 }), expect: { min: 20 }, level: 'error', seconds: 30 },
    // Rutschen: Sprint + C irgendwo 60–400 u vor dem Tunneltor, C gehalten bis durch den Tunnel.
    { model: 'Sprint + C', from: 'rutschen', make: slider(p2(0, at(U.end).z), p2(0, at(U.tunnelGate).z), [60, 400], p2(0, at(U.tunnel[1] + 60).z)), expect: { min: 20 }, level: 'error', seconds: 30 },
    { model: 'Sprint + C (Bonus Tunnel)', from: 'rutschen', to: 'flink', make: slider(p2(0, at(U.end).z), p2(0, at(U.tunnelGate).z), [40, 160], p2(0, at(U.tunnel[1] + 60).z)), expect: { min: 18 }, level: 'warning', seconds: 30 },
    { model: 'Sprint + C früh (Bonus Tunnel)', from: 'rutschen', to: 'flink', make: slider(p2(0, at(U.end).z), p2(0, at(U.tunnelGate).z), [300, 450], p2(0, at(U.tunnel[1] + 60).z)), expect: { max: 20 }, level: 'info', seconds: 30 },
    { model: 'Fehler: W + Leertaste (Rutschen)', from: 'rutschen', make: naive(p2(0, at(U.end).z)), expect: { max: 0 }, level: 'error', seconds: 30 },
    // Meister: vor der Rinne C drücken und halten; wer steht, kommt nicht hinein.
    { model: 'Rinnen-Rutscher', from: 'rinne', make: slider(p2(192, at(U.end).z), p2(192, at(U.slope[0]).z), [0, 100]), expect: { min: 18 }, level: 'warning', seconds: 30 },
    { model: 'Rinnen-Rutscher früh (C 250–400 u vorher)', from: 'rinne', make: slider(p2(192, at(U.end).z), p2(192, at(U.slope[0]).z), [250, 380]), expect: { min: 0 }, level: 'info', seconds: 30 },
    { model: 'Fehler: W + Leertaste (Rinne)', from: 'rinne', make: naive(p2(192, at(U.end).z)), expect: { max: 0 }, level: 'warning', seconds: 30 },
  ],
};
