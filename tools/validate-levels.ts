/**
 * Level-Validator (`npm run levels:check`).
 *
 * Prüft alle Level aus public/levels/index.json plus sandbox.json in zwei Stufen:
 *
 * 1. Statisch: Kompilierung, Spawn/Checkpoints frei und auf Boden, Trigger,
 *    killY, Kill-Zonen (nicht zu nah unter Fahrflächen, nicht auf der Route),
 *    Z-Fighting, Deko-Überschneidungen und die Route: jedes Sprung-Knotenpaar
 *    muss bei minSpeed (sonst 250) mit ≥ 10 % Reserve ballistisch machbar
 *    sein, die Flugbahn darf nirgends anstoßen, und bei 1.2 × minSpeed wird
 *    das Überschießen gemeldet (wer schneller ist, soll nicht stark bremsen).
 * 2. Physik (echte PlayerMovement-Ticks, tools/levels/physics.ts):
 *    RouteFollower-Durchlauf mit Sync 1.0 und 0.8 bis ins Ziel; ab jedem
 *    Checkpoint-Spawn aus dem Stand bis zum nächsten Checkpoint (Bot, und bei
 *    Surf-Abschnitten zusätzlich ein Grundtechnik-Surfer); Surf-Raster über
 *    Einstiegstempo, Tiefe und Blickfehler mit Nahtstopp-Erkennung; die
 *    Design-Proben der Level (tools/levels/designProbes.ts); Crouch-Kanten ohne
 *    Ducken (Fehler) und ihre Reserve zur Reichweite der Config (Warnung); der
 *    perfekte Bot über 49 Start-Jitter — zerfällt er in zwei Zweige, ist der
 *    Medaillen-Median von build.ts nicht belastbar (Warnung).
 *
 * Zum Schluss prüft der Selbsttest (tools/levels/selftest.ts), dass der
 * Validator eingebaute Fehler findet.
 *
 * Gabeln (Plan 007, `LevelFile.safeRoute`): beide Linien laufen durch Route- und
 * Physik-Stufe (Berichtszeilen mit [route] / [safeRoute]). Surf-Raster, Surf-Übergang
 * bei 320 u/s und Respawn-Surfer sind auf safeRoute Fehler, auf route nur Warnung —
 * die schnelle Linie darf riskant sein. RouteFollower sync 1.0/0.8 bleiben auf beiden
 * Pflicht. Par/Bronze kommen von der sicheren Linie. Ohne safeRoute ist der Bericht
 * zeilengleich zu vorher.
 *
 * Lektionen (Plan 007, `LevelFile.training`, public/levels/training/): statt Start/Ziel
 * und Medaillen prüft der Validator den Lektions-Vertrag (IDs, Referenzen, Textlängen,
 * Stufen-Spawns) und ruft für die Physik tools/levels/training/check.ts.
 *
 * Route-Flags (LevelFormat.RouteNode, siehe .docs/research/level-design.md):
 * - `jump`: an diesem Knoten abspringen, Flug bis zum nächsten Knoten.
 * - `crouch`: Crouch-Jump (Füße +18 u in der Luft).
 * - `surf`: Knoten an einer Surf-Flanke (kein Boden). Surf-Abschnitte ergeben
 *   sich geometrisch (physics.surfSectionStarts: neuer Abschnitt an jedem Drop).
 * - `air`: Luftknoten (Abrollen/Launch ohne Sprung).
 * - `precision`: Präzisionsziel — der Sprung dorthin ist vom Überschieß-Band
 *   ausgenommen (zu schnell → bremsen ist dort gewollt).
 * `note` ist reiner Freitext für Reports.
 *
 * Filter `levels:check -- <id>|<datei>|training …`: jedes Argument muss ein Level oder eine Lektion
 * treffen (auch ohne Index-Eintrag, wie `levels:build -- <id>` sie schreibt), sonst Fehler.
 *
 * Exit-Code 1 bei Fehlern, Warnungen allein lassen den Check grün.
 */
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Vector3 } from 'three';
import { VERDICTS } from '../src/engine/trainingTypes';
import { VELOCITY_DEFAULT, type MovementConfig } from '../src/player/MovementConfig';
import { PlayerMovement } from '../src/player/PlayerMovement';
import { makeBotInput, runRoute } from '../src/player/bots';
import { BrushWorld } from '../src/world/collision/BrushWorld';
import { compileBrush, compileLevel } from '../src/world/level/compileLevel';
import type { CompiledLevel } from '../src/world/level/compileLevel';
import type { LevelFile, LevelIndexEntry, RouteNode, TaskDef, TrainingIndexEntry } from '../src/world/level/LevelFormat';
import type { BrushFace, CollisionWorld } from '../src/world/collision/types';
import type { MutablePlayerInput } from '../src/player/types';
import { hasGlyph } from '../src/ui/glyphs';
import { MIN_GROUND_NORMAL_Y } from '../src/world/collision/types';
import { OVERSHOOT, PHYS, RESERVE, airTime } from './levels/ballistics';
import { LEVELS, MEDAL_MAX_STEP, MEDAL_MIN_STEP, medalSteps } from './levels/build';
import { designProbes, type DesignReport } from './levels/designProbes';
import { checkTrainingLevel } from './levels/training/check';
import { isParallelogram } from '../src/render/trims';
import {
  SURF_GRID,
  configKey,
  describeBranches,
  isAirNode,
  isSurfNode,
  nodeInTrigger,
  recordRoute,
  resumeIndex,
  respawnRun,
  respawnSurf,
  sectionFromStart,
  jitterMedian,
  medianOf,
  surfGrid,
  timedMedian,
  withRoute,
  type StrafeModel,
} from './levels/physics';

const LEVEL_DIR = 'public/levels';
const DEFAULT_SPEED = 250;
/**
 * Kill-Zonen liegen mindestens so tief unter jeder Fahrfläche darüber: Hull-Höhe (72)
 * plus Luft — wer auf der Fläche steht, surft oder knapp von der Kante fällt
 * (Coyote), berührt die Zone nie. Meine Level halten ≥ 250.
 */
const KILL_CLEARANCE = 128;
/** Par höchstens so viel über der 3°-Hand (Median), sonst ist die Ansage bedeutungslos. */
const PAR_SLACK_MAX = 1.25;

const STAND_MINS = new Vector3(-PHYS.hullHalf, 0, -PHYS.hullHalf);
const STAND_MAXS = new Vector3(PHYS.hullHalf, PHYS.standHeight, PHYS.hullHalf);
const DUCK_MAXS = new Vector3(PHYS.hullHalf, PHYS.duckHeight, PHYS.hullHalf);
/** Dünne Sonde für "Boden unter der Mitte" (strenger als die Hull). */
const PROBE_MINS = new Vector3(-4, 0, -4);
const PROBE_MAXS = new Vector3(4, 4, 4);

export interface Report {
  readonly name: string;
  readonly errors: string[];
  readonly warnings: string[];
  readonly info: string[];
}

export interface ValidateOptions {
  /** Physik-Stufe (Bot-Durchläufe, Respawns, Surf-Raster, Design-Proben). Default true. */
  readonly physics?: boolean;
  /**
   * Zusätzliche Design-Proben (nach designProbes, nur mit Physik) — für Levels, deren Proben nicht
   * über die id laufen: Selbsttest-Attrappen, Prototypen, die ein Strang vor dem Einbau misst.
   */
  readonly probes?: (level: CompiledLevel, cfg: MovementConfig) => DesignReport;
}

/**
 * Welche Bot-Linie gerade geprüft wird. Ohne safeRoute gibt es nur MAIN_LINE (ohne Präfix,
 * Surf-Prüfungen sind Fehler) — der Bericht bleibt zeilengleich zu vor Plan 007.
 */
interface LineMode {
  /** Präfix jeder Berichtszeile dieser Linie ('' ohne Gabel). */
  readonly tag: string;
  /** Surf-Raster, Surf-Übergang bei 320 u/s, Respawn-Surfer: Fehler (true) oder Warnung. */
  readonly surfErrors: boolean;
  /** Level-weite Proben (designProbes, Zusatz-Proben) nur einmal, mit der Hauptlinie. */
  readonly main: boolean;
}

const MAIN_LINE: LineMode = { tag: '', surfErrors: true, main: true };

function fmt(n: number, d = 0): string {
  return n.toFixed(d);
}

interface XYZ {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

function fmtV(v: Vector3 | readonly number[] | XYZ): string {
  const a: readonly number[] = v instanceof Vector3 ? v.toArray() : 'x' in v ? [v.x, v.y, v.z] : v;
  return `(${a.map((x) => fmt(x)).join(', ')})`;
}

// ---------------------------------------------------------------------------
// Boden-/Trace-Helfer


/** Begehbarer Boden direkt unter `pos` (Hull, bis `down` u tiefer)? Liefert Bodenhöhe oder null. */
function groundBelow(world: CollisionWorld, pos: Vector3, down: number, mins = STAND_MINS, maxs = STAND_MAXS, lift = 1): number | null {
  const start = new Vector3(pos.x, pos.y + lift, pos.z);
  const end = new Vector3(pos.x, pos.y - down, pos.z);
  const tr = world.traceBox(start, end, mins, maxs);
  if (tr.startSolid || tr.fraction >= 1) return null;
  if (tr.normal.y < MIN_GROUND_NORMAL_Y) return null;
  return tr.endPos.y;
}

/** Hull an pos frei? Prüft minimal angehoben, weil exakter Bodenkontakt als "im Solid" zählt. */
function hullFree(world: CollisionWorld, pos: Vector3, maxs = STAND_MAXS): boolean {
  return !world.testBox(new Vector3(pos.x, pos.y + 1, pos.z), STAND_MINS, maxs);
}

function checkStandPoint(world: CollisionWorld, pos: Vector3, what: string, r: Report): void {
  if (!hullFree(world, pos)) {
    r.errors.push(`${what} ${fmtV(pos)}: Stand-Hull steckt im Solid`);
    return;
  }
  const g = groundBelow(world, pos, 4);
  if (g === null) r.errors.push(`${what} ${fmtV(pos)}: kein begehbarer Boden innerhalb 4 u darunter`);
  else if (groundBelow(world, pos, 4, PROBE_MINS, PROBE_MAXS) === null)
    r.warnings.push(`${what} ${fmtV(pos)}: Mitte steht über der Kante (nur die Hull-Ecke trägt)`);
  else {
    // Spawns gehören mitten auf die Fläche: unter jeder Hull-Ecke (4 u eingerückt) liegt
    // Boden — 24 u tief gesucht, damit geneigte Flächen (Ring, E1) nicht als Kante gelten.
    const e = PHYS.hullHalf - 4;
    const free = [[-e, -e], [e, -e], [-e, e], [e, e]].filter(([dx, dz]) => groundBelow(world, new Vector3(pos.x + dx, pos.y, pos.z + dz), 24, PROBE_MINS, PROBE_MAXS) === null);
    if (free.length) r.warnings.push(`${what} ${fmtV(pos)}: steht an einer Kante (${free.length} Hull-Ecke(n) ohne Boden)`);
  }
}

// ---------------------------------------------------------------------------
// Z-Fighting: koplanare, gleich orientierte Flächen verschiedener Brushes mit Überlappung

interface FaceRef {
  readonly brush: number;
  readonly tag: string | null;
  readonly face: BrushFace;
}

function checkZFighting(level: CompiledLevel, r: Report): void {
  const faces: FaceRef[] = [];
  // Unsichtbare Clips werden nicht gerendert, Bodenmarkierungen liegen als Leuchtfläche
  // (Trim-Pipeline, polygonOffset) auf ihrer Fläche — beide können nicht flimmern.
  for (const b of level.brushes) if (b.visible && b.mat !== 'marking') for (const f of b.faces) faces.push({ brush: b.index, tag: b.tag, face: f });
  // Grob nach Normale bucketen (auch die Nachbar-Buckets zählen); innerhalb exakt prüfen.
  const buckets = new Map<string, FaceRef[]>();
  const keyOf = (x: number, y: number, z: number): string => `${x},${y},${z}`;
  for (const f of faces) {
    const n = f.face.normal;
    const key = keyOf(Math.round(n.x * 50), Math.round(n.y * 50), Math.round(n.z * 50));
    let list = buckets.get(key);
    if (!list) buckets.set(key, (list = []));
    list.push(f);
  }
  let found = 0;
  const seen = new Set<string>();
  for (const [key, list] of buckets) {
    const [kx, ky, kz] = key.split(',').map(Number);
    const others: FaceRef[] = [];
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) others.push(...(buckets.get(keyOf(kx + dx, ky + dy, kz + dz)) ?? []));
    for (const a of list) {
      for (const b of others) {
        if (a.brush === b.brush) continue;
        const pair = a.brush < b.brush ? `${a.brush}|${b.brush}|${a.face.plane.dist.toFixed(2)}` : `${b.brush}|${a.brush}|${b.face.plane.dist.toFixed(2)}`;
        if (a.face.normal.dot(b.face.normal) < 0.9999) continue;
        if (Math.abs(a.face.plane.dist - b.face.plane.dist) > 0.05) continue;
        if (seen.has(pair)) continue;
        const area = overlapArea(a.face, b.face);
        if (area > 1) {
          seen.add(pair);
          found++;
          if (found <= 12)
            r.errors.push(
              `Z-Fighting: Brush #${a.brush}${a.tag ? ` (${a.tag})` : ''} und #${b.brush}${b.tag ? ` (${b.tag})` : ''} ` +
                `teilen ${fmt(area)} u² koplanare Fläche, Normale ${fmtV(a.face.normal.clone().multiplyScalar(100))}/100`,
            );
        }
      }
    }
  }
  if (found > 12) r.errors.push(`Z-Fighting: … ${found - 12} weitere`);
}

/**
 * Deko (collide:false), die in begehbare Geometrie ragt, sieht aus wie ein
 * Hindernis, ist aber keins — oder steckt sichtbar durch die Fahrbahn.
 * Exakt für achsparallele Deko (testBox der um 0.5 u geschrumpften AABB).
 * Geprüft gegen die SICHTBARE Kollision: Deko unter einem unsichtbaren Clip ist
 * gewollt (Treppe als Optik, der Clip trägt).
 */
function checkDecoIntersections(level: CompiledLevel, r: Report): void {
  const world = new BrushWorld(level.brushes.filter((b) => b.visible));
  let found = 0;
  for (const b of level.brushes) {
    if (b.collide || b.mat === 'marking') continue;
    const size = b.bounds.getSize(new Vector3());
    if (size.x < 1.5 || size.y < 1.5 || size.z < 1.5) continue;
    const c = b.bounds.getCenter(new Vector3());
    const half = size.clone().multiplyScalar(0.5).subScalar(0.5);
    const pos = new Vector3(c.x, b.bounds.min.y + 0.5, c.z);
    const mins = new Vector3(-half.x, 0, -half.z);
    const maxs = new Vector3(half.x, size.y - 1, half.z);
    if (world.testBox(pos, mins, maxs)) {
      found++;
      if (found <= 8) r.warnings.push(`Deko ${brushName(level, b.index)} schneidet Kollisionsgeometrie (Bounds ${fmtV(b.bounds.min)} … ${fmtV(b.bounds.max)})`);
    }
  }
  if (found > 8) r.warnings.push(`Deko: … ${found - 8} weitere Überschneidungen`);
}

/**
 * Bodenmarkierungen (mat 'marking'): ohne Kollision, Oberseite ein Parallelogramm
 * (trims.ts malt genau eines), und sie liegt auf einer sichtbaren Fläche — unter
 * ihrer Mitte ist innerhalb 1 u Boden oder Surf-Flanke. Sonst schwebt ein Pfeil in
 * der Luft oder verschwindet im Boden.
 */
function checkMarkings(level: CompiledLevel, r: Report): void {
  const marks = level.brushes.filter((b) => b.mat === 'marking');
  if (!marks.length) return;
  const solid = new BrushWorld(level.brushes.filter((b) => b.collide && b.visible));
  const bad: string[] = [];
  const probe = new Vector3(0.5, 0.5, 0.5);
  for (const b of marks) {
    const name = brushName(level, b.index);
    if (b.collide) bad.push(`${name}: kollidiert`);
    const top = b.faces.reduce((best, f) => (f.normal.y > best.normal.y ? f : best), b.faces[0]);
    if (!top || top.normal.y <= 0.05 || !isParallelogram(top.vertices)) {
      bad.push(`${name}: Oberseite ist kein Parallelogramm`);
      continue;
    }
    const c = new Vector3();
    for (const v of top.vertices) c.add(v);
    c.multiplyScalar(1 / top.vertices.length);
    const above = c.clone().addScaledVector(top.normal, 1);
    const below = c.clone().addScaledVector(top.normal, -1);
    if (solid.testBox(above, probe.clone().negate(), probe)) bad.push(`${name}: steckt in Geometrie`);
    else if (!solid.testBox(below, probe.clone().negate(), probe)) bad.push(`${name}: schwebt (keine Fläche 1 u darunter)`);
  }
  if (bad.length) r.errors.push(`Bodenmarkierung: ${bad.slice(0, 4).join('; ')}${bad.length > 4 ? ` … ${bad.length - 4} weitere` : ''}`);
  else r.info.push(`Bodenmarkierungen: ${marks.length}, alle liegen auf`);
}

/**
 * Kill-Zonen: kein Route-Knoten, kein Spawn darin; jede Fahrfläche (begehbar
 * oder Surf), deren Grundriss die Zone überlappt, liegt ≥ KILL_CLEARANCE darüber.
 * Flächen ganz innerhalb der Zone sind gewollte Todesböden (Sandbox: "catch").
 */
function checkKillZones(level: CompiledLevel, r: Report): void {
  const kills = level.triggers.filter((t) => t.kind === 'kill');
  for (const k of kills) {
    const name = `Kill-Zone ${k.tag ?? ''}`;
    const kb = k.bounds;
    for (const [i, n] of (level.def.route ?? []).entries()) {
      const p = new Vector3(...n.pos);
      if (kb.containsPoint(p) || kb.containsPoint(p.clone().setY(p.y + PHYS.standHeight))) r.errors.push(`${name} enthält Route-Knoten ${i} ${fmtV(p)}`);
    }
    for (const [i, n] of (level.def.safeRoute ?? []).entries()) {
      const p = new Vector3(...n.pos);
      if (kb.containsPoint(p) || kb.containsPoint(p.clone().setY(p.y + PHYS.standHeight))) r.errors.push(`${name} enthält safeRoute-Knoten ${i} ${fmtV(p)}`);
    }
    const spawns = [level.spawnPos, ...level.triggers.filter((t) => t.kind === 'checkpoint').map((t) => t.spawnPos)];
    for (const s of spawns) if (kb.containsPoint(s)) r.errors.push(`${name} enthält einen Spawn ${fmtV(s)}`);
    let worst = Infinity;
    let worstTag = '';
    for (const b of level.brushes) {
      if (!b.collide) continue;
      for (const f of b.faces) {
        if (!f.walkable && !f.surf) continue;
        let x0 = Infinity;
        let x1 = -Infinity;
        let z0 = Infinity;
        let z1 = -Infinity;
        let y0 = Infinity;
        let y1 = -Infinity;
        for (const v of f.vertices) {
          x0 = Math.min(x0, v.x);
          x1 = Math.max(x1, v.x);
          z0 = Math.min(z0, v.z);
          z1 = Math.max(z1, v.z);
          y0 = Math.min(y0, v.y);
          y1 = Math.max(y1, v.y);
        }
        if (y1 <= kb.max.y) continue;
        if (x1 <= kb.min.x || x0 >= kb.max.x || z1 <= kb.min.z || z0 >= kb.max.z) continue;
        const gap = y0 - kb.max.y;
        if (gap < worst) {
          worst = gap;
          worstTag = brushName(level, b.index);
        }
      }
    }
    if (worst < KILL_CLEARANCE) r.errors.push(`${name}: Oberkante nur ${fmt(worst)} u unter Fahrfläche ${worstTag} (Soll ≥ ${KILL_CLEARANCE})`);
  }
  if (kills.length) r.info.push(`Kill-Zonen: ${kills.length} (${kills.map((k) => k.tag ?? '?').join(', ')})`);
}

type P2 = readonly [number, number];

function overlapArea(a: BrushFace, b: BrushFace): number {
  const n = a.normal;
  const u = Math.abs(n.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
  u.cross(n).normalize();
  const v = new Vector3().crossVectors(n, u);
  const proj = (pts: readonly Vector3[]): P2[] => ccw(pts.map((p) => [p.dot(u), p.dot(v)] as const));
  const clipped = clipConvex(proj(a.vertices), proj(b.vertices));
  return Math.abs(polyArea(clipped));
}

function polyArea(p: readonly P2[]): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const [x0, y0] = p[i];
    const [x1, y1] = p[(i + 1) % p.length];
    s += x0 * y1 - x1 * y0;
  }
  return s / 2;
}

function ccw(p: P2[]): P2[] {
  return polyArea(p) < 0 ? p.reverse() : p;
}

/** Sutherland–Hodgman: subject ∩ clip (beide konvex, CCW). */
function clipConvex(subject: readonly P2[], clip: readonly P2[]): P2[] {
  let out: P2[] = [...subject];
  for (let i = 0; i < clip.length && out.length > 0; i++) {
    const [ax, ay] = clip[i];
    const [bx, by] = clip[(i + 1) % clip.length];
    const side = (p: P2): number => (bx - ax) * (p[1] - ay) - (by - ay) * (p[0] - ax);
    const input = out;
    out = [];
    for (let k = 0; k < input.length; k++) {
      const cur = input[k];
      const prev = input[(k + input.length - 1) % input.length];
      const sc = side(cur);
      const sp = side(prev);
      if (sc >= -1e-6) {
        if (sp < -1e-6) out.push(intersect(prev, cur, sp, sc));
        out.push(cur);
      } else if (sp >= -1e-6) {
        out.push(intersect(prev, cur, sp, sc));
      }
    }
  }
  return out;
}

function intersect(p: P2, q: P2, sp: number, sq: number): P2 {
  const t = sp / (sp - sq);
  return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
}

// ---------------------------------------------------------------------------
// Route: Sprünge, Laufstrecken, Checkpoint-Reihenfolge

type ArcResult =
  | { readonly kind: 'land'; readonly pos: Vector3; readonly brush: number; readonly t: number }
  | { readonly kind: 'surf'; readonly pos: Vector3; readonly t: number }
  | { readonly kind: 'block'; readonly pos: Vector3; readonly normal: Vector3; readonly brush: number; readonly t: number }
  | { readonly kind: 'miss'; readonly pos: Vector3 };

/**
 * Parabel von a in Richtung dir mit Horizontalgeschwindigkeit u abfliegen
 * (8 Segmente bis T, danach weiter bis 2·T), Hull mitschieben.
 */
function traceArc(
  world: CollisionWorld,
  a: Vector3,
  dir: Vector3,
  u: number,
  vy0: number,
  T: number,
  crouch: boolean,
  allowSurf: boolean,
  fromSurface = false,
): ArcResult {
  const lift = crouch ? PHYS.duckLift : 0;
  const maxs = crouch ? DUCK_MAXS : STAND_MAXS;
  const g = PHYS.gravity;
  const at = (t: number): Vector3 =>
    new Vector3(a.x + dir.x * u * t, a.y + 0.5 + lift + vy0 * t - 0.5 * g * t * t, a.z + dir.z * u * t);
  const segs = 8;
  // 8 Segmente bis T, danach weiter bis 2·T (fängt Landungen hinter/unter dem Ziel ab).
  const times: number[] = [];
  for (let i = 0; i <= segs * 2; i++) times.push((T * i) / segs);
  // Abflug von einer Fläche: die Sehne des ersten Segments läge unter der Parabel
  // und schnitte die eigene Rampe — erst ein kurzes Stück (24 u) exakt fliegen.
  if (fromSurface && u > 0 && 24 / u < times[1]) times.splice(1, 0, 24 / u);
  for (let i = 0; i + 1 < times.length; i++) {
    const t0 = times[i];
    const t1 = times[i + 1];
    const p0 = at(t0);
    const p1 = at(t1);
    const tr = world.traceBox(p0, p1, STAND_MINS, maxs);
    if (tr.startSolid && i === 0) return { kind: 'block', pos: p0, normal: tr.normal.clone(), brush: tr.brushIndex, t: t0 };
    if (tr.fraction < 1) {
      const t = t0 + (t1 - t0) * tr.fraction;
      if (tr.normal.y >= MIN_GROUND_NORMAL_Y) return { kind: 'land', pos: tr.endPos.clone(), brush: tr.brushIndex, t };
      if (allowSurf && tr.normal.y > 0.05) return { kind: 'surf', pos: tr.endPos.clone(), t };
      return { kind: 'block', pos: tr.endPos.clone(), normal: tr.normal.clone(), brush: tr.brushIndex, t };
    }
  }
  return { kind: 'miss', pos: at(2 * T) };
}

function brushName(level: CompiledLevel, i: number): string {
  const b = level.brushes[i];
  return b ? `#${i}${b.tag ? ` (${b.tag})` : ''}` : `#${i}`;
}

interface JumpStats {
  minMargin: number;
  worst: string;
  overshoot: number;
}

/**
 * Steigung der Surf-Flanke unter `a` in Flugrichtung (dy pro u horizontal).
 * Wer eine fallende Rampe verlässt, fliegt mit diesem Gefälle weiter — nicht waagerecht.
 */
function surfSlopeAlong(world: CollisionWorld, a: Vector3, dir: Vector3): number {
  const tr = world.traceBox(new Vector3(a.x, a.y + 1, a.z), new Vector3(a.x, a.y - 96, a.z), STAND_MINS, STAND_MAXS);
  const n = tr.normal;
  if (tr.fraction >= 1 || !(n.y > 0.05 && n.y < MIN_GROUND_NORMAL_Y)) return 0;
  return -(n.x * dir.x + n.z * dir.z) / n.y;
}

function checkJumpPair(level: CompiledLevel, i: number, A: RouteNode, B: RouteNode, r: Report, stats: JumpStats): void {
  const world = level.world;
  const label = `Route ${i}→${i + 1}`;
  const a = new Vector3(...A.pos);
  const b = new Vector3(...B.pos);
  const v = A.minSpeed ?? DEFAULT_SPEED;
  const crouch = A.crouch === true;
  const dir = new Vector3(b.x - a.x, 0, b.z - a.z);
  const dAB = dir.length();
  if (dAB < 1) return;
  dir.divideScalar(dAB);
  const aSurf = !A.jump && isSurfNode(A);
  const vy0 = A.jump ? PHYS.jumpImpulse : aSurf ? v * surfSlopeAlong(world, a, dir) : 0;
  const drop = a.y - b.y;
  const T = airTime(drop, crouch, vy0);
  if (!Number.isFinite(T)) {
    r.errors.push(`${label}: ${fmt(-drop)} u hoch ist mit ${crouch ? 'Crouch-' : ''}Sprung nicht erreichbar`);
    return;
  }
  const bSurf = isSurfNode(B) || isAirNode(B);

  // Landekante: von B rückwärts, solange Boden auf B-Höhe durchgeht.
  let lip = dAB;
  let bBrush = -1;
  if (!bSurf) {
    const land = crouch ? DUCK_MAXS : STAND_MAXS;
    if (groundBelow(world, b, 6, STAND_MINS, land) === null) {
      r.errors.push(`${label}: Zielknoten ${fmtV(b)} hat keinen Boden`);
      return;
    }
    bBrush = world.traceBox(new Vector3(b.x, b.y + 1, b.z), new Vector3(b.x, b.y - 6, b.z), STAND_MINS, land).brushIndex;
    // Landbar ist Boden zwischen Absprung- und Zielhöhe: lückenloses Gefälle
    // (bergab wie bergauf) zählt mit — die Lücke ist nur echte Leere davor.
    const hiY = Math.max(a.y, b.y) + 8;
    const loY = Math.min(a.y, b.y) - 6;
    for (let s = dAB; s >= 0; s -= 4) {
      const p = new Vector3(a.x + dir.x * s, b.y, a.z + dir.z * s);
      const gy = groundBelow(world, p, b.y - loY, STAND_MINS, land, hiY - b.y);
      if (gy === null || gy < loY) break;
      lip = s;
    }
  }
  const range = v * T;
  const need = lip * RESERVE;
  const margin = lip > 1 ? range / lip - 1 : Infinity;
  if (!bSurf && margin < stats.minMargin) {
    stats.minMargin = margin;
    stats.worst = `${label} (${A.note ?? ''})`;
  }
  const speedNeed = lip > 1 ? (lip * RESERVE) / T : 0;
  // Surf-/Luftziele haben keine Landekante; dort zählt nur die freie Flugbahn.
  if (!bSurf && need > range) {
    r.errors.push(
      `${label}${A.note ? ` [${A.note}]` : ''}: Flug ${fmt(lip)} u bis zur Landekante, Reichweite bei ${v} u/s nur ${fmt(range)} u ` +
        `(braucht ${fmt(speedNeed)} u/s mit 10 % Reserve, Höhe ${fmt(-drop)})`,
    );
  }

  // Flugbahnen: exakt auf B passend, mit minSpeed und im Überschieß-Band
  // (1.2 × minSpeed). Surf-Ausgänge haben kein frei wählbares Tempo (vy hängt
  // am Tempo) — dort nur die minSpeed-Bahn.
  const uFit = dAB / T;
  const curves: Array<{ name: string; u: number; fit: boolean; band: boolean }> = aSurf ? [] : [{ name: 'Passbahn', u: uFit, fit: true, band: false }];
  if (aSurf || v > uFit * 1.02) curves.push({ name: `Bahn bei ${v} u/s`, u: v, fit: false, band: false });
  // Präzisionsziele (B.precision) verlangen Tempokontrolle: kein Überschieß-Band.
  if (A.jump && !bSurf && !B.precision) curves.push({ name: `Band ${OVERSHOOT}× (${fmt(v * OVERSHOOT)} u/s)`, u: v * OVERSHOOT, fit: false, band: true });
  for (const c of curves) {
    const res = traceArc(world, a, dir, c.u, vy0, T, crouch, bSurf || !c.fit, aSurf);
    switch (res.kind) {
      case 'block':
        // Im Band ist ein Aufprall an der nächsten Kante kein Bau-, sondern ein Rhythmusfehler: melden, nicht blockieren.
        (c.band ? r.warnings : r.errors).push(
          `${label}: ${c.name} stößt bei t=${fmt(res.t, 2)} s an ${brushName(level, res.brush)} ${fmtV(res.pos)} ` +
            `(Normale ${fmtV(res.normal.clone().multiplyScalar(100))}/100)`,
        );
        if (c.band) stats.overshoot++;
        break;
      case 'surf':
        // Schneller als geplant auf der nächsten Surf-Flanke zu landen ist kein Absturz.
        if (!bSurf && !c.band) r.warnings.push(`${label}: ${c.name} fliegt über das Ziel hinaus auf eine Surf-Flanke ${fmtV(res.pos)}`);
        break;
      case 'land':
        // Auf derselben (schrägen) Fläche weiter unten oder auf einer späteren Plattform zu landen ist normal.
        if (!bSurf && !c.band && res.brush !== bBrush && Math.abs(res.pos.y - b.y) > 8)
          r.warnings.push(`${label}: ${c.name} landet auf ${brushName(level, res.brush)} in Höhe ${fmt(res.pos.y)} statt ${fmt(b.y)}`);
        // Weiter unten auf derselben (schrägen) Zielfläche zu landen ist kein Überschießen.
        if (c.band && res.brush !== bBrush && res.pos.y < Math.min(a.y, b.y) - 40) {
          r.warnings.push(`${label}: ${c.name} landet ${fmt(Math.min(a.y, b.y) - res.pos.y)} u tiefer auf ${brushName(level, res.brush)} — wer schneller ist, muss bremsen`);
          stats.overshoot++;
        }
        break;
      case 'miss':
        if (bSurf) break;
        if (c.fit) r.errors.push(`${label}: Passbahn findet keinen Boden bei ${fmtV(b)}`);
        else if (aSurf) r.errors.push(`${label}: Surf-Ausgang bei ${v} u/s verfehlt die Landefläche (${fmtV(res.pos)})`);
        else {
          r.warnings.push(`${label}: ${c.name} überschießt die Landefläche (${fmtV(res.pos)}) — wer schneller ist, muss bremsen`);
          if (c.band) stats.overshoot++;
        }
        break;
    }
  }
}

/**
 * Surf → Surf (Übergang zwischen Rampen): ballistisch mit dem Plantempo und
 * dem Flankengefälle des Absprungs. Eine Stirn-/Seitenfläche im Weg ist ein
 * Fehler; wie weit man danach auf der Folgerampe trägt, prüft die Physik-Stufe.
 */
function checkSurfPair(level: CompiledLevel, i: number, A: RouteNode, B: RouteNode, r: Report, mode: LineMode): void {
  const world = level.world;
  const a = new Vector3(...A.pos);
  const b = new Vector3(...B.pos);
  const dir = new Vector3(b.x - a.x, 0, b.z - a.z);
  const d = dir.length();
  if (d < 1) return;
  dir.divideScalar(d);
  [A.minSpeed ?? DEFAULT_SPEED, 320].forEach((v, k) => {
    const vy0 = v * surfSlopeAlong(world, a, dir);
    const T = d / v;
    const res = traceArc(world, a, dir, v, vy0, T, false, true, true);
    // Der Übergang bei 320 u/s (Einstieg aus dem Stand) ist auf der schnellen Linie einer Gabel nur eine Warnung.
    if (res.kind === 'block')
      (k === 1 && !mode.surfErrors ? r.warnings : r.errors).push(
        `Route ${i}→${i + 1} (Surf-Übergang, ${v} u/s): stößt bei t=${fmt(res.t, 2)} s an ${brushName(level, res.brush)} ${fmtV(res.pos)} ` +
          `(Normale ${fmtV(res.normal.clone().multiplyScalar(100))}/100)`,
      );
  });
}

function checkWalk(level: CompiledLevel, i: number, A: RouteNode, B: RouteNode, r: Report): void {
  const a = new Vector3(...A.pos);
  const b = new Vector3(...B.pos);
  const d = Math.hypot(b.x - a.x, b.z - a.z);
  const steps = Math.max(1, Math.ceil(d / 16));
  for (let k = 0; k <= steps; k++) {
    const p = a.clone().lerp(b, k / steps);
    const tr = level.world.traceBox(new Vector3(p.x, p.y + 24, p.z), new Vector3(p.x, p.y - 40, p.z), PROBE_MINS, PROBE_MAXS);
    if (tr.startSolid || tr.fraction >= 1 || tr.normal.y < MIN_GROUND_NORMAL_Y) {
      r.errors.push(`Route ${i}→${i + 1}: Laufstrecke ohne Boden bei ${fmtV(p)} (fehlt jump oder Flag air/surf?)`);
      return;
    }
  }
}

/** Schneidet die Strecke p→q die Box (um die Hull erweitert)? Slab-Test. */
function segmentHitsBox(p: Vector3, q: Vector3, min: Vector3, max: Vector3): boolean {
  let t0 = 0;
  let t1 = 1;
  const d = q.clone().sub(p);
  const lo = [min.x - PHYS.hullHalf, min.y - PHYS.standHeight, min.z - PHYS.hullHalf];
  const hi = [max.x + PHYS.hullHalf, max.y, max.z + PHYS.hullHalf];
  const ps = [p.x, p.y, p.z];
  const ds = [d.x, d.y, d.z];
  for (let k = 0; k < 3; k++) {
    if (Math.abs(ds[k]) < 1e-9) {
      if (ps[k] < lo[k] || ps[k] > hi[k]) return false;
      continue;
    }
    let ta = (lo[k] - ps[k]) / ds[k];
    let tb = (hi[k] - ps[k]) / ds[k];
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 > t1) return false;
  }
  return true;
}

function checkRoute(level: CompiledLevel, r: Report, mode: LineMode = MAIN_LINE): { length: number; time: number } {
  const route = level.def.route ?? [];
  if (route.length === 0) {
    r.info.push('keine Route');
    return { length: 0, time: 0 };
  }
  const world = level.world;
  // Knoten selbst
  route.forEach((n, i) => {
    const p = new Vector3(...n.pos);
    if (!hullFree(world, p) && !hullFree(world, p, DUCK_MAXS)) r.errors.push(`Route-Knoten ${i} ${fmtV(p)} steckt im Solid`);
    if (!isSurfNode(n) && !isAirNode(n) && groundBelow(world, p, 6, PROBE_MINS, PROBE_MAXS) === null && groundBelow(world, p, 6) === null)
      r.errors.push(`Route-Knoten ${i} ${fmtV(p)}${n.note ? ` [${n.note}]` : ''}: kein Boden (Flag surf/air für Luftknoten)`);
  });
  // Paare
  const stats: JumpStats = { minMargin: Infinity, worst: '', overshoot: 0 };
  let length = 0;
  let time = 0;
  let jumps = 0;
  for (let i = 0; i + 1 < route.length; i++) {
    const A = route[i];
    const B = route[i + 1];
    const d = Math.hypot(B.pos[0] - A.pos[0], B.pos[2] - A.pos[2]);
    length += d;
    time += d / Math.max(DEFAULT_SPEED, A.minSpeed ?? DEFAULT_SPEED);
    const aAir = isSurfNode(A) || isAirNode(A);
    const bAir = isSurfNode(B) || isAirNode(B);
    if (A.jump) {
      jumps++;
      checkJumpPair(level, i, A, B, r, stats);
    } else if (aAir && !bAir) {
      checkJumpPair(level, i, A, B, r, stats);
    } else if (aAir && bAir) {
      checkSurfPair(level, i, A, B, r, mode);
    } else if (!aAir && !bAir) {
      checkWalk(level, i, A, B, r);
    }
  }
  if (jumps > 0)
    r.info.push(
      `Sprünge: ${jumps}, knappste Reserve ${fmt(stats.minMargin * 100)} % bei ${stats.worst}; ` +
        `Überschieß-Band ${OVERSHOOT}×: ${stats.overshoot === 0 ? 'jede Landung hält' : `${stats.overshoot} Sprünge verlangen Bremsen`}`,
    );

  // Route muss Start → Checkpoints in Reihenfolge → Ziel durchlaufen.
  const pts = route.map((n) => new Vector3(...n.pos));
  const firstHit = (min: Vector3, max: Vector3): number => {
    for (let i = 0; i + 1 < pts.length; i++) if (segmentHitsBox(pts[i], pts[i + 1], min, max)) return i;
    return -1;
  };
  let last = -1;
  for (const t of level.triggers.filter((x) => x.kind === 'checkpoint')) {
    const hit = firstHit(t.bounds.min, t.bounds.max);
    if (hit < 0) r.errors.push(`Route berührt Checkpoint ${t.order} nicht`);
    else if (hit < last) r.errors.push(`Route berührt Checkpoint ${t.order} vor dem vorherigen`);
    else last = hit;
  }
  const fin = level.triggers.find((x) => x.kind === 'finish');
  if (fin && firstHit(fin.bounds.min, fin.bounds.max) < 0) r.errors.push('Route endet nicht im Ziel-Trigger');
  const start = level.triggers.find((x) => x.kind === 'start');
  if (start && !start.bounds.containsPoint(pts[0].clone().setY(pts[0].y + 1))) r.warnings.push('Route beginnt nicht im Start-Trigger');
  return { length, time };
}

// ---------------------------------------------------------------------------
// Physik-Stufe


/**
 * Bot-Modelle der Physik-Stufe. Pflicht: RouteFollower sync 1.0 und 0.8 (von
 * Start bis Ziel und ab jedem Checkpoint aus dem Stand). Info: der Anfänger-
 * Bot (sync 0.7) und die Menschenmodelle mit absolutem Zielfehler (CS2-
 * Parität, movement-tuning.md) — der Pflichtweg soll für eine 3°-Hand
 * schaffbar sein; scheitert sie, ist das eine Warnung.
 */
const BOT_MODELS: ReadonlyArray<{ readonly name: string; readonly model: StrafeModel; readonly level: 'error' | 'warning' | 'info' }> = [
  { name: 'sync 1.0', model: { sync: 1 }, level: 'error' },
  { name: 'sync 0.8', model: { sync: 0.8 }, level: 'error' },
  { name: 'Hand 2°', model: { aimNoiseDeg: 2 }, level: 'info' },
  { name: 'Hand 3°', model: { aimNoiseDeg: 3 }, level: 'warning' },
  { name: 'sync 0.7', model: { sync: 0.7 }, level: 'info' },
  // Gute Hände (Prüfung 27.09.): sie kommen schneller an als geplant und überschießen —
  // der L1-Slalom tötete Hand 1°/1.5° in 4 von 20 Läufen, ohne dass es hier auffiel.
  { name: 'sync 0.9', model: { sync: 0.9 }, level: 'warning' },
  { name: 'Hand 1°', model: { aimNoiseDeg: 1 }, level: 'warning' },
  { name: 'Hand 1.5°', model: { aimNoiseDeg: 1.5 }, level: 'warning' },
];

export interface SectionCell {
  readonly ok: boolean;
  readonly text: string;
}

/** Voll-Läufe Start → Ziel eines Bot-Modells über FULL_RUN_SEEDS. */
export interface FullRuns {
  readonly ok: number;
  readonly runs: number;
  /** Median der Zielzeiten (s), null ohne Zielankunft. */
  readonly median: number | null;
  readonly min: number | null;
  readonly max: number | null;
  readonly maxSpeed: number;
  /** "Seed n: Grund bei … vor Knoten k [Notiz]" je gescheitertem Lauf. */
  readonly failures: readonly string[];
}

export interface SectionTable {
  readonly sections: readonly string[];
  readonly bots: readonly string[];
  /** cells[section][bot] */
  readonly cells: readonly (readonly SectionCell[])[];
  /** Ganzer Lauf Start → Ziel je Bot, über mehrere Seeds. */
  readonly full: readonly FullRuns[];
}

/**
 * Seeds der Voll-Läufe. Ein einzelner Seed verdeckte Ausfälle: im E2E-Review
 * scheiterte der Übergang Kehre → Wende (Level 1) bei anderen Seeds, im Echtzeit-
 * Lauf blieb ein Bot an der Surf-Flanke stehen. Berichtet wird die Ausfallquote.
 */
export const FULL_RUN_SEEDS: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8];

/** Voll-Läufe eines Modells über alle Seeds (der Median ist robuster als ein Einzellauf, z. B. für Par). */
export function fullRuns(level: CompiledLevel, model: StrafeModel, cfg = VELOCITY_DEFAULT, seeds: readonly number[] = FULL_RUN_SEEDS): FullRuns {
  const route = level.def.route ?? [];
  const times: number[] = [];
  const failures: string[] = [];
  let maxSpeed = 0;
  for (const seed of seeds) {
    const res = runRoute(level, cfg, { sync: model.sync, aimNoiseDeg: model.aimNoiseDeg, seed });
    if (res.touchedFinish) {
      times.push(res.time);
      maxSpeed = Math.max(maxSpeed, res.maxSpeed);
    } else {
      const note = route[res.reached]?.note;
      failures.push(`Seed ${seed}: ${res.reason ?? res.status} bei ${fmtV(res.endPos)} vor Knoten ${res.reached}${note ? ` [${note}]` : ''}`);
    }
  }
  times.sort((a, b) => a - b);
  return {
    ok: times.length,
    runs: seeds.length,
    median: times.length ? times[Math.floor((times.length - 1) / 2)] : null,
    min: times.length ? times[0] : null,
    max: times.length ? times[times.length - 1] : null,
    maxSpeed,
    failures,
  };
}

/** Abschnitt × Bot: jeder Abschnitt aus dem Stand (Start bzw. Checkpoint-Spawn) bis zum nächsten Checkpoint/Ziel. */
export function sectionTable(level: CompiledLevel, cfg = VELOCITY_DEFAULT): SectionTable {
  const cps = level.triggers.filter((t) => t.kind === 'checkpoint').sort((a, b) => a.order - b.order);
  const names = ['Start', ...cps.map((c) => `CP${c.order}`)];
  const sections = names.map((n, i) => `${n}→${names[i + 1] ?? 'Ziel'}`);
  const cells: SectionCell[][] = [];
  for (let s = 0; s < names.length; s++) {
    const row: SectionCell[] = [];
    for (const b of BOT_MODELS) {
      const res = s === 0 ? sectionFromStart(level, b.model, cfg) : respawnRun(level, cps[s - 1], b.model, cfg);
      const seam = res.seam ? `, Nahtstopp ${fmt(res.seam.before)}→${fmt(res.seam.after)} bei ${fmtV(res.seam.pos)}` : '';
      row.push(res.ok && !res.seam ? { ok: true, text: `${fmt(res.time, 1)} s` } : { ok: false, text: `${res.reason} bei ${fmtV(res.end)}${seam}` });
    }
    cells.push(row);
  }
  const full = BOT_MODELS.map((b) => fullRuns(level, b.model, cfg));
  return { sections, bots: BOT_MODELS.map((b) => b.name), cells, full };
}

/** Bot-Zeiten für die Par-Prüfung (Median über die Seeds). */
interface BotTimes {
  readonly perfect: number | null;
  readonly hand3: number | null;
  /** 3°-Hand mit Spiel-Uhr (ab Startzone, Tode inklusive) — Maßstab für Par und Bronze. */
  readonly hand3Timed: number | null;
}

function checkPhysics(level: CompiledLevel, r: Report, mode: LineMode = MAIN_LINE, opts: ValidateOptions = {}): BotTimes {
  const cfg = VELOCITY_DEFAULT;
  const route = level.def.route ?? [];
  const cps = level.triggers.filter((t) => t.kind === 'checkpoint').sort((a, b) => a.order - b.order);
  // Surf-Prüfungen: auf der schnellen Linie einer Gabel Warnung, sonst Fehler.
  const surfSink = mode.surfErrors ? r.errors : r.warnings;

  // 1) + 2) Durchlauf von Start bis Ziel (mehrere Seeds) und jeder Abschnitt aus dem Stand, je Bot-Modell.
  const table = sectionTable(level, cfg);
  const sink = (lvl: 'error' | 'warning' | 'info'): string[] => (lvl === 'error' ? r.errors : lvl === 'warning' ? r.warnings : r.info);
  BOT_MODELS.forEach((b, k) => {
    const full = table.full[k];
    const rate = `${full.ok}/${full.runs} Seeds im Ziel`;
    const times = full.median !== null ? `Median ${fmt(full.median, 1)} s (${fmt(full.min ?? 0, 1)}–${fmt(full.max ?? 0, 1)}, max ${fmt(full.maxSpeed)} u/s)` : '';
    if (full.ok === full.runs) r.info.push(`Bot-Durchlauf ${b.name}: ${rate}, ${times}`);
    // Kein Lauf im Ziel: Fehler nach Modell-Stufe. Einzelne Ausfälle: ab einem warnen (Info-Modelle nur melden).
    else if (full.ok === 0) sink(b.level).push(`Bot-Durchlauf ${b.name} scheitert (${rate}; ${full.failures.slice(0, 2).join('; ')})`);
    else (b.level === 'info' ? r.info : r.warnings).push(`Bot-Durchlauf ${b.name}: ${rate}, ${times} — ${full.failures.slice(0, 3).join('; ')}`);
    table.cells.forEach((row, s) => {
      if (!row[k].ok) sink(b.level).push(`Abschnitt ${table.sections[s]} aus dem Stand (Bot ${b.name}): ${row[k].text}`);
    });
  });
  const w = Math.max(...table.sections.map((s) => s.length));
  r.info.push(`Abschnitt × Bot (aus dem Stand): ${''.padEnd(Math.max(0, w - 30))}${table.bots.map((b) => b.padStart(10)).join('')}`);
  table.cells.forEach((row, s) => r.info.push(`  ${table.sections[s].padEnd(w)}${row.map((c) => (c.ok ? c.text : '✗').padStart(10)).join('')}`));

  // Surf-Abschnitt nach einem Checkpoint: zusätzlich der Grundtechnik-Surfer.
  const lines: string[] = [];
  for (const cp of cps) {
    const from = resumeIndex(route, cp);
    const surfAhead = from >= 0 && route.slice(from, from + 3).some((n) => isSurfNode(n));
    if (!surfAhead) continue;
    const parts: string[] = [];
    for (const look of [0, 2]) {
      const res = respawnSurf(level, cp, (look * Math.PI) / 180, cfg);
      if (!res.ok) surfSink.push(`Respawn CP${cp.order} (Surfer, Blick ${look}°): ${res.reason} bei ${fmtV(res.end)}`);
      else parts.push(`${fmt(res.goalSpeed)} u/s`);
      if (res.seam) surfSink.push(`Respawn CP${cp.order} (Surfer): Nahtstopp bei ${fmtV(res.seam.pos)} (${fmt(res.seam.before)} → ${fmt(res.seam.after)} u/s)`);
    }
    lines.push(`CP${cp.order} ${parts.join(' / ')}`);
  }
  if (lines.length) r.info.push(`Grundtechnik-Surfer aus dem Stand (Blick 0°/2°, Tempo am nächsten Checkpoint): ${lines.join('; ')}`);

  // 3) Surf-Raster.
  for (const g of surfGrid(level, { ...SURF_GRID, cfg })) {
    for (const f of g.failures.slice(0, 4))
      surfSink.push(
        `Surf ${g.note} → ${g.goal}: Einstieg ${f.speed} u/s, Versatz ${f.lateral}, Blick ${f.lookDeg}° scheitert (${f.outcome.reason} bei ${fmtV(f.outcome.end)})`,
      );
    if (g.failures.length > 4) surfSink.push(`Surf ${g.note} → ${g.goal}: … ${g.failures.length - 4} weitere Fehlschläge`);
    for (const s of g.seams.slice(0, 3))
      surfSink.push(`Surf ${g.note}: Nahtstopp bei ${fmtV(s.seam.pos)} (${fmt(s.seam.before)} → ${fmt(s.seam.after)} u/s; Einstieg ${s.speed}/${s.lateral}/${s.lookDeg}°)`);
    r.info.push(
      `Surf-Raster ${g.note} → ${g.goal}: ${g.runs - g.failures.length}/${g.runs} Läufe, ${g.seams.length} Nahtstopps, Tempo am Ziel ${fmt(g.goalSpeed[0])}–${fmt(g.goalSpeed[1])} u/s`,
    );
  }

  // 4) Deko auf der geflogenen Linie.
  checkDecoOnPath(level, r);

  // 4b) Crouch-Kanten dürfen ohne Ducken nicht erreichbar sein (meldet nur Verstöße).
  checkCrouchNoDuck(level, cfg, r);

  // 5) Design-Proben des Levels (einmal, mit der Hauptlinie).
  if (mode.main) {
    const d = designProbes(level, cfg);
    r.errors.push(...d.errors);
    r.warnings.push(...d.warnings);
    r.info.push(...d.info);
    if (opts.probes) {
      const x = opts.probes(level, cfg);
      r.errors.push(...x.errors);
      r.warnings.push(...x.warnings);
      r.info.push(...x.info);
    }
    // 6) Start-Jitter des perfekten Bots (Grundlage von Gold/VELOCITY/Autor, build.ts): zerfällt er in
    //    Zweige, ist der Median eine Frage der Stichprobe. Meldet nur Befunde.
    const j = jitterMedian(level, { sync: 1 }, cfg);
    if (j.branches)
      r.warnings.push(
        `Perfekter Bot zerfällt über den Start-Kasten (±16 u × ±1°, ${j.runs.length} Starts) in zwei Zweige: ${describeBranches(j.branches)} — ` +
          `der Medaillen-Median (build.ts) hängt an der Stichprobe; Chaos-Stelle entschärfen (z. B. Absprung vor einer Wand)`,
      );
  }
  const hand = BOT_MODELS.findIndex((b) => b.model.aimNoiseDeg === 3);
  return { perfect: table.full[0].median, hand3: hand >= 0 ? table.full[hand].median : null, hand3Timed: timedMedian(level, { aimNoiseDeg: 3 }, FULL_RUN_SEEDS, cfg).median };
}

/**
 * Deko (collide:false, sichtbar) darf die tatsächlich geflogene Linie nicht
 * schneiden: Oberkörper und Kopf der Hull (24–72 u über den Füßen) entlang der
 * Bahn des perfekten Bots und dreier 3°-Hände. Sonst fliegt die Kamera durch
 * Geometrie — L2-Finale: ein Torbalken verdeckte die Ziel-Landung in der
 * entscheidenden Viertelsekunde (Look-Kritik). Die Füße zählen nicht: unter einem
 * unsichtbaren Clip ragt die Treppe als Optik bis 16 u in die Hull.
 */
function checkDecoOnPath(level: CompiledLevel, r: Report): void {
  const deco = level.brushes.filter((b) => !b.collide && b.visible).map((b) => ({ ...b, collide: true }));
  if (!deco.length || !(level.def.route ?? []).length) return;
  const world = new BrushWorld(deco);
  const mins = new Vector3(-PHYS.hullHalf, 0, -PHYS.hullHalf);
  const maxs = new Vector3(PHYS.hullHalf, PHYS.standHeight - 24, PHYS.hullHalf);
  const p = new Vector3();
  const hits = new Map<number, string>();
  let frames = 0;
  const runs: Array<{ model: StrafeModel; seed: number }> = [
    { model: { sync: 1 }, seed: 11 },
    { model: { aimNoiseDeg: 3 }, seed: 1 },
    { model: { aimNoiseDeg: 3 }, seed: 2 },
    { model: { aimNoiseDeg: 3 }, seed: 3 },
  ];
  for (const run of runs) {
    const rec = recordRoute(level, run.model, run.seed);
    for (let i = 0; i < rec.ticks; i++) {
      const eye = rec.path[i * 4 + 3];
      // Geduckt ist die Hull kürzer: Oberkante = Augenhöhe + 8 (Stand: 64 + 8 = 72).
      const top = Math.min(PHYS.standHeight, eye + 8);
      maxs.y = top - 24;
      p.set(rec.path[i * 4], rec.path[i * 4 + 1] + 24, rec.path[i * 4 + 2]);
      frames++;
      if (!world.testBox(p, mins, maxs)) continue;
      // Welcher Brush? (Deko ist wenig — einzeln testen.)
      for (const b of deco) {
        if (hits.has(b.index)) continue;
        const single = new BrushWorld([b]);
        if (single.testBox(p, mins, maxs)) hits.set(b.index, `${brushName(level, b.index)} bei ${fmtV(p)} (${run.model.sync !== undefined ? `sync ${run.model.sync}` : `Hand ${run.model.aimNoiseDeg}°`})`);
      }
    }
  }
  if (hits.size) r.errors.push(`Deko auf der Flugbahn: ${[...hits.values()].slice(0, 4).join('; ')}${hits.size > 4 ? ` … ${hits.size - 4} weitere` : ''}`);
  else r.info.push(`Deko frei von der Flugbahn (${runs.length} Bot-Läufe, ${frames} Ticks, Oberkörper+Kopf gegen ${deco.length} Deko-Brushes)`);
}

// ---------------------------------------------------------------------------
// Plan 007: Crouch-Kanten, gestapelte Level, Lektionen

/**
 * Crouch-Kanten sollen so viel über der Reichweite ohne Ducken liegen (u). Heute (Repo-Physik, ledgeStep 5)
 * reicht es ohne Ducken bis ≈ 63.8 u: Sprung 57 + Auto-Hop-Landehöhe bis 1.75 (Boden-Trace 2 u) +
 * Kanten-Assist 5 — eine 64-u-Kante hat 0.2–0.5 u Reserve, ein Movement-Tuning kippt sie still.
 */
export const CROUCH_RESERVE = 2;

/** Anlauf-Tempi der Crouch-Proben: Sprint, Mitte, bis 1.2 × Plan-Tempo des Knotens. */
export function crouchSpeeds(cfg: MovementConfig, minSpeed: number | undefined): readonly number[] {
  const vTop = Math.max(cfg.sprintSpeed, OVERSHOOT * (minSpeed ?? cfg.sprintSpeed));
  return [cfg.sprintSpeed, (cfg.sprintSpeed + vTop) / 2, vTop];
}

/**
 * Ein Anlauf auf eine Kante OHNE Ducken: ab `start` mit Tempo v in Richtung (fx, fz), W + Sprint + Leertaste
 * gehalten (Auto-Hop, mehrere Versuche), 1.5 s. true = Füße stehen auf Kantenhöhe (≥ top − 1) und `past`.
 * Füße selbst prüfen, kein simulate-Ziel: das wird gegen die ganze Hull geprüft (fallen.md #93).
 */
function climbsWithoutDuck(
  world: CollisionWorld,
  cfg: MovementConfig,
  inp: MutablePlayerInput,
  start: Vector3,
  fx: number,
  fz: number,
  v: number,
  top: number,
  past: (x: number, z: number) => boolean,
  killY: number,
): boolean {
  const pm = new PlayerMovement(world, cfg);
  pm.teleport(start);
  pm.state.vel.set(fx * v, 0, fz * v);
  const yaw = Math.atan2(-fx, -fz);
  for (let k = 0; k < 1.5 * cfg.tickRate; k++) {
    inp.yaw = yaw;
    inp.pitch = 0;
    inp.forward = 1;
    inp.side = 0;
    inp.sprint = true;
    inp.crouch = false;
    inp.jumpHeld = true;
    inp.jumpPressed = k === 0;
    pm.tick(inp);
    const st = pm.state;
    if (st.pos.y < killY) return false;
    if (st.onGround && st.pos.y >= top - 1 && past(st.pos.x, st.pos.z)) return true;
  }
  return false;
}

const reachCache = new Map<string, number>();

/**
 * Höchste Kante (u über dem Anlauf-Boden), die man OHNE Ducken erreicht — eine Eigenschaft der Config
 * (Sprung, Auto-Hop, Kanten-Assist), nicht des Levels: Attrappe aus Boden und Wand der Höhe h, Anlauf
 * 16–400 u vor der Wand im 8-u-Raster mit den Tempi der Probe, Bisektion auf 0.05 u. Cache je Config + Tempi.
 */
export function noDuckReach(cfg: MovementConfig, speeds: readonly number[]): number {
  const key = `${configKey(cfg)}|${speeds.join(',')}`;
  const hit = reachCache.get(key);
  if (hit !== undefined) return hit;
  const half = cfg.hull.halfWidth;
  const inp = makeBotInput();
  const floor = compileBrush({ type: 'box', min: [-256, -64, 0], max: [256, 0, 512], mat: 'floor' }, 0);
  const climbs = (h: number): boolean => {
    const world = new BrushWorld([floor, compileBrush({ type: 'box', min: [-256, -64, -512], max: [256, h, 0], mat: 'wall' }, 1)]);
    for (let back = 16; back <= 400; back += 8)
      for (const v of speeds) if (climbsWithoutDuck(world, cfg, inp, new Vector3(0, 0.25, back), 0, -1, v, h, (_x, z) => z <= half, -1000)) return true;
    return false;
  };
  // Stufenhöhe schafft man immer (Step), 128 u nie (Crouch-Jump ≈ 76 u + Assist).
  let lo = cfg.stepSize;
  let hi = 128;
  while (hi - lo > 0.05) {
    const mid = (lo + hi) / 2;
    if (climbs(mid)) lo = mid;
    else hi = mid;
  }
  reachCache.set(key, lo);
  return lo;
}

/**
 * Crouch-Kanten (Knoten mit `crouch`, Flug auf eine höhere Fläche) dürfen OHNE Ducken nicht erreichbar
 * sein, sonst lehrt die Kante nichts. Fehler: die Probe im Level kommt ohne Ducken hoch (Anlauf auf der
 * Absprungfläche 16–400 u vor der Wand, Sprint bis 1.2 × Plan-Tempo, Linie und ±48 seitlich, W + Leertaste
 * gehalten, nie geduckt). Warnung: die Kante liegt weniger als CROUCH_RESERVE über `noDuckReach` — heute
 * noch dicht, nach dem nächsten Tuning nicht mehr. Meldet nur Befunde; L2 hat keine Crouch-Kante.
 */
function checkCrouchNoDuck(level: CompiledLevel, cfg: MovementConfig, r: Report): void {
  const route = level.def.route ?? [];
  const world = level.world;
  const inp = makeBotInput();
  for (let i = 0; i + 1 < route.length; i++) {
    const A = route[i];
    const B = route[i + 1];
    if (!A.crouch || B.pos[1] <= A.pos[1] + PHYS.stepSize) continue;
    const dx = B.pos[0] - A.pos[0];
    const dz = B.pos[2] - A.pos[2];
    const d = Math.hypot(dx, dz);
    if (d < 1) continue;
    const fx = dx / d;
    const fz = dz / d;
    // Wand = erster Punkt der Linie A→B, an dem der Boden über Stufenhöhe liegt; dort oben ist die Kante.
    let wall = -1;
    let top = 0;
    for (let s = 0; s <= d; s += 4) {
      const g = groundBelow(world, new Vector3(A.pos[0] + fx * s, B.pos[1] + 8, A.pos[2] + fz * s), B.pos[1] - A.pos[1] + 16, PROBE_MINS, PROBE_MAXS, 0);
      if (g !== null && g > A.pos[1] + PHYS.stepSize) {
        wall = s;
        top = g;
        break;
      }
    }
    if (wall < 0) continue;
    const speeds = crouchSpeeds(cfg, A.minSpeed);
    const past = (x: number, z: number): boolean => (x - A.pos[0]) * fx + (z - A.pos[2]) * fz >= wall - PHYS.hullHalf;
    const hits: string[] = [];
    let runs = 0;
    // 24-u-Raster: dichter (8 u) traf eine Kante 0.5 u unter der Reichweite auch nur 3× (320 u/s, 376 u vor
    // der Wand — ein schmales Phasenfenster); knapp unter der Schwelle fängt die Reserve-Warnung.
    for (let back = 16; back <= 400; back += 24) {
      for (const lateral of [-48, 0, 48]) {
        const x = A.pos[0] + fx * (wall - back) - fz * lateral;
        const z = A.pos[2] + fz * (wall - back) + fx * lateral;
        const g = groundBelow(world, new Vector3(x, A.pos[1] + 24, z), 48, STAND_MINS, STAND_MAXS, 0);
        if (g === null || Math.abs(g - A.pos[1]) > 24) continue;
        for (const v of speeds) {
          runs++;
          if (climbsWithoutDuck(world, cfg, inp, new Vector3(x, g + 0.25, z), fx, fz, v, top, past, level.def.killY)) hits.push(`${fmt(v)} u/s ${back} u vor der Wand, seitlich ${lateral}`);
        }
      }
    }
    const name = `Crouch-Kante Route ${i}→${i + 1}${A.note ? ` [${A.note}]` : ''} (${fmt(top - A.pos[1], 1)} u hoch)`;
    const reach = noDuckReach(cfg, speeds);
    const why = `ohne Ducken reicht es bis ${fmt(reach, 1)} u (Sprung, Auto-Hop-Landehöhe, Kanten-Assist)`;
    const need = Math.ceil(reach + CROUCH_RESERVE);
    if (hits.length) r.errors.push(`${name}: ohne Ducken erreichbar in ${hits.length}/${runs} Läufen (z. B. ${hits.slice(0, 2).join('; ')}) — ${why}; Crouch-Kanten brauchen ≥ ${need} u`);
    else if (top - A.pos[1] - reach < CROUCH_RESERVE)
      r.warnings.push(`${name}: Reserve ${fmt(top - A.pos[1] - reach, 1)} u < ${CROUCH_RESERVE} u — ${why}; ein Movement-Tuning kippt sie still, Kante auf ≥ ${need} u heben`);
  }
}

/**
 * Gestapelte Level (Wendel): liegen Knoten einer anderen Etage im Trigger eines Checkpoints, setzt der
 * Wiedereinstieg nach einem Respawn beim ERSTEN Durchgang an (physics.resumeIndex). Fehler, wenn das nicht
 * der Durchgang am Spawn ist — Bots, Spiel-Uhr und Proben fahren dann die falsche Etage ab ("Schatten-
 * Knoten"). Abhilfe: Trigger in der Höhe begrenzen. Meldet nur Verstöße.
 */
function checkResume(level: CompiledLevel, r: Report): void {
  const route = level.def.route ?? [];
  for (const cp of level.triggers.filter((t) => t.kind === 'checkpoint')) {
    const runs: Array<{ from: number; to: number; dist: number }> = [];
    route.forEach((n, i) => {
      if (!nodeInTrigger(n.pos, cp)) return;
      const d = Math.hypot(n.pos[0] - cp.spawnPos.x, n.pos[1] - cp.spawnPos.y, n.pos[2] - cp.spawnPos.z);
      const last = runs[runs.length - 1];
      if (last && last.to === i - 1) {
        last.to = i;
        last.dist = Math.min(last.dist, d);
      } else runs.push({ from: i, to: i, dist: d });
    });
    if (runs.length < 2) continue;
    const near = runs.reduce((a, b) => (b.dist < a.dist ? b : a));
    const at = resumeIndex(route, cp);
    if (at >= near.from && at <= near.to + 1) continue;
    r.errors.push(
      `Checkpoint ${cp.order}: Wiedereinstieg bei Knoten ${at} (y ${fmt(route[at]?.pos[1] ?? Number.NaN)}), der Spawn gehört aber zum Durchgang ${near.from}–${near.to} ` +
        `— die Route durchquert den Trigger ${runs.length}× (${runs.map((x) => `${x.from}–${x.to}`).join(', ')}): Schatten-Knoten einer anderen Etage, Trigger in der Höhe begrenzen`,
    );
  }
}

/** Lektionskarte im HUD: Titel ≤ 16 Zeichen, Texte ≤ 2 Zeilen à ≤ 40 Zeichen. */
const TITLE_MAX = 16;
const TEXT_LINES = 2;
const TEXT_LINE_MAX = 40;

function textProblem(text: string): string | null {
  const lines = text.split('\n');
  if (lines.length > TEXT_LINES) return `${lines.length} Zeilen (höchstens ${TEXT_LINES})`;
  const long = lines.find((l) => [...l].length > TEXT_LINE_MAX);
  return long === undefined ? null : `Zeile mit ${[...long].length} Zeichen (höchstens ${TEXT_LINE_MAX}): "${long}"`;
}

/** Zeichen ohne Glyphe im HUD-Pixelfont (ui/glyphs, samt Aliasen wie — → -) zeichnen als Kasten. */
function glyphProblem(text: string): string | null {
  const bad = [...new Set([...text].filter((ch) => ch !== '\n' && !hasGlyph(ch)))];
  return bad.length ? `Zeichen ohne Glyphe im HUD-Font: ${bad.map((ch) => `"${ch}"`).join(' ')} in "${text.replace(/\n/g, ' / ')}"` : null;
}

function taskZones(task: TaskDef): readonly string[] {
  switch (task.kind) {
    case 'reach':
    case 'crouchLand':
      return [task.zone];
    case 'course':
      return task.zones;
    default:
      return [];
  }
}

function taskProblem(task: TaskDef): string | null {
  switch (task.kind) {
    case 'hopChain':
    case 'goodHops':
    case 'crouchLand':
    case 'event':
      return Number.isInteger(task.count) && task.count >= 1 ? null : `count ${task.count}`;
    case 'speed':
    case 'surfSpeed':
      return task.min > 0 ? null : `min ${task.min}`;
    case 'surfHold':
      return task.seconds > 0 ? null : `seconds ${task.seconds}`;
    case 'course':
      return task.zones.length === 0 ? 'course ohne Zonen' : task.minSpeed >= 0 ? null : `minSpeed ${task.minSpeed}`;
    case 'reach':
      return null;
  }
}

/**
 * Vertrag einer Lektion (LevelFile.training): kein Timer (medals/parTime verboten), Nummer/Kurzname/Gruppe,
 * lektionsweit eindeutige IDs (Zonen, Tore, Stufen), jede Referenz zeigt auf Existierendes (Aufgaben-Zonen,
 * opens → Tore, Tipp-Zonen, Urteile, Demo-Knoten), Titel ≤ 16 und Texte ≤ 2 × 40 Zeichen (HUD-Karte), jedes
 * Zeichen von Name, Kurzname, Titeln, Texten und Tipps mit Glyphe im HUD-Font,
 * mindestens eine Pflichtstufe, Stufen-Spawns stehen frei auf Boden.
 */
function checkTraining(level: CompiledLevel, r: Report): void {
  const def = level.def;
  const t = def.training;
  if (!t) return;
  const err = (m: string): void => {
    r.errors.push(`Lektion ${t.short || def.id}: ${m}`);
  };
  if (def.medals !== undefined || def.parTime !== undefined) err('training zusammen mit medals/parTime — Lektionen haben keinen Timer und keine Bestzeit');
  if (!Number.isInteger(t.lesson) || t.lesson < 1) err(`lesson ${t.lesson} ist keine Lektionsnummer ≥ 1`);
  if (!t.short) err('short fehlt');
  for (const [what, text] of [['Name', def.name], ['short', t.short]] as const) {
    const gp = glyphProblem(text);
    if (gp) err(`${what}: ${gp}`);
  }
  if (t.group !== 'basics' && t.group !== 'advanced') err(`group "${String(t.group)}" unbekannt`);
  const ids = new Map<string, string>();
  const claim = (id: string, what: string): void => {
    const prev = ids.get(id);
    if (prev !== undefined) err(`id "${id}" doppelt (${prev} und ${what}) — IDs sind lektionsweit eindeutig`);
    else ids.set(id, what);
  };
  const zones = new Set<string>();
  const gates = new Set<string>();
  for (const z of t.zones ?? []) {
    claim(z.id, 'Zone');
    zones.add(z.id);
    if (!(z.min[0] < z.max[0] && z.min[1] < z.max[1] && z.min[2] < z.max[2])) err(`Zone "${z.id}" ohne Volumen`);
  }
  for (const g of t.gates ?? []) {
    claim(g.id, 'Tor');
    gates.add(g.id);
    if (!(g.min[0] < g.max[0] && g.min[1] < g.max[1] && g.min[2] < g.max[2])) err(`Tor "${g.id}" ohne Volumen`);
  }
  if (t.stages.length === 0) err('keine Stufen');
  else if (!t.stages.some((s) => (s.rank ?? 'required') === 'required')) err('keine Pflichtstufe (rank required) — ohne sie gibt es keinen Stern');
  const routeLen = (def.route ?? []).length;
  for (const st of t.stages) {
    const name = `Stufe "${st.id}"`;
    claim(st.id, 'Stufe');
    if ([...st.title].length > TITLE_MAX) err(`${name}: Titel "${st.title}" hat ${[...st.title].length} Zeichen (höchstens ${TITLE_MAX})`);
    const tp = textProblem(st.text);
    if (tp) err(`${name}: Text ${tp}`);
    for (const [what, text] of [['Titel', st.title], ['Text', st.text]] as const) {
      const gp = glyphProblem(text);
      if (gp) err(`${name}: ${what} ${gp}`);
    }
    const task = taskProblem(st.task);
    if (task) err(`${name}: Aufgabe ${st.task.kind} ungültig (${task})`);
    for (const z of taskZones(st.task)) if (!zones.has(z)) err(`${name}: Aufgabe ${st.task.kind} verweist auf unbekannte Zone "${z}"`);
    for (const g of st.opens ?? []) if (!gates.has(g)) err(`${name}: opens verweist auf unbekanntes Tor "${g}"`);
    for (const tip of st.tips ?? []) {
      const tt = textProblem(tip.text);
      if (tt) err(`${name}: Tipp (${tip.on}) ${tt}`);
      const tg = glyphProblem(tip.text);
      if (tg) err(`${name}: Tipp (${tip.on}) ${tg}`);
      if (tip.on === 'zone' && tip.zone === undefined) err(`${name}: Tipp 'zone' ohne Zone`);
      if (tip.zone !== undefined && !zones.has(tip.zone)) err(`${name}: Tipp verweist auf unbekannte Zone "${tip.zone}"`);
      if (tip.on === 'verdict' && tip.verdict === undefined) err(`${name}: Tipp 'verdict' ohne Urteil`);
      if (tip.verdict !== undefined && !VERDICTS.some((v) => v === tip.verdict)) err(`${name}: Tipp mit unbekanntem Urteil "${String(tip.verdict)}"`);
    }
    const demo = st.demo;
    if (demo?.kind === 'route' && !(Number.isInteger(demo.from) && Number.isInteger(demo.to) && demo.from >= 0 && demo.from < demo.to && demo.to < routeLen))
      err(`${name}: Demo-Route ${demo.from}→${demo.to} liegt nicht in der Route (${routeLen} Knoten)`);
    if (demo && !(demo.seconds > 0)) err(`${name}: Demo ohne Dauer`);
    if (st.spawn) checkStandPoint(level.world, new Vector3(...st.spawn.pos), `${name}-Spawn`, r);
  }
  const rank = (k: string): number => t.stages.filter((s) => (s.rank ?? 'required') === k).length;
  r.info.push(`Lektion ${t.short} (${t.group}): ${t.stages.length} Stufen (Pflicht ${rank('required')}, Bonus ${rank('bonus')}, Meister ${rank('master')}), ${zones.size} Zonen, ${gates.size} Tore`);
}

/** Zeilen einer Teilprüfung mit Präfix übernehmen ('' = direkt in den Bericht). */
function tagged<T>(r: Report, tag: string, fn: (x: Report) => T): T {
  if (!tag) return fn(r);
  const x: Report = { name: r.name, errors: [], warnings: [], info: [] };
  const out = fn(x);
  r.errors.push(...x.errors.map((l) => tag + l));
  r.warnings.push(...x.warnings.map((l) => tag + l));
  r.info.push(...x.info.map((l) => tag + l));
  return out;
}

const SAFE_LINE: LineMode = { tag: '[safeRoute] ', surfErrors: true, main: false };
const NO_TIMES: BotTimes = { perfect: null, hand3: null, hand3Timed: null };

// ---------------------------------------------------------------------------
// Level

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function validateLevel(file: string, def: LevelFile, opts: ValidateOptions = {}): Report {
  const r: Report = { name: file, errors: [], warnings: [], info: [] };
  let level: CompiledLevel;
  try {
    level = compileLevel(def);
  } catch (e) {
    r.errors.push(`compileLevel: ${(e as Error).message}`);
    return r;
  }
  const world = level.world;
  const training = def.training !== undefined;
  // Gabel: die sichere Linie als eigene Level-Variante (alle Proben lesen def.route).
  const safe = def.safeRoute ? withRoute(level, 'safeRoute') : null;

  // Environment
  const env = def.environment;
  for (const k of ['skyTop', 'skyHorizon', 'skyBottom', 'fogColor', 'sunColor', 'ambientSky', 'ambientGround', 'trimColor'] as const) {
    if (!HEX.test(env[k])) r.errors.push(`environment.${k} "${env[k]}" ist keine Hex-Farbe`);
  }
  if (env.trimColorAlt !== undefined && !HEX.test(env.trimColorAlt)) r.errors.push(`environment.trimColorAlt ist keine Hex-Farbe`);
  if (!(env.fogNear < env.fogFar)) r.errors.push(`fogNear ${env.fogNear} muss < fogFar ${env.fogFar} sein`);

  // Spawn
  checkStandPoint(world, level.spawnPos, 'Spawn', r);

  // Trigger
  const starts = level.triggers.filter((t) => t.kind === 'start');
  const finishes = level.triggers.filter((t) => t.kind === 'finish');
  const cps = level.triggers.filter((t) => t.kind === 'checkpoint');
  // Lektionen haben keinen Lauf (kein Timer): Start und Ziel sind dort freiwillig.
  if (!training && starts.length !== 1) r.errors.push(`${starts.length} Start-Trigger (erwartet 1)`);
  if (!training && finishes.length < 1) r.errors.push('kein Ziel-Trigger');
  for (const t of level.triggers) {
    const s = t.bounds.getSize(new Vector3());
    if (!(s.x > 0 && s.y > 0 && s.z > 0)) r.errors.push(`Trigger ${t.kind}${t.tag ? ` (${t.tag})` : ''} ohne Volumen`);
    if (!t.bounds.intersectsBox(level.bounds)) r.errors.push(`Trigger ${t.kind}${t.tag ? ` (${t.tag})` : ''} liegt außerhalb des Levels`);
  }
  if (starts[0] && !starts[0].bounds.containsPoint(level.spawnPos.clone().setY(level.spawnPos.y + 1)))
    r.warnings.push('Spawn liegt nicht im Start-Trigger (Timer liefe sofort)');
  cps.forEach((t, i) => {
    if (t.order !== i + 1) r.errors.push(`Checkpoint-Reihenfolge: erwartet ${i + 1}, gefunden ${t.order}`);
    checkStandPoint(world, t.spawnPos, `Checkpoint ${t.order}-Spawn`, r);
    const b = t.bounds;
    const p = t.spawnPos;
    if (p.x < b.min.x || p.x > b.max.x || p.z < b.min.z || p.z > b.max.z)
      r.warnings.push(`Checkpoint ${t.order}: Spawn liegt nicht über seinem Trigger`);
  });

  // killY / voidY
  let lowestTop = Infinity;
  let walkFaces = 0;
  let surfFaces = 0;
  let faceCount = 0;
  let deco = 0;
  const surfAngles: number[] = [];
  for (const b of level.brushes) {
    if (!b.collide) deco++;
    faceCount += b.faces.length;
    for (const f of b.faces) {
      if (!b.collide) continue;
      if (f.walkable) {
        walkFaces++;
        for (const vtx of f.vertices) lowestTop = Math.min(lowestTop, vtx.y);
      }
      if (f.surf) {
        surfFaces++;
        surfAngles.push((Math.acos(f.normal.y) * 180) / Math.PI);
      }
    }
  }
  if (!(def.killY < lowestTop - 32)) r.errors.push(`killY ${def.killY} liegt nicht unter der tiefsten begehbaren Fläche (${fmt(lowestTop)})`);
  if (!(env.voidY < def.killY)) r.warnings.push(`voidY ${env.voidY} liegt nicht unter killY ${def.killY}`);

  checkZFighting(level, r);
  checkDecoIntersections(level, r);
  checkMarkings(level, r);
  checkKillZones(level, r);
  checkTraining(level, r);
  // Mit Gabel: route darf riskant sein (Surf-Prüfungen warnen), safeRoute muss halten.
  const main: LineMode = safe ? { tag: '[route] ', surfErrors: false, main: true } : MAIN_LINE;
  const route = tagged(r, main.tag, (x) => checkRoute(level, x, main));
  const safeStats = safe ? tagged(r, SAFE_LINE.tag, (x) => checkRoute(safe, x, SAFE_LINE)) : null;
  tagged(r, main.tag, (x) => checkResume(level, x));
  if (safe) tagged(r, SAFE_LINE.tag, (x) => checkResume(safe, x));
  const physics = opts.physics !== false;
  let bots: BotTimes = NO_TIMES;
  let safeBots: BotTimes | null = null;
  if (physics && training) {
    // Lektionen: Bot-Matrix je Stufe statt Start → Ziel (tools/levels/training/check.ts).
    const t = checkTrainingLevel(level, VELOCITY_DEFAULT);
    r.errors.push(...t.errors);
    r.warnings.push(...t.warnings);
    r.info.push(...t.info);
  } else if (physics && route.length > 0) {
    bots = tagged(r, main.tag, (x) => checkPhysics(level, x, main, opts));
    if (safe && safeStats && safeStats.length > 0) safeBots = tagged(r, SAFE_LINE.tag, (x) => checkPhysics(safe, x, SAFE_LINE, opts));
  }

  // Medaillen: streng fallend, Par = Bronze auf ganze Sekunden (build.ts misst beides mit der Spiel-Uhr).
  const m = def.medals;
  if (m) {
    const vals = [m.bronze, m.silver, m.gold, m.velocity, m.author];
    if (!vals.every((x) => Number.isFinite(x) && x > 0)) r.errors.push(`Medaillen ungültig: ${JSON.stringify(m)}`);
    else if (!(m.bronze > m.silver && m.silver > m.gold && m.gold > m.velocity && m.velocity >= m.author)) r.errors.push(`Medaillen nicht streng fallend (bronze > silver > gold > velocity ≥ author): ${JSON.stringify(m)}`);
    if (def.parTime !== undefined && def.parTime !== Math.ceil(m.bronze)) r.warnings.push(`Par ${def.parTime} s ≠ Bronze ${m.bronze} s aufgerundet`);
    // Staffel (build.ts staggerMedals, level-design.md Regel 10): jede Stufe ≥ 4 % über der nächstbesseren; Bronze → Silber →
    // Gold ≤ 20 %, sonst fehlt einer Spielergruppe das erreichbare nächste Ziel. Gold → VELOCITY nur als Zahl (die Krone).
    const st = medalSteps(m);
    const pct = (f: number): string => `${((f - 1) * 100).toFixed(1)} %`;
    const stepText = `Bronze→Silber ${pct(st.bs)}, Silber→Gold ${pct(st.sg)}, Gold→VELOCITY ${pct(st.gv)}, VELOCITY→Autor ${pct(st.va)}`;
    const tight = ([['Bronze→Silber', st.bs], ['Silber→Gold', st.sg], ['Gold→VELOCITY', st.gv]] as const).filter(([, f]) => f < MEDAL_MIN_STEP - 1e-9);
    const wide = ([['Bronze→Silber', st.bs], ['Silber→Gold', st.sg]] as const).filter(([, f]) => f > MEDAL_MAX_STEP);
    if (tight.length) r.errors.push(`Medaillen-Staffel unter ${pct(MEDAL_MIN_STEP)}: ${tight.map(([n]) => n).join(', ')} — ${stepText} (npm run levels:build)`);
    else if (wide.length) r.warnings.push(`Medaillen-Staffel über ${pct(MEDAL_MAX_STEP)}: ${wide.map(([n]) => n).join(', ')} — ${stepText}`);
    else r.info.push(`Medaillen-Staffel: ${stepText}`);
  } else if (route.length > 0 && !training) r.warnings.push('Keine Medaillen (npm run levels:build misst sie)');

  // Statistik
  const bmin = level.bounds.min;
  const bmax = level.bounds.max;
  r.info.push(
    `Brushes ${level.brushes.length} (Kollision ${world.brushCount}, Deko ${deco}), Flächen ${faceCount} ` +
      `(begehbar ${walkFaces}, Surf ${surfFaces}${surfAngles.length ? `, ${fmt(Math.min(...surfAngles))}–${fmt(Math.max(...surfAngles))}°` : ''})`,
  );
  r.info.push(`Bounds ${fmtV(bmin)} … ${fmtV(bmax)}, Größe ${fmtV(bmax.clone().sub(bmin))}`);
  r.info.push(`Trigger: Start ${starts.length}, Checkpoints ${cps.length}, Ziel ${finishes.length}; killY ${def.killY}, voidY ${env.voidY}`);
  if (route.length > 0) {
    // Keine "geschätzte Mindestzeit" mehr: sie rechnete mit den minSpeed-Planungswerten
    // (unteres Band, an Surf-Knoten 90 % des Langsamsten) und lag in Level 2 doppelt so
    // hoch wie die echte Bot-Zeit. Gemessen wird mit den Bots (Median über die Seeds).
    r.info.push(
      `Route ${(def.route ?? []).length} Knoten, ${fmt(route.length)} u` +
        (bots.perfect !== null ? `, Bot sync 1.0 ${fmt(bots.perfect, 1)} s` : '') +
        (bots.hand3 !== null ? `, Hand 3° ${fmt(bots.hand3, 1)} s (Median)` : '') +
        (bots.hand3Timed !== null ? `, mit Spiel-Uhr ${fmt(bots.hand3Timed, 1)} s` : '') +
        (def.parTime !== undefined ? `, Par ${def.parTime} s` : '') +
        (m ? `, Medaillen ${m.bronze}/${m.silver}/${m.gold}/${m.velocity}/${m.author} s` : ''),
    );
    if (safe && safeStats)
      r.info.push(
        `safeRoute ${(def.safeRoute ?? []).length} Knoten, ${fmt(safeStats.length)} u` +
          (safeBots && safeBots.perfect !== null ? `, Bot sync 1.0 ${fmt(safeBots.perfect, 1)} s` : '') +
          (safeBots && safeBots.hand3 !== null ? `, Hand 3° ${fmt(safeBots.hand3, 1)} s (Median)` : '') +
          (safeBots && safeBots.hand3Timed !== null ? `, mit Spiel-Uhr ${fmt(safeBots.hand3Timed, 1)} s (Bronze/Par)` : ''),
      );
    const par = def.parTime;
    const refEntry = physics && par !== undefined ? LEVELS.find((e) => e.id === def.id) : undefined;
    const ref = refEntry?.reference ? refEntry.reference() : null;
    // Perfekt wie in build.ts: der schnellere aus RouteFollower und Referenz (L3: der Surfer ist 6 s schneller als der Bot).
    const perfRuns = ref && par !== undefined && bots.perfect !== null && par < bots.perfect ? ref.runs(level, { sync: 1 }, 'route', true, FULL_RUN_SEEDS) : null;
    const perfRef = perfRuns ? medianOf(perfRuns.runs) : null;
    const perfect = bots.perfect === null ? null : perfRef === null ? bots.perfect : Math.min(bots.perfect, perfRef);
    if (par !== undefined && perfect !== null && par < perfect)
      r.warnings.push(`Par ${par} s liegt unter der Zeit des perfekten Bots (${fmt(perfect, 1)} s${perfRef !== null ? `, Referenz ${fmt(perfRef, 1)} s` : ''})`);
    // Par = Ansage für Gelegenheitsspieler (3°-Hand + ~5 %, build.ts, Spiel-Uhr): darunter unerreichbar, weit darüber bedeutungslos.
    // Mit Gabel misst build.ts Bronze auf der sicheren Linie — also auch hier.
    // Hat das Level eine Medaillen-Referenz (build.ts LEVELS[].reference, L4: Hybrid mit Surf-Grundtechnik), zählt wie
    // in build.ts die schnellere Technik der 3°-Hand.
    const h3bot = safeBots ? safeBots.hand3Timed : bots.hand3Timed;
    // Wie Bronze in build.ts: surfend wie gelehrt (Blick 0°).
    const refRuns = ref ? ref.runs(safe ?? level, { aimNoiseDeg: 3 }, safe ? 'safeRoute' : 'route', false, FULL_RUN_SEEDS, { look: 'lesson' }) : null;
    const h3ref = refRuns ? medianOf(refRuns.runs) : null;
    const h3 = h3bot === null ? h3ref : h3ref === null ? h3bot : Math.min(h3bot, h3ref);
    if (par !== undefined && h3 !== null && par < h3)
      r.warnings.push(`Par ${par} s liegt unter der 3°-Hand mit Spiel-Uhr (${fmt(h3, 1)} s${h3ref !== null ? `; RouteFollower ${h3bot === null ? '–' : fmt(h3bot, 1)}, Referenz ${fmt(h3ref, 1)}` : ''})`);
    else if (par !== undefined && h3ref !== null) r.info.push(`Par ${par} s: 3°-Hand mit Spiel-Uhr RouteFollower ${h3bot === null ? '–' : fmt(h3bot, 1)} s, Referenz (${ref?.name ?? ''}) ${fmt(h3ref, 1)} s`);
    if (par !== undefined && h3 !== null && par > PAR_SLACK_MAX * h3) r.warnings.push(`Par ${par} s liegt über ${PAR_SLACK_MAX} × 3°-Hand (${fmt(h3, 1)} s) — bedeutungslos`);
  }
  return r;
}

/**
 * Lektionsliste (training/index.json): ids über beide Indizes eindeutig, Nummer und Kurzname (Menü T1–T8)
 * über alle Lektionen eindeutig. Liefert ✗-Zeilen; `ids` bekommt die Lektions-ids dazu.
 */
export function trainingIndexProblems(lessons: readonly TrainingIndexEntry[], ids: Map<string, string>): string[] {
  const out: string[] = [];
  const numbers = new Map<number, string>();
  const shorts = new Map<string, string>();
  for (const e of lessons) {
    const f = `training/${e.file}`;
    if (ids.has(e.id)) out.push(`training/index.json: id "${e.id}" doppelt (auch in index.json oder zweimal)`);
    ids.set(e.id, f);
    const n = numbers.get(e.lesson);
    if (n !== undefined) out.push(`training/index.json: Lektionsnummer ${e.lesson} doppelt ("${n}" und "${e.id}")`);
    else numbers.set(e.lesson, e.id);
    const s = shorts.get(e.short);
    if (s !== undefined) out.push(`training/index.json: Kurzname "${e.short}" doppelt ("${s}" und "${e.id}")`);
    else shorts.set(e.short, e.id);
  }
  return out;
}

/** Auswahl für `levels:check -- <arg> …`: Dateien, Hinweise und ✗-Zeilen. */
export interface LevelSelection {
  readonly files: readonly string[];
  readonly notes: readonly string[];
  readonly errors: readonly string[];
}

/**
 * Welche Dateien `levels:check -- <arg> …` prüft. `listed` = Index-Dateien (inkl. sandbox.json und
 * training/…), `idOf` = Datei → id. Argument = id, Dateiname (mit/ohne .json) oder 'training' (alle
 * Lektionen); genau, kein Präfix (level1 ≠ level10). Ohne Index-Eintrag zählt eine vorhandene Datei
 * `<arg>.json` oder `training/<arg>.json` — `levels:build -- <id>` schreibt nur die Datei (Plan 007
 * Phase 2). Jedes Argument muss etwas treffen: ein Tippfehler oder ein Stub ohne JSON ist ein Fehler,
 * kein "0 Level, grün".
 */
export function selectLevels(only: readonly string[], listed: readonly string[], idOf: ReadonlyMap<string, string>, exists: (file: string) => boolean): LevelSelection {
  if (!only.length) return { files: [...listed], notes: [], errors: [] };
  const files: string[] = [];
  const notes: string[] = [];
  const errors: string[] = [];
  const pick = (f: string): void => {
    if (!files.includes(f)) files.push(f);
  };
  for (const o of only) {
    if (o === 'training') {
      const lessons = listed.filter((f) => f.startsWith('training/'));
      if (!lessons.length) errors.push(`training: keine Lektionen gefunden (training/index.json fehlt oder ist leer) — erst npm run levels:build -- training`);
      lessons.forEach(pick);
      continue;
    }
    const name = o.replace(/\.json$/, '');
    const hit = listed.find((f) => idOf.get(f) === o || f === o || f === `${name}.json` || f === `training/${name}.json`);
    if (hit) {
      pick(hit);
      continue;
    }
    const loose = [`${name}.json`, `training/${name}.json`].find(exists);
    if (loose) {
      notes.push(`(${loose} steht in keinem Index — geprüft, weil ausdrücklich angefragt)`);
      pick(loose);
      continue;
    }
    errors.push(`${o}: kein Level und keine Lektion gefunden (weder im Index noch ${LEVEL_DIR}/${name}.json oder training/${name}.json) — Tippfehler oder noch nicht gebaut?`);
  }
  return { files, notes, errors };
}

async function main(): Promise<void> {
  const indexPath = `${LEVEL_DIR}/index.json`;
  const files: string[] = [];
  let errors = 0;
  let warnings = 0;
  const indexIds = new Map<string, string>();
  if (existsSync(indexPath)) {
    const index = JSON.parse(readFileSync(indexPath, 'utf8')) as LevelIndexEntry[];
    for (const e of index) {
      files.push(e.file);
      if (indexIds.has(e.id)) {
        console.log(`✗ index.json: doppelte id "${e.id}"`);
        errors++;
      }
      indexIds.set(e.id, e.file);
    }
  } else {
    console.log(`✗ ${indexPath} fehlt — erst npm run levels:build`);
    errors++;
  }
  files.push('sandbox.json');
  // Lektionen des Trainingsmodus (Plan 007): public/levels/training/index.json, falls gebaut.
  const trainingIndex = `${LEVEL_DIR}/training/index.json`;
  if (existsSync(trainingIndex)) {
    const lessons = JSON.parse(readFileSync(trainingIndex, 'utf8')) as TrainingIndexEntry[];
    files.push(...lessons.map((e) => `training/${e.file}`));
    for (const l of trainingIndexProblems(lessons, indexIds)) {
      console.log(`✗ ${l}`);
      errors++;
    }
  }
  // Optional: nur bestimmte Level prüfen (`npm run levels:check -- level1`, `-- training`, `-- <Lektions-id>`), dann ohne Selbsttest.
  const only = process.argv.slice(2);
  const sel = selectLevels(only, files, new Map([...indexIds].map(([id, file]) => [file, id] as const)), (f) => existsSync(`${LEVEL_DIR}/${f}`));
  for (const l of sel.notes) console.log(l);
  for (const l of sel.errors) console.log(`✗ ${l}`);
  errors += sel.errors.length;
  const selected = sel.files;

  for (const f of selected) {
    const path = `${LEVEL_DIR}/${f}`;
    if (!existsSync(path)) {
      console.log(`\n✗ ${f}: Datei fehlt`);
      errors++;
      continue;
    }
    const def = JSON.parse(readFileSync(path, 'utf8')) as LevelFile;
    const t0 = performance.now();
    const r = validateLevel(f, def);
    for (const [id, file] of indexIds) if (file === f && id !== def.id) r.errors.push(`index.json: Eintrag "${id}" zeigt auf ${f}, dessen id "${def.id}" ist`);
    errors += r.errors.length;
    warnings += r.warnings.length;
    console.log(`\n${r.errors.length ? '✗' : '✓'} ${f} — ${def.name}${def.subtitle ? ` · ${def.subtitle}` : ''}  (${fmt((performance.now() - t0) / 1000, 1)} s)`);
    for (const l of r.info) console.log(`    ${l}`);
    for (const l of r.warnings) console.log(`  ! ${l}`);
    for (const l of r.errors) console.log(`  ✗ ${l}`);
  }

  // Selbsttest: der Validator muss eingebaute Fehler finden, sonst täuscht sein Grün.
  if (!only.length) {
    const { runSelftest } = await import('./levels/selftest');
    const self = runSelftest();
    console.log(`\n${self.failed ? '✗' : '✓'} Selbsttest: ${self.cases - self.failed}/${self.cases} eingebaute Fehler erkannt`);
    for (const l of self.lines) if (l.startsWith('✗')) console.log(`  ${l}`);
    errors += self.failed;
  }

  console.log(`\n${errors ? '✗' : '✓'} ${selected.length} Level, ${errors} Fehler, ${warnings} Warnungen`);
  if (errors) process.exitCode = 1;
}

// Nur als CLI laufen, nicht beim Import (Tests, andere Tools).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
