import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { compileLevel } from '../src/world/level/compileLevel';
import type { BrushDef, LevelFile } from '../src/world/level/LevelFormat';
import { DIST_EPSILON } from '../src/world/collision/types';

const ENV: LevelFile['environment'] = {
  skyTop: '#000', skyHorizon: '#000', skyBottom: '#000', fogColor: '#000', fogNear: 0, fogFar: 1,
  sunDir: [0, 1, 0], sunColor: '#fff', ambientSky: '#fff', ambientGround: '#000', trimColor: '#fff', voidY: -1000,
};

function level(brushes: BrushDef[]): LevelFile {
  return { version: 1, id: 't', name: 't', spawn: { pos: [0, 0, 0], yaw: 0 }, killY: -500, environment: ENV, brushes, triggers: [] };
}

const MINS = new Vector3(-16, 0, -16);
const MAXS = new Vector3(16, 72, 16);

describe('BrushWorld.traceBox', () => {
  const lvl = compileLevel(level([
    { type: 'box', min: [-512, -64, -512], max: [512, 0, 512], mat: 'floor', tag: 'floor' },
    { type: 'box', min: [100, 0, -512], max: [164, 256, 512], mat: 'wall', tag: 'wall' },
    { type: 'wedge', min: [-400, 0, -100], max: [-200, 100, 100], rise: '-x', mat: 'floor', tag: 'ramp' },
    { type: 'prism', axis: 'z', from: 300, to: 500, profile: [[-300, 0], [-100, 0], [-200, 200]], mat: 'surf', tag: 'surf' },
  ]));
  const w = lvl.world;

  it('landet auf dem Boden und hält DIST_EPSILON Abstand', () => {
    const tr = w.traceBox(new Vector3(0, 100, 0), new Vector3(0, -100, 0), MINS, MAXS);
    expect(tr.fraction).toBeLessThan(1);
    expect(tr.normal.y).toBeCloseTo(1);
    expect(tr.endPos.y).toBeGreaterThan(0);
    expect(tr.endPos.y).toBeLessThan(DIST_EPSILON * 2);
    expect(tr.startSolid).toBe(false);
  });

  it('stoppt an der Wand mit Box-Ausdehnung', () => {
    const tr = w.traceBox(new Vector3(0, 10, 0), new Vector3(200, 10, 0), MINS, MAXS);
    expect(tr.normal.x).toBeCloseTo(-1);
    expect(tr.endPos.x).toBeCloseTo(100 - 16, 1);
  });

  it('erkennt Startposition im Solid', () => {
    expect(w.testBox(new Vector3(120, 10, 0), MINS, MAXS)).toBe(true);
    expect(w.testBox(new Vector3(0, 1, 0), MINS, MAXS)).toBe(false);
  });

  it('Rampe liefert schräge, begehbare Normale', () => {
    const ramp = lvl.brushes.find((b) => b.tag === 'ramp')!;
    const top = ramp.faces.find((f) => f.normal.y > 0.1 && f.normal.y < 0.99)!;
    expect(top.walkable).toBe(true);
    expect(top.normal.x).toBeGreaterThan(0); // steigt nach -x → Normale zeigt nach +x
    const tr = w.traceBox(new Vector3(-300, 200, 0), new Vector3(-300, 0, 0), MINS, MAXS);
    expect(tr.normal.y).toBeCloseTo(top.normal.y, 3);
  });

  it('Surf-Flanke ist zu steil zum Stehen', () => {
    const surf = lvl.brushes.find((b) => b.tag === 'surf')!;
    const flanks = surf.faces.filter((f) => f.surf);
    expect(flanks.length).toBe(2);
    for (const f of flanks) expect(f.walkable).toBe(false);
  });

  it('gedrehte Box kollidiert entlang ihrer gedrehten Fläche', () => {
    const rot = compileLevel(level([{ type: 'box', min: [-50, 0, -50], max: [50, 100, 50], mat: 'wall', rotY: 45 }]));
    const tr = rot.world.traceBox(new Vector3(-300, 10, 0), new Vector3(0, 10, 0), MINS, MAXS);
    expect(tr.fraction).toBeLessThan(1);
    // Die Ecke der gedrehten Box zeigt nach -x: Minkowski-Summe mit Bevel → Normale -x.
    expect(tr.endPos.x).toBeLessThan(-50 * Math.SQRT2 + 1);
    expect(tr.endPos.x).toBeGreaterThan(-50 * Math.SQRT2 - 16 - 1);
  });

  it('Faces sind CCW von außen', () => {
    for (const b of lvl.brushes) {
      for (const f of b.faces) {
        const [a, bb, c] = f.vertices;
        const n = new Vector3().subVectors(bb, a).cross(new Vector3().subVectors(c, a)).normalize();
        expect(n.dot(f.normal)).toBeGreaterThan(0.99);
      }
    }
  });
});
