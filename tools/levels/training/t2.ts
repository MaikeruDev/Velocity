/**
 * T2 AUTO-HOP — Leertaste halten = Bhop (Plan 007; Prototyp lessonAutoHop, v2-Entwurf §3 T2).
 *
 * Bahn 1024 breit Richtung −Z: erst eine Gerade (Kette ×6 mit gehaltener Leertaste), dann vier Gräben
 * als Auffangmulden (160–208 lang, 40 tief — zu kurz gesprungen kostet nichts). Hinter dem Ausgangstor
 * die Bonusbahn mit versetzten Säulen: Bonus = Slalom durch vier Tore mit W + Maus (Luftlenkung, Plan 007
 * A8: W dreht die Flugrichtung zum Blick, ohne Tempo zu gewinnen), Meister = alle sechs in einer Kette
 * (≈ 20 Hops ohne Absetzen). Mausrad-Hämmern bei jeder Landung umgeht den Smart-Auto-Hop und kriecht
 * (fallen.md #68): seine Absprünge zählen nicht zur Kette (CHAIN_MIN_SPEED), der Stuck-Tipp erklärt es.
 */
import type { Point2 } from '../../../src/player/bots';
import type { PlayerSnapshot } from '../../../src/player/types';
import type { LevelFile } from '../../../src/world/level/LevelFormat';
import { Frame } from '../lib';
import { naive, p2, routeHand } from './drivers';
import { ENV_BASICS, LessonBuilder, TC } from './lessonLib';
import type { LessonCheck } from './lessonLib';

const W = 512;
const WALL_TOP = 320;
const U = { tor1: 2600, dips: 3000, tor2: 0, end: 0 };
const GAPS = [160, 176, 192, 208];
const ISLAND = 600;
/** Bonusbahn: Säulen im Wechsel links/rechts, Slalom-Tore dazwischen. */
const PILLAR_EVERY = 700;
const PILLARS = 6;
const PILLAR_X = 180;

function layout(): { gaps: [number, number][]; ende: [number, number]; tor2: number; bahn: number; end: number } {
  const gaps: [number, number][] = [];
  let u = U.dips;
  for (const g of GAPS) {
    gaps.push([u, u + g]);
    u += g + ISLAND;
  }
  const ende: [number, number] = [u - ISLAND + 150, u - ISLAND + 400];
  const tor2 = u;
  const bahn = tor2 + 400;
  const end = bahn + PILLARS * PILLAR_EVERY + 800;
  return { gaps, ende, tor2, bahn, end };
}
const LY = layout();
const pillarU = (k: number): number => LY.bahn + (k + 0.5) * PILLAR_EVERY;
const pillarX = (k: number): number => (k % 2 === 0 ? PILLAR_X : -PILLAR_X);

export function buildT2(): LevelFile {
  const B = new LessonBuilder({ id: 't2', name: 'AUTO-HOP', subtitle: 'Leertaste halten statt hämmern.', lesson: 2, group: 'basics', killY: -600, environment: ENV_BASICS });
  const L = B.L;
  const f = Frame.at([0, 0], 0);
  const z = (u: number): number => -u;
  L.platform(f, [-256, LY.gaps[0][0]], [-W, W], 0, { tag: 'gerade' });
  LY.gaps.forEach(([a, b], i) => {
    L.catchDip(f, [a, b], [-W, W], 0, 40, { tag: `graben${i}` });
    const next = i + 1 < LY.gaps.length ? LY.gaps[i + 1][0] : LY.end;
    L.platform(f, [b, next], [-W, W], 0, { tag: i + 1 < LY.gaps.length ? `insel${i}` : 'bonusbahn', ...(i + 1 < LY.gaps.length ? {} : { mat: 'finish' as const }) });
  });
  for (let k = 0; k < PILLARS; k++) L.pillar([pillarX(k), z(pillarU(k))], 96, 0, WALL_TOP, { tint: TC.magenta, tag: `saeule${k}` });
  L.box([-W - 64, -64, z(LY.end)], [-W, WALL_TOP, z(-256)], { mat: 'wall', tag: 'bande-w' });
  L.box([W, -64, z(LY.end)], [W + 64, WALL_TOP, z(-256)], { mat: 'wall', tag: 'bande-o' });
  L.box([-W - 64, -64, z(-256)], [W + 64, WALL_TOP, z(-320)], { mat: 'wall', tag: 'bande-s' });
  L.box([-W - 64, -64, z(LY.end + 64)], [W + 64, WALL_TOP, z(LY.end)], { mat: 'wall', tag: 'bande-n' });
  B.gate('tor1', [-W, 0, z(U.tor1 + 24)], [W, WALL_TOP, z(U.tor1)], TC.amber);
  B.gate('ausgang', [-W, 0, z(LY.tor2 + 24)], [W, WALL_TOP, z(LY.tor2)], TC.amber);
  B.zone('ende', [-W, 0, z(LY.ende[1])], [W, 200, z(LY.ende[0])]);
  // Slalom-Tore: jeweils neben einer Säule auf der freien Seite (Bonus die ersten vier, Meister alle sechs).
  for (let k = 0; k < PILLARS; k++) {
    const x = -pillarX(k);
    const u = pillarU(k);
    B.zone(`slalom${k}`, [Math.min(x * 0.4, x * 1.9), 0, z(u + 48)], [Math.max(x * 0.4, x * 1.9), 300, z(u - 48)]);
    L.marking(Frame.at([x * 1.15, z(u)], 0), [[-40, -60], [40, -60], [40, 60], [-40, 60]], 0, TC.lime, `slalom-mark${k}`);
  }
  for (const [a] of LY.gaps) L.marking(f, [[a - 24, -W + 32], [a - 8, -W + 32], [a - 8, W - 32], [a - 24, W - 32]], 0, TC.amber, 'kante');
  B.portalZ(0, z(LY.end - 300), 0, 384, TC.lime);
  L.spawn([0, 0, 0], 0);

  // Route: Gerade, Gräben, Ende (Vorführung), dann Slalom und Portal.
  L.node([0, 0, 0]);
  L.node([0, 0, z(U.tor1 - 200)], { note: 'kette' }); // 1
  LY.gaps.forEach(([a, b]) => {
    // Gehaltene Leertaste mit Sprint hüpft mit ~313 u/s (Planungstempo für die Reichweite).
    L.node([0, 0, z(a - 20)], { jump: true, minSpeed: 300 });
    L.node([0, 0, z(b + 120)]);
  });
  L.node([0, 0, z((LY.ende[0] + LY.ende[1]) / 2)], { note: 'ende' }); // 10
  for (let k = 0; k < PILLARS; k++) L.node([-pillarX(k) * 1.2, 0, z(pillarU(k))], { note: `slalom${k}` });
  L.node([0, 0, z(LY.end - 300)], { note: 'portal' });

  B.stage({
    id: 'halten',
    title: 'HALTEN',
    text: 'W + LEERTASTE GEDRÜCKT HALTEN\nDU HÜPFST VON SELBST WEITER',
    task: { kind: 'hopChain', count: 6 },
    opens: ['tor1'],
    spawn: { pos: [0, 0, 0], yaw: 0 },
    // Vorführung wie die Anweisung: W + Leertaste gehalten, kein Strafen (vorher 608 u/s mit gedrücktem D).
    demo: { kind: 'route', from: 0, to: 1, style: 'hold', seconds: 8 },
    tips: [{ on: 'stuck', after: 12, text: 'NICHT HÄMMERN: LEERTASTE EINMAL\nDRÜCKEN UND GEDRÜCKT HALTEN' }],
  });
  B.stage({
    id: 'graeben',
    title: 'ÜBER DIE GRÄBEN',
    text: 'EINFACH GEDRÜCKT LASSEN:\nDIE GRÄBEN FLIEGEN UNTER DIR VORBEI',
    task: { kind: 'reach', zone: 'ende' },
    opens: ['ausgang'],
    spawn: { pos: [0, 0, z(U.tor1 + 150)], yaw: 0 },
    demo: { kind: 'route', from: 1, to: 10, style: 'hold', seconds: 16 },
    tips: [{ on: 'stuck', after: 20, text: 'ERST ANLAUFEN, DANN HÜPFEN:\nIM STAND HÜPFT MAN NUR AUF DER STELLE' }],
  });
  B.stage({
    id: 'lenken',
    title: 'LENKEN',
    text: 'IN DER LUFT: W HALTEN, MAUS LENKT\nIM SLALOM AN DEN SÄULEN VORBEI',
    task: { kind: 'course', zones: ['slalom0', 'slalom1', 'slalom2', 'slalom3'], minSpeed: 250, airborne: true, groundGrace: 0.15 },
    rank: 'bonus',
    spawn: { pos: [0, 0, z(LY.tor2 + 150)], yaw: 0 },
    // W + Leertaste gehalten, Blick auf die nächste Slalom-Marke: die Luftlenkung zieht die Bahn — genau der Text.
    // Ohne style strafte der RouteFollower (A/D 46 % der Ticks, W in der Luft nie, bis 642 u/s; Review rv-tc3).
    demo: { kind: 'route', from: 11, to: 14, style: 'hold', seconds: 16 },
  });
  // Meister: der ganze Slalom (≈ 20 Hops) in einer Kette. Als hopChain 20 schaffte ihn W + Leertaste geradeaus
  // (20/20) — der dritte Stern verlangte nichts über HALTEN hinaus. Die id bleibt (gespeicherter Fortschritt).
  B.stage({
    id: 'kette20',
    title: 'GANZER SLALOM',
    text: `MEISTER: ALLE ${PILLARS} SÄULEN IM SLALOM\nIN EINER KETTE, OHNE ABZUSETZEN`,
    task: { kind: 'course', zones: Array.from({ length: PILLARS }, (_, k) => `slalom${k}`), minSpeed: 250, airborne: true, groundGrace: 0.15 },
    rank: 'master',
    spawn: { pos: [0, 0, z(LY.tor2 + 150)], yaw: 0 },
    // Wie LENKEN, nur alle Säulen: W + Leertaste gehalten, Blick auf die nächste Marke — die Luftlenkung fliegt den Slalom.
    demo: { kind: 'route', from: 11, to: 10 + PILLARS, style: 'hold', seconds: 24 },
  });
  return B.build();
}

/** Slalom-Ziele der Reihe nach (Ziel wechselt 150 u vor der Säule): W + Maus lenkt zum nächsten Tor. */
function slalomGoal(): (s: PlayerSnapshot) => Point2 {
  const pts = Array.from({ length: PILLARS }, (_, k) => p2(-pillarX(k) * 1.15, -pillarU(k)));
  pts.push(p2(0, -(LY.end - 200)));
  return (s) => {
    const i = pts.findIndex((p) => s.pos.z > p.z + 60);
    return pts[i < 0 ? pts.length - 1 : i];
  };
}

export const T2_CHECK: LessonCheck = {
  rows: [
    { model: 'NaiveBot hold', from: 'halten', make: naive(p2(0, -(U.tor1 - 100))), expect: { min: 20 }, level: 'error', seconds: 30 },
    { model: 'NaiveBot hold', from: 'graeben', make: naive(p2(0, -LY.ende[1])), expect: { min: 20 }, level: 'error', seconds: 60 },
    { model: 'RouteFollower 5°', from: 'halten', make: routeHand({ from: 0, to: 1, noise: 5 }), expect: { min: 20 }, level: 'error', seconds: 30 },
    { model: 'RouteFollower 5°', from: 'graeben', make: routeHand({ from: 1, to: 10, noise: 5 }), expect: { min: 20 }, level: 'error', seconds: 60 },
    // HALTEN lehrt die gehaltene Taste: Hämmern (Mausrad bei jeder Landung) hüpft mit ~40 u/s auf der Stelle und darf
    // die Kette nicht füllen (Absprünge unter CHAIN_MIN_SPEED zählen nicht).
    { model: 'Fehler: Mausrad-Hämmerer (Halten)', from: 'halten', make: naive(p2(0, -(U.tor1 - 100)), 'spam'), expect: { max: 0 }, level: 'error', seconds: 30 },
    { model: 'Mausrad-Hämmerer', from: 'graeben', make: naive(p2(0, -LY.ende[1]), 'spam'), expect: { max: 20 }, level: 'info', seconds: 60 },
    { model: 'W-Lenker (Bonus Slalom)', from: 'lenken', make: naive(slalomGoal()), expect: { min: 15 }, level: 'warning', seconds: 40 },
    { model: 'Geradeaus (Bonus Slalom)', from: 'lenken', make: naive(p2(0, -LY.end)), expect: { max: 0 }, level: 'warning', seconds: 40 },
    { model: 'W-Lenker (Meister Slalom)', from: 'kette20', make: naive(slalomGoal()), expect: { min: 10 }, level: 'warning', seconds: 40 },
    { model: 'Fehler: W + Leertaste geradeaus (Meister)', from: 'kette20', make: naive(p2(0, -LY.end)), expect: { max: 0 }, level: 'error', seconds: 40 },
  ],
};
