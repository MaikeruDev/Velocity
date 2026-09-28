import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { compileLevel } from '../src/world/level/compileLevel';
import type { BrushDef, LevelFile, LevelIndexEntry } from '../src/world/level/LevelFormat';
import { buildTrims } from '../src/render/trims';

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
