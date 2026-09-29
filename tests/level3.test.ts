/**
 * Level 3 "03 BRANDUNG" (Plan 007, Strang level3): die gebaute JSON (public/levels/level3.json, levels:build) und
 * die Geometrie des Builders. Schnell: kein Neubau mit Messung (der dauert ~12 s), nur Layout + wenige Läufe.
 * Die vollen Abnahmen (Raster, Proben, Gabel-Quoten, Mensch-Band) prüft `npm run levels:check -- level3`.
 */
import { readFileSync } from 'node:fs';
import { Box3, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { VELOCITY_DEFAULT } from '../src/player/MovementConfig';
import { compileLevel, type CompiledTrigger } from '../src/world/level/compileLevel';
import type { HullDef, LevelFile, RouteNode, Vec3Tuple } from '../src/world/level/LevelFormat';
import { layoutLevel3 } from '../tools/levels/level3';
import { FORK_SYNC1, GLIDE_JOINTS, GLIDE_LOSS, bankGlide, humanCtx, humanRun, kehreRidge, ridgeSide, wHolder } from '../tools/levels/probes/level3';
import { flankTag, nextGoal, nodeInTrigger, resumeIndex, timedRun, withRoute } from '../tools/levels/physics';

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
const hulls = (re: RegExp): HullDef[] => def.brushes.filter((b): b is HullDef => b.type === 'hull' && b.tag !== undefined && re.test(b.tag));

/**
 * Wie weit liegt Punkt `q` VOR der Fläche durch `a` → `b` (waagrecht, u)? `toward` zeigt zur Seite, von der man an
 * die Fläche fährt; negativ = dahinter (verdeckt).
 */
const ahead = (a: Vec3Tuple, b: Vec3Tuple, toward: readonly [number, number], q: Vec3Tuple): number => {
  const ux = b[0] - a[0];
  const uz = b[2] - a[2];
  const l = Math.hypot(ux, uz);
  // Normale der Fläche, zur Fahrseite orientiert.
  let nx = -uz / l;
  let nz = ux / l;
  if (nx * toward[0] + nz * toward[1] < 0) [nx, nz] = [-nx, -nz];
  return (q[0] - b[0]) * nx + (q[2] - b[2]) * nz;
};

describe('Level 3 BRANDUNG: JSON', () => {
  it('Name, Untertitel und Mondflut-Licht (Mond in #d6fff5)', () => {
    expect(def.id).toBe('level3');
    expect(def.name).toBe('03 BRANDUNG');
    expect(def.subtitle).toBe('Halt die Linie.');
    expect(def.environment.sunColor).toBe('#d6fff5');
    // Ohne das Flag rendert sky.ts die Scheibe als warme Sonne (Phase 3).
    expect(def.environment.moon).toBe(true);
    expect(def.training).toBeUndefined();
    // Reine Surf-Map: die Surf-Lektionen vorher (Menü "Empfohlen: T7/T8").
    expect(def.prepLessons).toEqual(['t7', 't8']);
  });

  it('Medaillen streng fallend, Par = Bronze aufgerundet', () => {
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

  it('Außenbande ohne Lippe: jede Bank beginnt ≥ 2 u HINTER der Innenfläche der vorigen (W1-Band bis Viertel 4, auch über die Fugen)', () => {
    // catchBand-Punkte: oben innen 0, oben außen 1 (Fuge a), 4/5 (Fuge b). Review Phase 3: Folgeviertel 1.5 u davor.
    // Fahrreihenfolge = Bandnummer (das W1-Band outerCatch0 steht in der JSON hinten), darin Brush-Reihenfolge.
    const quarter = (h: HullDef): number => Number(/^outerCatch(\d)Bank$/.exec(h.tag ?? '')?.[1] ?? -1);
    const banks = hulls(/^outerCatch[0-4]Bank$/).sort((a, b) => quarter(a) - quarter(b));
    expect(quarter(banks[0])).toBe(0);
    for (let i = 1; i < banks.length; i++) {
      const [p, q] = [banks[i - 1].points, banks[i].points];
      const toBand: [number, number] = [p[4][0] - p[5][0], p[4][2] - p[5][2]];
      expect(ahead(p[0], p[4], toBand, q[0]), `${banks[i].tag} #${i}`).toBeLessThanOrEqual(-2);
    }
  });

  it('Grat-Bande Koralle-seitig als Sägezahn: jedes Stück beginnt ≥ 2 u hinter dem Ende des vorigen (W1-Finne bis Viertel 4)', () => {
    // Punkte je Fuge: oben/unten Türkis (0/1), oben/unten Koralle (2/3); Fuge b 4–7. Im konkaven Knick zweier Facetten +
    // Innenflanke nullte Source das Tempo (735 → 3 u/s, Surf-Raster).
    const rails = hulls(/^(w1|outer[1-4][a-z])-rail$/);
    expect(rails[0].tag).toBe('w1-rail');
    expect(rails.length).toBeGreaterThan(40);
    for (let i = 1; i < rails.length; i++) {
      const [p, q] = [rails[i - 1].points, rails[i].points];
      const toKoralle: [number, number] = [p[7][0] - p[5][0], p[7][2] - p[5][2]];
      expect(ahead(p[2], p[6], toKoralle, q[2]), `${rails[i].tag}`).toBeLessThanOrEqual(-2);
    }
  });

  it('Finale-Schürze: setzt beide Flanken der Kicker-Stücke in ihrer Ebene fort, oberer Rand = deren Fuß (punktgleich)', () => {
    // Stück: [Grat a, links a, rechts a, Grat b, links b, rechts b]; Schürze: [Fuß links/rechts a, außen links/rechts a, … b].
    const pieces = hulls(/^finale[a-z]$/);
    const skirts = hulls(/^finale-skirt$/);
    expect(skirts.length).toBe(pieces.length);
    const off = (a: Vec3Tuple, b: Vec3Tuple, c: Vec3Tuple, q: Vec3Tuple): number => {
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const l = Math.hypot(n[0], n[1], n[2]);
      return Math.abs((q[0] - a[0]) * n[0] + (q[1] - a[1]) * n[1] + (q[2] - a[2]) * n[2]) / l;
    };
    for (const [i, s] of skirts.entries()) {
      const p = pieces[i].points;
      const q = s.points;
      expect([q[0], q[1], q[4], q[5]], `Stück ${i}`).toEqual([p[1], p[2], p[4], p[5]]);
      // Außenkanten in den Flankenebenen (links: Grat a, Grat b, links a; rechts entsprechend).
      for (const k of [2, 6]) expect(off(p[0], p[3], p[1], q[k]), `Stück ${i} links`).toBeLessThan(0.05);
      for (const k of [3, 7]) expect(off(p[0], p[3], p[2], q[k]), `Stück ${i} rechts`).toBeLessThan(0.05);
    }
  });

  it('Checkpoint-Plattformen schweben über der Grat-Bande: kein Pad sitzt auf dem Grat', () => {
    const pads = hulls(/^cp[1-3]pad$/);
    expect(pads.length).toBe(3);
    for (const pad of pads) {
      // Unter der Plattformmitte (Mittel der Eckpunkte, Probe so breit wie die Hull) erst ≥ 7 u Luft, dann die
      // Bande — nicht der Grat einer Rampe wie beim alten Keil-Pad.
      const n = pad.points.length;
      const cx = pad.points.reduce((a, q) => a + q[0], 0) / n;
      const cz = pad.points.reduce((a, q) => a + q[2], 0) / n;
      const from = new Vector3(cx, Math.min(...pad.points.map((q) => q[1])) - 1, cz);
      const tr = level.world.traceBox(from, new Vector3(cx, from.y - 100, cz), new Vector3(-16, 0, -16), new Vector3(16, 1, 16));
      expect(tr.fraction, `${pad.tag}: nichts unter der Plattform`).toBeLessThan(1);
      expect(level.brushes[tr.brushIndex]?.tag ?? '', pad.tag).toMatch(/-rail$/);
      expect(from.y - tr.endPos.y, pad.tag).toBeGreaterThanOrEqual(7);
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

describe('Level 3 BRANDUNG: Physik', () => {
  it('perfekter Bot: beide Linien ohne Tod im Ziel, Koralle spürbar schneller, VELOCITY nur innen', { timeout: 60000 }, () => {
    const fast = timedRun(level, { sync: 1 }, 1);
    const safe = timedRun(withRoute(level, 'safeRoute'), { sync: 1 }, 1);
    expect(fast.deaths).toBe(0);
    expect(safe.deaths).toBe(0);
    if (fast.time === null || safe.time === null) throw new Error(`nicht im Ziel: ${fast.reason} / ${safe.reason}`);
    expect(fast.splits.length).toBe(3);
    expect(safe.splits.length).toBe(3);
    expect(fast.time / safe.time).toBeLessThanOrEqual(FORK_SYNC1);
    // VELOCITY verlangt die Innenbahn (für den RouteFollower; die Grundtechnik ist schneller, siehe level3.md).
    expect(def.medals?.velocity ?? 0).toBeLessThan(safe.time);
  });

  it('Grundtechnik vom Brett (Koralle −2.5°/0° ab x −160, Türkis 0° ab x +160): kein Checkpoint-Pad, kein Einbruch, im Ziel', () => {
    // Review Phase 3: am Drop lagen die Pads im Flugband (1114 → 80 u/s, über das Pad auf die andere Bahn).
    const ctx = humanCtx(level);
    for (const [x, look] of [
      [-160, -2.5],
      [-160, 0],
      [160, 0],
    ] as const) {
      const h = humanRun(level, ctx, new Vector3(x, level.spawnPos.y + 1, level.spawnPos.z), null, null, { look, lag: 0, sigma: 1, seed: 1 }, VELOCITY_DEFAULT);
      expect(h.pads, `x ${x} Blick ${look}°`).toEqual([]);
      expect(h.collapse, `x ${x} Blick ${look}°`).toBeNull();
      expect(h.reason, `x ${x} Blick ${look}°`).toBe('ziel');
    }
  });

  it('Türkis-Bandfahrer (Grundtechnik vom Spawn, Blick −2.5°) kommen nach CP3 ins Ziel — die Finale-Schürze fängt sie', () => {
    // Ohne Schürze starben diese Läufe alle nach CP3 seitlich am Kicker (91/216 der Türkis-Brettläufe im Mensch-Band).
    const ctx = humanCtx(level);
    for (const seed of [1, 2]) {
      const h = humanRun(level, ctx, new Vector3(level.spawnPos.x, level.spawnPos.y + 1, level.spawnPos.z), null, null, { look: -2.5, lag: 0, sigma: 1, seed }, VELOCITY_DEFAULT);
      expect(h.reason, `Seed ${seed} (Abschnitt beim Tod ${h.deathAt})`).toBe('ziel');
      expect(h.collapse, `Seed ${seed}`).toBeNull();
    }
  });

  it('Netz ab dem Brett: W-Halter rechts der Finne fallen aufs W1-Band und erreichen CP1 lebend', () => {
    // Review Phase 3: ohne W1-Band starben sie 12/12 nach ~3 s auf W1.
    const goal = nextGoal(level, 0);
    if (!goal) throw new Error('level3: kein CP1');
    for (const [look, hold] of [
      [0, false],
      [0, true],
      [30, false],
    ] as const) {
      const res = wHolder(level, def.safeRoute ?? [], 1, level.spawnPos, look, hold, goal.bounds, VELOCITY_DEFAULT, 320);
      expect(res.ok, `Blick ${look}°${hold ? ' + Leertaste' : ''}: ${res.reason} bei ${res.end.x.toFixed(0)},${res.end.y.toFixed(0)},${res.end.z.toFixed(0)}`).toBe(true);
    }
    // RunState zählt nur den NÄCHSTEN Checkpoint: wer auf dem Band stehend an CP1 vorbeikäme, erreichte nie das Ziel.
    const band = hulls(/^outerCatch0$/);
    expect(band.length).toBeGreaterThan(0);
    const P = band[band.length - 1].points;
    for (const t of [0.1, 0.5, 0.9]) {
      const x = P[2][0] + (P[3][0] - P[2][0]) * t;
      const z = P[2][2] + (P[3][2] - P[2][2]) * t;
      const y = P[2][1] + (P[3][1] - P[2][1]) * t + 1;
      const hull = new Box3(new Vector3(x - 16, y, z - 16), new Vector3(x + 16, y + 72, z + 16));
      expect(goal.bounds.intersectsBox(hull), `Band-Ende quer ${t}`).toBe(true);
    }
  });

  it('Außenbande: über jede Fuge (W1 → Viertel 1 … 3 → 4) gleitet man mit ≤ 10 % Tempoverlust (hüpfend, 4 u vor der Bande)', () => {
    for (const joint of GLIDE_JOINTS) {
      for (const v of [400, 900]) {
        const g = bankGlide(level, { joint, d: 4, v, input: 'hop' }, VELOCITY_DEFAULT);
        expect(g.passed, `Fuge ${joint}, ${v} u/s`).toBe(true);
        expect(1 - g.min / v, `Fuge ${joint}, ${v} u/s`).toBeLessThanOrEqual(GLIDE_LOSS);
      }
    }
  });
});
