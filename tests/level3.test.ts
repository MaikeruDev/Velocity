/**
 * Level 3 "03 BRANDUNG" (Plan 007, Strang level3): die gebaute JSON (public/levels/level3.json, levels:build) und
 * die Geometrie des Builders. Schnell: kein Neubau mit Messung (der dauert ~12 s), nur Layout + zwei Bot-Läufe.
 * Die vollen Abnahmen (Raster, Proben, Gabel-Quoten) prüft `npm run levels:check -- level3`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compileLevel, type CompiledTrigger } from '../src/world/level/compileLevel';
import type { LevelFile, RouteNode } from '../src/world/level/LevelFormat';
import { layoutLevel3 } from '../tools/levels/level3';
import { FORK_SYNC1, kehreRidge, ridgeSide } from '../tools/levels/probes/level3';
import { flankTag, nodeInTrigger, resumeIndex, timedRun, withRoute } from '../tools/levels/physics';

const def = JSON.parse(readFileSync('public/levels/level3.json', 'utf8')) as LevelFile;
const level = compileLevel(def);
const lines: Array<[string, readonly RouteNode[]]> = [
  ['route', def.route ?? []],
  ['safeRoute', def.safeRoute ?? []],
];
const trigger = (kind: CompiledTrigger['kind'], order = 0): CompiledTrigger => {
  const t = level.triggers.find((x) => x.kind === kind && (kind !== 'checkpoint' || x.order === order));
  if (!t) throw new Error(`level3: kein Trigger ${kind} ${order}`);
  return t;
};

describe('Level 3 BRANDUNG: JSON', () => {
  it('Name, Untertitel und Mondflut-Licht (Mondfarbe #d6fff5)', () => {
    expect(def.id).toBe('level3');
    expect(def.name).toBe('03 BRANDUNG');
    expect(def.subtitle).toBe('Halt die Linie.');
    expect(def.environment.sunColor).toBe('#d6fff5');
    expect(def.training).toBeUndefined();
    // Reine Surf-Map: die Surf-Lektionen vorher (Menü "Empfohlen: T7/T8").
    expect(def.prepLessons).toEqual(['t7', 't8']);
  });

  it('Medaillen streng fallend, Par = Bronze aufgerundet, VELOCITY schneller als die sichere Linie erlaubt', () => {
    const m = def.medals;
    if (!m) throw new Error('level3 ohne Medaillen (npm run levels:build -- level3)');
    expect(m.bronze).toBeGreaterThan(m.silver);
    expect(m.silver).toBeGreaterThan(m.gold);
    expect(m.gold).toBeGreaterThan(m.velocity);
    expect(m.velocity).toBeGreaterThanOrEqual(m.author);
    expect(def.parTime).toBe(Math.ceil(m.bronze));
  });

  it('beide Linien beginnen im Start, passieren CP1–CP3 der Reihe nach und enden im Ziel', () => {
    const start = trigger('start');
    const finish = trigger('finish');
    for (const [name, route] of lines) {
      expect(route.length, name).toBeGreaterThan(20);
      expect(nodeInTrigger(route[0].pos, start), `${name}: erster Knoten im Start`).toBe(true);
      expect(nodeInTrigger(route[route.length - 1].pos, finish), `${name}: letzter Knoten im Ziel`).toBe(true);
      const at = [1, 2, 3].map((o) => resumeIndex(route, trigger('checkpoint', o)));
      for (const i of at) expect(i, `${name}: Wiedereinstieg je Checkpoint`).toBeGreaterThan(0);
      expect(at[0], name).toBeLessThan(at[1]);
      expect(at[1], name).toBeLessThan(at[2]);
    }
  });

  it('die Gabel: Koralle (route) links vom Grat auf den Innen-Stücken, Türkis (safeRoute) rechts auf den Außen-Stücken', () => {
    const route = def.route ?? [];
    const safe = def.safeRoute ?? [];
    expect(route[0].pos).toEqual(safe[0].pos);
    // Seite relativ zum GRAT (nächster Gratpunkt, Querabstand), nicht zu einem Kreismittelpunkt: jedes Viertel beginnt
    // per Überlappung früher, der Grat zieht sich zu (R 2000 → ~1790). Je Viertel mehrere Knoten auf der eigenen Flanke.
    const ridge = kehreRidge(def);
    expect(ridge.length).toBeGreaterThan(80);
    for (const [line, nodes, lane, sign] of [
      ['route', route, 'inner', -1],
      ['safeRoute', safe, 'outer', 1],
    ] as const) {
      const perQuarter = [0, 0, 0, 0];
      for (const n of nodes) {
        const tag = flankTag(level, n);
        const m = /^(inner|outer)([1-4])[a-z]$/.exec(tag);
        if (!m) continue;
        expect(m[1], `${line}: Knoten ${n.pos.join(',')} auf ${tag}`).toBe(lane);
        expect(Math.sign(ridgeSide(ridge, n.pos[0], n.pos[2]).lateral), `${line}: Seite am Grat bei ${tag}`).toBe(sign);
        perQuarter[Number(m[2]) - 1]++;
      }
      for (const [q, k] of perQuarter.entries()) expect(k, `${line}: Knoten in Viertel ${q + 1}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('Außenbande = unsichtbarer Clip mit Leuchtbalken in ihrer Hülle (Kollision wie die Vollwand)', () => {
    const banks = level.brushes.filter((b) => b.tag !== null && /^outerCatch\dBank$/.test(b.tag));
    const bars = level.brushes.filter((b) => b.tag !== null && /^outerCatch\dBar$/.test(b.tag));
    expect(banks.length).toBeGreaterThan(40);
    expect(bars.length).toBe(banks.length);
    for (const [i, b] of banks.entries()) {
      expect(b.collide && !b.visible, b.tag ?? '').toBe(true);
      const bar = bars[i];
      expect(!bar.collide && bar.visible && bar.mat === 'light').toBe(true);
      // Der Balken liegt ganz in der AABB seiner Bande (kein Teil ragt in die Flugbahn).
      expect(b.bounds.containsBox(bar.bounds), `${bar.tag} #${i}`).toBe(true);
    }
  });
});

describe('Level 3 BRANDUNG: Geometrie des Builders', () => {
  it('Kehre 180° (±1°): Tangente am Ende beider Bahnen und R1 zeigen zurück', () => {
    const lay = layoutLevel3();
    const w1 = lay.paths.w1.o.yaw;
    for (const lane of ['outer4', 'inner4']) expect(Math.abs(lay.paths[lane].endYaw - w1 - 180), lane).toBeLessThanOrEqual(1);
    expect(Math.abs(lay.paths.r1.o.yaw - w1 - 180)).toBeLessThanOrEqual(1);
  });

  it('Layout und gebaute JSON teilen die Kollision bis auf den Strand (levels:build nach jeder Builder-Änderung)', () => {
    // Nur der Strand (und seine Deko) hängt am gemessenen Tempo-Band (zweiter Bau); alles davor ist reine Geometrie.
    const lay = layoutLevel3().level;
    const beach = new Set(['finish', 'backstop']);
    const a = lay.brushes.filter((x) => x.collide !== false && !beach.has(x.tag ?? ''));
    const b = def.brushes.filter((x) => x.collide !== false && !beach.has(x.tag ?? ''));
    expect(b.length).toBe(a.length);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});

describe('Level 3 BRANDUNG: Physik (perfekter Bot, Spiel-Uhr)', () => {
  it('beide Linien ohne Tod im Ziel, Koralle spürbar schneller als Türkis', { timeout: 60000 }, () => {
    const fast = timedRun(level, { sync: 1 }, 1);
    const safe = timedRun(withRoute(level, 'safeRoute'), { sync: 1 }, 1);
    expect(fast.deaths).toBe(0);
    expect(safe.deaths).toBe(0);
    if (fast.time === null || safe.time === null) throw new Error(`nicht im Ziel: ${fast.reason} / ${safe.reason}`);
    expect(fast.splits.length).toBe(3);
    expect(safe.splits.length).toBe(3);
    expect(fast.time / safe.time).toBeLessThanOrEqual(FORK_SYNC1);
    // VELOCITY verlangt die Innenbahn.
    expect(def.medals?.velocity ?? 0).toBeLessThan(safe.time);
  });
});
