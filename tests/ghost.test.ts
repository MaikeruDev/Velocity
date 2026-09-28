import { readFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  GHOST_HZ,
  GHOST_KEY_PREFIX,
  GHOST_MAX_CHARS,
  GhostRecorder,
  GhostStore,
  decodeSamples,
  encodeSamples,
  ghostDiff,
  ghostPoseAt,
  levelSignature,
} from '../src/engine/Ghost';
import type { StorageLike } from '../src/engine/Settings';
import { RunState } from '../src/engine/runState';
import type { RunEvent } from '../src/engine/events';
import { parseIndex, parseMedals } from '../src/engine/Game';
import { VELOCITY_DEFAULT } from '../src/player/MovementConfig';
import { PlayerMovement } from '../src/player/PlayerMovement';
import { RouteFollower } from '../src/player/bots';
import { medalFor, nextMedal } from '../src/ui/medals';
import { compileLevel } from '../src/world/level/compileLevel';
import type { LevelFile } from '../src/world/level/LevelFormat';

function memStorage(): StorageLike & { readonly map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

interface Recorded {
  readonly time: number;
  readonly splits: number[];
  /** Position pro Tick ab Timer-Start (Füße), für den Abgleich mit der Wiedergabe. */
  readonly ticks: { t: number; x: number; y: number; z: number }[];
  readonly rec: GhostRecorder;
}

/** Ganzer Lauf wie im Spiel (RunState-Timer, Aufnahme wie Game.onTick/finishRun), perfekter Route-Bot. */
function recordRun(file: string, sync = 1): Recorded {
  const def = JSON.parse(readFileSync(`public/levels/${file}`, 'utf8')) as LevelFile;
  const level = compileLevel(def);
  const cfg = VELOCITY_DEFAULT;
  const pm = new PlayerMovement(level.world, cfg);
  const run = new RunState(level);
  run.reset(null);
  const rec = new GhostRecorder();
  const out: RunEvent[] = [];
  pm.teleport(new Vector3(level.spawnPos.x, level.spawnPos.y + 1, level.spawnPos.z));
  const bot = new RouteFollower(def.route ?? [], cfg, {
    sync,
    seed: 3,
    killY: def.killY,
    world: level.world,
    start: { x: level.spawnPos.x, z: level.spawnPos.z },
  });
  const dt = 1 / cfg.tickRate;
  const ticks: Recorded['ticks'] = [];
  for (let i = 0; i < 120 * cfg.tickRate; i++) {
    const cmd = bot.next(pm.state, pm.surfNormal);
    pm.tick(cmd);
    const s = pm.state;
    const o = run.tick(dt, s.pos, pm.hullMins, pm.hullMaxs, s.speed, s.onGround, out);
    for (const e of out) if (e.type === 'runStart') rec.reset();
    if (o === 'finish') {
      const time = run.time ?? 0;
      rec.sample(time, s.pos, cmd.yaw);
      ticks.push({ t: time, x: s.pos.x, y: s.pos.y, z: s.pos.z });
      return { time, splits: run.splits(), ticks, rec };
    }
    if (o !== 'none') throw new Error(`Bot starb (${o}) — Test braucht einen sauberen Lauf`);
    if (run.running) {
      rec.sample(run.time ?? 0, s.pos, cmd.yaw);
      ticks.push({ t: run.time ?? 0, x: s.pos.x, y: s.pos.y, z: s.pos.z });
    }
  }
  throw new Error('Timeout');
}

describe('Ghost der Bestzeit (Plan 003, S7)', () => {
  const lv1 = recordRun('level1.json');
  const sig = 'test';
  const track = lv1.rec.finish(sig, lv1.time, lv1.splits);

  it('nimmt im 32-Hz-Raster ab Timer-Start auf', () => {
    expect(track).not.toBeNull();
    if (!track) return;
    // Sample k liegt bei k/32 s: Anzahl = floor(Zielzeit·32) + 1 Raster-Samples (+1, wenn das Ziel nicht auf dem Raster liegt).
    const grid = Math.floor(lv1.time * GHOST_HZ + 1e-9) + 1;
    expect(track.count).toBeGreaterThanOrEqual(grid);
    expect(track.count).toBeLessThanOrEqual(grid + 1);
  });

  it('Wiedergabe trifft die Tick-Positionen (zeitsynchron, < 2 u im Mittel)', () => {
    if (!track) throw new Error('kein Track');
    const v = new Vector3();
    let sum = 0;
    let max = 0;
    let onGrid = 0;
    for (const p of lv1.ticks) {
      ghostPoseAt(track, p.t, v);
      const d = Math.hypot(v.x - p.x, v.y - p.y, v.z - p.z);
      sum += d;
      max = Math.max(max, d);
      // Auf dem Raster exakt (bis auf Float32).
      if (Math.abs(p.t * GHOST_HZ - Math.round(p.t * GHOST_HZ)) < 1e-9) onGrid = Math.max(onGrid, d);
    }
    expect(onGrid).toBeLessThan(0.05);
    expect(sum / lv1.ticks.length).toBeLessThan(2);
    // Zwischen zwei Samples nur Sehne statt Bogen — bei 1000 u/s bleibt das unter ~16 u.
    expect(max).toBeLessThan(20);
  });

  it('komprimiert unter 40 KB und dekodiert auf 0.125 u / 0.2° genau', () => {
    if (!track) throw new Error('kein Track');
    const b64 = encodeSamples(track.data, track.count);
    const store = memStorage();
    const gs = new GhostStore(store);
    const chars = gs.save('level1', track);
    expect(chars).toBeGreaterThan(0);
    expect(chars).toBeLessThan(GHOST_MAX_CHARS);
    expect(store.map.get(GHOST_KEY_PREFIX + 'level1')?.length).toBe(chars);
    const dec = decodeSamples(b64);
    expect(dec?.count).toBe(track.count);
    if (!dec) return;
    let maxPos = 0;
    let maxYaw = 0;
    for (let k = 0; k < track.count; k++) {
      for (let c = 0; c < 3; c++) maxPos = Math.max(maxPos, Math.abs(dec.data[k * 4 + c] - track.data[k * 4 + c]));
      let dy = Math.abs(dec.data[k * 4 + 3] - track.data[k * 4 + 3]) % (Math.PI * 2);
      dy = Math.min(dy, Math.PI * 2 - dy);
      maxYaw = Math.max(maxYaw, dy);
    }
    expect(maxPos).toBeLessThanOrEqual(0.125 + 1e-3);
    expect((maxYaw * 180) / Math.PI).toBeLessThan(0.2);
    // Neuer Store liest ihn aus dem Storage (Versionierung, Signatur).
    const again = new GhostStore(store).load('level1', sig);
    expect(again?.count).toBe(track.count);
    expect(again?.time).toBe(track.time);
    expect(new GhostStore(store).load('level1', 'anderes-level')).toBeNull();
  });

  it('Abstand am Ziel = Laufzeit − Ghost-Zeit (±0.05 s) — gegen den eigenen Ghost 0', () => {
    if (!track) throw new Error('kein Track');
    const slow = recordRun('level1.json', 0.8);
    const d = ghostDiff(track, 0, slow.time);
    expect(d).not.toBeNull();
    expect(Math.abs((d ?? 0) - (slow.time - lv1.time))).toBeLessThan(0.05);
    // Gleicher Bot, gleicher Seed: deterministisch → exakt der Ghost.
    const same = recordRun('level1.json');
    expect(ghostDiff(track, 0, same.time)).toBe(0);
    for (let i = 0; i < same.splits.length; i++) expect(ghostDiff(track, i + 1, same.splits[i])).toBe(0);
  });

  it('kaputte oder fremde Einträge werden verworfen', () => {
    const store = memStorage();
    store.setItem(GHOST_KEY_PREFIX + 'x', '{"v":1,"sig":"s","time":1,"splits":[],"hz":32,"data":"!!"}');
    expect(new GhostStore(store).load('x', 's')).toBeNull();
    store.setItem(GHOST_KEY_PREFIX + 'x', '{"v":99}');
    expect(new GhostStore(store).load('x', 's')).toBeNull();
    expect(decodeSamples('')).toBeNull();
  });

  it('Level-Signatur ändert sich mit der Geometrie', () => {
    const def = JSON.parse(readFileSync('public/levels/level1.json', 'utf8')) as LevelFile;
    const a = levelSignature(def);
    const b = levelSignature({ ...def, killY: def.killY - 1 });
    expect(a).not.toBe(b);
    expect(levelSignature(def)).toBe(a);
  });
});

describe('Medaillen (Index, Anzeige)', () => {
  const m = { bronze: 38.5, silver: 32.2, gold: 24.5, velocity: 23.4, author: 22.25 };

  it('parseMedals akzeptiert nur streng fallende, endliche Zeiten', () => {
    expect(parseMedals(m)).toEqual(m);
    expect(parseMedals({ ...m, gold: 40 })).toBeNull();
    // Reihenfolge bronze > silver > gold > velocity ≥ author; velocity = author ist erlaubt.
    expect(parseMedals({ ...m, velocity: 24.5 })).toBeNull();
    expect(parseMedals({ ...m, velocity: 22 })).toBeNull();
    expect(parseMedals({ ...m, velocity: 22.25 })).toEqual({ ...m, velocity: 22.25 });
    // Alter Stand ohne VELOCITY-Medaille: keine Medaillen statt falscher Anzeige.
    expect(parseMedals({ bronze: 38.5, silver: 32.2, gold: 24.5, author: 22.25 })).toBeNull();
    expect(parseMedals({ ...m, bronze: Number.POSITIVE_INFINITY })).toBeNull();
    expect(parseMedals('x')).toBeNull();
  });

  it('index.json trägt die Medaillen weiter', () => {
    const idx = parseIndex(JSON.parse(readFileSync('public/levels/index.json', 'utf8')));
    expect(idx.length).toBeGreaterThanOrEqual(2);
    for (const e of idx) expect(e.medals).toBeDefined();
  });

  it('medalFor / nextMedal', () => {
    expect(medalFor(null, m)).toBeNull();
    expect(medalFor(40, m)).toBeNull();
    expect(medalFor(38.5, m)).toBe('bronze');
    expect(medalFor(24, m)).toBe('gold');
    expect(medalFor(23.4, m)).toBe('velocity');
    // Unter der Autor-Zeit gibt es keine eigene Medaille — VELOCITY ist die Spitze.
    expect(medalFor(22, m)).toBe('velocity');
    expect(nextMedal(26.64, m)).toEqual({ id: 'gold', limit: 24.5 });
    expect(nextMedal(24, m)).toEqual({ id: 'velocity', limit: 23.4 });
    expect(nextMedal(50, m)).toEqual({ id: 'bronze', limit: 38.5 });
    expect(nextMedal(null, m)).toEqual({ id: 'bronze', limit: 38.5 });
    expect(nextMedal(23.4, m)).toBeNull();
  });
});
