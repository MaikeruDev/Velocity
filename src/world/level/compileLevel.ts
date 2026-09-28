import { Box3, Vector3 } from 'three';
import { computeHull } from '../geometry/convexHull';
import { BrushWorld } from '../collision/BrushWorld';
import type { BrushFace, CompiledBrush, Plane } from '../collision/types';
import { MIN_GROUND_NORMAL_Y } from '../collision/types';
import type { BrushDef, GateDef, LevelFile, TrainingZoneDef, TriggerDef, TriggerKind, Vec3Tuple } from './LevelFormat';

export interface CompiledTrigger {
  readonly kind: TriggerKind;
  readonly bounds: Box3;
  readonly order: number;
  /** Respawn-Punkt (Füße) und Blickrichtung (Grad). */
  readonly spawnPos: Vector3;
  readonly spawnYaw: number;
  readonly tag: string | null;
}

/**
 * Brush im kompilierten Level. `faces` bleiben die geometrischen Flächen (Validator,
 * Bots, Proben brauchen sie auch bei Clips); gerendert und mit Trims versehen werden
 * nur sichtbare Brushes.
 */
export interface LevelBrush extends CompiledBrush {
  /** false = unsichtbarer Clip (LevelFormat.BrushCommon.visible): nur Kollision. */
  readonly visible: boolean;
  /** Leuchtband an der Unterkante (LevelFormat.BrushCommon.underTrim). */
  readonly underTrim: boolean;
}

/**
 * Tor einer Lektion (Plan 007, TrainingDef.gates): kollidiert, bis es offen ist. Liegt NICHT in
 * `world` — die GatedWorld (Phase 2) traced `brush` zusätzlich, solange das Tor zu ist.
 * Die Reihenfolge in CompiledLevel.gates ist der Index für Render (RenderFx.gateOpen) und Kollision.
 */
export interface CompiledGate {
  readonly id: string;
  /** Box-Brush des Tors; index = brushes.length + Tor-Index (eindeutig in TraceResult.brushIndex). */
  readonly brush: LevelBrush;
  readonly bounds: Box3;
  /** GateDef.tint, null = Trim-Farbe des Levels. */
  readonly tint: string | null;
}

export interface CompiledLevel {
  readonly def: LevelFile;
  readonly brushes: readonly LevelBrush[];
  readonly triggers: readonly CompiledTrigger[];
  readonly world: BrushWorld;
  readonly bounds: Box3;
  readonly spawnPos: Vector3;
  readonly spawnYaw: number;
  /** Tore der Lektion (leer ohne LevelFile.training). */
  readonly gates: readonly CompiledGate[];
  /** Zonen der Lektion nach id (leer ohne LevelFile.training). */
  readonly zones: ReadonlyMap<string, Box3>;
}

const WALKABLE = MIN_GROUND_NORMAL_Y;
const SURF_MIN = 0.05;

/** Punkte eines Primitivs in Weltkoordinaten, vor Rotation. */
export function primitivePoints(def: BrushDef): Vector3[] {
  switch (def.type) {
    case 'box': {
      const [x0, y0, z0] = def.min;
      const [x1, y1, z1] = def.max;
      assertOrdered(def.min, def.max, def.tag);
      return [
        new Vector3(x0, y0, z0), new Vector3(x1, y0, z0), new Vector3(x0, y0, z1), new Vector3(x1, y0, z1),
        new Vector3(x0, y1, z0), new Vector3(x1, y1, z0), new Vector3(x0, y1, z1), new Vector3(x1, y1, z1),
      ];
    }
    case 'wedge': {
      assertOrdered(def.min, def.max, def.tag);
      const [x0, y0, z0] = def.min;
      const [x1, y1, z1] = def.max;
      const low = def.lowY ?? y0;
      const pts = [new Vector3(x0, y0, z0), new Vector3(x1, y0, z0), new Vector3(x0, y0, z1), new Vector3(x1, y0, z1)];
      // Hohe und niedrige Oberkante.
      const hi: Vector3[] = [];
      const lo: Vector3[] = [];
      switch (def.rise) {
        case '+x': hi.push(new Vector3(x1, y1, z0), new Vector3(x1, y1, z1)); lo.push(new Vector3(x0, low, z0), new Vector3(x0, low, z1)); break;
        case '-x': hi.push(new Vector3(x0, y1, z0), new Vector3(x0, y1, z1)); lo.push(new Vector3(x1, low, z0), new Vector3(x1, low, z1)); break;
        case '+z': hi.push(new Vector3(x0, y1, z1), new Vector3(x1, y1, z1)); lo.push(new Vector3(x0, low, z0), new Vector3(x1, low, z0)); break;
        case '-z': hi.push(new Vector3(x0, y1, z0), new Vector3(x1, y1, z0)); lo.push(new Vector3(x0, low, z1), new Vector3(x1, low, z1)); break;
      }
      pts.push(...hi);
      if (low > y0 + 1e-3) pts.push(...lo);
      return pts;
    }
    case 'prism': {
      const pts: Vector3[] = [];
      for (const [a, y] of def.profile) {
        for (const t of [def.from, def.to]) {
          pts.push(def.axis === 'z' ? new Vector3(a, y, t) : new Vector3(t, y, a));
        }
      }
      return pts;
    }
    case 'hull':
      return def.points.map(([x, y, z]) => new Vector3(x, y, z));
  }
}

function assertOrdered(min: Vec3Tuple, max: Vec3Tuple, tag?: string): void {
  if (!(min[0] < max[0] && min[1] < max[1] && min[2] < max[2])) {
    throw new Error(`Brush ${tag ?? ''}: min ${JSON.stringify(min)} muss in allen Achsen < max ${JSON.stringify(max)} sein`);
  }
}

/** rotY (Grad) um pivot anwenden — gleiche Matrix wie three.js rotation.y. */
function applyRotation(points: Vector3[], def: BrushDef): void {
  if (!def.rotY) return;
  const box = new Box3().setFromPoints(points);
  const pivot = def.pivot ? new Vector3(...def.pivot) : box.getCenter(new Vector3());
  const a = (def.rotY * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  for (const p of points) {
    const x = p.x - pivot.x;
    const z = p.z - pivot.z;
    p.x = pivot.x + x * c + z * s;
    p.z = pivot.z - x * s + z * c;
  }
}

/**
 * Kanten-Bevels wie q3map `AddBrushBevels` (zweiter Teil): für jede schräge
 * Kante und jede Achsrichtung eine Ebene durch die Kante, die senkrecht zur
 * Achse steht — sofern der ganze Brush dahinter liegt.
 *
 * Ohne sie schießt die Minkowski-Aufblähung (Ebenen um die Box-Ausdehnung
 * verschoben) an schrägen Kanten über die echte Form hinaus: an Fugen zwischen
 * zwei Surf-Rampen oder am Grat entsteht ein unsichtbarer Keil, an dem man
 * hängen bleibt (der berüchtigte "Rampbug"). Mit Bevels ist der aufgeblähte
 * Körper für achsparallele Boxen exakt.
 */
function addEdgeBevels(
  faces: readonly { vertices: readonly Vector3[] }[],
  points: readonly Vector3[],
  planes: Plane[],
): void {
  const edge = new Vector3();
  const axis = new Vector3();
  const n = new Vector3();
  for (const f of faces) {
    const w = f.vertices;
    for (let j = 0; j < w.length; j++) {
      const a = w[j];
      const b = w[(j + 1) % w.length];
      edge.subVectors(b, a);
      if (edge.length() < 0.5) continue;
      edge.normalize();
      // Achsparallele Kanten sind durch die axialen Bevels abgedeckt.
      const ax = Math.abs(edge.x);
      const ay = Math.abs(edge.y);
      const az = Math.abs(edge.z);
      if (ax > 1 - 1e-6 || ay > 1 - 1e-6 || az > 1 - 1e-6) continue;
      for (let k = 0; k < 3; k++) {
        for (const dir of [-1, 1]) {
          axis.set(k === 0 ? dir : 0, k === 1 ? dir : 0, k === 2 ? dir : 0);
          n.crossVectors(edge, axis);
          const len = n.length();
          if (len < 0.5) continue;
          n.divideScalar(len);
          const dist = n.dot(a);
          // Gültig nur, wenn alle Brush-Punkte hinter der Ebene liegen.
          let valid = true;
          for (const p of points) {
            if (n.dot(p) - dist > 0.1) {
              valid = false;
              break;
            }
          }
          if (!valid) continue;
          if (planes.some((p) => p.normal.dot(n) > 1 - 1e-5 && Math.abs(p.dist - dist) < 0.05)) continue;
          planes.push({ normal: n.clone(), dist });
        }
      }
    }
  }
}

export function compileBrush(def: BrushDef, index: number): LevelBrush {
  const pts = primitivePoints(def);
  applyRotation(pts, def);
  let hull;
  try {
    hull = computeHull(pts);
  } catch (e) {
    throw new Error(`Brush #${index}${def.tag ? ` (${def.tag})` : ''}: ${(e as Error).message}`);
  }
  const bounds = new Box3().setFromPoints(hull.points);

  const faces: BrushFace[] = hull.faces.map((f) => {
    const plane: Plane = { normal: f.plane.normal, dist: f.plane.dist };
    const ny = f.plane.normal.y;
    return {
      vertices: f.vertices,
      normal: f.plane.normal,
      plane,
      walkable: ny >= WALKABLE,
      surf: ny > SURF_MIN && ny < WALKABLE,
    };
  });

  // Kollisionsebenen = Hüllenebenen + fehlende achsparallele Bevels.
  const planes: Plane[] = hull.planes.map((p) => ({ normal: p.normal, dist: p.dist }));
  const axial: Array<[Vector3, number]> = [
    [new Vector3(1, 0, 0), bounds.max.x],
    [new Vector3(-1, 0, 0), -bounds.min.x],
    [new Vector3(0, 1, 0), bounds.max.y],
    [new Vector3(0, -1, 0), -bounds.min.y],
    [new Vector3(0, 0, 1), bounds.max.z],
    [new Vector3(0, 0, -1), -bounds.min.z],
  ];
  for (const [normal, dist] of axial) {
    if (!planes.some((p) => p.normal.dot(normal) > 1 - 1e-6)) planes.push({ normal, dist });
  }
  addEdgeBevels(hull.faces, hull.points, planes);

  const hasWalkable = faces.some((f) => f.walkable);
  const visible = def.visible ?? true;
  // Ein unsichtbarer Brush, der nicht kollidiert, wäre wirkungslos — eher ein Tippfehler.
  if (!visible && def.collide === false) throw new Error(`Brush #${index}${def.tag ? ` (${def.tag})` : ''}: visible:false und collide:false — wirkungslos`);
  return {
    index,
    planes,
    faces,
    bounds,
    mat: def.mat,
    tint: def.tint ?? null,
    // Clips sind unsichtbar: keine Trims, auch nicht per trim:true.
    trim: visible && (def.trim ?? (hasWalkable && def.mat !== 'dark')),
    collide: def.collide ?? true,
    tag: def.tag ?? null,
    visible,
    underTrim: visible && def.underTrim === true,
  };
}

function compileTrigger(t: TriggerDef): CompiledTrigger {
  const bounds = new Box3(new Vector3(...t.min), new Vector3(...t.max));
  const center = bounds.getCenter(new Vector3());
  const spawnPos = t.spawn ? new Vector3(...t.spawn.pos) : new Vector3(center.x, bounds.min.y, center.z);
  return {
    kind: t.kind,
    bounds,
    order: t.order ?? 0,
    spawnPos,
    spawnYaw: t.spawn?.yaw ?? 0,
    tag: t.tag ?? null,
  };
}

function compileGate(g: GateDef, index: number): CompiledGate {
  // Tore sind Wände ohne eigene Optik im Brush-Renderer (gateVisuals zeichnet sie) und ohne Trims.
  const brush = compileBrush({ type: 'box', min: g.min, max: g.max, mat: 'wall', trim: false, tag: `gate:${g.id}` }, index);
  return { id: g.id, brush, bounds: brush.bounds.clone(), tint: g.tint ?? null };
}

function zoneBox(z: TrainingZoneDef): Box3 {
  assertOrdered(z.min, z.max, `zone:${z.id}`);
  return new Box3(new Vector3(...z.min), new Vector3(...z.max));
}

/** ids einer Lektion eindeutig — eine Map würde Doppelte still überschreiben. */
function assertUnique(ids: readonly string[], what: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`${what} "${id}" doppelt`);
    seen.add(id);
  }
}

export function compileLevel(def: LevelFile): CompiledLevel {
  if (def.version !== 1) throw new Error(`Unbekannte Level-Version ${String(def.version)}`);
  const brushes = def.brushes.map((b, i) => compileBrush(b, i));
  const triggers = def.triggers.map(compileTrigger).sort((a, b) => a.order - b.order);
  const bounds = new Box3();
  for (const b of brushes) bounds.union(b.bounds);
  const gateDefs = def.training?.gates ?? [];
  const zoneDefs = def.training?.zones ?? [];
  assertUnique(gateDefs.map((g) => g.id), 'Tor');
  assertUnique(zoneDefs.map((z) => z.id), 'Zone');
  const gates = gateDefs.map((g, i) => compileGate(g, brushes.length + i));
  const zones = new Map<string, Box3>();
  for (const z of zoneDefs) zones.set(z.id, zoneBox(z));
  return {
    def,
    brushes,
    triggers,
    world: new BrushWorld(brushes),
    bounds,
    spawnPos: new Vector3(...def.spawn.pos),
    spawnYaw: def.spawn.yaw,
    gates,
    zones,
  };
}

export async function loadLevel(url: string): Promise<CompiledLevel> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Level ${url}: HTTP ${res.status}`);
  return compileLevel((await res.json()) as LevelFile);
}
