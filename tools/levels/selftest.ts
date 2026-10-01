/**
 * Selbsttest des Level-Validators — läuft am Ende von `npm run levels:check`
 * mit, einzeln: `npx tsx tools/levels/selftest.ts`.
 *
 * Nimmt level1.json/level2.json und zwei Attrappen (Plan 007: gestapelte Wendel,
 * Lektion), baut gezielt Fehler ein und prüft, dass `validateLevel` jeden davon
 * meldet — ein Validator, der nie rot wird, ist wertlos. Statische Fälle laufen
 * ohne Physik-Stufe (schnell), die Physik-Fälle mit. Die unveränderten Level und
 * Attrappen müssen fehlerfrei sein (die Turm-Attrappe mit Physik: sie belegt den
 * höhenbewussten Wiedereinstieg nach Respawn). Die Crouch-Fälle setzen die Kante relativ zur
 * gemessenen Reichweite ohne Ducken (noDuckReach) — sie prüfen die Schwelle auch nach einem
 * Movement-Tuning. Exit-Code 1, wenn ein Fall durchrutscht.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { VELOCITY_DEFAULT, type MovementConfig } from '../../src/player/MovementConfig';
import type { CompiledLevel } from '../../src/world/level/compileLevel';
import type { BrushDef, LevelFile, RouteNode, TrainingDef, TriggerDef, Vec3Tuple } from '../../src/world/level/LevelFormat';
import { CROUCH_RESERVE, crouchSpeeds, noDuckReach, validateLevel } from '../validate-levels';
import { helixBoardProbe, type DesignReport } from './designProbes';
import { LevelBuilder, type Helix, type HelixSection, type V2, type V3 } from './lib';

type Mutable = { -readonly [K in keyof LevelFile]: LevelFile[K] };

const shiftZ = (p: Vec3Tuple, dz: number): Vec3Tuple => [p[0], p[1], p[2] + dz];
const shiftY = (p: Vec3Tuple, dy: number): Vec3Tuple => [p[0], p[1] + dy, p[2]];

type CaseFile = 'level1' | 'level2' | 'tower' | 'lesson';

interface Case {
  readonly name: string;
  readonly file: CaseFile;
  readonly expect: RegExp;
  readonly physics?: boolean;
  readonly mutate: (l: Mutable) => void;
}

// ── Attrappen (Plan 007): gestapelte Wendel und Lektion ──────────────────

const ENV: LevelFile['environment'] = {
  skyTop: '#000000', skyHorizon: '#000000', skyBottom: '#000000', fogColor: '#000000', fogNear: 0, fogFar: 1,
  sunDir: [0, 1, 0], sunColor: '#ffffff', ambientSky: '#ffffff', ambientGround: '#000000', trimColor: '#ffffff', voidY: -2000,
};

/** Radius der Fahrlinie (Route) der Turm-Attrappe. */
const TOWER_LINE = 704;

/**
 * Turm-Attrappe wie L4: 1.25 Umdrehungen Wendel (r 512–896, Bande außen, Kern innen), Start θ 0–30 am
 * Südpunkt, CP1 auf dem Podest θ 150–175, CP2 auf dem Podest θ 360–385 — GENAU über dem Wendel-Anfang:
 * die Route läuft dort eine Etage tiefer schon einmal durch den Grundriss des CP2-Triggers
 * (Schatten-Knoten). Am Ostpunkt (θ 450) geht es gerade nach Norden auf einen Steg, Ziel ab 600 u. Mit
 * einem Wiedereinstieg ohne Höhe fährt der Bot nach CP2 die untere Etage ab (vom Steg auf die Wendel
 * darunter, gemessen 3× so lange, aber im Ziel); den Rückfall meldet deshalb die Regel "Schatten-Knoten"
 * auf der unveränderten Attrappe.
 */
function towerFixture(): { readonly def: LevelFile; readonly helix: Helix } {
  const L = new LevelBuilder({ id: 'selftest-tower', name: 'SELBSTTEST TURM', killY: -600, environment: ENV });
  const podest = (from: number, to: number, y: number, mat: 'start' | 'checkpoint' | 'finish', tag: string): HelixSection => ({ from, to, y0: y, y1: y, mat, tag });
  const helix = L.helix({
    center: [0, 0],
    rIn: 512,
    rOut: 896,
    phi0: 270,
    seg: 6,
    thick: 96,
    board: { h: 80, t: 32 },
    sections: [
      podest(0, 30, 0, 'start', 'st'),
      { from: 30, to: 150, y0: 0, y1: 280, tag: 'e1' },
      podest(150, 175, 280, 'checkpoint', 'p1'),
      { from: 175, to: 360, y0: 280, y1: 640, tag: 'e2' },
      podest(360, 385, 640, 'checkpoint', 'p2'),
      { from: 385, to: 450, y0: 640, y1: 760, tag: 'e3' },
    ],
  });
  // Steg ab dem Ostpunkt (Wendel-Ende, φ 0) gerade nach Norden, achsparallel; Ziel auf den letzten 300 u.
  L.box([512, 696, -900], [896, 760, 0], { tag: 'steg' });
  // Kern: 16-Eck, Flächenmitten an der Wendel-Innenkante.
  const coreR = 512 / Math.cos(Math.PI / 16);
  const core: Vec3Tuple[] = [];
  for (let k = 0; k < 16; k++) {
    const a = ((k + 0.5) * 2 * Math.PI) / 16;
    core.push([coreR * Math.cos(a), -200, -coreR * Math.sin(a)], [coreR * Math.cos(a), 1000, -coreR * Math.sin(a)]);
  }
  L.add({ type: 'hull', points: core, mat: 'wall', trim: false, tag: 'core' });
  // Trigger über den Podesten (Hülle des Bogens), Füße bis 160 u darüber.
  const box = (from: number, to: number, y: number): [V3, V3] => {
    const pts: V2[] = [];
    for (let t = from; t <= to + 1e-6; t += 2) for (const r of [512, 896]) pts.push(helix.xz(t, r));
    const xs = pts.map((p) => p[0]);
    const zs = pts.map((p) => p[1]);
    return [
      [Math.min(...xs), y, Math.min(...zs)],
      [Math.max(...xs), y + 160, Math.max(...zs)],
    ];
  };
  L.spawn(helix.p3(10, TOWER_LINE, 0), helix.yawAt(10));
  L.startZone(...box(0, 30, 0));
  L.checkpoint(1, ...box(150, 175, 280), helix.p3(162.5, TOWER_LINE, 280), helix.yawAt(162.5) % 360);
  L.checkpoint(2, ...box(360, 385, 640), helix.p3(372.5, TOWER_LINE, 640), helix.yawAt(372.5) % 360);
  L.finishZone([512, 760, -900], [896, 920, -600]);
  L.placeNodes((rest) => {
    for (let t = 10; t <= 440; t += 10) {
      const [x, z] = helix.xz(t, TOWER_LINE);
      L.node(rest(x, z, helix.yAt(t, true)), { minSpeed: 300, ...(t === 10 ? { note: 'Start' } : {}) });
    }
    for (const z of [-150, -400, -650, -850]) L.node([TOWER_LINE, 760.05, z], { minSpeed: 300, ...(z === -850 ? { note: 'Ziel' } : {}) });
  });
  return { def: L.build(), helix };
}

/** Bande-Probe der Turm-Attrappe (θ 30–270, bis 600 u/s, 2 s: niemand erreicht das Wendel-Ende bei θ 450). */
function towerProbes(helix: Helix): (level: CompiledLevel, cfg: MovementConfig) => DesignReport {
  return (level, cfg) => {
    const r: DesignReport = { errors: [], warnings: [], info: [] };
    helixBoardProbe(level, helix, { thetas: [30, 270, 30], radii: [560, 704, 848], speeds: [320, 600], seconds: 2 }, cfg, r, 'Turm');
    return r;
  };
}

/** Lektions-Attrappe: ebene Fläche, eine Zone, ein Tor, zwei Stufen (Pflicht + Bonus). */
function lessonFixture(): LevelFile {
  const L = new LevelBuilder({ id: 'selftest-lesson', name: 'SELBSTTEST LEKTION', killY: -500, environment: ENV });
  L.box([-512, -64, -1024], [512, 0, 256], { tag: 'floor' });
  L.spawn([0, 0, 0], 0);
  const training: TrainingDef = {
    lesson: 1,
    short: 'T0',
    group: 'basics',
    zones: [{ id: 'ziel', min: [-128, 0, -900], max: [128, 128, -700] }],
    gates: [{ id: 'tor', min: [-512, 0, -600], max: [512, 256, -584] }],
    stages: [
      {
        id: 'laufen',
        title: 'LAUFEN',
        text: 'W = LAUFEN\nMAUS = UMSEHEN',
        task: { kind: 'reach', zone: 'ziel' },
        opens: ['tor'],
        tips: [{ on: 'stuck', after: 20, text: '[H] ZEIGT ES DIR' }],
      },
      { id: 'huepfen', title: 'HÜPFEN', text: 'LEERTASTE HALTEN', task: { kind: 'hopChain', count: 3 }, rank: 'bonus' },
    ],
  };
  return { ...L.build(), training };
}


/**
 * L1-Crouch-Kante (ledge + ledgeLip) auf `h` u über dem Crouch-Knoten setzen — relativ zur Reichweite ohne
 * Ducken der aktuellen Config, damit der Fall auch nach einem Movement-Tuning an der Schwelle prüft.
 */
function setCrouchEdge(l: Mutable, dh: (reach: number) => number): void {
  const a = (l.route ?? []).find((n: RouteNode) => n.crouch);
  if (!a) return;
  const top = a.pos[1] + dh(noDuckReach(VELOCITY_DEFAULT, crouchSpeeds(VELOCITY_DEFAULT, a.minSpeed)));
  l.brushes = l.brushes.map((b: BrushDef) => ((b.tag === 'ledge' || b.tag === 'ledgeLip') && b.type === 'box' ? { ...b, max: [b.max[0], top, b.max[2]] } : b));
}

const cases: Case[] = [
  {
    // Level 2: das Ziel liegt nach Norden (−z) hinter einer echten Lücke (Level 1 endet über einer Auffangfläche).
    name: 'Ziel 200 u weiter weg',
    file: 'level2',
    expect: /Reichweite/,
    mutate: (l) => {
      const far = (tag: string | undefined): boolean => tag === 'finish' || tag === 'backstop' || tag === 'finishArch-post' || tag === 'finishArch-lintel';
      l.brushes = l.brushes.map((b: BrushDef) => (far(b.tag) && b.type === 'box' ? { ...b, min: shiftZ(b.min, -200), max: shiftZ(b.max, -200) } : b));
      l.triggers = l.triggers.map((t: TriggerDef) => (t.kind === 'finish' ? { ...t, min: shiftZ(t.min, -200), max: shiftZ(t.max, -200) } : t));
      const r = l.route ?? [];
      const last = r[r.length - 1];
      l.route = [...r.slice(0, -1), { ...last, pos: shiftZ(last.pos, -200) }];
    },
  },
  { name: 'Spawn im Boden', file: 'level1', expect: /Spawn .*Solid/, mutate: (l) => (l.spawn = { pos: [l.spawn.pos[0], -10, l.spawn.pos[2]], yaw: 0 }) },
  {
    name: 'Koplanare Kopie (Z-Fighting)',
    file: 'level1',
    expect: /Z-Fighting/,
    mutate: (l) => {
      const s = l.brushes.find((b: BrushDef) => b.tag === 'start');
      if (s && s.type === 'box') l.brushes = [...l.brushes, { ...s, min: [s.min[0] + 32, s.min[1] - 10, s.min[2] + 32], tag: 'dup' }];
    },
  },
  {
    name: 'Crouch-Flag fehlt',
    file: 'level1',
    expect: /nicht erreichbar|stößt/,
    mutate: (l) => (l.route = (l.route ?? []).map((n: RouteNode) => (n.crouch ? { ...n, crouch: false } : n))),
  },
  {
    name: 'Decke über der Hop-Reihe',
    file: 'level1',
    expect: /stößt/,
    mutate: (l) => {
      const h = l.brushes.find((b: BrushDef) => b.tag === 'hop3');
      if (h && h.type === 'box')
        l.brushes = [...l.brushes, { type: 'box', min: [h.min[0], h.max[1] + 90, h.min[2] - 200], max: [h.max[0], h.max[1] + 110, h.max[2] + 200], mat: 'wall', tag: 'ceiling' }];
    },
  },
  {
    name: 'Checkpoint-Reihenfolge',
    file: 'level1',
    expect: /Checkpoint-Reihenfolge|vor dem vorherigen/,
    mutate: (l) => (l.triggers = l.triggers.map((t: TriggerDef) => (t.kind === 'checkpoint' && t.order === 1 ? { ...t, order: 5 } : t))),
  },
  { name: 'killY über dem Ziel', file: 'level1', expect: /killY/, mutate: (l) => (l.killY = 0) },
  {
    name: 'Medaillen vertauscht (Gold langsamer als Silber)',
    file: 'level2',
    expect: /Medaillen nicht streng fallend/,
    mutate: (l) => (l.medals = l.medals ? { ...l.medals, gold: l.medals.silver + 1 } : { bronze: 30, silver: 20, gold: 25, velocity: 12, author: 10 }),
  },
  {
    name: 'VELOCITY-Medaille schneller als der Autor',
    file: 'level1',
    expect: /Medaillen nicht streng fallend/,
    mutate: (l) => (l.medals = l.medals ? { ...l.medals, velocity: l.medals.author - 0.5 } : { bronze: 30, silver: 20, gold: 15, velocity: 9, author: 10 }),
  },
  {
    // Der Knoten NACH 'Slalom' (Insel 1 → 2): unter den Erstkontakt-Lücken liegen Auffangmulden, und vor Insel 1 trägt
    // seit der l1l2-Runde die 9°-Lippe (slalom1Lip) — dort ist Laufen erlaubt, der Fall wäre nicht mehr eingebaut.
    name: 'Lücke ohne jump-Flag',
    file: 'level1',
    expect: /Laufstrecke ohne Boden/,
    mutate: (l) => {
      const route = l.route ?? [];
      const i = route.findIndex((n: RouteNode) => n.note === 'Slalom') + 1;
      l.route = route.map((n: RouteNode, k: number) => (k === i ? { ...n, jump: false } : n));
    },
  },
  {
    name: 'Deko im Weg',
    file: 'level1',
    expect: /Deko .*schneidet/,
    mutate: (l) => {
      l.brushes = [...l.brushes, { type: 'box', min: [-40, -32, 0], max: [40, 200, 80], mat: 'dark', collide: false, tag: 'decoInStart' }];
    },
  },
  {
    name: 'Checkpoint-Spawn an der Plateaukante',
    file: 'level1',
    expect: /steht an einer Kante|über der Kante/,
    mutate: (l) =>
      (l.triggers = l.triggers.map((t: TriggerDef) =>
        t.kind === 'checkpoint' && t.order === 1 && t.spawn ? { ...t, spawn: { ...t.spawn, pos: [256, t.spawn.pos[1], t.spawn.pos[2]] } } : t,
      )),
  },
  {
    name: 'Kill-Zone direkt unter der Hop-Reihe',
    file: 'level1',
    expect: /Kill-Zone .*(Oberkante|Route-Knoten)/,
    mutate: (l) => (l.triggers = l.triggers.map((t: TriggerDef) => (t.kind === 'kill' && t.tag === 'kill-row' ? { ...t, max: [t.max[0], 40, t.max[2]] } : t))),
  },
  // ── Physik-Fälle ────────────────────────────────────────────────────────
  {
    name: 'Slalom-Insel fehlt (Bot-Durchlauf)',
    file: 'level1',
    physics: true,
    expect: /Bot-Durchlauf sync 1\.0 scheitert|Respawn CP3/,
    mutate: (l) => (l.brushes = l.brushes.filter((b: BrushDef) => !(b.tag ?? '').startsWith('slalom3'))),
  },
  {
    // Ohne Auffangfläche unter der Rutsche stirbt jeder, der nicht surfen kann.
    name: 'Auffangfläche der Rutsche fehlt',
    file: 'level1',
    physics: true,
    expect: /Surf-Rutsche fängt nicht jeden/,
    mutate: (l) => (l.brushes = l.brushes.filter((b: BrushDef) => b.tag !== 'chuteCatch')),
  },
  {
    // Ohne Bande fliegt, wer von der Flanke rutscht, mit Auto-Hop seitlich von der Auffangfläche.
    name: 'Bande an der Rutsche fehlt',
    file: 'level1',
    physics: true,
    expect: /Surf-Rutsche fängt nicht jeden/,
    mutate: (l) => (l.brushes = l.brushes.filter((b: BrushDef) => b.tag !== 'chuteRail')),
  },
  {
    // Ohne Mulde unter Lauf-Lücke 2 stirbt mit gehaltener Leertaste wieder jede zweite Hop-Phase.
    name: 'Auffangmulde fehlt (Erstkontakt)',
    file: 'level1',
    physics: true,
    expect: /Erstkontakt tödlich/,
    mutate: (l) => (l.brushes = l.brushes.filter((b: BrushDef) => b.tag !== 'catch-run2')),
  },
  {
    // Ein vergessener Graben in der Hop-Reihe: der Fehlsprung dort endet wieder im Respawn.
    name: 'Graben in der Hop-Reihe fehlt (Grundkurs-Ausstieg)',
    file: 'level1',
    physics: true,
    expect: /Grundkurs-Fehlsprung ohne Ausstieg/,
    mutate: (l) => (l.brushes = l.brushes.filter((b: BrushDef) => b.tag !== 'catch-row3')),
  },
  {
    // Der alte Ziel-Torbalken (fin.u0 + 96, 560 u hoch) lag im Launch-Flug: die Kamera flog hindurch.
    name: 'Torbalken im Finale-Flug (Deko auf der Flugbahn)',
    file: 'level2',
    physics: true,
    expect: /Deko auf der Flugbahn/,
    mutate: (l) => {
      const f = l.brushes.find((b: BrushDef) => b.tag === 'finish');
      if (f && f.type === 'box')
        l.brushes = [
          ...l.brushes,
          { type: 'box', min: [f.min[0], f.max[1] + 560, f.max[2] - 124], max: [f.max[0], f.max[1] + 616, f.max[2] - 68], mat: 'accent', collide: false, tag: 'oldLintel' },
        ];
    },
  },
  {
    // Ohne Vorfeld liegt zwischen Ring und E1 wieder eine Lücke vor der 131 u hohen E1-Stirn.
    name: 'Vorfeld fehlt (Todesband an der Ausfahrt)',
    file: 'level2',
    physics: true,
    expect: /Ausfahrt hat Todesstreifen mit Auto-Hop/,
    mutate: (l) => (l.brushes = l.brushes.filter((b: BrushDef) => b.tag !== 'apron')),
  },
  {
    // Auffangfläche unter S0 abgesenkt: wer von E1 auf S0 fällt und nicht surft, stirbt wieder.
    name: 'S0-Auffangfläche fehlt (erste Surf-Berührung tödlich)',
    file: 'level2',
    physics: true,
    expect: /S0 fängt Nicht-Surfer nicht/,
    mutate: (l) => (l.brushes = l.brushes.map((b: BrushDef) => (b.tag === 's0Catch' && b.type === 'wedge' ? { ...b, min: shiftY(b.min, -2000), max: shiftY(b.max, -2000) } : b))),
  },
  {
    name: 'Rückweg aus der S0-Grube fehlt',
    file: 'level2',
    physics: true,
    expect: /Rückweg von der S0-Fläche nicht begehbar/,
    mutate: (l) => (l.brushes = l.brushes.filter((b: BrushDef) => b.tag !== 's0Back')),
  },
  {
    name: 'Folgerampe S2 zu hoch (Stirnfläche im Übergang)',
    file: 'level2',
    physics: true,
    expect: /Surf .*scheitert|Nahtstopp|Respawn CP2|Bot-Durchlauf/,
    mutate: (l) => (l.brushes = l.brushes.map((b: BrushDef) => (b.tag === 'surf2' && b.type === 'hull' ? { ...b, points: b.points.map((p) => shiftY(p, 200)) } : b))),
  },
  // ── Plan 007 ─────────────────────────────────────────────────────────────
  {
    // Kante 0.5 u unter der Reichweite ohne Ducken (Repo-Physik ≈ 63.2 u, Phase 0 ≈ 58.2 u): die grobe
    // Level-Probe (153 Läufe) muss die Schwelle treffen, nicht nur eine 40-u-Kante.
    name: 'Crouch-Kante knapp unter der Reichweite (ohne Ducken erreichbar)',
    file: 'level1',
    physics: true,
    expect: /Crouch-Kante .*ohne Ducken erreichbar/,
    mutate: (l) => setCrouchEdge(l, (reach) => reach - 0.5),
  },
  {
    // 1 u über der Reichweite: heute dicht, aber unter CROUCH_RESERVE — der nächste Tuning-Schritt kippt sie.
    name: `Crouch-Kante mit Reserve < ${CROUCH_RESERVE} u`,
    file: 'level1',
    physics: true,
    expect: /Crouch-Kante .*Reserve -?\d+\.\d u < /,
    mutate: (l) => setCrouchEdge(l, (reach) => reach + 1),
  },
  {
    // 60° Bande fehlen auf der ersten Umdrehung: Geradeaus-Hüpfer fallen von der Wendel.
    name: 'Bande-Lücke (Wendel)',
    file: 'tower',
    physics: true,
    expect: /Turm-Bande hält nicht/,
    mutate: (l) => (l.brushes = l.brushes.filter((b: BrushDef) => !/^board-e1#([5-9]|1[0-4])$/.test(b.tag ?? ''))),
  },
  {
    // CP2-Trigger ohne Höhenbegrenzung: er reicht eine Etage tiefer, die Route durchquert ihn schon am Start.
    name: 'Schatten-Knoten (gestapelte Route)',
    file: 'tower',
    expect: /Schatten-Knoten/,
    mutate: (l) => (l.triggers = l.triggers.map((t: TriggerDef) => (t.kind === 'checkpoint' && t.order === 2 ? { ...t, min: [t.min[0], -100, t.min[2]] } : t))),
  },
  {
    name: 'Lektion mit Medaillen (training + medals/parTime)',
    file: 'lesson',
    expect: /training zusammen mit medals\/parTime/,
    mutate: (l) => {
      l.medals = { bronze: 30, silver: 25, gold: 20, velocity: 18, author: 17 };
      l.parTime = 30;
    },
  },
  {
    name: 'Lektion: Stufe öffnet ein unbekanntes Tor',
    file: 'lesson',
    expect: /opens verweist auf unbekanntes Tor/,
    mutate: (l) => {
      const t = l.training;
      if (t) l.training = { ...t, stages: t.stages.map((st) => (st.id === 'laufen' ? { ...st, opens: ['tuer'] } : st)) };
    },
  },
  {
    // Der HUD-Font kennt keinen Pfeil: "→" zeichnet als Kasten.
    name: 'Lektion: Zeichen ohne Glyphe im HUD-Font',
    file: 'lesson',
    expect: /Zeichen ohne Glyphe im HUD-Font: "→"/,
    mutate: (l) => {
      const t = l.training;
      if (t) l.training = { ...t, stages: t.stages.map((st) => (st.id === 'laufen' ? { ...st, text: 'W → LAUFEN\nMAUS = UMSEHEN' } : st)) };
    },
  },
  {
    // Die Lektionskarte hat zwei Zeilen à 40 Zeichen.
    name: 'Lektion: Stufentext länger als 40 Zeichen',
    file: 'lesson',
    expect: /Text Zeile mit \d+ Zeichen \(höchstens 40\)/,
    mutate: (l) => {
      const t = l.training;
      if (t) l.training = { ...t, stages: t.stages.map((st) => (st.id === 'laufen' ? { ...st, text: 'W HALTEN UND MIT DER MAUS IN DIE KURVE SCHAUEN' } : st)) };
    },
  },
];

export interface SelftestResult {
  readonly cases: number;
  readonly failed: number;
  readonly lines: string[];
}

export function runSelftest(): SelftestResult {
  const tower = towerFixture();
  const base: Record<CaseFile, LevelFile> = {
    level1: JSON.parse(readFileSync('public/levels/level1.json', 'utf8')) as LevelFile,
    level2: JSON.parse(readFileSync('public/levels/level2.json', 'utf8')) as LevelFile,
    tower: tower.def,
    lesson: lessonFixture(),
  };
  const probes = towerProbes(tower.helix);
  const clone = (f: CaseFile): Mutable => JSON.parse(JSON.stringify(base[f])) as Mutable;
  const lines: string[] = [];
  let failed = 0;
  for (const c of cases) {
    const l = clone(c.file);
    c.mutate(l);
    const r = validateLevel(c.name, l, { physics: c.physics === true, ...(c.file === 'tower' ? { probes } : {}) });
    const hit = [...r.errors, ...r.warnings].find((e) => c.expect.test(e));
    if (!hit) failed++;
    lines.push(`${hit ? '✓' : '✗'} ${c.name}: ${hit ?? `nicht erkannt (${r.errors.length} Fehler: ${r.errors.slice(0, 2).join(' | ')})`}`);
  }
  // Unverändert fehlerfrei: L1/L2 und Lektion statisch, der Turm mit Physik (Wiedereinstieg auf der richtigen Etage).
  const clean: ReadonlyArray<readonly [CaseFile, boolean]> = [
    ['level1', false],
    ['level2', false],
    ['tower', true],
    ['lesson', false],
  ];
  for (const [f, physics] of clean) {
    const r = validateLevel(f, clone(f), { physics, ...(f === 'tower' ? { probes } : {}) });
    if (r.errors.length) failed++;
    lines.push(`${r.errors.length ? '✗' : '✓'} ${f} unverändert (${physics ? 'Physik' : 'statisch'}): ${r.errors.length} Fehler${r.errors.length ? ` — ${r.errors.slice(0, 3).join(' | ')}` : ''}`);
  }
  return { cases: cases.length + clean.length, failed, lines };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = runSelftest();
  for (const l of r.lines) console.log(l);
  console.log(r.failed ? `✗ ${r.failed} Fälle durchgerutscht` : `✓ alle ${r.cases} Fälle erkannt`);
  if (r.failed) process.exitCode = 1;
}
