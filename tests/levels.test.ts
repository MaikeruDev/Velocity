import { existsSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Box3, Vector3 } from 'three';
import { VELOCITY_DEFAULT } from '../src/player/MovementConfig';
import { PlayerMovement } from '../src/player/PlayerMovement';
import { makeBotInput } from '../src/player/bots';
import { compileBrush, compileLevel, type CompiledTrigger } from '../src/world/level/compileLevel';
import type { BrushDef, HullDef, LevelFile, LevelIndexEntry, RouteNode, TrainingDef, TrainingIndexEntry, Vec3Tuple } from '../src/world/level/LevelFormat';
import { buildTrims } from '../src/render/trims';
import { RESERVE, airTime } from '../tools/levels/ballistics';
import { LEVELS, runBuild } from '../tools/levels/build';
import { finaleReserve, type DesignReport } from '../tools/levels/designProbes';
import { Helix, LevelBuilder, SurfPath, dropFrom, yawTo } from '../tools/levels/lib';
import {
  BRANCH_GAP,
  JITTER_LATERAL,
  JITTER_YAW_DEG,
  RESUME_BELOW,
  START_JITTERS,
  SpeedCurve,
  StartAim,
  configKey,
  describeBranches,
  jitterBranches,
  jitterGrid,
  jitterMedian,
  jitterStart,
  nodeInTrigger,
  resumeIndex,
  timedRun,
  withRoute,
  type TimedRun,
} from '../tools/levels/physics';
import { crouchSpeeds, noDuckReach, selectLevels, trainingIndexProblems, validateLevel, type Report } from '../tools/validate-levels';

const ENV: LevelFile['environment'] = {
  skyTop: '#000', skyHorizon: '#000', skyBottom: '#000', fogColor: '#000', fogNear: 0, fogFar: 1,
  sunDir: [0, 1, 0], sunColor: '#fff', ambientSky: '#fff', ambientGround: '#000', trimColor: '#fff', trimColorAlt: '#0ff', voidY: -1000,
};

function level(brushes: BrushDef[]): LevelFile {
  return { version: 1, id: 't', name: 't', spawn: { pos: [0, 0, 0], yaw: 0 }, killY: -500, environment: ENV, brushes, triggers: [] };
}

const MINS = new Vector3(-16, 0, -16);
const MAXS = new Vector3(16, 72, 16);

function readLevel(file: string): LevelFile {
  return JSON.parse(readFileSync(`public/levels/${file}`, 'utf8')) as LevelFile;
}

describe('LevelFormat.visible (Clip-Brush)', () => {
  const lvl = compileLevel(level([
    { type: 'box', min: [-512, -64, -512], max: [512, 0, 512], mat: 'floor' },
    // Treppe als Optik, darüber ein unsichtbarer Keil (Stair-Clip).
    { type: 'box', min: [-64, 0, -200], max: [64, 16, -100], mat: 'metal', collide: false, tag: 'stairOptic' },
    { type: 'wedge', min: [-64, 0, -300], max: [64, 64, -100], rise: '-z', mat: 'floor', visible: false, tag: 'clip' },
  ]));

  it('kollidiert, wird aber nicht gezeichnet und bekommt keine Trims', () => {
    const clip = lvl.brushes.find((b) => b.tag === 'clip');
    expect(clip?.visible).toBe(false);
    expect(clip?.collide).toBe(true);
    expect(clip?.trim).toBe(false);
    // Der Clip trägt: von oben auf die Rampe fallen landet auf ihrer Fläche, nicht auf der Optik-Stufe.
    const tr = lvl.world.traceBox(new Vector3(0, 200, -250), new Vector3(0, -100, -250), MINS, MAXS);
    expect(tr.fraction).toBeLessThan(1);
    expect(tr.endPos.y).toBeGreaterThan(30);
  });

  it('visible:false und collide:false zugleich ist ein Fehler (wirkungslos)', () => {
    expect(() => compileLevel(level([{ type: 'box', min: [0, 0, 0], max: [8, 8, 8], mat: 'floor', visible: false, collide: false }]))).toThrow(/wirkungslos/);
  });
});

describe('LevelFormat.underTrim', () => {
  const base: BrushDef = { type: 'box', min: [-256, -64, -256], max: [256, 0, 256], mat: 'floor' };
  it('legt ein zweites Band an die Unterkante (nur sichtbare Brushes)', () => {
    const count = (b: BrushDef): number => buildTrims(compileLevel(level([b])))?.getAttribute('position').count ?? 0;
    const plain = count(base);
    const under = count({ ...base, underTrim: true });
    // Vier freie Unterkanten, je mindestens ein Band-Stück à 4 Vertices.
    expect(under).toBeGreaterThanOrEqual(plain + 16);
    expect(compileLevel(level([{ ...base, underTrim: true, visible: false }])).brushes[0].underTrim).toBe(false);
  });
});

describe('public/levels (npm run levels:build)', () => {
  const index = JSON.parse(readFileSync('public/levels/index.json', 'utf8')) as LevelIndexEntry[];

  it('Medaillen streng fallend, Par = Bronze aufgerundet', () => {
    for (const e of index) {
      const l = readLevel(e.file);
      const m = l.medals;
      expect(m, e.id).toBeDefined();
      if (!m) continue;
      expect(m.bronze).toBeGreaterThan(m.silver);
      expect(m.silver).toBeGreaterThan(m.gold);
      expect(m.gold).toBeGreaterThan(m.velocity);
      expect(m.velocity).toBeGreaterThanOrEqual(m.author);
      expect(l.parTime).toBe(Math.ceil(m.bronze));
    }
  });

  it('Start-Chevrons liegen als Markierungen vor dem Spawn, Stufen-Lichter am L2-Tor', () => {
    const l1 = readLevel('level1.json');
    const l2 = readLevel('level2.json');
    const chevrons = (l: LevelFile): number => l.brushes.filter((b) => b.tag === 'startChevron' && b.mat === 'marking').length;
    // Zwei Arme je Chevron.
    expect(chevrons(l1)).toBe(8);
    expect(chevrons(l2)).toBe(6);
    const lights = l2.brushes.filter((b) => b.tag === 'tierLight');
    expect(lights.map((b) => b.mat)).toEqual(['light', 'light', 'light']);
    expect(new Set(lights.map((b) => b.tint)).size).toBe(3);
  });

  it('Level 1: Treppe ist Optik über einem unsichtbaren Clip, die Rutsche hat eine Auffangfläche', () => {
    const l1 = compileLevel(readLevel('level1.json'));
    const stairs = l1.brushes.filter((b) => /^stair\d$/.test(b.tag ?? ''));
    expect(stairs.length).toBe(8);
    expect(stairs.every((b) => !b.collide && b.visible)).toBe(true);
    const clip = l1.brushes.find((b) => b.tag === 'stairClip');
    expect(clip?.visible).toBe(false);
    expect(clip?.collide).toBe(true);
    expect(l1.brushes.some((b) => b.tag === 'chuteCatch' && b.collide)).toBe(true);
    expect(l1.brushes.filter((b) => b.tag?.startsWith('chute') && b.mat === 'surf').length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Plan 007 (level-tools): Werkzeuge für L3, L4 und Lektionen

/** Lange gerade Bahn mit Start, Ziel und Route — Bots kommen in < 1 s Rechenzeit durch. */
function straight(id: string, extra: Partial<LevelFile> = {}): LevelFile {
  const L = new LevelBuilder({ id, name: id.toUpperCase(), killY: -500, environment: ENV });
  L.box([-512, -64, -7000], [512, 0, 256], { tag: 'floor' });
  L.spawn([0, 0, 0], 0);
  L.startZone([-512, 0, -128], [512, 160, 256]);
  L.finishZone([-512, 0, -6400], [512, 400, -6000]);
  for (const z of [0, -1500, -3000, -4500, -6300]) L.node([0, 0, z], { minSpeed: 300 });
  return { ...L.build(), ...extra };
}

describe('physics (Plan 007): SpeedCurve, resumeIndex, withRoute, Start-Jitter', () => {
  it('zwei Configs in einem Prozess → zwei Kurven (Schlüssel über alle Felder)', () => {
    // Beide Werte ausdrücklich (der Default wandert in Plan 007 von 32 auf 40).
    const cap32 = SpeedCurve.hand(3, { ...VELOCITY_DEFAULT, airSpeedCapLow: 32 });
    const cap40 = SpeedCurve.hand(3, { ...VELOCITY_DEFAULT, airSpeedCapLow: 40 });
    // Der alte Schlüssel (8 Felder) kannte airSpeedCapLow nicht und lieferte dieselbe Kurve.
    expect(cap40).not.toBe(cap32);
    expect(cap40.after(250, 10)).toBeGreaterThan(cap32.after(250, 10));
    // Gleiche Werte, neues Objekt: Cache greift.
    expect(SpeedCurve.hand(3, { ...VELOCITY_DEFAULT, airSpeedCapLow: 32 })).toBe(cap32);
  });

  it('configKey ändert sich mit jedem Zahlen- und Schalter-Feld der MovementConfig', () => {
    const k0 = configKey(VELOCITY_DEFAULT);
    const cfg: Record<string, unknown> = { ...VELOCITY_DEFAULT };
    for (const [k, v] of Object.entries(cfg)) {
      if (typeof v === 'number') expect(configKey({ ...VELOCITY_DEFAULT, [k]: v + 1 }), k).not.toBe(k0);
      if (typeof v === 'boolean') expect(configKey({ ...VELOCITY_DEFAULT, [k]: !v }), k).not.toBe(k0);
    }
    expect(configKey({ ...VELOCITY_DEFAULT, hull: { ...VELOCITY_DEFAULT.hull, halfWidth: 17 } })).not.toBe(k0);
  });

  it('resumeIndex prüft die Höhe: in gestapelten Leveln zählt die Etage des Checkpoints', () => {
    // Zwei Umläufe übereinander: Knoten 0–2 unten (y 0), 3–5 oben (y 600) — gleicher Grundriss.
    const route: RouteNode[] = [0, 600].flatMap((y) => [0, 1, 2].map((k): RouteNode => ({ pos: [0, y, -k * 100] })));
    const cp: CompiledTrigger = { kind: 'checkpoint', bounds: new Box3(new Vector3(-100, 600, -250), new Vector3(100, 760, 50)), order: 1, spawnPos: new Vector3(0, 600, -100), spawnYaw: 0, tag: null };
    expect(resumeIndex(route, cp)).toBeGreaterThanOrEqual(3);
    expect(nodeInTrigger([0, 0, -100], cp)).toBe(false);
    // Füße bis RESUME_BELOW unter der Unterkante zählen noch (Hang, Pad).
    expect(nodeInTrigger([0, 600 - RESUME_BELOW, -100], cp)).toBe(true);
    expect(nodeInTrigger([0, 600 - RESUME_BELOW - 1, -100], cp)).toBe(false);
  });

  it('withRoute: ohne safeRoute unverändert, sonst die sichere Linie als route (ohne safeRoute)', () => {
    const plain = straight('p');
    expect(withRoute(plain, 'safeRoute')).toBe(plain);
    const safeLine: RouteNode[] = [{ pos: [0, 0, 0] }, { pos: [200, 0, -6300] }];
    const fork = straight('f', { safeRoute: safeLine });
    const s = withRoute(fork, 'safeRoute');
    expect(s.route).toBe(safeLine);
    expect(s.safeRoute).toBeUndefined();
    expect(withRoute(fork, 'route')).toBe(fork);
    const c = compileLevel(fork);
    const cs = withRoute(c, 'safeRoute');
    expect(cs.world).toBe(c.world);
    expect(cs.def.route).toBe(safeLine);
  });

  it('Start-Jitter-Raster: 7 × 7 Zellmitten im Kasten ±16 u × ±1°, gleichabständig, symmetrisch, Mitte = ungestört', () => {
    expect(START_JITTERS).toEqual(jitterGrid(7));
    expect(START_JITTERS).toHaveLength(49);
    expect(new Set(START_JITTERS.map((j) => `${j.lateral}|${j.yawDeg}`)).size).toBe(49);
    expect(START_JITTERS.some((j) => j.lateral === 0 && j.yawDeg === 0)).toBe(true);
    for (const [values, box] of [
      [START_JITTERS.map((j) => j.lateral), JITTER_LATERAL],
      [START_JITTERS.map((j) => j.yawDeg), JITTER_YAW_DEG],
    ] as const) {
      const v = [...new Set(values)].sort((a, b) => a - b);
      expect(v).toHaveLength(7);
      // Äußerste Zellmitte bei ±(1 − 1/7) × Kasten, Schritt 2/7 × Kasten.
      expect(v[0]).toBeCloseTo((-box * 6) / 7, 12);
      for (let i = 1; i < 7; i++) expect(v[i] - v[i - 1]).toBeCloseTo((2 * box) / 7, 12);
      v.forEach((x, i) => expect(x + v[6 - i]).toBeCloseTo(0, 12));
    }
  });

  it('jitterStart: +lateral liegt dort, wohin Taste D (side +1) schiebt — für jeden Spawn-Blick', () => {
    const floor = compileLevel(level([{ type: 'box', min: [-4000, -64, -4000], max: [4000, 0, 4000], mat: 'floor' }]));
    const inp = makeBotInput();
    for (const yawDeg of [0, 90, 30, -135]) {
      const s = jitterStart(new Vector3(0, 0, 0), yawDeg, 16);
      expect(s.y).toBe(0);
      expect(Math.hypot(s.x, s.z)).toBeCloseTo(16, 9);
      const pm = new PlayerMovement(floor.world, VELOCITY_DEFAULT);
      pm.teleport(new Vector3(0, 0, 0));
      Object.assign(inp, { yaw: (yawDeg * Math.PI) / 180, side: 1, forward: 0 });
      for (let k = 0; k < 64; k++) pm.tick(inp);
      const d = pm.state.pos.clone().setY(0).normalize();
      expect(s.x / 16, `yaw ${yawDeg}`).toBeCloseTo(d.x, 6);
      expect(s.z / 16, `yaw ${yawDeg}`).toBeCloseTo(d.z, 6);
    }
    const p = new Vector3(1, 2, 3);
    expect(jitterStart(p, 45, 0)).toBe(p);
  });

  it('StartAim: Blickfehler bis zum ersten Abheben nach dem Aufsetzen am Spawn, danach nie wieder', () => {
    const cmd = { ...makeBotInput(), yaw: 0.5 };
    const d = Math.PI / 180;
    const aim = new StartAim(1);
    // Spawn schwebt 1 u (SPAWN_LIFT): erst Luft, dann Boden — der Fehler gilt; Abheben löscht ihn.
    expect(aim.apply(cmd, false).yaw).toBeCloseTo(0.5 + d, 12);
    expect(aim.apply(cmd, true).yaw).toBeCloseTo(0.5 + d, 12);
    expect(aim.apply(cmd, true).yaw).toBeCloseTo(0.5 + d, 12);
    expect(aim.active).toBe(true);
    expect(aim.apply(cmd, false)).toBe(cmd);
    expect(aim.active).toBe(false);
    // Landung und neuer Bodenkontakt holen ihn nicht zurück; die Bot-Ausgabe blieb unberührt.
    expect(aim.apply(cmd, true)).toBe(cmd);
    expect(aim.apply(cmd, false)).toBe(cmd);
    expect(cmd.yaw).toBe(0.5);
    expect(new StartAim(0).apply(cmd, true)).toBe(cmd);
  });

  it('timedRun mit Jitter: +16 u startet rechts (Kill-Zone daneben → Tod), −16 u links (frei), Mitte = ungestört', () => {
    // Kill-Zone rechts neben dem Spawn ab x = 17: die Hull des ungestörten Starts (x −16…16) berührt sie nicht,
    // die des um +16 u versetzten (x 0…32) schon.
    const base = straight('jr');
    const c = compileLevel({ ...base, triggers: [...base.triggers, { kind: 'kill', min: [17, 0, -24], max: [200, 80, 24], tag: 'rechts' }] });
    const right = timedRun(c, { sync: 1 }, 1, VELOCITY_DEFAULT, 180, { lateral: 16, yawDeg: 0 });
    const left = timedRun(c, { sync: 1 }, 1, VELOCITY_DEFAULT, 180, { lateral: -16, yawDeg: 0 });
    const plain = timedRun(c, { sync: 1 }, 1);
    expect(right.deaths).toBeGreaterThanOrEqual(1);
    expect(left.deaths).toBe(0);
    expect(plain.deaths).toBe(0);
    // Mitte = ungestörter Lauf. (Der Blickfehler wirkt nur bis zum ersten Absprung — auf dieser Bahn wenige Ticks,
    // die Zeit ändert sich auf Tick-Auflösung nicht; seine Mechanik prüft der StartAim-Test.)
    expect(timedRun(c, { sync: 1 }, 1, VELOCITY_DEFAULT, 180, { lateral: 0, yawDeg: 0 }).time).toBe(plain.time);
    const j = jitterMedian(compileLevel(base), { sync: 1 });
    expect(j.runs).toHaveLength(49);
    expect(j.median).not.toBeNull();
    expect(j.branches).toBeNull();
  });

  it('jitterBranches: ein Zweig oder Ausreißer → null; zwei Zweige (Lücke ≥ 4 %, je ≥ 10 %) samt Abschnitt', () => {
    const run = (time: number | null, splits: number[] = []): TimedRun => ({ time, deaths: 0, reason: time === null ? 'bot' : null, splits });
    // Ruhig wie L2: 49 Zeiten dicht zwischen 15.4 und 16.5 s.
    const calm = Array.from({ length: 49 }, (_, i) => run(15.4 + (1.1 * i) / 48, [5, 10]));
    expect(jitterBranches(calm)).toBeNull();
    // Drei Ausreißer (< 10 % der Starts) sind kein Zweig.
    expect(jitterBranches([...calm.slice(0, 46), run(20, [5, 14]), run(20.1, [5, 14]), run(20.2, [5, 14])])).toBeNull();
    // Wie L1 (Repo-Physik): 12 schnelle, 37 langsame Läufe, auseinander zwischen CP3 und CP4.
    const fast = Array.from({ length: 12 }, (_, i) => run(21.7 + 0.04 * i, [3, 6, 9, 14]));
    const slow = Array.from({ length: 37 }, (_, i) => run(24.4 + 0.05 * i, [3, 6, 9, 17.3 + 0.05 * i]));
    const b = jitterBranches([...slow, ...fast]);
    expect(b).not.toBeNull();
    if (!b) return;
    expect(b.fast).toHaveLength(12);
    expect(b.slow).toHaveLength(37);
    expect(b.gap).toBeCloseTo(24.4 - 22.14, 9);
    expect(b.checkpoints).toBe(4);
    expect(b.segment).toBe(3);
    expect(b.segmentDiff).toBeCloseTo(8.3 + 0.05 * 18 - 5, 9);
    expect(describeBranches(b)).toBe('12/49 Starts bei 21.7–22.1 s, 37/49 bei 24.4–26.2 s (Lücke 2.3 s); größter Verlust in CP3 → CP4 (+4.2 s)');
    // Schwelle: Lücke knapp unter / über 4 % des Medians (20 s).
    const pair = (hi: number): TimedRun[] => [...Array.from({ length: 25 }, () => run(20)), ...Array.from({ length: 24 }, () => run(hi))];
    expect(jitterBranches(pair(20 + 0.99 * BRANCH_GAP * 20))).toBeNull();
    expect(jitterBranches(pair(20 + 1.01 * BRANCH_GAP * 20))).not.toBeNull();
    // Scheitern ≥ 10 % der Starts ist ein Zweig ("der Rest scheitert"), ohne Abschnitt.
    const failing = jitterBranches([...calm.slice(0, 44), ...Array.from({ length: 5 }, () => run(null))]);
    expect(failing?.gap).toBe(Infinity);
    expect(failing?.segment).toBe(-1);
    expect(failing && describeBranches(failing)).toMatch(/5\/49 bei 5 ohne Ziel \(der Rest scheitert\)$/);
  });
});

describe('lib (Plan 007): SurfPath, dropFrom, Helix', () => {
  const quarter = (prev: SurfPath, yawFrom: 'tangent' | 'piece'): SurfPath =>
    dropFrom(prev, { overlap: 96, drop: 64, half: 'right', segs: [{ length: 1571, slopeDeg: 12, turnDeg: 45, pieces: 12 }], yawFrom });

  it('Gehrung: Nachbarstücke teilen exakt dasselbe Fugen-Dreieck', () => {
    const p = new SurfPath({ start: [0, 0], yaw: 0, apex: 0, width: 768, segs: [{ length: 1571, slopeDeg: 12, turnDeg: 45, pieces: 12 }] });
    for (let i = 0; i + 1 < p.pieces.length; i++) expect(p.pieces[i].brush.points.slice(3)).toEqual(p.pieces[i + 1].brush.points.slice(0, 3));
    expect(p.endYaw).toBe(45);
  });

  it('dropFrom mit Endtangente: vier 45°-Viertel mit Drops ergeben 180° (Prototyp: 174.375°)', () => {
    // [Modus, Richtung nach 4 Vierteln, Achse der geraden Folgerampe]; Knick 3.75° → halber Knick 1.875°.
    for (const [mode, end, axis] of [['tangent', 180, 180], ['piece', 174.375, 172.5]] as const) {
      let q = new SurfPath({ start: [0, 0], yaw: 0, apex: 0, width: 768, half: 'right', segs: [{ length: 1571, slopeDeg: 12, turnDeg: 45, pieces: 12 }] });
      for (let k = 0; k < 3; k++) q = quarter(q, mode);
      expect(q.endYaw, mode).toBeCloseTo(end, 9);
      // Achse der Folgerampe aus ihren Brush-Punkten (Grat am Anfang → Grat am Ende).
      const r = dropFrom(q, { overlap: 96, drop: 256, segs: [{ length: 1536, slopeDeg: 10 }], yawFrom: mode });
      const [a, , , b] = r.pieces[0].brush.points;
      const off = ((((yawTo(a, b) - axis) % 360) + 540) % 360) - 180;
      expect(Math.abs(off), mode).toBeLessThan(1e-3);
    }
  });

  it('Helix: fugenlos, Bande an Stufen auf Achsen als Box, Punkte auf der Wendelfläche', () => {
    const h = new Helix({
      center: [0, 0],
      rIn: 640,
      rOut: 1152,
      phi0: 270,
      seg: 4,
      thick: 128,
      board: { h: 80, t: 32 },
      boardRisers: [90],
      sections: [
        { from: 0, to: 90, y0: 0, y1: 200, tag: 'a' },
        { from: 90, to: 120, y0: 264, y1: 264, tag: 'b' },
      ],
    });
    // Zwei Dreiecks-Prismen je Segment, Nachbarsegmente teilen die Kante (tb von k = ta von k + 1).
    const top = (b: HullDef): Vec3Tuple[] => b.points.filter((_, i) => i % 2 === 0);
    const segA = h.brushes.filter((b) => b.tag?.startsWith('a#'));
    expect(segA).toHaveLength(2 * Math.ceil(90 / 4));
    expect(top(segA[1])).toContainEqual(top(segA[2])[0]);
    // Stufe bei θ 90 = φ 0 (Ostpunkt): das Banden-Segment darauf ist eine achsparallele Box.
    expect(h.boards.filter((b) => b.type === 'box')).toHaveLength(1);
    expect(h.yAt(45)).toBeCloseTo(100, 9);
    expect(h.yAt(90, true)).toBe(264);
    expect(h.thetaOf(...h.xz(400, 900), 380)).toBeCloseTo(400, 9);
  });

  it('finishAfterLaunch: Lücke aus dem unteren Band mit 10 % Reserve, Ziel-Trigger und Prallwand', () => {
    const L = new LevelBuilder({ id: 'f', name: 'f', killY: -5000, environment: ENV });
    const goal = L.finishAfterLaunch({ x: 0, z: 0, yaw: 0, apex: 0 }, [0, -300, 0], 700, { drop: 1000, depth: 1900, v: [-448, 448] });
    const t = airTime(-300 - goal.top, false, 0);
    expect(goal.top).toBe(-1000);
    expect(goal.lip).toBe(Math.floor(((700 * t) / RESERVE + 8) / 16) * 16);
    expect(L.triggers.filter((x) => x.kind === 'finish')).toHaveLength(1);
    expect(L.brushes.map((b) => b.tag)).toEqual(['finish', 'backstop']);
  });

  it('killTiles: Prismen und gedrehte Brushes zählen mit ihren echten Punkten (compileBrush)', () => {
    // Prisma-Boden (y −900…−800) in derselben Kachel wie ein Box-Boden (−64…0): die Kachel muss unter dem
    // Prisma liegen. Ohne Prismen lag sie bei −914…−314 — der Prisma-Boden mitten in der Kill-Zone.
    const L = new LevelBuilder({ id: 'k', name: 'k', killY: -5000, environment: ENV });
    L.box([0, -64, 0], [256, 0, 1024], { tag: 'box' });
    L.add({ type: 'prism', axis: 'z', from: 0, to: 1024, profile: [[512, -900], [1000, -900], [760, -800]], mat: 'floor', tag: 'prism' });
    L.killTiles({ margin: 0, reach: 0 });
    const tiles = L.triggers.filter((t) => t.kind === 'kill');
    expect(tiles).toHaveLength(1);
    expect(tiles[0].max[1]).toBe(-900 - 250);
    // rotY dreht um pivot (hier den Ursprung), nicht um die eigene Mitte: 90° bringt x 2048…2304 nach z −2304…−2048.
    const R = new LevelBuilder({ id: 'r', name: 'r', killY: -5000, environment: ENV });
    R.add({ type: 'box', min: [2048, -700, 0], max: [2304, -600, 256], rotY: 90, pivot: [0, 0, 0], mat: 'floor', tag: 'rot' });
    const bb = compileBrush(R.brushes[0], 0).bounds;
    expect(bb.min.z).toBeCloseTo(-2304, 6);
    R.killTiles();
    const rt = R.triggers.filter((t) => t.kind === 'kill');
    expect(rt.length).toBeGreaterThan(0);
    expect(rt.every((t) => t.max[2] <= -1024 && t.min[0] >= -1024 && t.max[0] <= 1024)).toBe(true);
    expect(rt.every((t) => t.max[1] === -700 - 250)).toBe(true);
  });
});

describe('designProbes (Plan 007): finaleReserve', () => {
  /** Launch nach Norden, CP davor, Zielplattform (Tag 'finish') 600 u weiter, um rotY gedreht. */
  function finale(rotY: number): ReturnType<typeof compileLevel> {
    const L = new LevelBuilder({ id: 'fr', name: 'fr', killY: -3000, environment: ENV });
    L.box([-256, -64, -512], [256, 0, 256], { tag: 'floor' });
    L.spawn([0, 0, 0], 0);
    L.startZone([-256, 0, -64], [256, 160, 128]);
    L.checkpoint(1, [-256, 0, -400], [256, 160, -200], [0, 0, -300], 0);
    L.add({ type: 'box', min: [-256, -1064, -1600], max: [256, -1000, -1100], rotY, mat: 'finish', tag: 'finish' });
    L.finishZone([-400, -1000, -1700], [400, -600, -1000]);
    L.node([0, 0, 0]);
    L.node([0, 0, -500], { surf: true, note: 'Launch' });
    L.node([0, -1000, -1300]);
    return compileLevel(L.build());
  }

  it('misst die Lücke an der echten Kante; steht die Plattform schräg zur Flugrichtung, ist das ein Fehler', () => {
    const skew = (lvl: ReturnType<typeof compileLevel>, yaw: number): string[] => {
      const r: DesignReport = { errors: [], warnings: [], info: [] };
      finaleReserve(lvl, VELOCITY_DEFAULT, r, yaw);
      return r.errors.filter((e) => /steht schräg/.test(e));
    };
    // Um 30° gedreht: gegen Norden (0°) schräg, gegen die eigene Richtung (30°) quer.
    const turned = finale(30);
    expect(skew(turned, 0)).toHaveLength(1);
    expect(skew(turned, 30)).toEqual([]);
    expect(skew(finale(0), 0)).toEqual([]);
  });
});

describe('validate-levels (Plan 007): Gabeln, Lektionen', () => {
  it('ohne Gabel-Unterschied (safeRoute = route) sind beide Teilberichte der Bericht ohne safeRoute', () => {
    const lvl = straight('g');
    const plain = validateLevel('g', lvl);
    const fork = validateLevel('g', { ...lvl, safeRoute: lvl.route });
    const all = (r: Report): string[] => [...r.errors.map((l) => `E ${l}`), ...r.warnings.map((l) => `W ${l}`), ...r.info.map((l) => `I ${l}`)];
    // Ohne safeRoute keine Präfixe (Bericht wie vor Plan 007).
    expect(all(plain).some((l) => l.includes('[route]') || l.includes('[safeRoute]'))).toBe(false);
    const part = (tag: string): string[] => all(fork).filter((l) => l.slice(2).startsWith(tag)).map((l) => l.slice(0, 2) + l.slice(2 + tag.length)).sort();
    const global = all(fork).filter((l) => !l.slice(2).startsWith('[') && !l.startsWith('I safeRoute '));
    expect([...part('[route] '), ...global].sort()).toEqual(all(plain).sort());
    expect(part('[safeRoute] ')).toEqual(part('[route] '));
    expect(fork.info.some((l) => l.startsWith('safeRoute 5 Knoten'))).toBe(true);
  });

  it('Lektion: kein Start/Ziel nötig, Vertrag wird geprüft (IDs, Referenzen, Texte, Medaillen)', () => {
    const L = new LevelBuilder({ id: 'lesson', name: 'L', killY: -500, environment: ENV });
    L.box([-512, -64, -1024], [512, 0, 256], { tag: 'floor' });
    L.spawn([0, 0, 0], 0);
    const training: TrainingDef = {
      lesson: 3,
      short: 'T3',
      group: 'basics',
      zones: [{ id: 'z', min: [-64, 0, -900], max: [64, 128, -800] }],
      gates: [{ id: 'g', min: [-512, 0, -600], max: [512, 256, -584] }],
      stages: [{ id: 's', title: 'LINKS', text: 'A HALTEN + MAUS NACH LINKS', task: { kind: 'goodHops', count: 5, side: 'left' }, opens: ['g'], tips: [{ on: 'verdict', verdict: 'wOnly', text: 'A STATT W' }] }],
    };
    const ok = validateLevel('lesson', { ...L.build(), training }, { physics: false });
    expect(ok.errors).toEqual([]);
    expect(ok.info.some((l) => l.startsWith('Lektion T3 (basics): 1 Stufen'))).toBe(true);
    const bad = validateLevel(
      'lesson',
      {
        ...L.build(),
        parTime: 30,
        training: {
          ...training,
          zones: [...(training.zones ?? []), { id: 'g', min: [0, 0, 0], max: [1, 1, 1] }],
          stages: [{ ...training.stages[0], title: 'VIEL ZU LANGER TITEL', text: 'A → LINKS', task: { kind: 'reach', zone: 'nix' }, tips: [{ on: 'zone', text: 'x' }] }],
        },
      },
      { physics: false },
    );
    const text = bad.errors.join('\n');
    expect(text).toMatch(/training zusammen mit medals\/parTime/);
    expect(text).toMatch(/id "g" doppelt/);
    expect(text).toMatch(/Titel "VIEL ZU LANGER TITEL" hat 20 Zeichen/);
    expect(text).toMatch(/unbekannte Zone "nix"/);
    expect(text).toMatch(/Tipp 'zone' ohne Zone/);
    expect(text).toMatch(/Text Zeichen ohne Glyphe im HUD-Font: "→"/);
    // Typografische Striche haben Aliase im Font (— → -): kein Befund.
    const dash = validateLevel('lesson', { ...L.build(), training: { ...training, stages: [{ ...training.stages[0], text: 'LINKS — RECHTS' }] } }, { physics: false });
    expect(dash.errors).toEqual([]);
  });

  it('Gabel: eine safeRoute außerhalb von Start/Ziel meldet [safeRoute], route bleibt sauber', () => {
    const lvl = straight('gs');
    const r = validateLevel('gs', { ...lvl, safeRoute: [{ pos: [0, 0, -1000] }, { pos: [0, 0, -3000] }] }, { physics: false });
    expect(r.errors).toContain('[safeRoute] Route endet nicht im Ziel-Trigger');
    expect(r.warnings).toContain('[safeRoute] Route beginnt nicht im Start-Trigger');
    expect([...r.errors, ...r.warnings].some((l) => l.startsWith('[route] '))).toBe(false);
  });

  it('levels:check -- <arg>: jedes Argument muss treffen, einzeln gebaute Level/Lektionen auch ohne Index, kein Präfix', () => {
    const listed = ['level1.json', 'level2.json', 'sandbox.json', 'training/t1.json'];
    const idOf = new Map([
      ['level1.json', 'level1'],
      ['level2.json', 'level2'],
      ['training/t1.json', 't1'],
    ]);
    const disk = new Set([...listed, 'level3.json', 'training/t2.json']);
    const sel = (...only: string[]): ReturnType<typeof selectLevels> => selectLevels(only, listed, idOf, (f) => disk.has(f));
    expect(sel().files).toEqual(listed);
    expect(sel('level1')).toEqual({ files: ['level1.json'], notes: [], errors: [] });
    expect(sel('level1.json', 'sandbox', 'level1').files).toEqual(['level1.json', 'sandbox.json']);
    expect(sel('training').files).toEqual(['training/t1.json']);
    // Einzeln gebaut (levels:build -- <id> schreibt keinen Index): gefunden, mit Hinweis — Lektionen unter training/.
    expect(sel('level3').files).toEqual(['level3.json']);
    expect(sel('t2').files).toEqual(['training/t2.json']);
    expect(sel('t2').notes[0]).toMatch(/training\/t2\.json steht in keinem Index/);
    // Tippfehler, Stub ohne JSON, Präfix: rot statt "0 Level, grün".
    expect(sel('levle1').errors[0]).toMatch(/levle1: kein Level und keine Lektion gefunden/);
    expect(sel('level4').errors).toHaveLength(1);
    expect(sel('level').errors).toHaveLength(1);
    expect(sel('level1', 'bogus')).toMatchObject({ files: ['level1.json'] });
    expect(sel('level1', 'bogus').errors).toHaveLength(1);
    expect(selectLevels(['training'], ['level1.json'], idOf, () => false).errors[0]).toMatch(/keine Lektionen gefunden/);
  });

  it('training/index.json: doppelte id, Lektionsnummer oder Kurzname sind Fehler', () => {
    const e = (id: string, lesson: number, short: string): TrainingIndexEntry => ({ id, name: id, file: `${id}.json`, lesson, short, group: 'basics' });
    const levelIds = (): Map<string, string> => new Map([['level1', 'level1.json']]);
    expect(trainingIndexProblems([e('t1', 1, 'T1'), e('t2', 2, 'T2')], levelIds())).toEqual([]);
    const p = trainingIndexProblems([e('t1', 1, 'T1'), e('t2', 1, 'T1'), e('level1', 3, 'T3')], levelIds()).join('\n');
    expect(p).toMatch(/Lektionsnummer 1 doppelt \("t1" und "t2"\)/);
    expect(p).toMatch(/Kurzname "T1" doppelt \("t1" und "t2"\)/);
    expect(p).toMatch(/id "level1" doppelt/);
  });

  it('Reichweite ohne Ducken folgt der Config: Sprunghöhe ≤ Reichweite ≤ Sprung + Kanten-Assist + Boden-Trace', () => {
    const cfg = VELOCITY_DEFAULT;
    const jump = cfg.jumpImpulse ** 2 / (2 * cfg.gravity);
    const reach = noDuckReach(cfg, crouchSpeeds(cfg, 761));
    expect(reach).toBeGreaterThanOrEqual(jump - 1);
    expect(reach).toBeLessThanOrEqual(jump + cfg.ledgeStep + 2);
    expect(crouchSpeeds(cfg, 761)).toEqual([cfg.sprintSpeed, (cfg.sprintSpeed + 1.2 * 761) / 2, 1.2 * 761]);
  });
});

describe('levels:build (Plan 007): Registry und Filter', () => {
  it('mit Filter nur die gewählte Datei, index.json bleibt unberührt; ohne Filter neu', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vel-build-'));
    const index = join(dir, 'index.json');
    writeFileSync(index, '[]\n');
    const old = new Date('2020-01-01T00:00:00Z');
    utimesSync(index, old, old);
    const before = statSync(index).mtimeMs;
    const levels = [
      { id: 'tiny', build: () => straight('tiny') },
      { id: 'stub', build: () => null },
    ];
    const quiet = (): void => undefined;
    const filtered = runBuild({ out: dir, only: ['tiny'], levels, training: () => null, log: quiet });
    expect(filtered.written).toEqual(['tiny.json']);
    expect(statSync(index).mtimeMs).toBe(before);
    expect(readFileSync(index, 'utf8')).toBe('[]\n');
    const tiny = JSON.parse(readFileSync(join(dir, 'tiny.json'), 'utf8')) as LevelFile;
    const m = tiny.medals;
    expect(m && m.bronze > m.silver && m.silver > m.gold && m.gold > m.velocity && m.velocity >= m.author).toBe(true);
    // Voller Lauf: Stub übersprungen (auch im Index), index.json neu geschrieben.
    const full = runBuild({ out: dir, levels, training: () => null, log: quiet });
    expect(full.stubs).toEqual(['stub']);
    expect(statSync(index).mtimeMs).not.toBe(before);
    expect((JSON.parse(readFileSync(index, 'utf8')) as LevelIndexEntry[]).map((e) => e.id)).toEqual(['tiny']);
    expect(() => runBuild({ out: dir, only: ['gibtsnicht'], levels, training: () => null, log: quiet })).toThrow(/Unbekannte id/);
    expect(full.warnings).toEqual([]);
  });

  it('gemischter Filter mit Tippfehler: Abbruch, bevor irgendetwas geschrieben ist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vel-build-'));
    const levels = [{ id: 'tiny', build: () => straight('tiny') }];
    const quiet = (): void => undefined;
    expect(() => runBuild({ out: dir, only: ['tiny', 'bogus'], levels, training: () => null, log: quiet })).toThrow(/Unbekannte id\(s\): bogus.*nichts geschrieben/);
    expect(existsSync(join(dir, 'tiny.json'))).toBe(false);
    // Eine Lektion mit Medaillen bricht ebenso vor dem ersten write ab.
    const bad: LevelFile = { ...straight('t9'), medals: { bronze: 30, silver: 25, gold: 20, velocity: 18, author: 17 }, training: { lesson: 9, short: 'T9', group: 'basics', stages: [] } };
    expect(() => runBuild({ out: dir, only: ['tiny', 't9'], levels, training: () => [bad], log: quiet })).toThrow(/medals\/parTime.*nichts geschrieben/);
    expect(existsSync(join(dir, 'tiny.json'))).toBe(false);
  });

  // Eigenes Timeout: die Builder von L3/L4 messen beim Bau (L3 zwei Surf-Raster auf zwei Linien, ~11–19 s).
  it('die Registry kennt level1–level4 in Index-Reihenfolge; L3/L4 bauen ihre id (keine Stubs mehr)', { timeout: 120000 }, () => {
    expect(LEVELS.map((e) => e.id)).toEqual(['level1', 'level2', 'level3', 'level4']);
    // L1/L2 decken die anderen Tests ab (formatLevel/Index); hier nur die Phase-2-Level.
    for (const e of LEVELS.slice(2)) expect(e.build()?.id, e.id).toBe(e.id);
  });
});
