import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { compileLevel } from '../src/world/level/compileLevel';
import type { BrushDef, LevelFile } from '../src/world/level/LevelFormat';
import type { CompiledBrush } from '../src/world/collision/types';

/**
 * Referenztest für die Minkowski-Aufblähung: testBox muss für jede Position
 * genau dann "solid" melden, wenn sich Box und Brush wirklich überlappen.
 * Die Referenz ist ein exakter Separating-Axis-Test. Ohne Kanten-Bevels
 * meldet testBox an schrägen Kanten Überlappung, wo keine ist (Phantom-Keil).
 */

const ENV: LevelFile['environment'] = {
  skyTop: '#000', skyHorizon: '#000', skyBottom: '#000', fogColor: '#000', fogNear: 0, fogFar: 1,
  sunDir: [0, 1, 0], sunColor: '#fff', ambientSky: '#fff', ambientGround: '#000', trimColor: '#fff', voidY: -1000,
};

const MINS = new Vector3(-16, 0, -16);
const MAXS = new Vector3(16, 72, 16);

function edgesOf(b: CompiledBrush): Vector3[] {
  const out: Vector3[] = [];
  for (const f of b.faces) {
    for (let i = 0; i < f.vertices.length; i++) {
      const d = new Vector3().subVectors(f.vertices[(i + 1) % f.vertices.length], f.vertices[i]).normalize();
      if (!out.some((e) => Math.abs(e.dot(d)) > 1 - 1e-6)) out.push(d);
    }
  }
  return out;
}

/** Vorzeichenbehafteter Abstand entlang der besten Trennachse: > 0 getrennt, < 0 überlappend. */
function satSeparation(b: CompiledBrush, pos: Vector3): number {
  const pts: Vector3[] = [];
  for (const f of b.faces) for (const v of f.vertices) pts.push(v);
  const boxMin = pos.clone().add(MINS);
  const boxMax = pos.clone().add(MAXS);
  const axes: Vector3[] = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];
  for (const f of b.faces) axes.push(f.normal.clone());
  for (const e of edgesOf(b)) {
    for (const a of [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)]) {
      const c = new Vector3().crossVectors(e, a);
      if (c.lengthSq() > 1e-8) axes.push(c.normalize());
    }
  }
  let best = -Infinity;
  for (const ax of axes) {
    let bMin = Infinity;
    let bMax = -Infinity;
    for (const p of pts) {
      const d = p.dot(ax);
      bMin = Math.min(bMin, d);
      bMax = Math.max(bMax, d);
    }
    // Box-Projektion: Zentrum ± Summe der Halbausdehnungen.
    const c = boxMin.clone().add(boxMax).multiplyScalar(0.5);
    const h = boxMax.clone().sub(boxMin).multiplyScalar(0.5);
    const r = Math.abs(ax.x) * h.x + Math.abs(ax.y) * h.y + Math.abs(ax.z) * h.z;
    const cMin = c.dot(ax) - r;
    const cMax = c.dot(ax) + r;
    const sep = Math.max(bMin - cMax, cMin - bMax);
    best = Math.max(best, sep);
  }
  return best;
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const CASES: Array<[string, BrushDef]> = [
  ['surf-prisma', { type: 'prism', axis: 'z', from: -200, to: 200, profile: [[-300, 0], [300, 0], [0, 420]], mat: 'surf' }],
  ['gedrehte surf', { type: 'prism', axis: 'x', from: -200, to: 200, profile: [[-250, 0], [250, 0], [0, 400]], mat: 'surf', rotY: 30 }],
  ['keil', { type: 'wedge', min: [-200, 0, -150], max: [200, 180, 150], rise: '+x', mat: 'floor' }],
  ['gedrehte box', { type: 'box', min: [-120, 0, -80], max: [120, 100, 80], mat: 'wall', rotY: 37 }],
  ['hülle', { type: 'hull', points: [[-150, 0, -150], [150, 0, -120], [0, 0, 180], [20, 260, 10], [-60, 120, 60]], mat: 'wall' }],
];

describe('Kanten-Bevels: testBox == exakte Überlappung', () => {
  for (const [name, def] of CASES) {
    it(name, () => {
      const lvl = compileLevel({
        version: 1, id: 't', name: 't', spawn: { pos: [0, 0, 0], yaw: 0 }, killY: -500, environment: ENV,
        brushes: [def], triggers: [],
      });
      const b = lvl.brushes[0];
      const r = rng(1234);
      const bb = b.bounds;
      let checked = 0;
      let phantom = 0;
      let missed = 0;
      for (let i = 0; i < 6000; i++) {
        const pos = new Vector3(
          bb.min.x - 40 + r() * (bb.max.x - bb.min.x + 80),
          bb.min.y - 90 + r() * (bb.max.y - bb.min.y + 100),
          bb.min.z - 40 + r() * (bb.max.z - bb.min.z + 80),
        );
        const sep = satSeparation(b, pos);
        if (Math.abs(sep) < 0.5) continue; // Epsilon-Zone nicht bewerten
        checked++;
        const solid = lvl.world.testBox(pos, MINS, MAXS);
        if (solid && sep > 0) phantom++;
        if (!solid && sep < 0) missed++;
      }
      expect(checked).toBeGreaterThan(3000);
      expect(missed).toBe(0);
      expect(phantom).toBe(0);
    });
  }
});
