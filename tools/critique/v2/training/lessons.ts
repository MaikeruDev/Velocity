/**
 * Trainingsmodus-Entwurf (v2/training) — Prototyp-Geometrie der Lektionen (nur im Speicher,
 * nichts wird nach public/ geschrieben). Mit dem echten LevelBuilder (tools/levels/lib.ts),
 * damit die Messungen gegen dieselbe Kollision laufen wie das Spiel.
 *
 * Koordinaten: Spawn bei (0, 0, 0), Blick −Z (yaw 0). Alle Lektionen ohne Tod: Wände/Banden
 * statt Kill-Zonen, Auffangböden unter Rampen.
 */
import type { LevelFile } from '../../../../src/world/level/LevelFormat';
import { Frame, LevelBuilder } from '../../../levels/lib';
import type { StageDef, ZoneDef } from './trainingProto';

const ENV: LevelFile['environment'] = {
  skyTop: '#0b0620', skyHorizon: '#3a1d6e', skyBottom: '#12081f', fogColor: '#2a1650', fogNear: 1500, fogFar: 9000,
  sunDir: [0.3, 0.5, -0.8], sunColor: '#ffd6f0', ambientSky: '#5a4abc', ambientGround: '#1a0f2e', trimColor: '#33f0ff', trimColorAlt: '#ff3fd0', voidY: -1200,
};

export interface LessonProto {
  readonly id: string;
  readonly level: LevelFile;
  readonly stages: readonly StageDef[];
  readonly zones: readonly ZoneDef[];
  /** Zusatzinfos für die Sim (Rampenachse etc.). */
  readonly meta: Record<string, number>;
}

function arenaWalls(L: LevelBuilder, half: number, h = 96): void {
  // Bande: niedrig (sichtbar, man hüpft nicht drüber), innen Trim.
  const t = 64;
  L.box([-half - t, 0, -half - t], [half + t, h, -half], { mat: 'wall', tag: 'bande-n' });
  L.box([-half - t, 0, half], [half + t, h, half + t], { mat: 'wall', tag: 'bande-s' });
  L.box([-half - t, 0, -half], [-half, h, half], { mat: 'wall', tag: 'bande-w' });
  L.box([half, 0, -half], [half + t, h, half], { mat: 'wall', tag: 'bande-o' });
}

/** T2 AUTO-HOP: Bahn 1024 breit, 7000 lang. Stufe 1: Kette ×6 (Leertaste halten). Stufe 2: über die Gräben ans Ende. */
export function lessonAutoHop(): LessonProto {
  const L = new LevelBuilder({ id: 't2', name: 'T2 AUTO-HOP', killY: -1000, environment: ENV });
  const f = Frame.at([0, 0], 0);
  L.platform(f, [-256, 2600], [-512, 512], 0, { mat: 'floor', tag: 'bahn-a' });
  // Gräben: flache Mulden (40 u) wie L1-Lauf-Lücken — zu kurz gesprungen kostet nichts.
  let u = 2600;
  for (let i = 0; i < 4; i++) {
    const gap = 160 + i * 16;
    L.catchDip(f, [u, u + gap], [-512, 512], 0, 40, { tag: `graben${i}` });
    L.platform(f, [u + gap, u + gap + 700], [-512, 512], 0, { tag: `insel${i}` });
    u += gap + 700;
  }
  L.platform(f, [u, u + 800], [-512, 512], 0, { mat: 'finish', tag: 'ende' });
  L.spawn([0, 0, 0], 0);
  // Zone Ende (−Z): z von −(u+800) bis −u
  const endZone: ZoneDef = { id: 'ende', min: [-512, 0, -(u + 800)], max: [512, 200, -u] };
  return {
    id: 't2',
    level: L.build(),
    zones: [endZone],
    stages: [
      { id: 'kette', title: 'HALTEN', text: 'W + LEERTASTE HALTEN', task: { kind: 'hopChain', count: 6 } },
      { id: 'graeben', title: 'ÜBER DIE GRÄBEN', text: 'EINFACH GEHALTEN LASSEN', task: { kind: 'reach', zone: 'ende' } },
    ],
    meta: { length: u + 800 },
  };
}

/**
 * T3 AIR-STRAFE: flache Arena 4800 × 4800, Spawn in der Mitte. Rand = "Schüssel": 256 u breite,
 * begehbare Rampe (20.6°, 96 u hoch) statt senkrechter Bande — wer beim Kreisen driftet, rollt
 * hoch und wird gebremst, statt frontal abzuprallen (erste Fassung mit Bande 3200²: −166 u/s Bonk).
 */
export function lessonArena(wallsOnly = false): LessonProto {
  const half = wallsOnly ? 1600 : 2400;
  const L = new LevelBuilder({ id: 't3', name: 'T3 AIR-STRAFE', killY: -1000, environment: ENV });
  L.box([-half - 256, -64, -half - 256], [half + 256, 0, half + 256], { mat: 'floor', tag: 'arena' });
  if (wallsOnly) arenaWalls(L, half);
  else {
    const rim = 256;
    const h = 96;
    const n = Frame.at([0, -half], 0);
    L.ramp(n, [0, rim], [-half - rim, half + rim], 0, h, { tag: 'rand-n' });
    const s = Frame.at([0, half], 180);
    L.ramp(s, [0, rim], [-half - rim, half + rim], 0, h, { tag: 'rand-s' });
    const w = Frame.at([-half, 0], 90);
    L.ramp(w, [0, rim], [-half, half], 0, h, { tag: 'rand-w' });
    const o = Frame.at([half, 0], -90);
    L.ramp(o, [0, rim], [-half, half], 0, h, { tag: 'rand-o' });
    arenaWalls(L, half + rim, h + 64);
  }
  L.spawn([0, 0, wallsOnly ? 1200 : 0], 0);
  return {
    id: 't3',
    level: L.build(),
    zones: [],
    stages: [
      { id: 'links', title: 'LINKSKURVE', text: 'IN DER LUFT: A HALTEN + MAUS NACH LINKS', task: { kind: 'goodHops', count: 5, side: 'left' } },
      { id: 'rechts', title: 'RECHTSKURVE', text: 'IN DER LUFT: D HALTEN + MAUS NACH RECHTS', task: { kind: 'goodHops', count: 5, side: 'right' } },
      { id: 'wechsel', title: 'WECHSELN', text: 'JEDER SPRUNG ANDERE SEITE: A+LINKS, D+RECHTS', task: { kind: 'goodHops', count: 6, side: 'alternate' } },
    ],
    meta: { half },
  };
}

/** T4 SPEED: Prototyp als lange Gerade 2048 breit (im Spiel ein Oval zum Endlos-Üben). */
export function lessonSpeed(): LessonProto {
  const L = new LevelBuilder({ id: 't4', name: 'T4 SPEED', killY: -1000, environment: ENV });
  L.box([-1024, -64, -30000], [1024, 0, 400], { mat: 'floor', tag: 'gerade' });
  L.box([-1088, 0, -30000], [-1024, 96, 400], { mat: 'wall' });
  L.box([1024, 0, -30000], [1088, 96, 400], { mat: 'wall' });
  L.spawn([0, 0, 0], 0);
  return {
    id: 't4',
    level: L.build(),
    zones: [],
    stages: [
      { id: 'v400', title: '400', text: 'HÜPFEN + STRAFEN: ERREICHE 400 u/s', task: { kind: 'speed', min: 400 } },
      { id: 'halten', title: 'HALTEN', text: 'LANDE 5-MAL IN FOLGE ÜBER 400', task: { kind: 'speed', min: 400, holdHops: 5 } },
      { id: 'v500', title: 'BONUS 500', text: 'ERREICHE 500 u/s', task: { kind: 'speed', min: 500 }, bonus: true },
    ],
    meta: {},
  };
}

/**
 * T5 KURVEN: flacher Boden, 7 Luft-Tore auf einem 180°-Bogen (R 900) — im Flug durch alle,
 * nie unter 330 u/s, Kette nicht reißen lassen. Kein Tod: wer rausfällt, beginnt den Bogen neu.
 */
export function lessonCurve(gateHalf = Number(process.env.GATE_HALF ?? 110)): LessonProto {
  const L = new LevelBuilder({ id: 't5', name: 'T5 KURVEN', killY: -1000, environment: ENV });
  const R = 900;
  const cx = -R;
  const cz = -2400;
  L.box([-3200, -64, -5200], [1600, 0, 1200], { mat: 'floor', tag: 'feld' });
  const zones: ZoneDef[] = [];
  const ids: string[] = [];
  // Bogen von φ=0 (Punkt (0, cz)) gegen den Uhrzeigersinn nach φ=180 ((-2R, cz)), Anlauf von +Z nach −Z.
  for (let k = 0; k <= 6; k++) {
    const phi = (k * 30 * Math.PI) / 180;
    const x = cx + R * Math.cos(phi);
    const z = cz - R * Math.sin(phi);
    const id = `tor${k}`;
    ids.push(id);
    zones.push({ id, min: [x - gateHalf, 20, z - gateHalf], max: [x + gateHalf, 400, z + gateHalf] });
  }
  L.spawn([0, 0, 800], 0);
  return {
    id: 't5',
    level: L.build(),
    zones,
    stages: [
      { id: 'anlauf', title: 'ANLAUF', text: 'BAU 380 u/s AUF', task: { kind: 'speed', min: 380 } },
      { id: 'bogen', title: 'BOGEN', text: 'IM FLUG DURCH ALLE TORE — NIE UNTER 330', task: { kind: 'course', zones: ids, minSpeed: 330, airborne: true } },
    ],
    meta: { R, cx, cz },
  };
}

/** T6 CROUCH-JUMP: Block 64 u hoch (normal springt man 57), Anlauf 1200 u, Zone oben. */
export function lessonCrouch(height = 64): LessonProto {
  const L = new LevelBuilder({ id: 't6', name: 'T6 CROUCH', killY: -1000, environment: ENV });
  L.box([-512, -64, -1600], [512, 0, 400], { mat: 'floor', tag: 'anlauf' });
  L.box([-256, 0, -1600], [256, height, -1300], { mat: 'duck', tag: 'block' });
  L.spawn([0, 0, 0], 0);
  const top: ZoneDef = { id: 'oben', min: [-256, height, -1600], max: [256, height + 100, -1300] };
  return {
    id: 't6',
    level: L.build(),
    zones: [top],
    stages: [{ id: 'block', title: `KANTE ${height}`, text: 'SPRINGEN, IN DER LUFT DUCKEN [C]', task: { kind: 'crouchLand', zone: 'oben', count: 3 } }],
    meta: { wallZ: -1300, height },
  };
}

/**
 * T7 SURF HALTEN: Rampe 768 breit, 60°-Flanken, 4000 lang, Achse −Z mit `slopeDeg` Gefälle,
 * darunter Auffangboden 32 u unter dem Fuß (wie L2-S0-Grube).
 */
export function lessonSurf(slopeDeg = 3): LessonProto {
  const L = new LevelBuilder({ id: 't7', name: 'T7 SURF', killY: -3000, environment: ENV });
  const apex = 600;
  const len = 6000;
  const ramp = L.surfRamp({ start: [0, 0], yaw: 0, length: len, apex, apexEnd: apex - len * Math.tan((slopeDeg * Math.PI) / 180), width: 768, flankDeg: 60, tag: 'rampe' });
  const footY = Math.min(apex, apex - len * Math.tan((slopeDeg * Math.PI) / 180)) - ramp.height;
  L.box([-1400, footY - 96, -len - 400], [1400, footY - 32, 400], { mat: 'metal', tag: 'auffang' });
  L.box([-1464, footY - 96, -len - 400], [-1400, footY + 96, 400], { mat: 'wall' });
  L.box([1400, footY - 96, -len - 400], [1464, footY + 96, 400], { mat: 'wall' });
  // Startplattform VOR der Rampe (auf Firsthöhe): Anlauf entlang der Achse, dann seitlich auf die Flanke.
  // Einstieg MITTEN an der Flanke: Plattform östlich des Firsts, Oberkante ENTRY_DEPTH unter dem First;
  // wer am Ende (z = 0) abläuft, fällt ~DROP u auf die Ostflanke. (Einstieg am First: der Surfer kriecht
  // in 1–3 s auf den begehbaren Grat, steht dort am Boden und das Halten reißt — dbg_t7.ts. Drop 280 u:
  // man schlägt mit −630 u/s auf und rutscht in der Reaktionszeit 180 u ab — dbg_t7b.ts.)
  const entryDepth = Number(process.env.ENTRY_DEPTH ?? 120);
  const drop = Number(process.env.DROP ?? 40);
  const tan = Math.tan((60 * Math.PI) / 180);
  // Plattform-Innenkante bei x0: Flanke dort auf apex − x0·tan; Oberkante = Flanke + drop.
  const x0 = (entryDepth + drop) / tan;
  const platY = apex - entryDepth;
  L.box([x0 + 16, platY - 64, 0], [x0 + 320, platY, 700], { mat: 'start', tag: 'start' });
  L.spawn([x0 + 48, platY, 560], 0);
  return {
    id: 't7',
    level: L.build(),
    zones: [],
    stages: [
      { id: 'halten3', title: 'HALTEN', text: 'W LOS · A/D IN DIE RAMPE · BLICK ENTLANG', task: { kind: 'surfHold', seconds: 3 } },
      { id: 'halten6', title: 'LÄNGER', text: '6 SEKUNDEN AUF DER RAMPE', task: { kind: 'surfHold', seconds: 6 } },
    ],
    meta: { apex, len, height: ramp.height, footY, slopeDeg },
  };
}

/**
 * T4 SPEED als OVAL (so im Spiel): Bodenplatte 4400 × 7200, Mittelinsel 1400 × 4000 (Bande 96 u),
 * Bahn ~1500 breit, Kurven um die Inselenden. Endlos üben ohne Ende und ohne Tod.
 */
export function lessonSpeedOval(): LessonProto {
  const L = new LevelBuilder({ id: 't4o', name: 'T4 SPEED OVAL', killY: -1000, environment: ENV });
  L.box([-2200, -64, -3600], [2200, 0, 3600], { mat: 'floor', tag: 'bahn' });
  L.box([-700, 0, -2000], [700, 96, 2000], { mat: 'wall', tag: 'insel' });
  L.box([-2264, 0, -3664], [2264, 96, -3600], { mat: 'wall' });
  L.box([-2264, 0, 3600], [2264, 96, 3664], { mat: 'wall' });
  L.box([-2264, 0, -3600], [-2200, 96, 3600], { mat: 'wall' });
  L.box([2200, 0, -3600], [2264, 96, 3600], { mat: 'wall' });
  L.spawn([1450, 0, 1800], 0);
  return { ...lessonSpeed(), id: 't4o', level: L.build(), meta: {} };
}
