import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { GameEvent } from '../src/engine/events';
import { BEST_KEY, BestTimes, SETTINGS_KEY, SettingsStore } from '../src/engine/Settings';
import type { StorageLike } from '../src/engine/Settings';
import { DEFAULT_SETTINGS } from '../src/engine/settingsTypes';
import { UNLOCKS, UNLOCKS_KEY, UnlockStore, deriveUnlocks, gloveUnlock, itemUnlock, parseLocked, parseUnlocks, unlockPatch } from '../src/engine/Unlocks';
import type { UnlockId } from '../src/engine/Unlocks';
import { MEDAL_ORDER, adminTimeFor, medalFor, nextMedal } from '../src/ui/medals';
import type { MedalId } from '../src/ui/medals';
import { parseIndex } from '../src/engine/Game';
import { SAFE_ASPECT, safeLeft, safeRight, safeWidth } from '../src/ui/safeFrame';
import { TIER_SPEED, speedTier } from '../src/ui/hand/anim';
import { CAN_HOLD_POS, CAN_TIER_TRICKS, CanTricks } from '../src/ui/hand/canTricks';
import type { CanTrick } from '../src/ui/hand/canTricks';
import { CARD_TIER_TRICKS, CardTricks } from '../src/ui/hand/cardTricks';
import type { CardTrick } from '../src/ui/hand/cardTricks';
import { KNIFE_TIER_TRICKS, KnifeTricks } from '../src/ui/hand/knifeTricks';
import type { KnifeTrick } from '../src/ui/hand/knifeTricks';
import type { PropFrameInput, PropTricks } from '../src/ui/hand/propTricks';
import { ViewHand } from '../src/ui/hand/ViewHand';
import { makeHandInput } from '../src/ui/hand/handMotion';
import { POSE } from '../src/ui/hand/poses';

class MemoryStorage implements StorageLike {
  readonly data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

const M1 = { bronze: 36.2, silver: 30.4, gold: 24.5, velocity: 23.4, author: 22.25 };
const M2 = { bronze: 21.4, silver: 18.7, gold: 17.5, velocity: 16.7, author: 15.86 };
const LEVELS = [
  { id: 'level1', medals: M1 },
  { id: 'level2', medals: M2 },
  { id: 'sandbox', medals: null },
];
const ALL: UnlockId[] = ['glove.neon', 'item.card', 'item.can', 'item.knife'];

describe('Freischaltungen (Plan 006)', () => {
  it('Zuordnung: L1-Gold → Neon, L1-VELOCITY → Karte, L2-VELOCITY → Dose, beide VELOCITY → Messer; Sandbox nie', () => {
    const best = new Map<string, number>();
    const get = (id: string): number | null => best.get(id) ?? null;
    expect(deriveUnlocks(LEVELS, get)).toEqual([]);
    best.set('level1', 25.0); // Silber
    expect(deriveUnlocks(LEVELS, get)).toEqual([]);
    best.set('level1', 24.0); // Gold
    expect(deriveUnlocks(LEVELS, get)).toEqual(['glove.neon']);
    best.set('level1', 23.4); // genau VELOCITY
    expect(deriveUnlocks(LEVELS, get)).toEqual(['glove.neon', 'item.card']);
    best.set('level2', 17.0); // L2-Gold reicht nicht
    expect(deriveUnlocks(LEVELS, get)).toEqual(['glove.neon', 'item.card']);
    best.set('level2', 15.0); // unter der Autor-Zeit = auch VELOCITY
    expect(deriveUnlocks(LEVELS, get)).toEqual(ALL);
    // Nur L2-VELOCITY: Dose, aber kein Messer.
    expect(deriveUnlocks(LEVELS, (id) => (id === 'level2' ? 15 : null))).toEqual(['item.can']);
    expect(deriveUnlocks([{ id: 'sandbox', medals: M1 }], () => 1)).toEqual([]);
    for (const u of UNLOCKS) for (const r of u.requires) expect(r.levelId).not.toBe('sandbox');
  });

  it('die echten Level-Medaillen passen zur Ableitung', () => {
    const idx = parseIndex(JSON.parse(readFileSync('public/levels/index.json', 'utf8')));
    for (const u of UNLOCKS) for (const r of u.requires) expect(idx.find((l) => l.id === r.levelId)?.medals, u.id).toBeDefined();
    const l1 = idx.find((l) => l.id === 'level1');
    if (!l1?.medals) throw new Error('level1 ohne Medaillen');
    expect(deriveUnlocks(idx, (id) => (id === 'level1' ? (l1.medals?.gold ?? null) : null))).toEqual(['glove.neon']);
    expect(deriveUnlocks(idx, (id) => (id === 'level1' ? (l1.medals?.velocity ?? null) : null))).toEqual(['glove.neon', 'item.card']);
  });

  it('persistiert versioniert (v3), meldet nur NEUE Freischaltungen, übersteht kaputten Speicher', () => {
    const mem = new MemoryStorage();
    const store = new UnlockStore(mem);
    expect(store.list()).toEqual([]);
    const best = (id: string): number | null => (id === 'level2' ? 16.0 : null);
    expect(store.sync(LEVELS, best)).toEqual(['item.can']);
    expect(store.sync(LEVELS, best)).toEqual([]);
    const raw: unknown = JSON.parse(mem.getItem(UNLOCKS_KEY) ?? 'null');
    expect(raw).toMatchObject({ v: 3, unlocked: { 'item.can': expect.any(String) }, locked: [] });
    const again = new UnlockStore(mem);
    expect(again.has('item.can')).toBe(true);
    expect(again.has('glove.neon')).toBe(false);
    mem.setItem(UNLOCKS_KEY, '{kaputt');
    expect(new UnlockStore(mem).list()).toEqual([]);
    expect(parseUnlocks({ v: 4, unlocked: { 'item.can': 'x' } }).size).toBe(0);
    expect([...parseUnlocks({ v: 2, unlocked: { 'item.can': 'x', 'hat.crown': 'y' } }).keys()]).toEqual(['item.can']);
    expect(new UnlockStore(mem).sync(LEVELS, best)).toEqual(['item.can']);
  });

  it('Migration v1: Neon behalten (+ Karte), Neon + Dose → auch Messer; Stand wird als v3 neu geschrieben', () => {
    const neon = parseUnlocks({ v: 1, unlocked: { 'glove.neon': '2026-09-28T01:00:00Z' } });
    expect([...neon.keys()].sort()).toEqual(['glove.neon', 'item.card']);
    expect(neon.get('item.card')).toBe('2026-09-28T01:00:00Z');
    const both = parseUnlocks({ v: 1, unlocked: { 'glove.neon': 'a', 'item.can': 'b' } });
    expect([...both.keys()].sort()).toEqual(['glove.neon', 'item.can', 'item.card', 'item.knife']);
    // Nur Dose (L2): nichts dazu.
    expect([...parseUnlocks({ v: 1, unlocked: { 'item.can': 'b' } }).keys()]).toEqual(['item.can']);
    const mem = new MemoryStorage();
    mem.setItem(UNLOCKS_KEY, JSON.stringify({ v: 1, unlocked: { 'glove.neon': 'a' } }));
    const s = new UnlockStore(mem);
    expect(s.has('glove.neon')).toBe(true);
    expect(s.has('item.card')).toBe(true);
    // Auch ohne Bestzeiten (verdient ist verdient) — und v3 auf der Platte.
    expect(s.sync(LEVELS, () => null)).toEqual([]);
    expect(JSON.parse(mem.getItem(UNLOCKS_KEY) ?? 'null')).toMatchObject({ v: 3, unlocked: { 'glove.neon': 'a', 'item.card': 'a' }, locked: [] });
  });

  it('verdient bleibt verdient: Freischaltung hält auch, wenn die Bestzeit fehlt', () => {
    const mem = new MemoryStorage();
    new UnlockStore(mem).sync(LEVELS, () => 1);
    expect(new UnlockStore(mem).list()).toEqual(ALL);
    expect(new UnlockStore(mem).sync(LEVELS, () => null)).toEqual([]);
    expect(new UnlockStore(mem).list()).toEqual(ALL);
  });

  it('unlockAll / reset: reset hält dauerhaft gegen die Ableitung (auch nach Neuladen)', () => {
    const mem = new MemoryStorage();
    const s = new UnlockStore(mem);
    let calls = 0;
    s.subscribe(() => calls++);
    s.unlockAll();
    expect(s.list()).toEqual(ALL);
    s.reset();
    expect(s.list()).toEqual([]);
    expect(s.sync(LEVELS, () => 1)).toEqual([]);
    expect(calls).toBeGreaterThan(0);
    // Admin-Sperre ist gespeichert — Neuladen + Ableitung holt nichts zurück.
    expect(new UnlockStore(mem).sync(LEVELS, () => 1)).toEqual([]);
    const again = new UnlockStore(mem);
    again.unlockAll();
    expect(again.list()).toEqual(ALL);
    expect(ALL.every((id) => !again.isLocked(id))).toBe(true);
  });

  it('Admin-Schalter: von Hand an überlebt Neuableitung ohne Medaille, von Hand aus überlebt Neuableitung mit Medaille', () => {
    const mem = new MemoryStorage();
    const s = new UnlockStore(mem);
    // An ohne jede Bestzeit.
    s.set('item.knife', true);
    expect(s.sync(LEVELS, () => null)).toEqual([]);
    expect(new UnlockStore(mem).has('item.knife')).toBe(true);
    // Aus, obwohl alle Medaillen da sind: Ableitung (Start und Ziel) holt es NICHT zurück — auch nach Neuladen.
    const all = (): number => 1;
    s.sync(LEVELS, all);
    s.set('glove.neon', false);
    expect(s.sync(LEVELS, all)).toEqual([]);
    expect(s.has('glove.neon')).toBe(false);
    const re = new UnlockStore(mem);
    expect(re.sync(LEVELS, all)).toEqual([]);
    expect(re.has('glove.neon')).toBe(false);
    expect(re.isLocked('glove.neon')).toBe(true);
    // Die anderen bleiben unberührt.
    expect(re.list()).toEqual(['item.card', 'item.can', 'item.knife']);
    // Wieder an: Sperre weg.
    re.set('glove.neon', true);
    expect(re.isLocked('glove.neon')).toBe(false);
    expect(new UnlockStore(mem).list()).toEqual(ALL);
    expect(parseLocked(JSON.parse(mem.getItem(UNLOCKS_KEY) ?? 'null')).size).toBe(0);
  });

  it('Admin: Medaille setzen hebt die Sperre nur für Freischaltungen dieses Levels auf', () => {
    const mem = new MemoryStorage();
    const s = new UnlockStore(mem);
    const best = new BestTimes(mem);
    s.reset();
    best.set('level1', adminTimeFor('velocity', M1));
    // Echte Ableitung respektiert die Sperre ...
    expect(s.sync(LEVELS, (id) => best.get(id))).toEqual([]);
    // ... die Admin-Medaille nicht: L1-VELOCITY → Neon + Karte; Messer braucht noch L2, Dose ist L2.
    expect(s.grantEarnedFor('level1', LEVELS, (id) => best.get(id))).toEqual(['glove.neon', 'item.card']);
    expect(s.isLocked('item.can')).toBe(true);
    expect(s.isLocked('item.knife')).toBe(true);
    best.set('level2', adminTimeFor('velocity', M2));
    expect(s.grantEarnedFor('level2', LEVELS, (id) => best.get(id))).toEqual(['item.can', 'item.knife']);
    expect(new UnlockStore(mem).list()).toEqual(ALL);
  });

  it('Migration v2 → v3: nichts gesperrt, Einträge bleiben, Neuschreiben mit locked: []', () => {
    const mem = new MemoryStorage();
    mem.setItem(UNLOCKS_KEY, JSON.stringify({ v: 2, unlocked: { 'item.can': '2026-09-28T02:00:00Z' } }));
    const s = new UnlockStore(mem);
    expect(s.list()).toEqual(['item.can']);
    expect(UNLOCKS.every((u) => !s.isLocked(u.id))).toBe(true);
    expect(JSON.parse(mem.getItem(UNLOCKS_KEY) ?? 'null')).toEqual({ v: 3, unlocked: { 'item.can': '2026-09-28T02:00:00Z' }, locked: [] });
    // Ableitung wirkt normal weiter.
    expect(s.sync(LEVELS, () => 1)).toEqual(['glove.neon', 'item.card', 'item.knife']);
    // Kaputte/fremde Sperr-Einträge fallen weg; frei gewinnt gegen gesperrt.
    mem.setItem(UNLOCKS_KEY, JSON.stringify({ v: 3, unlocked: { 'item.can': 'x' }, locked: ['item.can', 'hat.crown', 'glove.neon', 7] }));
    const t = new UnlockStore(mem);
    expect(t.has('item.can')).toBe(true);
    expect(t.isLocked('item.can')).toBe(false);
    expect(t.isLocked('glove.neon')).toBe(true);
    expect(t.sync(LEVELS, () => 1)).toEqual(['item.card', 'item.knife']);
  });

  it('Kosmetik-Zuordnung und Sofort-Anlegen', () => {
    expect(gloveUnlock('classic')).toBeNull();
    expect(itemUnlock('none')).toBeNull();
    expect(gloveUnlock('neon')).toBe('glove.neon');
    expect(itemUnlock('card')).toBe('item.card');
    expect(itemUnlock('can')).toBe('item.can');
    expect(itemUnlock('knife')).toBe('item.knife');
    expect(unlockPatch('item.knife')).toEqual({ heldItem: 'knife' });
    expect(unlockPatch('glove.neon')).toEqual({ glove: 'neon' });
  });
});

describe('Admin: Medaille setzen (Bestzeit knapp unter der Grenze)', () => {
  const opts: readonly (MedalId | null)[] = [null, 'bronze', 'silver', 'gold', 'velocity'];

  it('ergibt genau die gewählte Medaille, auch in den echten Leveln', () => {
    const idx = parseIndex(JSON.parse(readFileSync('public/levels/index.json', 'utf8')));
    const sets = [M1, M2, ...idx.flatMap((l) => (l.medals ? [l.medals] : []))];
    expect(sets.length).toBeGreaterThan(2);
    for (const m of sets) {
      for (const want of opts) {
        const t = adminTimeFor(want, m);
        expect(medalFor(t, m)).toBe(want);
        if (want !== null) {
          expect(t).toBeLessThanOrEqual(m[want]);
          expect(m[want] - t).toBeLessThanOrEqual(0.0100001);
        }
      }
    }
  });

  it('rutscht bei eng beieinander liegenden Grenzen nie in die bessere Medaille', () => {
    const tight = { bronze: 10.005, silver: 10, gold: 9.995, velocity: 9.99, author: 9.9 };
    for (const want of MEDAL_ORDER) expect(medalFor(adminTimeFor(want, tight), tight)).toBe(want);
  });

  it('BestTimes.set überschreibt auch mit schlechterer Zeit, persistiert, ohne Splits; nextMedal passt', () => {
    const mem = new MemoryStorage();
    const b = new BestTimes(mem);
    b.submit('level1', 20, [5, 10]);
    expect(b.set('level1', adminTimeFor('silver', M1))).toBe(true);
    const re = new BestTimes(mem);
    expect(medalFor(re.get('level1'), M1)).toBe('silver');
    expect(re.getSplits('level1')).toEqual([]);
    expect(nextMedal(re.get('level1'), M1)).toEqual({ id: 'gold', limit: M1.gold });
    expect(b.set('level1', Number.NaN)).toBe(false);
    b.clear('level1');
    expect(new BestTimes(mem).get('level1')).toBeNull();
    expect(mem.getItem(BEST_KEY)).toBe('{}');
  });
});

describe('Kosmetik in GameSettings (Migration)', () => {
  it('Default Standard/Nichts, alter Stand ohne Felder lädt mit Default, ungültige Werte fallen zurück', () => {
    expect(DEFAULT_SETTINGS.glove).toBe('classic');
    expect(DEFAULT_SETTINGS.heldItem).toBe('none');
    const mem = new MemoryStorage();
    mem.setItem(SETTINGS_KEY, JSON.stringify({ sensitivity: 3, showHand: false }));
    const old = new SettingsStore(mem).get();
    expect(old.glove).toBe('classic');
    expect(old.heldItem).toBe('none');
    expect(old.sensitivity).toBe(3);
    mem.setItem(SETTINGS_KEY, JSON.stringify({ glove: 'gold', heldItem: 42 }));
    const bad = new SettingsStore(mem).get();
    expect(bad.glove).toBe('classic');
    expect(bad.heldItem).toBe('none');
  });

  it('Round-Trip aller Gegenstände', () => {
    for (const item of ['card', 'can', 'knife'] as const) {
      const mem = new MemoryStorage();
      new SettingsStore(mem).update({ glove: 'neon', heldItem: item });
      const s = new SettingsStore(mem).get();
      expect(s.glove).toBe('neon');
      expect(s.heldItem).toBe(item);
    }
  });
});

describe('Safe-Frame (Ultrawide)', () => {
  const H = 270;
  it('bis 16:9 = ganzes Bild, darüber zentrierter 16:9-Rahmen', () => {
    for (const w of [360, 432, 480]) {
      expect(safeLeft(w, H)).toBe(0);
      expect(safeRight(w, H)).toBe(w);
    }
    expect(safeWidth(1366, 768)).toBe(1366);
    expect(safeWidth(640, H)).toBe(480);
    expect(safeLeft(640, H)).toBe(80);
    expect(safeRight(640, H)).toBe(560);
    expect(safeLeft(960, H)).toBe(240);
    expect(safeRight(960, H)).toBe(720);
  });

  it('Showkeys haben auf Ultrawide denselben Abstand zur Bildmitte wie auf 16:9', () => {
    const keys = (w: number): number => w / 2 - (safeLeft(w, H) + 6);
    for (const w of [640, 960]) expect(keys(w)).toBeCloseTo(keys(480), 5);
    expect(SAFE_ASPECT).toBeCloseTo(16 / 9, 6);
  });
});

// ------------------------------------------------------------------ Gegenstände (Plan 006)

const JUMP = (speed: number, chain = 2, perfect = true): GameEvent => ({ type: 'jump', speed, gain: 5, perfect, chain, sync: 0.9, crouched: false, coyote: false });
const AIR = (speed: number): PropFrameInput => ({ speed, onGround: false, surfing: false });
const GROUND = (speed: number): PropFrameInput => ({ speed, onGround: true, surfing: false });

/** Sprünge im gegebenen Tempo, Trick jeweils ausspielen: welche Tricks kamen? */
function tricksAt<T extends string>(p: PropTricks<T>, speed: number): Set<string> {
  const got = new Set<string>();
  p.reset();
  for (let k = 0; k < 40; k++) {
    p.onEvent(JUMP(speed, 2 + k, k % 3 !== 0));
    if (p.trick !== 'none') got.add(p.trick);
    for (let f = 0; f < 60 * 3; f++) p.update(1 / 60, AIR(speed));
  }
  return got;
}

/** Ausgabe als Zahlenliste (Position, Drehung, Spin, Sichtbarkeit, Hand-Versatz, Messer). */
function sample<T extends string>(p: PropTricks<T>): number[] {
  const o = p.out;
  return [o.pos[0], o.pos[1], o.pos[2], o.rot[0], o.rot[1], o.rot[2], o.spin, o.visible, o.hx, o.hy, o.hz, o.hroll, o.knifeBlade, o.knifeBite];
}

function wild<T extends string>(p: PropTricks<T>): void {
  let seed = 3;
  const rnd = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let k = 0; k < 20000; k++) {
    const r = rnd();
    if (r < 0.03) p.onEvent(JUMP(rnd() * 3000, 1 + Math.floor(rnd() * 30), rnd() < 0.5));
    else if (r < 0.05) p.onEvent({ type: 'land', impact: rnd() < 0.1 ? Number.NaN : rnd() * 1e5, speed: rnd() * 400, airTime: 1, jumpQueued: rnd() < 0.5 });
    else if (r < 0.052) p.onEvent({ type: 'respawn', reason: 'fall' });
    else if (r < 0.055) p.onEvent({ type: 'speedMilestone', speed: 1000 });
    else if (r < 0.056) p.onEvent({ type: 'finish', time: 9, best: false, previousBest: null });
    p.update(rnd() < 0.01 ? Number.NaN : rnd() * 0.2, { speed: rnd() < 0.01 ? Number.NaN : rnd() * 1500, onGround: rnd() < 0.5, surfing: rnd() < 0.3 });
    for (const v of sample(p)) expect(Number.isFinite(v)).toBe(true);
    expect(Number.isFinite(p.out.kickY) && Number.isFinite(p.out.kickSq)).toBe(true);
    expect(p.out.visible).toBeGreaterThanOrEqual(0);
    expect(p.out.visible).toBeLessThanOrEqual(1);
    p.out.kickY = 0;
    p.out.kickSq = 0;
  }
}

/** Zwei Sprünge (Stufe 2, dann 3) — Abtastung auf dem gemeinsamen 1/6-s-Raster (fallen.md #77). */
function dtScenario<T extends string>(make: () => PropTricks<T>, fps: number): number[] {
  const p = make();
  const dt = 1 / fps;
  const out: number[] = [];
  const at = [2 / 6, 3 / 6, 5 / 6, 8 / 6, 11 / 6, 13 / 6, 15 / 6];
  for (let f = 1; f <= Math.round(3 * fps); f++) {
    const t = f * dt;
    if (f === Math.round(fps / 6)) p.onEvent(JUMP(650, 2, true));
    if (f === Math.round(1.5 * fps)) p.onEvent(JUMP(950, 3, false));
    p.update(dt, AIR(t < 1.5 ? 650 : 950));
    for (const s of at) if (f === Math.round(s * fps)) out.push(...sample(p));
  }
  return out;
}

function expectDtIndependent<T extends string>(make: () => PropTricks<T>): void {
  const ref = dtScenario(make, 1200);
  for (const fps of [30, 60, 144, 240]) {
    const got = dtScenario(make, fps);
    expect(got.length).toBe(ref.length);
    // Positionen in Hand-Einheiten (1 ≈ 0.3 px bei 270 Zeilen), Winkel in rad — gemessen ~0.001.
    for (let i = 0; i < ref.length; i++) expect(Math.abs(got[i] - ref[i]), `${fps} Hz #${i}`).toBeLessThan(0.05);
  }
}

describe('Tempo-Stufen', () => {
  it('300 / 500 / 800 u/s', () => {
    expect(speedTier(0)).toBe(0);
    expect(speedTier(299)).toBe(0);
    expect(speedTier(TIER_SPEED[0])).toBe(1);
    expect(speedTier(650)).toBe(2);
    expect(speedTier(801)).toBe(3);
    expect(speedTier(Number.NaN)).toBe(0);
  });
});

describe('Dose (Plan 006)', () => {
  it('Sprünge wählen Tricks der passenden Stufe — je schneller, desto wilder', () => {
    const c = new CanTricks();
    expect(tricksAt(c, 200).size).toBe(0);
    expect([...tricksAt(c, 400)]).toEqual(['flip']);
    const t2 = tricksAt(c, 650);
    for (const t of t2) expect(CAN_TIER_TRICKS[2]).toContain(t as CanTrick);
    expect(t2.size).toBeGreaterThanOrEqual(2);
    const t3 = tricksAt(c, 950);
    for (const t of t3) expect(CAN_TIER_TRICKS[3]).toContain(t as CanTrick);
    expect(t3.has('doubleFlip') && t3.has('behindThrow')).toBe(true);
  });

  it('crack genau einmal pro Leben (im ruhigen Moment), offen bis Respawn', () => {
    const c = new CanTricks();
    c.reset();
    let cracks = 0;
    let prev = 'none';
    const count = (): void => {
      if (c.trick === 'crack' && prev !== 'crack') cracks++;
      prev = c.trick;
    };
    for (let f = 0; f < 60 * 30; f++) {
      c.update(1 / 60, GROUND(f < 600 ? 0 : 200));
      count();
    }
    expect(cracks).toBe(1);
    expect(c.opened).toBe(true);
    c.onEvent({ type: 'checkpoint', index: 1, total: 3, time: 3, split: null });
    c.onEvent(JUMP(400));
    expect(c.opened).toBe(true);
    c.onEvent({ type: 'respawn', reason: 'manual' });
    expect(c.opened).toBe(false);
    expect(c.out.canOpen).toBe(false);
    cracks = 0;
    for (let f = 0; f < 60 * 10; f++) {
      c.update(1 / 60, GROUND(0));
      count();
    }
    expect(cracks).toBe(1);
  });

  it('wer nie steht, bekommt den crack trotzdem (spätestens nach 12 s Bodenzeit)', () => {
    const c = new CanTricks();
    c.reset();
    let cracked = false;
    for (let f = 0; f < 60 * 120 && !cracked; f++) {
      c.update(1 / 60, GROUND(650));
      if (c.trick === 'crack') cracked = true;
    }
    expect(cracked).toBe(true);
  });

  it('Lasche geht hoch und wieder runter, Öffnung ab dem "Pssht"', () => {
    const c = new CanTricks();
    c.debugPlay('crack', 0.2);
    c.update(1 / 60, GROUND(0));
    expect(c.out.canTab).toBe(0);
    expect(c.opened).toBe(false);
    c.debugPlay('crack', 0.45);
    c.update(1 / 60, GROUND(0));
    expect(c.out.canTab).toBeGreaterThan(0.9);
    c.debugPlay('crack', 1.0);
    c.update(1 / 60, GROUND(0));
    expect(c.out.canOpen).toBe(true);
    expect(c.out.canTab).toBeLessThan(0.3);
  });

  it('Schluck nur offen und nur in Ruhe — bei Tempo nie', () => {
    const c = new CanTricks();
    c.reset();
    c.opened = true;
    const seen = new Set<string>();
    for (let f = 0; f < 60 * 30; f++) {
      if (f % 45 === 0) c.onEvent(JUMP(600));
      if (f % 45 === 30) c.onEvent({ type: 'land', impact: 200, speed: 600, airTime: 0.5, jumpQueued: false });
      c.update(1 / 60, f % 45 < 30 ? AIR(600) : GROUND(600));
      seen.add(c.trick);
    }
    expect(seen.has('sip')).toBe(false);
    for (let f = 0; f < 60 * 15; f++) {
      c.update(1 / 60, GROUND(0));
      seen.add(c.trick);
    }
    expect(seen.has('sip')).toBe(true);
    // Geschlossen: kein Schluck vor dem crack.
    const d = new CanTricks();
    d.reset();
    const before = new Set<string>();
    for (let f = 0; f < 60 * 20; f++) {
      d.update(1 / 60, GROUND(0));
      if (d.trick === 'crack') break;
      before.add(d.trick);
    }
    expect(before.has('sip')).toBe(false);
  });

  it('ein laufender Trick wird nicht abgebrochen — nur Respawn setzt zurück; Fang bringt die Dose in den Griff', () => {
    const c = new CanTricks();
    c.reset();
    c.onEvent(JUMP(950));
    const first = c.trick;
    expect(first).not.toBe('none');
    for (let f = 0; f < 10; f++) {
      c.update(1 / 60, AIR(950));
      c.onEvent(JUMP(400));
      c.onEvent({ type: 'land', impact: 900, speed: 900, airTime: 1, jumpQueued: false });
      c.onEvent({ type: 'speedMilestone', speed: 1000 });
    }
    expect(c.trick).toBe(first);
    let sq = 0;
    for (let f = 0; f < 60 * 3; f++) {
      c.update(1 / 60, AIR(950));
      sq = Math.min(sq, c.out.kickSq);
      c.out.kickSq = 0;
    }
    expect(sq).toBeLessThan(0);
    expect(c.trick).toBe('none');
    expect(c.out.pos[0]).toBeCloseTo(CAN_HOLD_POS[0], 3);
    expect(c.out.pos[1]).toBeCloseTo(CAN_HOLD_POS[1], 3);
    c.onEvent(JUMP(950));
    c.onEvent({ type: 'respawn', reason: 'fall' });
    expect(c.trick).toBe('none');
  });

  it('ist framerate-unabhängig (30/60/144/240 Hz gegen 1200 Hz)', () => {
    expectDtIndependent(() => {
      const c = new CanTricks();
      c.opened = true;
      return c;
    });
  });

  it('keine NaN bei wilden Eingaben', () => wild(new CanTricks()));
});

describe('Sammelkarte (Plan 006)', () => {
  it('Tempo-Stufen', () => {
    const c = new CardTricks();
    expect(tricksAt(c, 200).size).toBe(0);
    for (const tier of [1, 2, 3]) {
      const got = tricksAt(c, [400, 650, 950][tier - 1]);
      for (const t of got) expect(CARD_TIER_TRICKS[tier]).toContain(t as CardTrick);
      expect(got.size).toBeGreaterThanOrEqual(2);
    }
    expect(tricksAt(c, 950).has('vanish')).toBe(true);
  });

  it('Spin zeigt die Rückseite (dreht über 180°) und endet wieder vorn', () => {
    const c = new CardTricks();
    c.reset();
    c.debugPlay('spin');
    let max = 0;
    for (let f = 0; f < 120; f++) {
      c.update(1 / 60, AIR(400));
      max = Math.max(max, c.out.spin);
    }
    expect(max).toBeGreaterThan(Math.PI);
    expect(c.trick).toBe('none');
    expect(c.out.spin).toBe(0);
  });

  it('turn wendet die Karte dauerhaft (bis zum nächsten turn oder Respawn)', () => {
    const c = new CardTricks();
    c.reset();
    c.debugPlay('turn');
    for (let f = 0; f < 60; f++) c.update(1 / 60, GROUND(0));
    expect(c.flipped).toBe(true);
    c.onEvent({ type: 'respawn', reason: 'fall' });
    expect(c.flipped).toBe(false);
  });

  it('Zaubertrick: Karte verschwindet (Poof), kurz leere Hand, erscheint mit Schwung wieder', () => {
    const c = new CardTricks();
    c.reset();
    c.onEvent({ type: 'speedMilestone', speed: 1000 });
    expect(c.trick).toBe('vanish');
    let minVis = 1;
    let poof = false;
    let emptyHand = false;
    let maxScale = 0;
    let gone = false;
    for (let f = 0; f < 60 * 3; f++) {
      c.update(1 / 60, AIR(1000));
      minVis = Math.min(minVis, c.out.visible);
      if (c.out.poof >= 0) poof = true;
      if (c.out.visible === 0 && c.out.pose === POSE.open) emptyHand = true;
      if (c.vanished) gone = true;
      maxScale = Math.max(maxScale, c.out.scale);
    }
    expect(minVis).toBe(0);
    expect(poof).toBe(true);
    expect(emptyHand).toBe(true);
    expect(gone).toBe(true);
    expect(maxScale).toBeGreaterThan(1.05);
    expect(c.trick).toBe('none');
    expect(c.vanished).toBe(false);
    expect(c.out.visible).toBe(1);
    expect(c.out.scale).toBe(1);
  });

  it('ist framerate-unabhängig (30/60/144/240 Hz gegen 1200 Hz)', () => expectDtIndependent(() => new CardTricks()));

  it('keine NaN bei wilden Eingaben', () => wild(new CardTricks()));
});

describe('Butterfly-Messer (Plan 006)', () => {
  it('Tempo-Stufen: Auf/Zu → Rollover → Aerials', () => {
    const k = new KnifeTricks();
    expect(tricksAt(k, 200).size).toBe(0);
    for (const tier of [1, 2, 3]) {
      const got = tricksAt(k, [400, 650, 950][tier - 1]);
      for (const t of got) expect(KNIFE_TIER_TRICKS[tier]).toContain(t as KnifeTrick);
    }
    const t3 = tricksAt(k, 950);
    expect(t3.has('aerial') && t3.has('doubleAerial')).toBe(true);
  });

  it('Auf- und Zuklappen: Zustand hält, Griffe liegen danach zusammen', () => {
    const k = new KnifeTricks();
    k.reset();
    expect(k.isOpen).toBe(false);
    expect(k.out.knifeBlade).toBeCloseTo(Math.PI, 5);
    k.debugPlay('open');
    for (let f = 0; f < 60; f++) k.update(1 / 60, GROUND(0));
    expect(k.isOpen).toBe(true);
    expect(k.out.knifeBlade).toBeCloseTo(0, 5);
    expect(k.out.knifeBlade + k.out.knifeBite).toBeCloseTo(0, 5);
    // Aerial wechselt den Zustand beim Fang.
    k.onEvent(JUMP(950, 2, true));
    for (let f = 0; f < 60 * 2; f++) k.update(1 / 60, AIR(950));
    expect(k.isOpen).toBe(false);
    expect(k.out.knifeBlade + k.out.knifeBite).toBeCloseTo(0, 5);
    k.onEvent({ type: 'respawn', reason: 'fall' });
    expect(k.isOpen).toBe(false);
  });

  it('ist framerate-unabhängig (30/60/144/240 Hz gegen 1200 Hz)', () => expectDtIndependent(() => new KnifeTricks()));

  it('keine NaN bei wilden Eingaben', () => wild(new KnifeTricks()));
});

describe('Hand mit Gegenstand', () => {
  it('motionFx 0: keine Tricks, Gegenstand ruht im Griff, Hand statisch', () => {
    for (const item of ['can', 'card', 'knife'] as const) {
      const h = new ViewHand();
      h.setItem(item);
      h.motionFx = 0;
      const inp = makeHandInput();
      let first: number[] | null = null;
      for (let f = 0; f < 60 * 8; f++) {
        if (f % 50 === 0) h.onEvent(JUMP(950));
        if (f % 50 === 25) h.onEvent({ type: 'speedMilestone', speed: 1000 });
        inp.speed = f < 200 ? 0 : 1000;
        inp.onGround = f < 200;
        h.update(1 / 60, inp);
        expect(h.state().trick).toBe('none');
        const fr = h.frame;
        const now = [fr.propPos[0], fr.propPos[1], fr.propPos[2], fr.propRot[0], fr.propRot[1], fr.propRot[2], fr.propSpin, fr.propVisible, fr.x, fr.y, fr.roll];
        if (!first) first = now;
        for (let i = 0; i < now.length; i++) expect(now[i]).toBeCloseTo(first[i], 9);
      }
    }
  });

  it('mit Gegenstand kein Daumen hoch/Faust — die Hand hält fest', () => {
    const h = new ViewHand();
    h.setItem('can');
    const inp = makeHandInput();
    h.onEvent({ type: 'finish', time: 20, best: true, previousBest: null });
    h.onEvent({ type: 'checkpoint', index: 1, total: 3, time: 4, split: null });
    const poses = new Set<string>();
    for (let f = 0; f < 144 * 3; f++) {
      h.update(1 / 144, inp);
      poses.add(h.state().pose);
    }
    expect(poses.has('thumbsUp')).toBe(false);
    expect(poses.has('fist')).toBe(false);
  });

  it('Gegenstand wechseln setzt Tricks zurück, Frame trägt den Gegenstand', () => {
    const h = new ViewHand();
    h.setItem('knife');
    h.onEvent(JUMP(950));
    expect(h.state().trick).not.toBe('none');
    h.setItem('card');
    h.update(1 / 60, makeHandInput());
    expect(h.frame.item).toBe('card');
    expect(h.state().trick).toBe('none');
    expect(h.forceTrick('vanish', 0.5)).toBe(true);
    expect(h.forceTrick('aerial')).toBe(false);
  });
});
