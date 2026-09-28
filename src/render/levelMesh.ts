import { Box3, BufferAttribute, BufferGeometry, Vector3 } from 'three';
import type { BrushFace, CompiledBrush } from '../world/collision/types';
import type { CompiledLevel, CompiledTrigger } from '../world/level/compileLevel';
import type { MaterialId } from '../world/level/LevelFormat';
import { defaultTint } from './palette';
import { tessellateFace } from './tessellate';
import { TEXTURE_WORLD_SIZE } from './textures';
import { hash3, hexToRgb, smoothstep } from './util';
import type { Rgb } from './util';

/** Zellgröße der Tesselierung (look.md: ~64 u). */
export const TESS_CELL = 64;

/**
 * Wachsende Attribut-Puffer einer gemergten Geometrie. Plain-Arrays statt
 * vorberechneter TypedArrays, weil die Endgröße erst nach der Tesselierung feststeht
 * (läuft nur beim Level-Laden).
 */
class GeometryBuilder {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly uv: number[] = [];
  readonly tint: number[] = [];
  readonly shade: number[] = [];
  readonly top: number[] = [];
  readonly idx: number[] = [];
  vertexCount = 0;

  build(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.nrm), 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array(this.uv), 2));
    g.setAttribute('aTint', new BufferAttribute(new Float32Array(this.tint), 3));
    g.setAttribute('aShade', new BufferAttribute(new Float32Array(this.shade), 3));
    g.setAttribute('aTop', new BufferAttribute(new Float32Array(this.top), 1));
    const index = this.vertexCount > 65535 ? new Uint32Array(this.idx) : new Uint16Array(this.idx);
    g.setIndex(new BufferAttribute(index, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/**
 * Grobes XZ-Raster über die Brush-Bounds (um `pad` erweitert) für AO- und
 * Trim-Nachbarschaftsabfragen — sonst O(Vertices × Brushes) beim Laden.
 */
export class BrushGrid {
  private readonly size = 512;
  private readonly cells = new Map<string, number[]>();

  constructor(private readonly brushes: readonly CompiledBrush[], pad: number) {
    brushes.forEach((b, i) => {
      const x0 = Math.floor((b.bounds.min.x - pad) / this.size);
      const x1 = Math.floor((b.bounds.max.x + pad) / this.size);
      const z0 = Math.floor((b.bounds.min.z - pad) / this.size);
      const z1 = Math.floor((b.bounds.max.z + pad) / this.size);
      for (let x = x0; x <= x1; x++) {
        for (let z = z0; z <= z1; z++) {
          const key = `${x},${z}`;
          const list = this.cells.get(key);
          if (list) list.push(i);
          else this.cells.set(key, [i]);
        }
      }
    });
  }

  near(x: number, z: number): readonly CompiledBrush[] {
    const list = this.cells.get(`${Math.floor(x / this.size)},${Math.floor(z / this.size)}`);
    return list ? list.map((i) => this.brushes[i]) : [];
  }
}

const AO_RADIUS = 72;

function distXZToBox(x: number, z: number, b: Box3): number {
  const dx = Math.max(b.min.x - x, 0, x - b.max.x);
  const dz = Math.max(b.min.z - z, 0, z - b.max.z);
  return Math.hypot(dx, dz);
}

/**
 * Gebackene "Radiosity": Kontaktschatten am Fuß aufragender Nachbar-Brushes,
 * Verschattung unter Überhängen, dunkle Unterseiten, Wände unten dunkler.
 * Absichtlich grob (Stützstellen alle 64 u) — genau das ergibt den PS2-Look.
 */
function ambientOcclusion(p: Vector3, ny: number, brush: CompiledBrush, grid: BrushGrid): number {
  if (ny < -0.3) return 0.42;
  if (ny < 0.7) {
    // Seiten- und Surf-Flächen: vom Brush-Fuß nach oben aufhellen.
    const h = brush.bounds.max.y - brush.bounds.min.y;
    const t = smoothstep(0, Math.min(h, 192), p.y - brush.bounds.min.y);
    return 0.62 + 0.38 * t;
  }
  let ao = 1;
  for (const b of grid.near(p.x, p.z)) {
    if (b === brush) continue;
    const d = distXZToBox(p.x, p.z, b.bounds);
    if (d > AO_RADIUS) continue;
    if (b.bounds.max.y > p.y + 8 && b.bounds.min.y < p.y + 4 && b.bounds.min.y > p.y - 512) {
      // Nachbar ragt aus dieser Fläche auf → Kontaktschatten.
      ao = Math.min(ao, 0.55 + 0.45 * smoothstep(0, AO_RADIUS, d));
    } else if (b.bounds.min.y >= p.y + 4 && b.bounds.min.y < p.y + 200 && d < 16) {
      // Überhang (Duck-Tunnel-Decke o. Ä.) → darunter dunkler, je niedriger desto mehr.
      ao = Math.min(ao, 0.5 + 0.5 * smoothstep(30, 200, b.bounds.min.y - p.y));
    }
  }
  return ao;
}

/** Leichte Höhentönung: tief unten kühler/bläulicher, oben neutral-warm. */
function heightTint(y: number, out: Rgb): Rgb {
  const t = smoothstep(-700, 300, y);
  out[0] = 0.8 + (1.04 - 0.8) * t;
  out[1] = 0.84 + (1.0 - 0.84) * t;
  out[2] = 1.1 + (0.96 - 1.1) * t;
  return out;
}

/**
 * Laufrichtung für die Richtungs-Chevrons auf Start-/Checkpoint-Oberseiten, auf
 * 90° gerundet (Viertelumdrehungen 0..3, three-Yaw: 0 = −Z, 1 = −X, 2 = +Z, 3 = +X).
 * Die Chevrons zeigen in der Textur nach Welt −Z; die UV wird darum gedreht.
 * Start: Level-Spawn. Checkpoint: Respawn-Yaw des Triggers, in dem die Oberseite
 * liegt — ohne expliziten spawn Richtung nächster Checkpoint/Ziel.
 */
export function markingQuarterTurns(brush: CompiledBrush, level: CompiledLevel): number {
  let yaw = level.spawnYaw;
  if (brush.mat === 'checkpoint') {
    const t = checkpointOf(brush, level);
    if (t) yaw = checkpointYaw(t, level) ?? yaw;
  }
  return (((Math.round(yaw / 90) % 4) + 4) % 4);
}

function checkpointOf(brush: CompiledBrush, level: CompiledLevel): CompiledTrigger | null {
  const b = brush.bounds;
  let best: CompiledTrigger | null = null;
  let bestArea = 0;
  for (const t of level.triggers) {
    if (t.kind !== 'checkpoint') continue;
    const tb = t.bounds;
    // Oberseite muss im Höhenbereich der Zone liegen (Trigger beginnt meist genau auf ihr).
    if (b.max.y < tb.min.y - 16 || b.max.y > tb.max.y) continue;
    const w = Math.min(b.max.x, tb.max.x) - Math.max(b.min.x, tb.min.x);
    const d = Math.min(b.max.z, tb.max.z) - Math.max(b.min.z, tb.min.z);
    if (w <= 0 || d <= 0 || w * d <= bestArea) continue;
    best = t;
    bestArea = w * d;
  }
  return best;
}

function checkpointYaw(t: CompiledTrigger, level: CompiledLevel): number | null {
  // spawnYaw ist ohne spawn-Angabe 0 — ob er gesetzt wurde, steht nur im Level-JSON.
  const def = level.def.triggers.find((d) => d.kind === 'checkpoint' && (d.order ?? 0) === t.order);
  if (def?.spawn) return t.spawnYaw;
  const next =
    level.triggers.find((o) => o.kind === 'checkpoint' && o.order > t.order) ??
    level.triggers.find((o) => o.kind === 'finish');
  if (!next) return null;
  const dx = (next.bounds.min.x + next.bounds.max.x - t.bounds.min.x - t.bounds.max.x) / 2;
  const dz = (next.bounds.min.z + next.bounds.max.z - t.bounds.min.z - t.bounds.max.z) / 2;
  if (Math.abs(dx) < 1e-3 && Math.abs(dz) < 1e-3) return null;
  // Blickrichtung (−sin yaw, −cos yaw) = (dx, dz) normiert.
  return (Math.atan2(-dx, -dz) * 180) / Math.PI;
}

/**
 * UV-Rahmen einer Surf-Flanke: u entlang der (waagerechten) Gratrichtung in
 * Welt-Units, v = Tiefe unter dem Grat als Anteil der Flankenhöhe (0 am Grat,
 * 1 am Fuß). Die Streifen der Surf-Textur laufen so parallel zum Grat und die
 * Lichtbahn liegt auf jeder Flanke auf derselben relativen Höhe (textures.surfTex).
 * Stücke einer Kette (gleiche Achse, gleiches Profil) setzen die UV nahtlos fort.
 * null, wenn die Fläche keine Gratkante mit einer anderen Surf-Fläche teilt.
 */
interface FlankFrame {
  readonly ux: number;
  readonly uz: number;
  readonly o: Vector3;
  readonly down: Vector3;
  readonly invSlant: number;
}

function surfFlankFrame(brush: CompiledBrush, face: BrushFace): FlankFrame | null {
  if (!face.surf) return null;
  const v = face.vertices;
  for (let i = 0; i < v.length; i++) {
    const a = v[i];
    const b = v[(i + 1) % v.length];
    const adj = brush.faces.find((f) => f !== face && f.surf && f.normal.y > 0 && f.vertices.some((w) => w.distanceToSquared(a) < 0.01) && f.vertices.some((w) => w.distanceToSquared(b) < 0.01));
    if (!adj) continue;
    const dir = new Vector3().subVectors(b, a);
    const h = Math.hypot(dir.x, dir.z);
    if (h < 1e-6) continue;
    const down = new Vector3().crossVectors(dir.normalize(), face.normal).normalize();
    if (down.y > 0) down.negate();
    let slant = 0;
    for (const w of v) slant = Math.max(slant, new Vector3().subVectors(w, a).dot(down));
    if (slant < 1) continue;
    // Gratrichtung waagerecht und mit fester Orientierung (u wächst nach −z bzw. +x), damit Nachbarstücke passen.
    let ux = (b.x - a.x) / h;
    let uz = (b.z - a.z) / h;
    if (uz > 1e-6 || (Math.abs(uz) <= 1e-6 && ux < 0)) {
      ux = -ux;
      uz = -uz;
    }
    return { ux, uz, o: a, down, invSlant: 1 / slant };
  }
  return null;
}

/** cos/sin der Viertelumdrehungen — exakt, damit die UVs auf dem 256-u-Raster bleiben. */
const QUARTER_COS = [1, 0, -1, 0] as const;
const QUARTER_SIN = [0, 1, 0, -1] as const;

export interface LevelMeshes {
  readonly byMaterial: ReadonlyMap<MaterialId, BufferGeometry>;
  readonly triangleCount: number;
}

export function buildLevelMeshes(level: CompiledLevel): LevelMeshes {
  const builders = new Map<MaterialId, GeometryBuilder>();
  // Unsichtbare Clips (LevelBrush.visible) werfen keinen Kontaktschatten und werden nicht gezeichnet;
  // Bodenmarkierungen (mat 'marking') malt trims.ts als Leuchtfläche.
  const shown = level.brushes.filter((b) => b.visible && b.mat !== 'marking');
  const grid = new BrushGrid(shown, AO_RADIUS);
  const ht: Rgb = [1, 1, 1];
  const inv = 1 / TEXTURE_WORLD_SIZE;
  let triangles = 0;

  for (const brush of shown) {
    let gb = builders.get(brush.mat);
    if (!gb) {
      gb = new GeometryBuilder();
      builders.set(brush.mat, gb);
    }
    const tint = hexToRgb(brush.tint ?? defaultTint(brush.mat));
    const topY = brush.bounds.max.y;
    const marked = brush.mat === 'start' || brush.mat === 'checkpoint';
    const turns = marked ? markingQuarterTurns(brush, level) : 0;
    const qc = QUARTER_COS[turns];
    const qs = QUARTER_SIN[turns];

    for (const face of brush.faces) {
      const n = face.normal;
      const ax = Math.abs(n.x);
      const ay = Math.abs(n.y);
      const az = Math.abs(n.z);
      const isTop = n.y > 0.05 ? 1 : 0;
      const pieces = tessellateFace(face.vertices, n, TESS_CELL);
      const flank = brush.mat === 'surf' ? surfFlankFrame(brush, face) : null;

      for (const piece of pieces) {
        const base = gb.vertexCount;
        for (const p of piece) {
          gb.pos.push(p.x, p.y, p.z);
          gb.nrm.push(n.x, n.y, n.z);
          // Weltprojektion nach dominanter Achse, von außen betrachtet nicht gespiegelt.
          // Seiten: v relativ zur Brush-Oberkante, damit Lippen/Streifen unter der Kante sitzen.
          if (flank) {
            // Grat = Texturzeile 0 (knapp unter v = 0), Fuß = Zeile 63.
            const depth = (p.x - flank.o.x) * flank.down.x + (p.y - flank.o.y) * flank.down.y + (p.z - flank.o.z) * flank.down.z;
            gb.uv.push((p.x * flank.ux + p.z * flank.uz) * inv, -depth * flank.invSlant);
          } else if (ay >= ax && ay >= az) {
            if (n.y >= 0) {
              // Oberseite: u = rechts, v = vorwärts der Laufrichtung (ungedreht x / −z).
              gb.uv.push((p.x * qc - p.z * qs) * inv, (-p.x * qs - p.z * qc) * inv);
            } else {
              gb.uv.push(p.x * inv, p.z * inv);
            }
          } else if (ax >= az) {
            gb.uv.push(-p.z * Math.sign(n.x) * inv, (p.y - topY) * inv);
          } else {
            gb.uv.push(p.x * Math.sign(n.z) * inv, (p.y - topY) * inv);
          }
          const variation = 0.94 + 0.12 * hash3(p.x, p.y, p.z);
          gb.tint.push(tint[0] * variation, tint[1] * variation, tint[2] * variation);
          const ao = ambientOcclusion(p, n.y, brush, grid);
          heightTint(p.y, ht);
          gb.shade.push(ao * ht[0], ao * ht[1], ao * ht[2]);
          gb.top.push(isTop);
        }
        for (let i = 1; i + 1 < piece.length; i++) {
          gb.idx.push(base, base + i, base + i + 1);
          triangles++;
        }
        gb.vertexCount += piece.length;
      }
    }
  }

  const byMaterial = new Map<MaterialId, BufferGeometry>();
  for (const [mat, gb] of builders) {
    if (gb.vertexCount > 0) byMaterial.set(mat, gb.build());
  }
  return { byMaterial, triangleCount: triangles };
}
