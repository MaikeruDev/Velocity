import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { GameEvent } from '../src/engine/events';
import { BEST_KEY, BestTimes, SETTINGS_KEY, SettingsStore } from '../src/engine/Settings';
import type { StorageLike } from '../src/engine/Settings';
import { DEFAULT_SETTINGS } from '../src/engine/settingsTypes';
import {
  UNLOCKS,
  UNLOCKS_KEY,
  UnlockStore,
  deriveUnlocks,
  gloveUnlock,
  itemUnlock,
  parseLocked,
  parseUnlocks,
  unlockPatch,
} from '../src/engine/Unlocks';
import type { UnlockId } from '../src/engine/Unlocks';
import type { LessonStars, TrainingProgressView } from '../src/engine/trainingTypes';
import type { TrainingIndexEntry } from '../src/world/level/LevelFormat';
import { GLOVE_IDS, HELD_ITEM_IDS } from '../src/engine/settingsTypes';
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
import { PropOut, PropTricks as PropTricksBase } from '../src/ui/hand/propTricks';
import { ViewHand, hasPropTricks } from '../src/ui/hand/ViewHand';
import { SPINNER_HOLD_POS, SPINNER_OMEGA_BASE, SPINNER_OMEGA_MAX, SPINNER_OMEGA_PER_SPEED, SPINNER_STEP_CAP, SPINNER_TIER_TRICKS, SPINNER_TRICKS, SpinnerTricks } from '../src/ui/hand/spinnerTricks';
import type { SpinnerTrick } from '../src/ui/hand/spinnerTricks';
import { VM_PARAM, VM_RIG, VM_STRING_POINTS } from '../src/render/types';
import { hasItemView } from '../src/render/viewmodel/items';
import { annulusGeometry, boneGeometry, mergeGeometries, tubeGeometry } from '../src/render/viewmodel/vmGeometry';
import type { BufferGeometry } from 'three';
import { hasSkin } from '../src/render/viewmodel/skins';
import { makeHandInput } from '../src/ui/hand/handMotion';
import { POSE, POSE_JOINTS } from '../src/ui/hand/poses';
import { PROP_FACTORIES } from '../src/ui/hand/ViewHand';
import type { PropControl } from '../src/ui/hand/propTricks';
import { CRADLE_FRONT, CRADLE_INDEX_BEYOND, CRADLE_THUMB_BEYOND, YOYO_STRING, YOYO_TIER_TRICKS, YoyoTricks } from '../src/ui/hand/yoyoTricks';
import { fingerTip, thumbPoint } from '../src/ui/hand/fk';
import { BLOW_SPEED, BLOW_TIME, CALM_SPEED, LIGHTER_TIER_TRICKS, LighterTricks, RELIGHT_TIME } from '../src/ui/hand/lighterTricks';
import { COIN_TIER_TRICKS, CoinTricks, HEADS, TAILS } from '../src/ui/hand/coinTricks';
import { KEN_BIG_CUP, KEN_SMALL_CUP, KEN_SPIKE, KENDAMA_TIER_TRICKS, KendamaTricks } from '../src/ui/hand/kendamaTricks';
import { PHONE_TIER_TRICKS, PhoneTricks, SHUTTER_AT } from '../src/ui/hand/phoneTricks';
import { VIEW_AXES, axisAngle, fromEulerXYZ, mat3, mul, mulT, toAxisAngleQ } from '../src/ui/hand/rot';
import { UNITS_PER_IMAGE_HEIGHT } from '../src/ui/hand/rope';
import { socketPoint } from '../src/ui/hand/view';
import { VM_PHONE_MODE } from '../src/render/types';
import type { HeldItemId } from '../src/engine/settingsTypes';
import { ViewModel } from '../src/render/viewmodel/ViewModel';
import { DataTexture, Mesh, ShaderMaterial, Vector3 } from 'three';

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
/** Die vier Freischaltungen aus Plan 005/006 (Zuordnung unverändert). */
const ALL: UnlockId[] = ['glove.neon', 'item.card', 'item.can', 'item.knife'];
/** Alles, was L1/L2 allein vergeben (alle Medaillen in beiden): Plan-006-Vier + Jo-Jo, Feuerzeug, Skelett. */
const L12: UnlockId[] = ['item.yoyo', 'item.lighter', 'glove.neon', 'glove.skeleton', 'item.card', 'item.can', 'item.knife'];
/** Alle 14 aus der Freischalt-Tabelle (Plan 007 §7), in Leiter-Reihenfolge. */
const ALL14: UnlockId[] = UNLOCKS.map((u) => u.id);
const legacy = (ids: readonly UnlockId[]): UnlockId[] => ids.filter((id) => ALL.includes(id));

/** Trainings-Fortschritt als Fake: T1–T4 Grundlagen, T5–T8 Fortgeschritten. */
function trainingView(stars: Record<string, LessonStars>, count = 8): TrainingProgressView {
  const lessons: TrainingIndexEntry[] = [];
  for (let i = 1; i <= count; i++) {
    lessons.push({ id: `t${i}`, name: `T${i}`, file: `t${i}.json`, lesson: i, short: `T${i}`, group: i <= 4 ? 'basics' : 'advanced' });
  }
  return { stars: (id) => stars[id] ?? 0, lessons: () => lessons };
}

describe('Freischaltungen (Plan 006, Tabelle Plan 007)', () => {
  it('Plan-006-Zuordnung bleibt: L1-Gold → Neon, L1-VELOCITY → Karte, L2-VELOCITY → Dose, beide VELOCITY → Messer; Sandbox nie', () => {
    const best = new Map<string, number>();
    const get = (id: string): number | null => best.get(id) ?? null;
    expect(legacy(deriveUnlocks(LEVELS, get))).toEqual([]);
    best.set('level1', 25.0); // Silber
    expect(legacy(deriveUnlocks(LEVELS, get))).toEqual([]);
    best.set('level1', 24.0); // Gold
    expect(legacy(deriveUnlocks(LEVELS, get))).toEqual(['glove.neon']);
    best.set('level1', 23.4); // genau VELOCITY
    expect(legacy(deriveUnlocks(LEVELS, get))).toEqual(['glove.neon', 'item.card']);
    best.set('level2', 17.0); // L2-Gold reicht nicht
    expect(legacy(deriveUnlocks(LEVELS, get))).toEqual(['glove.neon', 'item.card']);
    best.set('level2', 15.0); // unter der Autor-Zeit = auch VELOCITY
    expect(legacy(deriveUnlocks(LEVELS, get))).toEqual(ALL);
    // Nur L2-VELOCITY: Dose, aber kein Messer.
    expect(legacy(deriveUnlocks(LEVELS, (id) => (id === 'level2' ? 15 : null)))).toEqual(['item.can']);
    expect(deriveUnlocks([{ id: 'sandbox', medals: M1 }], () => 1)).toEqual([]);
    for (const u of UNLOCKS) for (const r of u.requires) if (r.kind === 'medal') expect(r.levelId).not.toBe('sandbox');
  });

  it('Tabelle Plan 007: 14 Einträge, Medaillen-Stufen in L1/L2, L3/L4 erst mit ihren Leveln', () => {
    expect(ALL14).toHaveLength(14);
    expect(new Set(ALL14).size).toBe(14);
    const best = new Map<string, number>();
    const get = (id: string): number | null => best.get(id) ?? null;
    best.set('level1', 25.0); // L1 Silber → Jo-Jo
    expect(deriveUnlocks(LEVELS, get)).toEqual(['item.yoyo']);
    best.set('level2', 18.0); // L2 Silber → Sturmfeuerzeug
    expect(deriveUnlocks(LEVELS, get)).toEqual(['item.yoyo', 'item.lighter']);
    best.set('level2', 17.0); // L2 Gold → Skelett
    expect(deriveUnlocks(LEVELS, get)).toEqual(['item.yoyo', 'item.lighter', 'glove.skeleton']);
    // Alles in L1/L2: Münze, Gold-Handschuh und Katzenpfote brauchen L3 und L4 — die gibt es noch nicht.
    const all12 = deriveUnlocks(LEVELS, () => 1);
    expect(all12).toEqual(['item.yoyo', 'item.lighter', 'glove.neon', 'glove.skeleton', 'item.card', 'item.can', 'item.knife']);
    const four = [...LEVELS, { id: 'level3', medals: M1 }, { id: 'level4', medals: M2 }];
    expect(deriveUnlocks(four, () => 1)).toEqual(ALL14.filter((id) => id !== 'item.spinner' && id !== 'glove.robot'));
    // Bronze in allen vier → Münze, aber noch kein Gold-Handschuh.
    const bronze = (id: string): number | null => (id === 'level1' || id === 'level3' ? 36 : 21);
    expect(deriveUnlocks(four, bronze)).toEqual(['item.coin']);
  });

  it('Training-Anforderung: Grundlagen ★ → Spinner, alles ★ → Roboter; ohne Fortschritt/Lektionen nie', () => {
    const basics = trainingView({ t1: 1, t2: 2, t3: 3, t4: 1 });
    expect(deriveUnlocks(LEVELS, () => null, basics)).toEqual(['item.spinner']);
    const all = trainingView({ t1: 1, t2: 1, t3: 1, t4: 1, t5: 1, t6: 2, t7: 1, t8: 3 });
    expect(deriveUnlocks(LEVELS, () => null, all)).toEqual(['item.spinner', 'glove.robot']);
    // Eine Lektion fehlt → nichts aus dieser Gruppe.
    expect(deriveUnlocks(LEVELS, () => null, trainingView({ t1: 1, t2: 1, t3: 1 }))).toEqual([]);
    expect(deriveUnlocks(LEVELS, () => null, trainingView({ t1: 1, t2: 1, t3: 1, t4: 1, t5: 1, t6: 1, t7: 1 }))).toEqual(['item.spinner']);
    // Ohne View und ohne Lektionen (Index nicht geladen): every() über nichts zählt nicht.
    expect(deriveUnlocks(LEVELS, () => null)).toEqual([]);
    expect(deriveUnlocks(LEVELS, () => null, trainingView({}, 0))).toEqual([]);
  });

  it('Phase 3: die Ableitung vergibt alle 14 (nichts mehr zurückgehalten), Admin-Medaille ebenso', () => {
    const mem = new MemoryStorage();
    const s = new UnlockStore(mem);
    const four = [...LEVELS, { id: 'level3', medals: M1 }, { id: 'level4', medals: M2 }];
    const full = trainingView({ t1: 3, t2: 3, t3: 3, t4: 3, t5: 3, t6: 3, t7: 3, t8: 3 });
    expect(s.sync(four, () => 1, full)).toEqual(ALL14);
    expect(s.list()).toEqual(ALL14);
    const m = new MemoryStorage();
    const t = new UnlockStore(m);
    const best = new BestTimes(m);
    best.set('level1', adminTimeFor('silver', M1));
    expect(t.grantEarnedFor('level1', LEVELS, (id) => best.get(id))).toEqual(['item.yoyo']);
    expect(new UnlockStore(m).list()).toEqual(['item.yoyo']);
    t.unlockAll();
    expect(new UnlockStore(m).list()).toEqual(ALL14);
  });

  it('die echten Level-Medaillen passen zur Ableitung', () => {
    const idx = parseIndex(JSON.parse(readFileSync('public/levels/index.json', 'utf8')));
    // Plan 007 Phase 3: alle vier Level stehen mit Medaillen im Index (keine Ausnahme mehr für L3/L4).
    expect(idx.map((l) => l.id)).toEqual(['level1', 'level2', 'level3', 'level4']);
    for (const u of UNLOCKS) {
      for (const r of u.requires) {
        if (r.kind === 'medal') expect(idx.find((l) => l.id === r.levelId)?.medals, u.id).toBeDefined();
      }
    }
    // Index = Level-Datei (build.ts schreibt beide; die Freischaltung liest den Index, das Ergebnis die Datei).
    for (const e of idx) expect(JSON.parse(readFileSync(`public/levels/${e.file}`, 'utf8')).medals, e.id).toEqual(e.medals);
    const l1 = idx.find((l) => l.id === 'level1');
    if (!l1?.medals) throw new Error('level1 ohne Medaillen');
    expect(deriveUnlocks(idx, (id) => (id === 'level1' ? (l1.medals?.gold ?? null) : null))).toEqual(['item.yoyo', 'glove.neon']);
    expect(deriveUnlocks(idx, (id) => (id === 'level1' ? (l1.medals?.velocity ?? null) : null))).toEqual(['item.yoyo', 'glove.neon', 'item.card']);
  });

  it('persistiert versioniert (v3), meldet nur NEUE Freischaltungen, übersteht kaputten Speicher', () => {
    const mem = new MemoryStorage();
    const store = new UnlockStore(mem);
    expect(store.list()).toEqual([]);
    const best = (id: string): number | null => (id === 'level2' ? 16.0 : null);
    const l2: UnlockId[] = ['item.lighter', 'glove.skeleton', 'item.can'];
    expect(store.sync(LEVELS, best)).toEqual(l2);
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
    expect(new UnlockStore(mem).sync(LEVELS, best)).toEqual(l2);
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
    expect(new UnlockStore(mem).list()).toEqual(L12);
    expect(new UnlockStore(mem).sync(LEVELS, () => null)).toEqual([]);
    expect(new UnlockStore(mem).list()).toEqual(L12);
  });

  it('unlockAll / reset: reset hält dauerhaft gegen die Ableitung (auch nach Neuladen)', () => {
    const mem = new MemoryStorage();
    const s = new UnlockStore(mem);
    let calls = 0;
    s.subscribe(() => calls++);
    s.unlockAll();
    expect(s.list()).toEqual(ALL14);
    s.reset();
    expect(s.list()).toEqual([]);
    expect(s.sync(LEVELS, () => 1)).toEqual([]);
    expect(calls).toBeGreaterThan(0);
    // Admin-Sperre ist gespeichert — Neuladen + Ableitung holt nichts zurück.
    expect(new UnlockStore(mem).sync(LEVELS, () => 1)).toEqual([]);
    const again = new UnlockStore(mem);
    again.unlockAll();
    expect(again.list()).toEqual(ALL14);
    expect(ALL14.every((id) => !again.isLocked(id))).toBe(true);
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
    expect(re.list()).toEqual(L12.filter((id) => id !== 'glove.neon'));
    // Wieder an: Sperre weg.
    re.set('glove.neon', true);
    expect(re.isLocked('glove.neon')).toBe(false);
    expect(new UnlockStore(mem).list()).toEqual(L12);
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
    // ... die Admin-Medaille nicht: L1-VELOCITY → Jo-Jo (Silber), Neon (Gold), Karte; Messer braucht noch L2.
    expect(s.grantEarnedFor('level1', LEVELS, (id) => best.get(id))).toEqual(['item.yoyo', 'glove.neon', 'item.card']);
    expect(s.isLocked('item.can')).toBe(true);
    expect(s.isLocked('item.knife')).toBe(true);
    best.set('level2', adminTimeFor('velocity', M2));
    expect(s.grantEarnedFor('level2', LEVELS, (id) => best.get(id))).toEqual(['item.lighter', 'glove.skeleton', 'item.can', 'item.knife']);
    expect(new UnlockStore(mem).list()).toEqual(L12);
  });

  it('Migration v2 → v3: nichts gesperrt, Einträge bleiben, Neuschreiben mit locked: []', () => {
    const mem = new MemoryStorage();
    mem.setItem(UNLOCKS_KEY, JSON.stringify({ v: 2, unlocked: { 'item.can': '2026-09-28T02:00:00Z' } }));
    const s = new UnlockStore(mem);
    expect(s.list()).toEqual(['item.can']);
    expect(UNLOCKS.every((u) => !s.isLocked(u.id))).toBe(true);
    expect(JSON.parse(mem.getItem(UNLOCKS_KEY) ?? 'null')).toEqual({ v: 3, unlocked: { 'item.can': '2026-09-28T02:00:00Z' }, locked: [] });
    // Ableitung wirkt normal weiter.
    expect(s.sync(LEVELS, () => 1)).toEqual(L12.filter((id) => id !== 'item.can'));
    // Kaputte/fremde Sperr-Einträge fallen weg; frei gewinnt gegen gesperrt.
    mem.setItem(UNLOCKS_KEY, JSON.stringify({ v: 3, unlocked: { 'item.can': 'x' }, locked: ['item.can', 'hat.crown', 'glove.neon', 7] }));
    const t = new UnlockStore(mem);
    expect(t.has('item.can')).toBe(true);
    expect(t.isLocked('item.can')).toBe(false);
    expect(t.isLocked('glove.neon')).toBe(true);
    expect(t.sync(LEVELS, () => 1)).toEqual(L12.filter((id) => id !== 'item.can' && id !== 'glove.neon'));
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
    // Plan 007: jede Kosmetik hat genau eine Freischaltung, und die legt genau diese Kosmetik an.
    for (const g of GLOVE_IDS) {
      const id = gloveUnlock(g);
      if (g === 'classic') expect(id).toBeNull();
      else {
        expect(id !== null && ALL14.includes(id), g).toBe(true);
        if (id) expect(unlockPatch(id)).toEqual({ glove: g });
      }
    }
    for (const i of HELD_ITEM_IDS) {
      const id = itemUnlock(i);
      if (i === 'none') expect(id).toBeNull();
      else {
        expect(id !== null && ALL14.includes(id), i).toBe(true);
        if (id) expect(unlockPatch(id)).toEqual({ heldItem: i });
      }
    }
    expect(GLOVE_IDS.length - 1 + HELD_ITEM_IDS.length - 1).toBe(ALL14.length);
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
    // 'gold' ist seit Plan 007 ein echter Skin — ungültig ist ein unbekannter Name.
    mem.setItem(SETTINGS_KEY, JSON.stringify({ glove: 'platinum', heldItem: 42 }));
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

const JUMP = (speed: number, chain = 2, perfect = true): GameEvent => ({ type: 'jump', speed, gain: 5, perfect, clean: perfect, chain, sync: 0.9, crouched: false, coyote: false });
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

// ------------------------------------------------------------------ Kosmetik v2 (Plan 007, cosmetics-core)

describe('Registries (Plan 007 K1)', () => {
  it('jeder Gegenstand mit Trick-Maschine hat eine Darstellung und umgekehrt; Skins der Registry sind GloveIds', () => {
    for (const i of HELD_ITEM_IDS) expect(hasPropTricks(i), i).toBe(hasItemView(i));
    expect(hasPropTricks('none')).toBe(false);
    for (const g of GLOVE_IDS) if (g === 'classic' || g === 'neon') expect(hasSkin(g)).toBe(true);
    // Phase 1: Gold, Roboter, Spinner sind da.
    expect(hasSkin('gold') && hasSkin('robot') && hasItemView('spinner') && hasPropTricks('spinner')).toBe(true);
  });

  it('forceTrick ist generisch: jeder Trick-Name des Gegenstands startet, fremde nicht, "none" immer', () => {
    for (const item of HELD_ITEM_IDS) {
      const h = new ViewHand();
      h.setItem(item);
      const names = h.state().tricks;
      if (!hasPropTricks(item)) {
        expect(names).toEqual([]);
        expect(h.forceTrick('flick')).toBe(false);
      }
      for (const n of names) {
        expect(h.forceTrick(n, 0.1), `${item}/${n}`).toBe(true);
        h.update(1 / 60, makeHandInput());
        expect(h.state().trick, `${item}/${n}`).toBe(n);
      }
      expect(h.forceTrick('none')).toBe(true);
      expect(h.forceTrick('keinTrick')).toBe(false);
    }
  });
});

/** Minimaler Gegenstand für die Haken der Trick-Maschine. */
class HookProbe extends PropTricksBase<'a' | 'b'> {
  calls: string[] = [];
  override get trickNames(): readonly string[] {
    return ['a', 'b'];
  }
  protected writeRest(o: PropOut): void {
    o.pose = POSE.grip;
  }
  protected evaluate(_id: 'a' | 'b', t: number): boolean {
    return t >= 0.5;
  }
  protected onJump(): void {
    this.calls.push('jump');
    this.start('a');
  }
  protected onMilestone(): void {
    this.calls.push('milestone');
  }
  protected onIdle(): number {
    this.calls.push('idle');
    return 10;
  }
  protected cooldownOf(): number {
    return 0;
  }
  protected resetRun(): void {}
  protected override onCheckpoint(split: number | null): void {
    this.calls.push(`cp:${split}`);
  }
  protected override onSurfStart(speed: number): void {
    this.calls.push(`surf:${Math.round(speed)}`);
  }
  protected override onSurfEnd(): void {
    this.calls.push('surfEnd');
  }
}

describe('PropTricks-Haken (Plan 007 K1)', () => {
  it('Checkpoint, Surf-Beginn (mit Tempo des letzten Frames) und -Ende nur ohne laufenden Trick und mit motionFx > 0', () => {
    const p = new HookProbe();
    p.update(1 / 60, AIR(640));
    p.onEvent({ type: 'checkpoint', index: 1, total: 3, time: 4, split: -0.3 });
    p.onEvent({ type: 'surfStart' });
    p.onEvent({ type: 'surfEnd' });
    expect(p.calls).toEqual(['cp:-0.3', 'surf:640', 'surfEnd']);
    p.calls = [];
    p.onEvent(JUMP(650));
    p.onEvent({ type: 'checkpoint', index: 2, total: 3, time: 5, split: null });
    expect(p.calls).toEqual(['jump']);
    p.calls = [];
    p.stop();
    p.motionFx = 0;
    p.onEvent({ type: 'checkpoint', index: 2, total: 3, time: 5, split: null });
    p.onEvent({ type: 'surfStart' });
    expect(p.calls).toEqual([]);
  });

  it('hold (Rutschen): keine neuen Tricks, kein Leerlauf — ein laufender Trick spielt zu Ende', () => {
    const p = new HookProbe();
    p.onEvent(JUMP(650));
    expect(p.trick).toBe('a');
    p.hold = true;
    for (let f = 0; f < 60; f++) p.update(1 / 60, GROUND(0));
    expect(p.trick).toBe('none');
    p.calls = [];
    p.onEvent(JUMP(650));
    p.onEvent({ type: 'speedMilestone', speed: 1000 });
    p.onEvent({ type: 'checkpoint', index: 1, total: 3, time: 4, split: 0.2 });
    for (let f = 0; f < 60 * 15; f++) p.update(1 / 60, GROUND(0));
    expect(p.calls).toEqual([]);
    p.hold = false;
    p.onEvent(JUMP(650));
    expect(p.calls).toEqual(['jump']);
  });

  it('Ausgabefelder: zweiter Körper, Schnur und Kanäle sind angelegt und neutral', () => {
    const o = new PropOut();
    expect(o.sub.length).toBe(3);
    expect(o.subRot.length).toBe(3);
    expect(o.string.length).toBe(VM_STRING_POINTS * 3);
    expect(o.param.length).toBe(4);
    expect(o.subVisible).toBe(0);
    expect(o.stringCount).toBe(0);
  });
});

describe('Fidget-Spinner (Plan 007 K5)', () => {
  const settle = (s: SpinnerTricks, speed: number, seconds: number, fps = 60): void => {
    for (let f = 0; f < seconds * fps; f++) s.update(1 / fps, AIR(speed));
  };

  it('Drehzahl folgt dem Tempo: ω → 6 + 0.07·Tempo (hoch τ 0.8 s, runter 3 s)', () => {
    const s = new SpinnerTricks();
    s.motionFx = 1;
    settle(s, 1000, 6);
    expect(s.omega).toBeCloseTo(SPINNER_OMEGA_BASE + SPINNER_OMEGA_PER_SPEED * 1000, 0);
    settle(s, 0, 0.8);
    // Nach 0.8 s runter (τ 3 s) noch deutlich über dem Stand-Wert — Auslaufen dauert.
    expect(s.omega).toBeGreaterThan(40);
    settle(s, 0, 30);
    expect(s.omega).toBeCloseTo(SPINNER_OMEGA_BASE, 1);
  });

  it('Schnipp-Impulse: Sprung +8, perfekter Hop +14, Meilenstein +20 — auch mitten im Trick; Deckel 110 rad/s', () => {
    const s = new SpinnerTricks();
    const w0 = s.omega;
    s.onEvent(JUMP(400, 2, false));
    expect(s.omega).toBeCloseTo(w0 + 8, 6);
    expect(s.trick).toBe('flick');
    s.onEvent(JUMP(400, 3, true));
    expect(s.omega).toBeCloseTo(w0 + 22, 6);
    s.onEvent({ type: 'speedMilestone', speed: 750 });
    expect(s.omega).toBeCloseTo(w0 + 42, 6);
    for (let k = 0; k < 20; k++) s.onEvent(JUMP(950, 3, true));
    expect(s.omega).toBe(SPINNER_OMEGA_MAX);
  });

  it('Tempo-Stufen: Lauf flick, Flow toss/swap, Overdrive ufo/toss', () => {
    const s = new SpinnerTricks();
    expect(tricksAt(s, 200).size).toBe(0);
    expect([...tricksAt(s, 400)]).toEqual(['flick']);
    for (const tier of [2, 3]) {
      const got = tricksAt(s, [0, 400, 650, 950][tier]);
      for (const t of got) expect(SPINNER_TIER_TRICKS[tier]).toContain(t as SpinnerTrick);
      expect(got.size).toBeGreaterThanOrEqual(2);
    }
  });

  it('Aliasing-Deckel: angezeigter Schritt ≤ 0.9 rad/Frame, darüber Unschärfe; bei 144 Hz dreht er ohne Ring', () => {
    for (const fps of [30, 60, 144]) {
      const s = new SpinnerTricks();
      settle(s, 1000, 6, fps);
      let prev = s.shownAngle;
      let worst = 0;
      for (let f = 0; f < 60; f++) {
        s.update(1 / fps, AIR(1000));
        const d = (s.shownAngle - prev + Math.PI * 2) % ((Math.PI * 2) / 3);
        worst = Math.max(worst, d);
        prev = s.shownAngle;
      }
      expect(worst, `${fps} Hz`).toBeLessThanOrEqual(SPINNER_STEP_CAP + 1e-6);
      const step = s.omega / fps;
      if (step > SPINNER_STEP_CAP) expect(s.blur, `${fps} Hz`).toBeGreaterThan(0.1);
      if (fps === 144) expect(s.blur).toBe(0);
      expect(s.out.param[VM_PARAM.spinner.blur]).toBeCloseTo(s.blur, 6);
    }
  });

  it('Surf ≥ 500 u/s: balanciert auf der Fingerspitze (Zustand, zählt nicht als Trick), endet mit dem Surf', () => {
    const s = new SpinnerTricks();
    s.update(1 / 60, AIR(700));
    s.onEvent({ type: 'surfStart' });
    expect(s.trick).toBe('balance');
    expect(s.inState).toBe(true);
    const surf: PropFrameInput = { speed: 800, onGround: false, surfing: true, surfSide: 0.7 };
    let point = false;
    for (let f = 0; f < 60 * 3; f++) {
      s.update(1 / 60, surf);
      if (s.out.pose === POSE.point) point = true;
    }
    expect(point).toBe(true);
    expect(s.trick).toBe('balance');
    // Neuer Sprung während des Surfs startet nichts (Zustand läuft).
    s.onEvent(JUMP(900));
    expect(s.trick).toBe('balance');
    for (let f = 0; f < 60; f++) s.update(1 / 60, AIR(800));
    expect(s.trick).toBe('none');
    expect(s.out.pos[0]).toBeCloseTo(SPINNER_HOLD_POS[0], 4);
    // Langsamer Surf: kein Balancieren.
    const t = new SpinnerTricks();
    t.update(1 / 60, AIR(300));
    t.onEvent({ type: 'surfStart' });
    t.update(1 / 60, { speed: 300, onGround: false, surfing: true });
    expect(t.trick).toBe('none');
  });

  it('Checkpoint: großer flick, Nabe grün vor der Bestzeit, rot dahinter', () => {
    const s = new SpinnerTricks();
    s.onEvent({ type: 'checkpoint', index: 1, total: 3, time: 4, split: -0.3 });
    expect(s.trick).toBe('flick');
    s.update(1 / 60, GROUND(0));
    expect(s.out.param[VM_PARAM.spinner.hub]).toBeGreaterThan(0.2);
    for (let f = 0; f < 90; f++) s.update(1 / 60, GROUND(0));
    s.onEvent({ type: 'checkpoint', index: 2, total: 3, time: 8, split: 0.4 });
    s.update(1 / 60, GROUND(0));
    expect(s.out.param[VM_PARAM.spinner.hub]).toBeLessThan(-0.2);
    for (let f = 0; f < 90; f++) s.update(1 / 60, GROUND(0));
    expect(s.out.param[VM_PARAM.spinner.hub]).toBe(0);
  });

  it('motionFx 0: der Spinner steht (Winkel fest, ω 0, keine Unschärfe, keine Tricks)', () => {
    const h = new ViewHand();
    h.setItem('spinner');
    h.motionFx = 0;
    const inp = makeHandInput();
    let angle: number | null = null;
    for (let f = 0; f < 60 * 5; f++) {
      if (f % 40 === 0) h.onEvent(JUMP(950));
      inp.speed = 1000;
      h.update(1 / 60, inp);
      const a = h.frame.propParam[VM_PARAM.spinner.angle];
      if (angle === null) angle = a;
      expect(a).toBe(angle);
      expect(h.frame.propParam[VM_PARAM.spinner.blur]).toBe(0);
      expect(h.state().trick).toBe('none');
    }
    expect(h.spinner.omega).toBe(0);
  });

  it('ist framerate-unabhängig (30/60/144/240 Hz gegen 1200 Hz)', () => expectDtIndependent(() => new SpinnerTricks()));

  /**
   * Ein Trick ab t = 1/6 s, JEDER Frame gegen 1440 Hz (alle Frame-Zeiten von 30/60/144/240 Hz liegen auf
   * dessen Raster). Balance: 1 s surfen, Surf-Ende auf dem Raster. Verglichen werden Lage und Hand-
   * Versatz; ω-Sprünge und Hand-Impulse fallen absichtlich auf den Frame der Marke (nicht verglichen).
   */
  const trickRun = (name: SpinnerTrick, fps: number): number[][] => {
    const s = new SpinnerTricks();
    const dt = 1 / fps;
    const start = Math.round(fps / 6);
    const surfEnd = Math.round((fps * 7) / 6);
    const out: number[][] = [];
    for (let f = 1; f <= Math.round(2 * fps); f++) {
      const surfing = name === 'balance' && f >= start && f < surfEnd;
      if (f === start) {
        if (name === 'balance') s.onEvent({ type: 'surfStart' });
        else s.debugPlayName(name, -1);
      }
      s.update(dt, surfing ? { speed: 800, onGround: false, surfing: true, surfSide: 0.5 } : AIR(800));
      s.out.kickY = 0;
      s.out.kickSq = 0;
      out.push(sample(s));
    }
    return out;
  };

  it('jeder Trick einzeln framerate-unabhängig, jeder Frame (≤ 0.001; vorher toss 0.023, balance 0.085 rad bei 30 Hz)', () => {
    const REF = 1440;
    for (const name of SPINNER_TRICKS.filter((t): t is SpinnerTrick => t !== 'none')) {
      const ref = trickRun(name, REF);
      let started = false;
      for (const fps of [30, 60, 144, 240]) {
        const got = trickRun(name, fps);
        let worst = 0;
        for (let i = 0; i < got.length; i++) {
          const j = ((i + 1) * REF) / fps - 1;
          for (let k = 0; k < got[i].length; k++) worst = Math.max(worst, Math.abs(got[i][k] - ref[j][k]));
          if (got[i][0] !== got[0][0]) started = true;
        }
        expect(worst, `${name} ${fps} Hz`).toBeLessThanOrEqual(0.001);
      }
      // Der Trick hat sich tatsächlich bewegt (sonst prüft der Vergleich nichts).
      expect(started, name).toBe(true);
    }
  });

  it('Drehzahl: Hochlauf τ 0.8 s und Auslauf τ 3 s exakt exponentiell, bei jeder Framerate', () => {
    const target = SPINNER_OMEGA_BASE + SPINNER_OMEGA_PER_SPEED * 1000;
    for (const fps of [30, 60, 144, 240]) {
      const s = new SpinnerTricks();
      const run = (speed: number, seconds: number): void => {
        for (let f = 0; f < Math.round(seconds * fps); f++) s.update(1 / fps, AIR(speed));
      };
      run(0, 1);
      expect(s.omega).toBeCloseTo(SPINNER_OMEGA_BASE, 9);
      run(1000, 5 / 6);
      expect(s.omega, `hoch ${fps} Hz`).toBeCloseTo(target + (SPINNER_OMEGA_BASE - target) * Math.exp(-5 / 6 / 0.8), 6);
      run(1000, 20);
      run(0, 3);
      expect(s.omega, `runter ${fps} Hz`).toBeCloseTo(SPINNER_OMEGA_BASE + (target - SPINNER_OMEGA_BASE) * Math.exp(-1), 3);
    }
  });

  it('keine NaN bei wilden Eingaben', () => {
    const s = new SpinnerTricks();
    wild(s);
    for (const v of s.out.param) expect(Number.isFinite(v)).toBe(true);
    expect(Number.isFinite(s.omega)).toBe(true);
  });
});

describe('Skin-Effekte (Plan 007 K3/K4)', () => {
  it('Gold: perfekter Hop → Funkeln 1, in 0.25 s auf 0; nicht bei motionFx 0 und nicht für andere Skins', () => {
    const h = new ViewHand();
    h.setGlove('gold');
    const inp = makeHandInput();
    h.update(1 / 60, inp);
    expect(h.frame.skinFx).toBe(0);
    h.onEvent(JUMP(600, 3, true));
    h.update(1 / 120, inp);
    expect(h.frame.skinFx).toBeGreaterThan(0.9);
    for (let f = 0; f < 30; f++) h.update(1 / 120, inp);
    expect(h.frame.skinFx).toBe(0);
    h.onEvent(JUMP(600, 3, false));
    h.update(1 / 120, inp);
    expect(h.frame.skinFx).toBe(0);
    h.motionFx = 0;
    h.onEvent(JUMP(600, 3, true));
    h.update(1 / 120, inp);
    expect(h.frame.skinFx).toBe(0);
    const c = new ViewHand();
    c.onEvent(JUMP(600, 3, true));
    c.update(1 / 120, inp);
    expect(c.frame.skinFx).toBe(0);
  });

  it('Katze: Krallen in Ruhe halb draußen (0.3), bei gutem Hop ab 500 u/s ganz raus, bei der Landung wieder rein; motionFx 0 ruhig', () => {
    const h = new ViewHand();
    h.setGlove('cat');
    const inp = makeHandInput();
    for (let f = 0; f < 30; f++) h.update(1 / 60, inp);
    expect(h.frame.skinFx).toBeCloseTo(0.3, 6);
    h.onEvent(JUMP(650, 3, true));
    for (let f = 0; f < 15; f++) h.update(1 / 60, inp);
    expect(h.frame.skinFx).toBeGreaterThan(0.95);
    h.onEvent({ type: 'land', impact: 300, speed: 600, airTime: 0.5, jumpQueued: true });
    for (let f = 0; f < 60; f++) h.update(1 / 60, inp);
    expect(h.frame.skinFx).toBeLessThan(0.32);
    // Langsamer guter Hop: keine Krallen; Checkpoint: raus.
    h.onEvent(JUMP(350, 3, true));
    for (let f = 0; f < 15; f++) h.update(1 / 60, inp);
    expect(h.frame.skinFx).toBeLessThan(0.32);
    h.onEvent({ type: 'checkpoint', index: 1, total: 3, time: 4, split: null });
    for (let f = 0; f < 15; f++) h.update(1 / 60, inp);
    expect(h.frame.skinFx).toBeGreaterThan(0.95);
    const q = new ViewHand();
    q.setGlove('cat');
    q.motionFx = 0;
    q.onEvent(JUMP(650, 3, true));
    for (let f = 0; f < 15; f++) q.update(1 / 60, inp);
    expect(q.frame.skinFx).toBeCloseTo(0.3, 6);
  });

  it('Katze: Treteln ohne Gegenstand im Stand nach 6–9 s (Zeige+Ring gegen Mittel+Klein), nicht mit Gegenstand', () => {
    const h = new ViewHand();
    h.setGlove('cat');
    const inp = makeHandInput();
    let kneadAt = -1;
    let diff = 0;
    for (let f = 0; f < 60 * 12; f++) {
      h.update(1 / 60, inp);
      const j = h.frame.joints;
      // Zeigefinger-Grundgelenk gegen die Pose: Treteln beugt ihn im Wechsel.
      const d = Math.abs(j[7 + 1] - h['joints'][7 + 1]);
      if (d > 0.05 && kneadAt < 0) kneadAt = f / 60;
      diff = Math.max(diff, d);
    }
    expect(kneadAt).toBeGreaterThan(6);
    expect(kneadAt).toBeLessThan(9.6);
    expect(diff).toBeGreaterThan(0.3);
    const c = new ViewHand();
    c.setGlove('cat');
    c.setItem('can');
    let moved = 0;
    for (let f = 0; f < 60 * 12; f++) {
      c.can.debugPlay('none');
      c.update(1 / 60, inp);
      moved = Math.max(moved, Math.abs(c.frame.joints[8] - c['joints'][8]));
    }
    expect(moved).toBe(0);
  });

  it('Skelett: harte Landung → Klappern 1, in 0.3 s weg; weiche Landung und motionFx 0 nicht', () => {
    const h = new ViewHand();
    h.setGlove('skeleton');
    const inp = makeHandInput();
    h.update(1 / 60, inp);
    h.onEvent({ type: 'land', impact: 600, speed: 400, airTime: 1, jumpQueued: false });
    h.update(1 / 120, inp);
    expect(h.frame.skinFx).toBeGreaterThan(0.95);
    for (let f = 0; f < 40; f++) h.update(1 / 120, inp);
    expect(h.frame.skinFx).toBe(0);
    h.onEvent({ type: 'land', impact: 300, speed: 400, airTime: 1, jumpQueued: false });
    h.update(1 / 120, inp);
    expect(h.frame.skinFx).toBe(0);
    const q = new ViewHand();
    q.setGlove('skeleton');
    q.motionFx = 0;
    q.onEvent({ type: 'land', impact: 900, speed: 400, airTime: 1, jumpQueued: false });
    q.update(1 / 120, inp);
    expect(q.frame.skinFx).toBe(0);
  });

  it('Roboter: LED wird mit dem Tempo heller (weich), im Stand 0', () => {
    const h = new ViewHand();
    h.setGlove('robot');
    const inp = makeHandInput();
    for (let f = 0; f < 60; f++) h.update(1 / 60, inp);
    expect(h.frame.skinFx).toBeCloseTo(0, 6);
    inp.speed = 1000;
    h.update(1 / 60, inp);
    expect(h.frame.skinFx).toBeLessThan(0.2);
    for (let f = 0; f < 120; f++) h.update(1 / 60, inp);
    expect(h.frame.skinFx).toBeGreaterThan(0.95);
  });
});

describe('Lob für verlustfreie Hops (jump.clean — perfekt ODER in der Lande-Gnade, movement.md §6)', () => {
  /** Hop in der Lande-Gnade: nicht tick-genau (perfect false), aber verlustfrei (clean true). */
  const GRACE = (speed: number, chain = 6): GameEvent => ({ type: 'jump', speed, gain: 5, perfect: false, clean: true, chain, sync: 0.9, crouched: false, coyote: false });
  const LOSSY = (speed: number, chain = 6): GameEvent => ({ type: 'jump', speed, gain: 5, perfect: false, clean: false, chain, sync: 0.9, crouched: false, coyote: false });

  it('Gold funkelt, der Spinner schnippt +14, das Messer macht den Doppel-Aerial — wie Kamera und Landewelle', () => {
    const h = new ViewHand();
    h.setGlove('gold');
    h.update(1 / 60, makeHandInput());
    h.onEvent(GRACE(600));
    h.update(1 / 120, makeHandInput());
    expect(h.frame.skinFx).toBeGreaterThan(0.9);
    const s = new SpinnerTricks();
    const w0 = s.omega;
    s.onEvent(GRACE(400));
    expect(s.omega).toBeCloseTo(w0 + 14, 6);
    const k = new KnifeTricks();
    k.onEvent(GRACE(950));
    expect(k.trick).toBe('doubleAerial');
    // Verlustbehafteter Hop: kein Lob.
    const g = new ViewHand();
    g.setGlove('gold');
    g.update(1 / 60, makeHandInput());
    g.onEvent(LOSSY(600));
    g.update(1 / 120, makeHandInput());
    expect(g.frame.skinFx).toBe(0);
    const s2 = new SpinnerTricks();
    s2.onEvent(LOSSY(400));
    expect(s2.omega).toBeCloseTo(w0 + 8, 6);
  });

  it('leere Hand: Daumen hoch nach einer Kette verlustfreier Hops', () => {
    const h = new ViewHand();
    const inp = makeHandInput();
    for (let f = 0; f < 30; f++) h.update(1 / 60, inp);
    h.onEvent(GRACE(600, 6));
    h.update(1 / 60, inp);
    expect(h.state().pose).toBe('thumbsUp');
  });
});

describe('Viewmodel-Geometrie (Plan 007 K2): Helfer für Skins/Gegenstände', () => {
  const RINGS = [
    { y: 0, rx: 2, rz: 1.5 },
    { y: 3, rx: 2.4, rz: 1.8 },
    { y: 6, rx: 1.8, rz: 1.2 },
  ];
  const posOf = (g: BufferGeometry): Float32Array => g.getAttribute('position').array as Float32Array;

  it('Superellipse n = 2 rechnet bitgleich wie die Ellipse ohne n (alter Pfad)', () => {
    const a = tubeGeometry(RINGS, 10, { poleStart: -1, poleEnd: 7 });
    const b = tubeGeometry(
      RINGS.map((r) => ({ ...r, n: 2 })),
      10,
      { poleStart: -1, poleEnd: 7 },
    );
    expect(Array.from(posOf(b))).toEqual(Array.from(posOf(a)));
    expect(Array.from(b.getAttribute('normal').array)).toEqual(Array.from(a.getAttribute('normal').array));
    // n = 4: kantiger — auf der Diagonalen weiter außen als die Ellipse.
    const c = tubeGeometry(
      RINGS.map((r) => ({ ...r, n: 4 })),
      8,
    );
    const e = tubeGeometry(RINGS, 8);
    const diag = 1; // k = 1 von 8 = 45°
    expect(Math.hypot(posOf(c)[diag * 3], posOf(c)[diag * 3 + 2])).toBeGreaterThan(Math.hypot(posOf(e)[diag * 3], posOf(e)[diag * 3 + 2]));
  });

  it('Fell: jeder zweite Vertex außen, die Naht (k = 0 und k = seg) bleibt geschlossen; ungerades seg wirft', () => {
    const seg = 12;
    const g = tubeGeometry(RINGS, seg, { fur: 0.2 });
    const p = posOf(g);
    const row = seg + 1;
    for (let r = 0; r < RINGS.length; r++) {
      const a = r * row;
      const b = a + seg;
      expect(p[b * 3]).toBeCloseTo(p[a * 3], 5);
      expect(p[b * 3 + 2]).toBeCloseTo(p[a * 3 + 2], 5);
      // k = 3 (90°, ungerade) liegt um 20 % weiter außen als die Ellipse.
      expect(p[(a + 3) * 3]).toBeCloseTo(RINGS[r].rx * 1.2, 5);
    }
    expect(() => tubeGeometry(RINGS, 11, { fur: 0.2 })).toThrow();
    expect(() => tubeGeometry(RINGS, 11)).not.toThrow();
  });

  it('mergeGeometries: Index-Versatz je Teil, Farben (ohne Farbe = Fallback), Normalen übernommen', () => {
    const a = tubeGeometry(RINGS, 6, { color: [1, 0, 0] });
    const b = tubeGeometry(RINGS, 6, { poleEnd: 7 });
    const m = mergeGeometries([a, b], [0, 0, 1]);
    const na = a.getAttribute('position').count;
    const nb = b.getAttribute('position').count;
    expect(m.getAttribute('position').count).toBe(na + nb);
    const ia = a.getIndex()?.count ?? 0;
    const ib = b.getIndex()?.count ?? 0;
    const idx = m.getIndex();
    expect(idx?.count).toBe(ia + ib);
    const bi = b.getIndex();
    for (let i = 0; i < ib; i++) expect(idx?.getX(ia + i)).toBe((bi?.getX(i) ?? -1) + na);
    let max = 0;
    for (let i = 0; i < (idx?.count ?? 0); i++) max = Math.max(max, idx?.getX(i) ?? 0);
    expect(max).toBe(na + nb - 1);
    const col = m.getAttribute('color');
    expect([col.getX(0), col.getY(0), col.getZ(0)]).toEqual([1, 0, 0]);
    expect([col.getX(na), col.getY(na), col.getZ(na)]).toEqual([0, 0, 1]);
    const n0 = b.getAttribute('normal');
    const nm = m.getAttribute('normal');
    expect(nm.getX(na + 5)).toBeCloseTo(n0.getX(5), 6);
    expect(nm.getZ(na + 5)).toBeCloseTo(n0.getZ(5), 6);
  });

  it('boneGeometry: Knöpfe dicker als der Schaft, Länge mit Polen, Querschnitt am Knopf = knob', () => {
    const len = 10;
    const knob = 1.6;
    const shaft = 0.7;
    const g = boneGeometry(len, knob, shaft, 8);
    g.computeBoundingBox();
    const bb = g.boundingBox;
    expect(bb?.min.y).toBeCloseTo(-knob * 0.8, 5);
    expect(bb?.max.y).toBeCloseTo(len + knob * 0.8, 5);
    expect(bb?.max.x).toBeCloseTo(knob, 5);
    // Schaft-Mitte (y = len/2) schmal.
    const p = posOf(g);
    let mid = 0;
    for (let i = 0; i < p.length / 3; i++) if (Math.abs(p[i * 3 + 1] - len / 2) < 1e-5) mid = Math.max(mid, Math.abs(p[i * 3]));
    expect(mid).toBeCloseTo(shaft, 5);
  });

  it('annulusGeometry: Ring zwischen r0 und r1, Normale +y', () => {
    const g = annulusGeometry(2, 3, 16);
    const p = posOf(g);
    for (let i = 0; i < p.length / 3; i++) {
      const r = Math.hypot(p[i * 3], p[i * 3 + 2]);
      expect(Math.abs(r - (i % 2 === 0 ? 2 : 3))).toBeLessThan(1e-5);
    }
    expect(g.getAttribute('normal').getY(3)).toBe(1);
    expect(g.getIndex()?.count).toBe(16 * 6);
  });
});

// ------------------------------------------------------------------ Kosmetik v2, Phase 2 (Plan 007, cosmetics-items)

const SURF = (speed: number, side = 0.5): PropFrameInput => ({ speed, onGround: false, surfing: true, surfSide: side });
const CP = (split: number | null): GameEvent => ({ type: 'checkpoint', index: 1, total: 3, time: 4, split });
const FINISH = (best: boolean): GameEvent => ({ type: 'finish', time: 20, best, previousBest: null });

/** Neue Gegenstände (Phase 2) und die mit KI8 nachgerüsteten alten. */
const NEW_ITEMS = ['yoyo', 'lighter', 'coin', 'kendama', 'phone'] as const;
const KI8_ITEMS = ['can', 'card', 'knife'] as const;
/** Surf-Zustand je Gegenstand (Plan 007 KI1–KI8). */
const SURF_STATE: { readonly [K in HeldItemId]?: string } = {
  yoyo: 'surfSleeper',
  lighter: 'surfFlame',
  coin: 'edgeSpin',
  kendama: 'cupRide',
  phone: 'gimbal',
  can: 'surfBalance',
  card: 'surfFan',
  knife: 'surfHeli',
  spinner: 'balance',
};

function makeProp(item: HeldItemId): PropControl {
  const make = PROP_FACTORIES[item];
  if (!make) throw new Error(`keine Trick-Maschine für ${item}`);
  return make();
}

/** Alles, was ein Gegenstand pro Frame ausgibt (inkl. zweitem Körper und Kanälen). */
function sampleAll(p: PropControl): number[] {
  const o = p.out;
  return [o.pos[0], o.pos[1], o.pos[2], o.rot[0], o.rot[1], o.rot[2], o.spin, o.visible, o.scale, o.hx, o.hy, o.hz, o.hpitch, o.hyaw, o.hroll, o.knifeBlade, o.knifeBite, o.subRot[0], o.subRot[1], o.subRot[2], o.subSpin, o.subVisible, o.param[0], o.param[1], o.param[2], o.param[3]];
}
/** Kanäle, die zyklisch laufen (Winkel, Feed-Scroll): modulo vergleichen. */
function cyclic(item: HeldItemId, k: number): number {
  if (k === 6 || k === 20 || (k >= 3 && k <= 5) || (k >= 17 && k <= 19)) return Math.PI * 2; // Winkel
  if (item === 'phone' && k === 24) return 1; // Feed-Scroll 0..1
  if (item === 'lighter' && k === 25) return Math.PI * 2; // Rad-Winkel
  return 0;
}
function diff(a: number, b: number, period: number): number {
  const d = Math.abs(a - b);
  return period > 0 ? Math.min(d % period, period - (d % period)) : d;
}

/** Anteil in Bild-oben (Handgelenk-Raum → Bildachse). */
function upOf(x: number, y: number, z: number): number {
  const u = VIEW_AXES.up;
  return x * u[0] + y * u[1] + z * u[2];
}

/** Hand-Gelenke für afterPose in den Proben (fest: Schnur-Anker und Ken-Lage hängen nur an der Zeitleiste). */
const RUN_JOINTS = POSE_JOINTS[POSE.run];

/**
 * Ein Trick ab t = 1/6 s, JEDER Frame; Zustände (Surf) mit `surfFor` s Surf (Standard 1 s — vor der ersten Einlage),
 * Ende auf dem Raster. Wie trickRun beim Spinner — für alle Gegenstände. `after` = afterPose rufen (Schnur/zweiter Körper).
 */
function runTrick(item: HeldItemId, name: string, fps: number, finishAt = -1, surfFor = 1): { every: number[][]; sub: number[][]; free: boolean; flourishes: number } {
  const p = makeProp(item);
  const dt = 1 / fps;
  const start = Math.round(fps / 6);
  const surfEnd = start + Math.round(fps * surfFor);
  // Optional: Ziel zur Zeit finishAt (auf dem 1/6-s-Raster) — bricht Trick oder Zustand ab.
  const finishFrame = finishAt > 0 ? Math.round(fps * finishAt) : -1;
  const state = SURF_STATE[item] === name;
  const every: number[][] = [];
  const sub: number[][] = [];
  let free = false;
  // Auf das 1/6-s-Raster (alle Frameraten teilen es), sonst endeten die Läufe je Framerate verschieden.
  const total = Math.round((Math.max(15.6, Math.ceil((1 / 6 + surfFor + 1.4) * 6)) / 6) * fps);
  for (let f = 1; f <= total; f++) {
    const surfing = state && f >= start && f < surfEnd;
    if (f === start) {
      if (state) p.onEvent({ type: 'surfStart' });
      else p.debugPlayName(name, -1);
    }
    if (f === finishFrame) p.onEvent(FINISH(true));
    const inp = surfing ? SURF(800) : AIR(800);
    p.update(dt, inp);
    p.afterPose(RUN_JOINTS, inp, dt);
    p.out.kickY = 0;
    p.out.kickSq = 0;
    every.push(sampleAll(p));
    sub.push([p.out.sub[0], p.out.sub[1], p.out.sub[2]]);
    if ((p instanceof YoyoTricks || p instanceof KendamaTricks) && p.rope.freeEnd) free = true;
  }
  return { every, sub, free, flourishes: p.flourishes };
}

/**
 * Anzeige-Kanäle des Handys (Modus, Wert) sind diskret — eigener Test, hier nicht verglichen. Ebenso Sichtbarkeit
 * und Größe der Karte: der Plan-006-Vanish (Ziel-Trick) springt bei V_POP = 1.45 s hart von 0 / 1 auf 1 / 0.05 —
 * 1.45 s liegt auf jedem 60-Hz-Raster, welche Seite ein Frame nimmt, entscheidet die Float-Summe.
 */
function compared(item: HeldItemId, k: number): boolean {
  if (item === 'card' && (k === 7 || k === 8)) return false;
  // Spinner: Rotor-Winkel und Unschärfe hängen absichtlich an der Framerate (Aliasing-Deckel, fallen.md #111).
  if (item === 'spinner' && (k === 22 || k === 23)) return false;
  return !(item === 'phone' && (k === 22 || k === 23));
}

/**
 * Größte Abweichung eines Tricks bei 30/60/144/240 Hz gegen 1440 Hz, jeder Frame. Zweiter Körper auf dem
 * 1/6-s-Raster: geführt in Einheiten; war das Ende irgendwann frei (Pendel), in Pixeln je Framerate
 * (Plan 007: freies Pendel ≤ 2.5 px bei 30 Hz, ≤ 1.3 px ab 60 Hz).
 */
function worstDt(item: HeldItemId, name: string, finishAt = -1, surfFor = 1): { worst: number; worstSub: number; pendulumPx: number[]; moved: boolean; skipped: number } {
  const REF = 1440;
  const ref = runTrick(item, name, REF, finishAt, surfFor);
  let worst = 0;
  let worstSub = 0;
  const pendulumPx: number[] = [];
  let moved = false;
  // Mit Ziel läuft ein Plan-006-Ziel-Trick mit, dessen Zeitleiste an Phasen-Grenzen springt (Messer-Aerial bei
  // 0.1 s, fallen.md #111): liegt die Grenze auf dem Raster, entscheidet die Float-Summe die Seite. Frames im
  // Umkreis eines Frames um eine solche Stufe des Referenzlaufs (ein 1440-Hz-Schritt > 0.2) auslassen, zählen.
  const steps: number[] = [];
  if (finishAt > 0) {
    for (let j = 1; j < ref.every.length; j++) {
      let d = 0;
      for (let k = 0; k < ref.every[j].length; k++) if (compared(item, k)) d = Math.max(d, diff(ref.every[j][k], ref.every[j - 1][k], cyclic(item, k)));
      if (d > 0.2) steps.push(j);
    }
  }
  let skipped = 0;
  for (const fps of [30, 60, 144, 240]) {
    const got = runTrick(item, name, fps, finishAt, surfFor);
    let px = 0;
    const per = REF / fps;
    for (let i = 0; i < got.every.length; i++) {
      const j = ((i + 1) * REF) / fps - 1;
      const a = got.every[i];
      const b = ref.every[j];
      if (steps.some((st) => Math.abs(st - j) <= per)) {
        skipped++;
        continue;
      }
      for (let k = 0; k < a.length; k++) if (compared(item, k)) worst = Math.max(worst, diff(a[k], b[k], cyclic(item, k)));
      if (a.some((v, k) => v !== got.every[0][k])) moved = true;
      if (((i + 1) * 6) % fps === 0) {
        const d = Math.hypot(got.sub[i][0] - ref.sub[j][0], got.sub[i][1] - ref.sub[j][1], got.sub[i][2] - ref.sub[j][2]);
        if (got.free || ref.free) px = Math.max(px, (d / UNITS_PER_IMAGE_HEIGHT) * 270);
        else worstSub = Math.max(worstSub, d);
      }
    }
    pendulumPx.push(px);
  }
  return { worst, worstSub, pendulumPx, moved, skipped };
}

/** 20 000 wilde Schritte (Events, Eingaben, NaN) inkl. afterPose: alles endlich, Sichtbarkeit 0..1. */
function wildAll(p: PropControl): void {
  let seed = 7;
  const rnd = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const joints = new Float32Array(RUN_JOINTS);
  for (let k = 0; k < 20000; k++) {
    const r = rnd();
    if (r < 0.03) p.onEvent(JUMP(rnd() * 3000, 1 + Math.floor(rnd() * 30), rnd() < 0.5));
    else if (r < 0.05) p.onEvent({ type: 'land', impact: rnd() < 0.1 ? Number.NaN : rnd() * 1e5, speed: rnd() * 400, airTime: 1, jumpQueued: rnd() < 0.5 });
    else if (r < 0.052) p.onEvent({ type: 'respawn', reason: 'fall' });
    else if (r < 0.055) p.onEvent({ type: 'speedMilestone', speed: 1000 });
    else if (r < 0.056) p.onEvent(FINISH(rnd() < 0.5));
    else if (r < 0.06) p.onEvent(CP(rnd() < 0.2 ? null : rnd() * 4 - 2));
    else if (r < 0.065) p.onEvent({ type: rnd() < 0.5 ? 'surfStart' : 'surfEnd' });
    const inp: PropFrameInput = { speed: rnd() < 0.01 ? Number.NaN : rnd() * 1500, onGround: rnd() < 0.5, surfing: rnd() < 0.3, surfSide: rnd() < 0.01 ? Number.NaN : rnd() * 2 - 1, handX: rnd() * 0.2 - 0.1, handY: rnd() * 0.2 - 0.1, handTilt: rnd() < 0.01 ? Number.NaN : rnd() * 40 - 20 };
    const dt = rnd() < 0.01 ? Number.NaN : rnd() * 0.2;
    p.update(dt, inp);
    for (let i = 0; i < joints.length; i++) joints[i] = RUN_JOINTS[i] + (rnd() - 0.5) * 0.6;
    p.afterPose(joints, inp, dt);
    // Ohne expect je Wert (20 000 × 8 Gegenstände): erste Verletzung merken.
    let ok = sampleAll(p).every(Number.isFinite) && Number.isFinite(p.out.kickY) && Number.isFinite(p.out.kickSq);
    for (let i = 0; i < 3; i++) ok = ok && Number.isFinite(p.out.sub[i]);
    for (let i = 0; i < p.out.stringCount * 3; i++) ok = ok && Number.isFinite(p.out.string[i]);
    ok = ok && p.out.visible >= 0 && p.out.visible <= 1;
    if (!ok) expect.fail(`Schritt ${k}: nicht endlich oder Sichtbarkeit außerhalb 0..1 (${p.trick})`);
    p.out.kickY = 0;
    p.out.kickSq = 0;
  }
}

/** Tempo-Stufen wie bei Dose/Karte/Messer: Sprünge im Tempo → nur Tricks der Stufen-Liste. */
function tierTricks(item: HeldItemId, speed: number): Set<string> {
  const p = makeProp(item);
  const got = new Set<string>();
  for (let k = 0; k < 40; k++) {
    p.onEvent(JUMP(speed, 2 + k, k % 3 !== 0));
    if (p.trick !== 'none') got.add(p.trick);
    for (let f = 0; f < 60 * 3; f++) p.update(1 / 60, AIR(speed));
  }
  return got;
}

describe('Neue Gegenstände (Plan 007 Phase 2): gemeinsame Regeln', () => {
  const TIERS: { readonly [K in (typeof NEW_ITEMS)[number]]: readonly (readonly string[])[] } = {
    yoyo: YOYO_TIER_TRICKS,
    lighter: LIGHTER_TIER_TRICKS,
    coin: COIN_TIER_TRICKS,
    kendama: KENDAMA_TIER_TRICKS,
    phone: PHONE_TIER_TRICKS,
  };

  it('Tempo-Stufen: Stand/Gehen keine Sprung-Tricks, sonst nur Tricks der Stufen-Liste (je schneller, desto wilder)', () => {
    for (const item of NEW_ITEMS) {
      expect(tierTricks(item, 200).size, item).toBe(0);
      for (const [tier, speed] of [
        [1, 400],
        [2, 650],
        [3, 950],
      ] as const) {
        const got = tierTricks(item, speed);
        expect(got.size, `${item} Stufe ${tier}`).toBeGreaterThan(0);
        // Guter Hop im Overdrive hat beim Jo-Jo einen eigenen Trick (Doppel-Around), sonst aus der Liste.
        const allowed = tier === 3 && item === 'yoyo' ? [...TIERS[item][tier], 'aroundDouble'] : TIERS[item][tier];
        for (const t of got) expect(allowed, `${item} Stufe ${tier}: ${t}`).toContain(t);
      }
    }
  });

  it('Surf ≥ 500 u/s: jeder Gegenstand hat einen Surf-Zustand (zählt nicht als Trick), er endet mit dem Surf; < 500 nicht', () => {
    for (const item of [...NEW_ITEMS, ...KI8_ITEMS] as const) {
      const p = makeProp(item);
      p.update(1 / 60, AIR(800));
      p.onEvent({ type: 'surfStart' });
      expect(p.trick, item).toBe(SURF_STATE[item]);
      expect(p.inState, item).toBe(true);
      for (let f = 0; f < 120; f++) p.update(1 / 60, SURF(800));
      expect(p.trick, `${item} hält den Zustand`).toBe(SURF_STATE[item]);
      for (let f = 0; f < 90; f++) p.update(1 / 60, AIR(800));
      expect(p.trick, `${item} nach dem Surf`).toBe('none');
      // Langsam surfen: kein Zustand.
      const q = makeProp(item);
      q.update(1 / 60, AIR(300));
      q.onEvent({ type: 'surfStart' });
      for (let f = 0; f < 30; f++) q.update(1 / 60, SURF(300));
      expect(q.inState, `${item} bei 300 u/s`).toBe(false);
      // Surf beginnt während eines Tricks: der Zustand kommt, sobald der Trick fertig ist.
      const r = makeProp(item);
      r.update(1 / 60, AIR(900));
      r.onEvent(JUMP(900, 3, false));
      expect(r.trick).not.toBe('none');
      for (let f = 0; f < 60 * 3; f++) r.update(1 / 60, SURF(900));
      expect(r.trick, `${item} nach dem Trick im Surf`).toBe(SURF_STATE[item]);
    }
  });

  it('jeder Trick einzeln framerate-unabhängig: jeder Frame 30/60/144/240 Hz gegen 1440 Hz ≤ 0.01 (Plan 007)', () => {
    const report: string[] = [];
    for (const item of [...NEW_ITEMS, ...KI8_ITEMS] as const) {
      const names = makeProp(item).trickNames.filter((n) => KI8_ITEMS.includes(item as (typeof KI8_ITEMS)[number]) === false || n === SURF_STATE[item]);
      for (const name of names) {
        const r = worstDt(item, name);
        report.push(`${item}/${name} ${r.worst.toFixed(5)} sub ${r.worstSub.toFixed(5)} Pendel ${r.pendulumPx.map((v) => v.toFixed(2)).join('/')} px`);
        expect(r.worst, `${item}/${name}`).toBeLessThanOrEqual(0.01);
        expect(r.worstSub, `${item}/${name} zweiter Körper (geführt)`).toBeLessThanOrEqual(0.01);
        expect(r.pendulumPx[0], `${item}/${name} Pendel 30 Hz`).toBeLessThanOrEqual(2.5);
        for (let i = 1; i < 4; i++) expect(r.pendulumPx[i], `${item}/${name} Pendel`).toBeLessThanOrEqual(1.3);
        expect(r.moved, `${item}/${name} bewegt sich`).toBe(true);
      }
    }
    expect(report.length).toBeGreaterThan(30);
  });

  it('20 000 wilde Schritte je Gegenstand (mit Schnur, Kanälen, NaN-Eingaben): keine NaN', () => {
    for (const item of [...NEW_ITEMS, ...KI8_ITEMS] as const) wildAll(makeProp(item));
  }, 60000);

  it('motionFx 0: keine Tricks und Zustände, Gegenstand ruht, Schnur hängt still (auch in der ViewHand)', () => {
    for (const item of [...NEW_ITEMS, ...KI8_ITEMS] as const) {
      const h = new ViewHand();
      h.setItem(item);
      h.motionFx = 0;
      const inp = makeHandInput();
      let first: number[] | null = null;
      for (let f = 0; f < 60 * 7; f++) {
        if (f % 50 === 0) h.onEvent(JUMP(950));
        if (f % 50 === 25) h.onEvent({ type: 'speedMilestone', speed: 1000 });
        if (f === 100) h.onEvent(CP(-0.4));
        if (f === 150) h.onEvent({ type: 'surfStart' });
        inp.speed = f < 150 ? 0 : 1000;
        inp.onGround = f < 150;
        inp.surfing = f >= 150 && f < 250;
        h.update(1 / 60, inp);
        expect(h.state().trick, item).toBe('none');
        const fr = h.frame;
        const now = [fr.propPos[0], fr.propPos[1], fr.propPos[2], fr.propRot[0], fr.propRot[1], fr.propRot[2], fr.propSpin, fr.x, fr.y, fr.roll, fr.subPos[0], fr.subPos[1], fr.subPos[2], fr.subSpin];
        for (let i = 0; i < fr.stringCount * 3; i++) now.push(fr.stringPts[i]);
        // Erste Sekunde: die Schnur legt sich aus der Startlage (numerisches Durchhängen), danach still.
        if (f < 60) continue;
        if (!first) first = now;
        expect(now.length, item).toBe(first.length);
        for (let i = 0; i < now.length; i++) expect(now[i], `${item} #${i}`).toBeCloseTo(first[i], 4);
      }
    }
  });
});

/** Ziel-Trick je Gegenstand (Dose ungeöffnet: Wurf hinter dem Rücken). */
const FINISH_TRICK: { readonly [K in HeldItemId]?: string } = {
  can: 'behindThrow',
  card: 'vanish',
  knife: 'doubleAerial',
  spinner: 'ufo',
  yoyo: 'cradle',
  lighter: 'finale',
  coin: 'call',
  kendama: 'spike',
  phone: 'photo',
};
const FINISH_ITEMS = Object.keys(FINISH_TRICK) as HeldItemId[];

interface Shot {
  readonly pos: number[];
  readonly rot: Float64Array;
  readonly sub: number[];
  readonly hand: number[];
}
function shot(p: PropControl): Shot {
  const o = p.out;
  return {
    pos: [o.pos[0], o.pos[1], o.pos[2]],
    rot: fromEulerXYZ(mat3(), o.rot[0], o.rot[1], o.rot[2]),
    sub: [o.sub[0], o.sub[1], o.sub[2]],
    hand: [o.hx, o.hy, o.hz, o.hpitch, o.hyaw, o.hroll, o.spin, o.visible, o.scale],
  };
}
const dist3 = (a: readonly number[], b: readonly number[]): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/** Winkel zwischen zwei Lagen (rad). */
function angleOf(a: Float64Array, b: Float64Array): number {
  let tr = 0;
  for (let i = 0; i < 9; i++) tr += a[i] * b[i];
  return Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2)));
}
/** Größte Frame-Schritte (Position, Lage, zweiter Körper) einer Folge. */
function maxSteps(list: readonly Shot[]): [number, number, number] {
  const r: [number, number, number] = [0, 0, 0];
  for (let i = 1; i < list.length; i++) {
    r[0] = Math.max(r[0], dist3(list[i].pos, list[i - 1].pos));
    r[1] = Math.max(r[1], angleOf(list[i].rot, list[i - 1].rot));
    r[2] = Math.max(r[2], dist3(list[i].sub, list[i - 1].sub));
  }
  return r;
}

type FinishScene = 'surf' | 'trick' | 'rest';
/**
 * 60 Hz: Szene aufbauen, Ziel (withFinish = false: ohne), 0.5 s weiter. before = letzte Frames davor,
 * after[0] = letzter Frame davor, after[1] = Frame, an dessen Ende das Ziel gilt (#77).
 */
function finishScene(item: HeldItemId, scene: FinishScene, withFinish = true): { before: Shot[]; after: Shot[] } {
  const p = makeProp(item);
  const dt = 1 / 60;
  let inp: PropFrameInput = AIR(900);
  const step = (): void => {
    p.update(dt, inp);
    p.afterPose(RUN_JOINTS, inp, dt);
    p.out.kickY = 0;
    p.out.kickSq = 0;
  };
  step();
  if (scene === 'surf') {
    p.onEvent({ type: 'surfStart' });
    inp = SURF(900);
  } else if (scene === 'trick') p.onEvent(JUMP(950, 3, false));
  const before: Shot[] = [];
  for (let f = 0; f < 48; f++) {
    step();
    before.push(shot(p));
  }
  // Abbruch-Szenarien: beim Ziel läuft wirklich ein Trick bzw. Zustand (sonst prüfte das den freien Fall).
  if (scene !== 'rest') expect(p.trick, `${item}/${scene} beim Ziel`).not.toBe('none');
  if (withFinish) p.onEvent(FINISH(true));
  const after: Shot[] = [before[before.length - 1]];
  for (let f = 0; f < 30; f++) {
    step();
    after.push(shot(p));
  }
  return { before: before.slice(-16), after };
}

describe('Drehungs-Helfer fürs Überblenden (rot.ts)', () => {
  it('toAxisAngleQ kehrt axisAngle um (Winkel 0..π, kürzester Weg, stabil nahe π); mulT = a·bᵀ', () => {
    let seed = 5;
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const q = new Float64Array(4);
    for (let k = 0; k < 500; k++) {
      const ax = rnd() - 0.5;
      const ay = rnd() - 0.5;
      const az = rnd() - 0.5;
      const l = Math.hypot(ax, ay, az);
      // Auch genau π und knapp darunter (dort kippt die Achse bei naiver Rechnung).
      const angle = k % 50 === 0 ? Math.PI : k % 50 === 1 ? Math.PI - 1e-7 : rnd() * Math.PI;
      const m = axisAngle(mat3(), ax / l, ay / l, az / l, angle);
      toAxisAngleQ(m, q);
      expect(q[3]).toBeCloseTo(angle, 6);
      const back = axisAngle(mat3(), q[0], q[1], q[2], q[3]);
      for (let i = 0; i < 9; i++) expect(back[i]).toBeCloseTo(m[i], 6);
    }
    // Winkel > π wird zum kürzeren Weg um die Gegenachse.
    toAxisAngleQ(axisAngle(mat3(), 0, 0, 1, 1.5 * Math.PI), q);
    expect(q[3]).toBeCloseTo(0.5 * Math.PI, 9);
    expect(q[2]).toBeCloseTo(-1, 9);
    toAxisAngleQ(mat3(), q);
    expect(q[3]).toBe(0);
    // mulT(a, b)·b = a (Differenz-Drehung).
    const a = fromEulerXYZ(mat3(), 0.3, -1.2, 2.5);
    const b = fromEulerXYZ(mat3(), -2.0, 0.4, 0.9);
    const d = mulT(mat3(), a, b);
    const ab = mul(mat3(), d, b);
    for (let i = 0; i < 9; i++) expect(ab[i]).toBeCloseTo(a[i], 12);
  });
});

describe('Ziel-Reaktion (Phase-2-Review): sofort, auch mitten im Trick, im Surf-Zustand und beim Rutschen', () => {
  it('jeder Gegenstand startet seinen Ziel-Trick im Frame des Ziels (Trick-Zeit 0); dieser Frame zeigt genau, was der alte Trick gezeigt hätte', () => {
    for (const item of FINISH_ITEMS) {
      for (const scene of ['surf', 'trick', 'slide'] as const) {
        const p = makeProp(item);
        p.update(1 / 60, AIR(900));
        if (scene === 'surf') {
          p.onEvent({ type: 'surfStart' });
          for (let f = 0; f < 30; f++) p.update(1 / 60, SURF(900));
          expect(p.inState, `${item} im Surf-Zustand`).toBe(true);
        } else if (scene === 'trick') {
          p.onEvent(JUMP(950, 3, false));
          expect(p.trick, `${item} Trick läuft`).not.toBe('none');
        } else p.hold = true;
        p.onEvent(FINISH(true));
        p.update(1 / 60, scene === 'surf' ? SURF(900) : AIR(900));
        expect(p.trick, `${item}/${scene}`).toBe(FINISH_TRICK[item]);
        expect(p.trickTime).toBe(0);
      }
      for (const scene of ['surf', 'trick'] as const) {
        const a = finishScene(item, scene, false).after[1];
        const b = finishScene(item, scene).after[1];
        expect(dist3(a.pos, b.pos), `${item}/${scene} Position`).toBeLessThan(1e-4);
        expect(angleOf(a.rot, b.rot), `${item}/${scene} Lage`).toBeLessThan(1e-3);
        expect(dist3(a.sub, b.sub), `${item}/${scene} zweiter Körper`).toBeLessThan(1e-4);
        // Spin (Index 6) ist ein Winkel: modulo 2π.
        for (let i = 0; i < a.hand.length; i++) expect(diff(a.hand[i], b.hand[i], i === 6 ? Math.PI * 2 : 0), `${item}/${scene} #${i}`).toBeLessThan(1e-5);
      }
    }
  });

  it('Überblenden: kein Frame bewegt sich weiter als der Ziel-Trick selbst plus 12 % des harten Schnitts (Versatz klingt in 0.25 s ab)', () => {
    const report: string[] = [];
    for (const item of FINISH_ITEMS) {
      // Der Ziel-Trick aus der Ruhe (ohne Abbruch) als Maßstab seiner eigenen Geschwindigkeit.
      const plain = finishScene(item, 'rest');
      const own = maxSteps(plain.after.slice(1));
      for (const scene of ['surf', 'trick'] as const) {
        const r = finishScene(item, scene);
        const fade = maxSteps(r.after);
        const old = maxSteps(r.before);
        const last = r.after[0];
        const first = plain.after[1];
        const cut = [dist3(last.pos, first.pos), angleOf(last.rot, first.rot), dist3(last.sub, first.sub)];
        report.push(`${item}/${scene}: ${fade.map((v) => v.toFixed(2)).join('/')} (Schnitt ${cut.map((v) => v.toFixed(2)).join('/')})`);
        for (let k = 0; k < 3; k++) expect(fade[k], `${item}/${scene} Kanal ${k}`).toBeLessThanOrEqual(Math.max(own[k], old[k]) + 0.12 * cut[k] + 0.02);
      }
    }
    expect(report.length).toBe(FINISH_ITEMS.length * 2);
  });

  it('Abbruch framerate-unabhängig: Surf-Zustand → Ziel-Trick, jeder Frame 30/60/144/240 Hz gegen 1440 Hz ≤ 0.01', () => {
    for (const item of FINISH_ITEMS) {
      const state = SURF_STATE[item];
      if (!state) continue;
      const r = worstDt(item, state, 5 / 6);
      // Höchstens die Frames um wenige Stufen (Messer-Aerial: Ausholen → Luft, 2 Stufen × ≤ 3 Frames × 4 Raten).
      expect(r.skipped, `${item} ausgelassene Frames`).toBeLessThanOrEqual(24);
      expect(r.worst, `${item}`).toBeLessThanOrEqual(0.01);
      expect(r.worstSub, `${item} zweiter Körper (geführt)`).toBeLessThanOrEqual(0.01);
      expect(r.pendulumPx[0], `${item} Pendel 30 Hz`).toBeLessThanOrEqual(2.5);
      for (let i = 1; i < 4; i++) expect(r.pendulumPx[i], `${item} Pendel`).toBeLessThanOrEqual(1.3);
    }
  });

  it('Handy: Selfie bei JEDEM Ziel (aus dem Gimbal, mitten im spinToss, beim Rutschen) — Auslöser vor dem Ergebnis (1.1 s)', () => {
    for (const scene of ['gimbal', 'spinToss', 'slide'] as const) {
      const h = new ViewHand();
      h.setItem('phone');
      const inp = makeHandInput();
      inp.onGround = false;
      inp.speed = 900;
      h.update(1 / 60, inp);
      if (scene === 'gimbal') {
        inp.surfing = true;
        h.onEvent({ type: 'surfStart' });
      } else if (scene === 'spinToss') h.forceTrick('spinToss');
      else {
        inp.onGround = true;
        h.onEvent({ type: 'slideStart', speed: 400, boost: false });
      }
      for (let f = 0; f < 30; f++) h.update(1 / 60, inp);
      if (scene !== 'slide') expect(h.state().trick).toBe(scene);
      else expect(h.state().sliding).toBe(true);
      h.onEvent(FINISH(true));
      // Erster Frame nach dem Ziel = Trick-Zeit 0 (das Ziel gilt an seinem Ende, wie jeder Trick-Start).
      let since = -1 / 60;
      let shotAfter = -1;
      for (let f = 0; f < 90; f++) {
        h.update(1 / 60, inp);
        since += 1 / 60;
        if (f === 0) {
          expect(h.state().trick, scene).toBe('photo');
          expect(h.state().trickTime).toBe(0);
        }
        if (h.takeShutter()) {
          expect(shotAfter, `${scene}: nur ein Auslöser`).toBe(-1);
          shotAfter = since;
        }
      }
      expect(shotAfter, scene).toBeGreaterThanOrEqual(SHUTTER_AT - 1e-9);
      expect(shotAfter, scene).toBeLessThanOrEqual(SHUTTER_AT + 1 / 60 + 1e-9);
      expect(shotAfter).toBeLessThan(1.1);
    }
  });

  it('Handy ohne Bewegung (motionFx 0): Ziel-Foto trotzdem (Kamera → Auslöser → Foto), Handy steht still; takeShutterNow löst sofort aus', () => {
    const P = VM_PARAM.phone;
    const M = VM_PHONE_MODE;
    const h = new ViewHand();
    h.setItem('phone');
    h.motionFx = 0;
    const inp = makeHandInput();
    h.update(1 / 60, inp);
    const pos = Array.from(h.frame.propPos);
    h.onEvent(FINISH(true));
    const modes: number[] = [];
    let shots = 0;
    let shotAt = -1;
    let t = -1 / 60;
    for (let f = 0; f < 60 * 2.5; f++) {
      h.update(1 / 60, inp);
      t += 1 / 60;
      if (h.takeShutter()) {
        shots++;
        shotAt = t;
      }
      const m = h.frame.propParam[P.mode];
      if (modes[modes.length - 1] !== m) modes.push(m);
      expect(h.state().trick).toBe('none');
      expect(Array.from(h.frame.propPos)).toEqual(pos);
    }
    expect(shots).toBe(1);
    expect(shotAt).toBeGreaterThanOrEqual(SHUTTER_AT - 1e-9);
    expect(shotAt).toBeLessThanOrEqual(SHUTTER_AT + 1 / 60 + 1e-9);
    expect(modes.slice(0, 3)).toEqual([M.camera, M.photo, M.feed]);
    // Ergebnis kommt früher (Enter, Tod nach dem Ziel): sofort auslösen, genau einmal.
    const e = new ViewHand();
    e.setItem('phone');
    e.update(1 / 60, inp);
    e.onEvent(FINISH(false));
    for (let f = 0; f < 10; f++) e.update(1 / 60, inp);
    expect(e.takeShutter()).toBe(false);
    expect(e.takeShutterNow()).toBe(true);
    let later = 0;
    for (let f = 0; f < 120; f++) {
      e.update(1 / 60, inp);
      if (e.takeShutter()) later++;
    }
    expect(later).toBe(0);
    expect(e.takeShutterNow()).toBe(false);
    // Ziel mitten im Trick, Ergebnis im selben Frame (Tod nach dem Ziel): Foto startet erst am Frame-Ende —
    // takeShutterNow löst trotzdem aus, das Ziel-Foto danach nicht noch einmal.
    const g = new ViewHand();
    g.setItem('phone');
    g.update(1 / 60, inp);
    g.forceTrick('spinToss');
    for (let f = 0; f < 10; f++) g.update(1 / 60, inp);
    g.onEvent(FINISH(true));
    expect(g.state().trick).toBe('spinToss');
    expect(g.takeShutterNow()).toBe(true);
    let again = 0;
    for (let f = 0; f < 120; f++) {
      g.update(1 / 60, inp);
      if (g.takeShutter()) again++;
    }
    expect(again).toBe(0);
    // Ohne Handy nie.
    const c = new ViewHand();
    c.setItem('coin');
    c.onEvent(FINISH(true));
    expect(c.takeShutterNow()).toBe(false);
  });
});

describe('Jo-Jo (KI1)', () => {
  it('Leerlauf: Sleeper (jedes 3. Mal Cradle), Schnur voll ab und wieder aufgewickelt, Jo-Jo hängt unter der Schlaufe', () => {
    const h = new ViewHand();
    h.setItem('yoyo');
    const inp = makeHandInput();
    const seen: string[] = [];
    let lowest = 0;
    let maxString = 0;
    let prev = 'none';
    for (let f = 0; f < 60 * 14; f++) {
      h.update(1 / 60, inp);
      const st = h.state();
      if (st.trick !== 'none' && prev === 'none') seen.push(st.trick);
      prev = st.trick;
      if (st.trick === 'sleeper' && st.trickTime > 0.5 && st.trickTime < 0.9) {
        const fr = h.frame;
        lowest = Math.min(lowest, upOf(fr.subPos[0] - fr.propPos[0], fr.subPos[1] - fr.propPos[1], fr.subPos[2] - fr.propPos[2]));
        maxString = Math.max(maxString, st.stringCount);
      }
    }
    expect(seen.slice(0, 3)).toEqual(['sleeper', 'sleeper', 'cradle']);
    expect(maxString).toBe(VM_STRING_POINTS);
    // Hängt im Bild deutlich tiefer als die Faust (Schnur 9.5 Einheiten).
    expect(lowest).toBeLessThan(-YOYO_STRING * 0.6);
  });

  it('Sleeper 0.7 s, Pass 0.5 s (Takt kalibriert, Plan 007 KI1)', () => {
    const y = new YoyoTricks();
    const dur = (name: string): number => {
      y.reset();
      y.debugPlayName(name, -1);
      let t = 0;
      while (y.trick !== 'none' && t < 5) {
        y.update(1 / 240, AIR(0));
        t += 1 / 240;
      }
      return t;
    };
    // Sleeper = Wurf 0.25 + Schlaf 0.7 + Rückweg 0.25 + Setzen 0.06.
    expect(dur('sleeper')).toBeCloseTo(0.25 + 0.7 + 0.25 + 0.06, 1);
    expect(dur('pass')).toBeCloseTo(0.5 * 0.85 + 0.25 + 0.06, 1);
  });

  it('Wiege ("Rock the Baby"): Schnur spannt ein Dreieck zwischen Daumen- und Zeigefingerspitze, Enden exakt', () => {
    const h = new ViewHand();
    h.setItem('yoyo');
    const inp = makeHandInput();
    for (let f = 0; f < 30; f++) h.update(1 / 60, inp);
    h.forceTrick('cradle');
    let seenFigure = false;
    for (let f = 0; f < 60 * 1.2; f++) {
      h.update(1 / 60, inp);
      const fr = h.frame;
      if (h.state().trick !== 'cradle' || h.state().trickTime < 0.6) continue;
      expect(h.state().pose).toBe('cradle');
      const P = fr.stringPts;
      const pt = (i: number): [number, number, number] => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
      const dist = (a: readonly number[], b: readonly number[]): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      // Letzter Punkt = Jo-Jo (exakt), Dreieck: Daumen (1) ↔ Zeigefinger (2) ↔ Knoten (3) ↔ Daumen (4).
      expect(dist(pt(8), [fr.subPos[0], fr.subPos[1], fr.subPos[2]])).toBeLessThan(1e-4);
      expect(dist(pt(1), pt(4))).toBeLessThan(1e-4);
      expect(dist(pt(3), pt(5))).toBeLessThan(1e-4);
      expect(dist(pt(1), pt(2))).toBeGreaterThan(3);
      expect(dist(pt(2), pt(3))).toBeGreaterThan(3);
      // Knoten liegt zwischen Schlaufe und Jo-Jo (unterhalb der Spitzen im Bild).
      expect(upOf(pt(3)[0] - pt(1)[0], pt(3)[1] - pt(1)[1], pt(3)[2] - pt(1)[2])).toBeLessThan(-3);
      // Die Figur sitzt an den ECHTEN Fingerspitzen dieses Frames (FK aus den gezeigten Gelenken, Review: vorher
      // hart kodierte Zahlen) — CRADLE_FRONT zur Kamera; Toleranz fürs Posen-Überblenden.
      const cam = VIEW_AXES.cam;
      const tT = thumbPoint(fr.joints, 2, 0, VM_RIG.thumb.len[2] + CRADLE_THUMB_BEYOND, 0, [0, 0, 0]);
      const tI = fingerTip(fr.joints, 0, [0, 0, 0], CRADLE_INDEX_BEYOND);
      const front = (p: ArrayLike<number>): number[] => [p[0] + cam[0] * CRADLE_FRONT, p[1] + cam[1] * CRADLE_FRONT, p[2] + cam[2] * CRADLE_FRONT];
      expect(dist(pt(1), front(tT)), 'Daumenspitze').toBeLessThan(0.3);
      expect(dist(pt(2), front(tI)), 'Zeigefingerspitze').toBeLessThan(0.3);
      seenFigure = true;
    }
    expect(seenFigure).toBe(true);
    // Nach der Wiege wieder eine gewöhnliche Schnur (kein Dreieck mehr) bzw. Jo-Jo in der Faust.
    for (let f = 0; f < 60 * 1.5; f++) h.update(1 / 60, inp);
    expect(h.state().pose).not.toBe('cradle');
  });
});

describe('Jo-Jo: Abwechslung (Review Phase 2)', () => {
  it('Breakaway nur noch in Stufe 2; Meilenstein Stufe 2 abwechselnd; Checkpoint vor der Bestzeit = Wiege, sonst Around', () => {
    for (const tier of [1, 3]) expect(YOYO_TIER_TRICKS[tier], `Stufe ${tier}`).not.toContain('breakaway');
    const y = new YoyoTricks();
    const milestones: string[] = [];
    for (let k = 0; k < 4; k++) {
      y.stop();
      y.update(1 / 60, AIR(700));
      y.onEvent({ type: 'speedMilestone', speed: 700 });
      milestones.push(y.trick);
    }
    expect(milestones).toEqual(['breakaway', 'snap', 'breakaway', 'snap']);
    const cp = (split: number | null): string => {
      const c = new YoyoTricks();
      c.update(1 / 60, AIR(700));
      c.onEvent(CP(split));
      return c.trick;
    };
    expect(cp(-0.3)).toBe('cradle');
    expect(cp(0.3)).toBe('around');
    expect(cp(null)).toBe('around');
  });
});

/** Tricks aus `n` Sprüngen gleicher Art (je Sprung ein freier Start, Abklingzeit abgewartet). */
function jumpSeries(p: PropControl, speed: number, good: boolean, n: number): string[] {
  const got: string[] = [];
  for (let k = 0; k < n; k++) {
    p.stop();
    p.update(1 / 60, AIR(speed));
    p.onEvent(JUMP(speed, 3, good));
    got.push(p.trick);
  }
  return got;
}

describe('Abwechslung Kendama, Spinner, Feuerzeug, Handy (Review Phase 2)', () => {
  it('Kendama: Lauf groß/klein, Flow mit Around Japan, guter Hop im Overdrive Spitze, Spitze, Around Japan', () => {
    expect(jumpSeries(new KendamaTricks(), 400, false, 4)).toEqual(['bigCup', 'smallCup', 'bigCup', 'smallCup']);
    expect(jumpSeries(new KendamaTricks(), 650, true, 3)).toEqual(['smallCup', 'aroundJapan', 'bigCup']);
    expect(jumpSeries(new KendamaTricks(), 950, true, 6)).toEqual(['spike', 'spike', 'aroundJapan', 'spike', 'spike', 'aroundJapan']);
    expect(jumpSeries(new KendamaTricks(), 950, false, 3)).toEqual(['spike', 'aroundJapan', 'bigCup']);
  });

  it('Kendama: Checkpoint vor der Bestzeit Around Japan, sonst klein/groß im Wechsel; Meilenstein im Flow ebenso', () => {
    const cp = (split: number | null): string => {
      const c = new KendamaTricks();
      c.update(1 / 60, AIR(700));
      c.onEvent(CP(split));
      return c.trick;
    };
    expect(cp(-0.3)).toBe('aroundJapan');
    expect(cp(0.3)).toBe('smallCup');
    expect(cp(null)).toBe('smallCup');
    const c2 = new KendamaTricks();
    const cps: string[] = [];
    for (let i = 0; i < 3; i++) {
      c2.stop();
      c2.update(1 / 60, AIR(700));
      c2.onEvent(CP(null));
      cps.push(c2.trick);
    }
    expect(cps).toEqual(['smallCup', 'bigCup', 'smallCup']);
    const k = new KendamaTricks();
    const ms: string[] = [];
    for (let i = 0; i < 4; i++) {
      k.stop();
      k.update(1 / 60, AIR(700));
      k.onEvent({ type: 'speedMilestone', speed: 700 });
      ms.push(k.trick);
    }
    expect(ms).toEqual(['smallCup', 'bigCup', 'smallCup', 'bigCup']);
  });

  it('Around Japan fängt nach dem Straffen der Zeitleiste weiter in allen drei Fangpunkten (klein → groß → Spitze)', () => {
    const k = new KendamaTricks();
    k.debugPlayName('aroundJapan', -1);
    const seen = new Set<string>();
    for (let f = 0; f < 60 * 3 && (f === 0 || k.trick !== 'none'); f++) {
      k.update(1 / 60, GROUND(0));
      k.afterPose(RUN_JOINTS, GROUND(0), 1 / 60);
      if (k.caughtOn(KEN_SMALL_CUP)) seen.add('klein');
      if (k.caughtOn(KEN_BIG_CUP)) seen.add('groß');
      if (k.caughtOn(KEN_SPIKE)) seen.add('Spitze');
    }
    expect([...seen]).toEqual(['klein', 'groß', 'Spitze']);
  });

  it('Spinner: Flow toss/swap im Wechsel (auch bei guten Hops), Overdrive guter Hop ufo/toss im Wechsel', () => {
    expect(jumpSeries(new SpinnerTricks(), 650, true, 4)).toEqual(['toss', 'swap', 'toss', 'swap']);
    expect(jumpSeries(new SpinnerTricks(), 950, true, 4)).toEqual(['ufo', 'toss', 'ufo', 'toss']);
  });

  it('Feuerzeug und Handy: im Lauf zwei Tricks im Wechsel (vorher einer — 54–56 % aller Starts)', () => {
    expect(jumpSeries(new LighterTricks(), 400, false, 4)).toEqual(['lidFlick', 'strike', 'lidFlick', 'strike']);
    expect(jumpSeries(new PhoneTricks(), 400, false, 4)).toEqual(['tap', 'scroll', 'tap', 'scroll']);
  });

  it('Feuerzeug am Checkpoint: brennend strike/twirl im Wechsel, aus immer strike (zündet wieder)', () => {
    const l = new LighterTricks();
    const got: string[] = [];
    for (let i = 0; i < 4; i++) {
      l.stop();
      l.lit = true;
      l.lidOpen = true;
      l.update(1 / 60, AIR(400));
      l.onEvent(CP(null));
      got.push(l.trick);
    }
    expect(got).toEqual(['strike', 'twirl', 'strike', 'twirl']);
    const off = new LighterTricks();
    off.lit = false;
    off.update(1 / 60, AIR(400));
    off.onEvent(CP(null));
    expect(off.trick).toBe('strike');
  });
});

/** Surf-Zustand eines Gegenstands laufen lassen (60 Hz): Zähler der Einlagen und alle Ausgaben je Frame. */
function surfRun(item: HeldItemId, frames: number, sideAt: (f: number) => number, events: (f: number, p: PropControl) => void = () => {}): { p: PropControl; every: number[][]; states: boolean[] } {
  const p = makeProp(item);
  p.update(1 / 60, AIR(900));
  p.onEvent({ type: 'surfStart' });
  const every: number[][] = [];
  const states: boolean[] = [];
  for (let f = 0; f < frames; f++) {
    events(f, p);
    const inp = SURF(900, sideAt(f));
    p.update(1 / 60, inp);
    p.afterPose(RUN_JOINTS, inp, 1 / 60);
    p.out.kickY = 0;
    p.out.kickSq = 0;
    every.push(sampleAll(p));
    states.push(p.inState);
  }
  return { p, every, states };
}

describe('Einlagen im Surf-Zustand (Review Phase 2: L3 zeigte 10–20 s denselben statischen Zustand)', () => {
  const STATE_ITEMS = [...NEW_ITEMS, ...KI8_ITEMS, 'spinner'] as const;

  it('im Takt (1.05 s, dann alle 2.4 s Trick-Zeit), bewegt die Ausgabe, der Zustand bleibt; jeder Gegenstand', () => {
    for (const item of STATE_ITEMS) {
      const quiet = surfRun(item, 60, () => 0.5);
      expect(quiet.p.flourishes, `${item} vor 1.05 s`).toBe(0);
      const r = surfRun(item, Math.round(60 * 3.6), () => 0.5);
      expect(r.p.flourishes, item).toBe(2);
      expect(r.states.every((s) => s), `${item} bleibt im Zustand`).toBe(true);
      // Sichtbar: eine per Meilenstein vorgezogene Einlage (ab Frame 40) gegen denselben Lauf ohne — bis Frame 55
      // unterscheiden sich die Läufe nur darin.
      const early = surfRun(item, 56, () => 0.5, (f, p) => {
        if (f === 40) p.onEvent({ type: 'speedMilestone', speed: 1000 });
      });
      const plain = surfRun(item, 56, () => 0.5);
      let d = 0;
      for (let k = 0; k < early.every[55].length; k++) d = Math.max(d, Math.abs(early.every[55][k] - plain.every[55][k]));
      // Jo-Jo: die Einlage kippt das Handgelenk (hroll), das Pendel folgt über HandMotion (hier ohne).
      expect(d, `${item} sichtbar`).toBeGreaterThan(0.05);
    }
  });

  it('Kehre (surfSide wechselt das Vorzeichen) und Tempo-Meilenstein ziehen die Einlage vor — am Frame-Ende, mit Mindestabstand', () => {
    const carve = surfRun('kendama', 60, (f) => (f < 40 ? 0.6 : -0.6));
    expect(carve.p.flourishes).toBe(1);
    // Zu früh (unter 0.5 s Zustand): keine.
    expect(surfRun('kendama', 20, (f) => (f < 10 ? 0.6 : -0.6)).p.flourishes).toBe(0);
    const ms = surfRun('coin', 60, () => 0.5, (f, p) => {
      if (f === 40 || f === 45) p.onEvent({ type: 'speedMilestone', speed: 1000 });
    });
    expect(ms.p.flourishes).toBe(1);
  });

  it('framerate-unabhängig: jeder Frame 30/60/144/240 Hz gegen 1440 Hz ≤ 0.01 (3.5 s Surf, zwei Einlagen; Jo-Jo-Pendel in px)', () => {
    for (const item of STATE_ITEMS) {
      const name = SURF_STATE[item];
      if (!name) throw new Error(`${item} ohne Surf-Zustand`);
      const r = worstDt(item, name, -1, 3.5);
      expect(r.worst, `${item}/${name}`).toBeLessThanOrEqual(0.01);
      expect(r.worstSub, `${item}/${name} zweiter Körper (geführt)`).toBeLessThanOrEqual(0.01);
      expect(r.pendulumPx[0], `${item}/${name} Pendel 30 Hz`).toBeLessThanOrEqual(2.5);
      for (let i = 1; i < 4; i++) expect(r.pendulumPx[i], `${item}/${name} Pendel`).toBeLessThanOrEqual(1.3);
      expect(runTrick(item, name, 60, -1, 3.5).flourishes, item).toBe(2);
    }
  });

  it('nach dem Surf keine neue Einlage; endet der Surf mitten in einer, springt nichts (Dose/Karte/Münze drehen zu Ende)', () => {
    /** Surf `frames` lang, dann Luft; größte Frame-Schritte (Position, Lage, Eigendrehung modulo 2π). */
    const steps = (item: HeldItemId, frames: number): { p: PropControl; dp: number; dr: number; ds: number } => {
      const p = makeProp(item);
      p.update(1 / 60, AIR(900));
      p.onEvent({ type: 'surfStart' });
      const shots: Shot[] = [];
      let ds = 0;
      for (let f = 0; f < 60 * 4; f++) {
        const inp = f < frames ? SURF(900) : AIR(900);
        const s0 = p.out.spin;
        p.update(1 / 60, inp);
        p.afterPose(RUN_JOINTS, inp, 1 / 60);
        p.out.kickY = 0;
        p.out.kickSq = 0;
        if (f > 0) ds = Math.max(ds, diff(p.out.spin, s0, Math.PI * 2));
        shots.push(shot(p));
      }
      const [dp, dr] = maxSteps(shots);
      return { p, dp, dr, ds };
    };
    for (const item of STATE_ITEMS) {
      // Surf bis 1.3 s Trick-Zeit (mitten in der ersten Einlage) gegen Surf bis 0.83 s (vor der ersten).
      const mid = steps(item, 78);
      const before = steps(item, 50);
      expect(mid.p.flourishes, item).toBe(1);
      expect(before.p.flourishes, item).toBe(0);
      expect(mid.p.trick, `${item} Zustand vorbei`).toBe('none');
      // Kein Sprung: höchstens etwas schneller als der gewöhnliche Ausklang (ein Sprung wären Einheiten bzw. ~π).
      expect(mid.dp, `${item} größter Positions-Schritt`).toBeLessThanOrEqual(before.dp + 0.4);
      expect(mid.dr, `${item} größter Dreh-Schritt`).toBeLessThanOrEqual(before.dr + 0.3);
      // Eigendrehung: Spinner (ω) und Münze (Kante) drehen ohnehin schnell — nur die übrigen prüfen.
      if (item !== 'spinner' && item !== 'coin') expect(mid.ds, `${item} Sprung der Eigendrehung`).toBeLessThan(0.6);
    }
  });
});

describe('Katzenpfote: Shader-Masken an jedem Teil (Review Phase 2, latentes WebGL-Risiko)', () => {
  it('jede Katzen-Geometrie hat aClaw und aTabby — kein Draw liest den generischen Attribut-Wert', () => {
    const vm = new ViewModel();
    vm.setResolution(480, 270);
    const h = new ViewHand();
    h.setGlove('cat');
    h.update(1 / 60, makeHandInput());
    vm.apply(h.output(true));
    let parts = 0;
    vm.scene.traverse((o) => {
      if (!(o instanceof Mesh) || !(o.material instanceof ShaderMaterial) || !o.visible) return;
      const src = o.material.vertexShader;
      if (!src.includes('aClaw')) return;
      parts++;
      expect(o.geometry.hasAttribute('aClaw'), o.name).toBe(true);
      expect(o.geometry.hasAttribute('aTabby'), o.name).toBe(true);
    });
    // Handfläche, 4 × 3 Finger, 3 Daumen, Bein, Halsband — je Mesh + Hülle.
    expect(parts).toBeGreaterThanOrEqual(36);
  });

  it('Fell-Saum (Review Phase 3): Büschel-Reihen ohne gekippte Dreiecke, Zickzack im Shader genau auf den Zacken', () => {
    const vm = new ViewModel();
    vm.setResolution(480, 270);
    const h = new ViewHand();
    h.setGlove('cat');
    h.update(1 / 60, makeHandInput());
    vm.apply(h.output(true));
    let legs = 0;
    vm.scene.traverse((o) => {
      if (!(o instanceof Mesh) || !(o.material instanceof ShaderMaterial) || !o.visible) return;
      const tab = o.geometry.getAttribute('aTabby');
      if (!tab || tab.getX(0) !== 2) return;
      legs++;
      // Bein = Röhre mit 22 Segmenten (23 Vertices je Ring): je Spalte muss y von Ring zu Ring streng fallen —
      // sonst kippen Dreiecke (die nächste Reihe beginnt unterhalb der tiefsten Spitze).
      const pos = o.geometry.getAttribute('position');
      const row = 23;
      const rings = Math.floor((pos.count - 1) / row);
      for (let k = 0; k < row; k++) {
        for (let r = 1; r < rings; r++) expect(pos.getY(r * row + k), `Spalte ${k}, Ring ${r}`).toBeLessThan(pos.getY((r - 1) * row + k));
      }
      // Shader-Kanten (uRuff: y, Versatz, Phase) liegen auf Ringen der Geometrie: Täler bei y, Spitzen bei y + Versatz.
      const m = o.material;
      expect(m.defines.RUFF).toBeDefined();
      const ys = new Set<number>();
      for (let i = 0; i < pos.count; i++) ys.add(Math.round(pos.getY(i) * 1000));
      const rows = m.uniforms.uRuff.value as { x: number; y: number; z: number }[];
      expect(rows.length).toBe(2);
      for (const r of rows) {
        expect(ys.has(Math.round(r.x * 1000)), `Tal-Ring ${r.x}`).toBe(true);
        expect(ys.has(Math.round((r.x + r.y) * 1000)), `Spitzen ${r.x + r.y}`).toBe(true);
        expect(r.y).toBeLessThan(0);
      }
    });
    expect(legs).toBe(1);
  });
});

describe('Sturmfeuerzeug (KI2)', () => {
  const P = VM_PARAM.lighter;
  /** Feuerzeug anzünden (strike) und brennen lassen, dann `speed` in der Luft, danach Ruhe am Boden. */
  function blowScenario(fps: number): { outAt: number; relitAt: number; flame: number[] } {
    const l = new LighterTricks();
    const dt = 1 / fps;
    l.debugPlayName('strike', -1);
    for (let f = 0; f < Math.round(fps * 0.5); f++) l.update(dt, GROUND(0));
    expect(l.lit).toBe(true);
    let t = 0;
    let outAt = -1;
    let relitAt = -1;
    const flame: number[] = [];
    // 1 s bei 1000 u/s in der Luft, dann 2 s am Boden bei 200 u/s.
    for (let f = 1; f <= Math.round(3 * fps); f++) {
      t = f * dt;
      const air = f <= Math.round(fps);
      l.update(dt, air ? AIR(1000) : GROUND(200));
      if (outAt < 0 && !l.lit) outAt = t;
      if (outAt >= 0 && relitAt < 0 && !air && l.lit) relitAt = t - 1;
      if ((f * 6) % fps === 0) flame.push(l.out.param[P.flame]);
    }
    return { outAt, relitAt, flame };
  }

  it('Flamme aus nach ≥ 0.4 s bei ≥ 950 u/s (Rauch), wieder an nach 0.8 s Boden < 300 u/s — bei jeder Framerate', () => {
    expect(BLOW_SPEED).toBe(950);
    expect(BLOW_TIME).toBe(0.4);
    expect(CALM_SPEED).toBe(300);
    expect(RELIGHT_TIME).toBe(0.8);
    for (const fps of [30, 60, 144, 240]) {
      const r = blowScenario(fps);
      expect(r.outAt, `${fps} Hz aus`).toBeGreaterThanOrEqual(BLOW_TIME - 1e-9);
      expect(r.outAt, `${fps} Hz aus`).toBeLessThan(BLOW_TIME + 1 / fps + 1e-9);
      expect(r.relitAt, `${fps} Hz an`).toBeGreaterThanOrEqual(RELIGHT_TIME - 1e-9);
      expect(r.relitAt, `${fps} Hz an`).toBeLessThan(RELIGHT_TIME + 1 / fps + 1e-9);
    }
  });

  it('Flammen-Kanal framerate-unabhängig (≤ 0.01 gegen 1200 Hz, 1/6-s-Raster)', () => {
    const ref = blowScenario(1200).flame;
    for (const fps of [30, 60, 144, 240]) {
      const got = blowScenario(fps).flame;
      expect(got.length).toBe(ref.length);
      for (let i = 0; i < ref.length; i++) expect(Math.abs(got[i] - ref[i]), `${fps} Hz #${i}`).toBeLessThanOrEqual(0.01);
    }
  });

  it('Unter 950 u/s brennt sie weiter und neigt sich mit dem Tempo; Deckel zu löscht; in Ruhe zündet sie von selbst', () => {
    const l = new LighterTricks();
    l.debugPlayName('strike', -1);
    for (let f = 0; f < 60; f++) l.update(1 / 60, GROUND(0));
    for (let f = 0; f < 180; f++) l.update(1 / 60, AIR(900));
    expect(l.lit).toBe(true);
    expect(l.out.param[P.wind]).toBeCloseTo(1, 3);
    expect(l.out.param[P.flame]).toBeGreaterThan(0.4);
    l.debugPlayName('snapClose', -1);
    for (let f = 0; f < 30; f++) l.update(1 / 60, AIR(900));
    expect(l.lit).toBe(false);
    // Ruhe: Deckel auf (flickOpen), dann zünden — ohne Zutun.
    const q = new LighterTricks();
    for (let f = 0; f < 60 * 10 && !q.lit; f++) q.update(1 / 60, GROUND(0));
    expect(q.lit).toBe(true);
  });
});

describe('Münze (KI5): Kopf oder Zahl zeigt den Split', () => {
  /** Am Boden (frei), Event, Trick ausspielen → Seite. */
  function sideAfter(e: GameEvent, fps = 60): number {
    const c = new CoinTricks();
    c.update(1 / fps, GROUND(0));
    c.onEvent(e);
    expect(c.trick).toBe('call');
    for (let f = 0; f < fps * 2 && c.trick !== 'none'; f++) c.update(1 / fps, GROUND(0));
    return c.side;
  }

  it('Checkpoint: split < 0 oder ohne Referenz → Kopf, sonst Zahl; Ziel: neue Bestzeit → Kopf, sonst Zahl', () => {
    for (const fps of [30, 60, 144]) {
      expect(sideAfter(CP(-0.42), fps), `${fps}`).toBe(HEADS);
      expect(sideAfter(CP(null), fps), `${fps}`).toBe(HEADS);
      expect(sideAfter(CP(0.31), fps), `${fps}`).toBe(TAILS);
      expect(sideAfter(FINISH(true), fps), `${fps}`).toBe(HEADS);
      expect(sideAfter(FINISH(false), fps), `${fps}`).toBe(TAILS);
    }
  });

  it('der Kanal side zeigt das Ergebnis vorn; beim Wurf wechselt er nur, während die Münze hochkant steht', () => {
    const c = new CoinTricks();
    c.update(1 / 60, GROUND(0));
    c.onEvent(CP(0.5));
    let prev = c.out.param[VM_PARAM.coin.side];
    let switches = 0;
    for (let f = 0; f < 90; f++) {
      c.update(1 / 60, GROUND(0));
      const s = c.out.param[VM_PARAM.coin.side];
      if (s !== prev) switches++;
      prev = s;
    }
    expect(prev).toBe(TAILS);
    expect(switches).toBe(1);
  });

  it('Checkpoint in der Luft oder im Surf: der call wartet (Surf-Zustand hat Vorrang) und kommt bei Landung/Sprung', () => {
    const c = new CoinTricks();
    c.update(1 / 60, AIR(700));
    c.onEvent(CP(0.2));
    expect(c.trick).toBe('none');
    c.onEvent({ type: 'surfStart' });
    expect(c.trick).toBe('edgeSpin');
    for (let f = 0; f < 60; f++) c.update(1 / 60, SURF(700));
    for (let f = 0; f < 30; f++) c.update(1 / 60, AIR(700));
    expect(c.trick).toBe('none');
    c.onEvent({ type: 'land', impact: 200, speed: 600, airTime: 0.5, jumpQueued: false });
    expect(c.trick).toBe('call');
    for (let f = 0; f < 90; f++) c.update(1 / 60, GROUND(0));
    expect(c.side).toBe(TAILS);
    // Im Bhop (nie am Boden): der nächste Sprung wirft den call.
    const b = new CoinTricks();
    b.update(1 / 60, AIR(700));
    b.onEvent(CP(-0.1));
    b.onEvent(JUMP(700));
    expect(b.trick).toBe('call');
  });

  it('Ziel: der call kommt sofort — in der Luft, mitten im Trick und im Surf-Zustand (edgeSpin)', () => {
    const c = new CoinTricks();
    c.update(1 / 60, AIR(700));
    c.onEvent(FINISH(true));
    expect(c.trick).toBe('call');
    for (let f = 0; f < 120 && c.trick !== 'none'; f++) c.update(1 / 60, AIR(700));
    expect(c.side).toBe(HEADS);
    // Mitten in einem Trick (in der Luft, ohne Landung): der call bricht ihn ab.
    const d = new CoinTricks();
    d.update(1 / 60, AIR(700));
    d.debugPlayName('highFlip', -1);
    for (let f = 0; f < 20; f++) d.update(1 / 60, AIR(700));
    d.onEvent(FINISH(false));
    d.update(1 / 60, AIR(700));
    expect(d.trick).toBe('call');
    for (let f = 0; f < 120 && d.trick !== 'none'; f++) d.update(1 / 60, AIR(700));
    expect(d.side).toBe(TAILS);
    // Ins Ziel gesurft (Review: onFree startete vorher wieder edgeSpin, der call kam nie).
    const e = new CoinTricks();
    e.update(1 / 60, AIR(900));
    e.onEvent({ type: 'surfStart' });
    for (let f = 0; f < 40; f++) e.update(1 / 60, SURF(900));
    expect(e.trick).toBe('edgeSpin');
    e.onEvent(FINISH(true));
    e.update(1 / 60, SURF(900));
    expect(e.trick).toBe('call');
    for (let f = 0; f < 120 && e.trick === 'call'; f++) e.update(1 / 60, SURF(900));
    expect(e.side).toBe(HEADS);
  });
});

describe('Kendama (KI6)', () => {
  const vm = new ViewModel();
  vm.setResolution(480, 270);

  /**
   * Echte ViewHand + echtes ViewModel (three, ohne WebGL): in jedem Frame der Fang-Phase liegt die
   * Kugel-Mitte des RENDERERS genau auf dem Becherpunkt des Kens (Weltkoordinaten).
   */
  function catchError(trick: string, target: readonly [number, number, number], fps: number): { worst: number; frames: number } {
    const h = new ViewHand();
    h.setItem('kendama');
    const inp = makeHandInput();
    for (let f = 0; f < fps; f++) h.update(1 / fps, inp);
    h.forceTrick(trick);
    const k = h.state();
    expect(k.trick).toBe(trick);
    const cup = new Vector3();
    const ball = new Vector3();
    let worst = 0;
    let frames = 0;
    const p = h.activeProp;
    if (!(p instanceof KendamaTricks)) throw new Error('Kendama fehlt');
    for (let f = 0; f < fps * 3; f++) {
      h.update(1 / fps, inp);
      if (h.state().trick === 'none') break;
      if (!p.caughtOn(target)) continue;
      vm.apply(h.output(true));
      vm.scene.updateMatrixWorld(true);
      const spinner = vm.itemSocket.children[0];
      cup.set(target[0], target[1], target[2]);
      spinner.localToWorld(cup);
      const sub = vm.subSocketGroup;
      if (!sub) throw new Error('kein zweiter Körper');
      sub.getWorldPosition(ball);
      worst = Math.max(worst, cup.distanceTo(ball));
      frames++;
    }
    return { worst, frames };
  }

  it('Fang exakt auf dem Becherpunkt (Renderer-Welt, Float32-Rest) bei 30/60/144/240 Hz — groß, klein, Spitze, Around Japan', () => {
    for (const fps of [30, 60, 144, 240]) {
      for (const [trick, target] of [
        ['bigCup', KEN_BIG_CUP],
        ['smallCup', KEN_SMALL_CUP],
        ['spike', KEN_SPIKE],
        ['aroundJapan', KEN_SPIKE],
        ['aroundJapan', KEN_BIG_CUP],
      ] as const) {
        const r = catchError(trick, target, fps);
        expect(r.frames, `${trick} ${fps} Hz`).toBeGreaterThan(0);
        expect(r.worst, `${trick} ${fps} Hz`).toBeLessThan(1e-4);
      }
    }
  });

  it('in Ruhe hängt die Kugel als Pendel unter dem Ken (Schnur 9); Fang = Klack (Hand-Impuls nach unten, Squash)', () => {
    const k = new KendamaTricks();
    for (let f = 0; f < 120; f++) {
      k.update(1 / 60, GROUND(0));
      k.afterPose(RUN_JOINTS, GROUND(0), 1 / 60);
    }
    expect(k.out.stringCount).toBe(VM_STRING_POINTS);
    expect(upOf(k.out.sub[0] - k.out.pos[0], k.out.sub[1] - k.out.pos[1], k.out.sub[2] - k.out.pos[2])).toBeLessThan(-6);
    k.debugPlayName('bigCup', -1);
    let klack = false;
    for (let f = 0; f < 120; f++) {
      k.update(1 / 60, GROUND(0));
      if (k.out.kickY > 0.3 && k.out.kickSq < -0.7) klack = true;
      k.out.kickY = 0;
      k.out.kickSq = 0;
    }
    expect(klack).toBe(true);
  });
});

describe('Handy (KI7)', () => {
  const P = VM_PARAM.phone;
  const M = VM_PHONE_MODE;

  it('Anzeige: Feed in Ruhe, Tacho ab 500 u/s (Hysterese 440), Split nach dem Checkpoint 2.5 s, Kamera im Surf', () => {
    const ph = new PhoneTricks();
    ph.update(1 / 60, AIR(0));
    expect(ph.out.param[P.mode]).toBe(M.feed);
    ph.update(1 / 60, AIR(520));
    expect(ph.out.param[P.mode]).toBe(M.speedo);
    expect(ph.out.param[P.value]).toBe(520);
    ph.update(1 / 60, AIR(460));
    expect(ph.out.param[P.mode]).toBe(M.speedo);
    ph.update(1 / 60, AIR(430));
    expect(ph.out.param[P.mode]).toBe(M.feed);
    ph.onEvent(CP(-0.42));
    ph.update(1 / 60, AIR(430));
    expect(ph.out.param[P.mode]).toBe(M.split);
    expect(ph.out.param[P.value]).toBeCloseTo(-0.42, 6);
    for (let f = 0; f < 160; f++) ph.update(1 / 60, AIR(430));
    expect(ph.out.param[P.mode]).toBe(M.feed);
    ph.onEvent({ type: 'surfStart' });
    ph.update(1 / 60, SURF(800));
    expect(ph.trick).toBe('gimbal');
    expect(ph.out.param[P.mode]).toBe(M.camera);
  });

  it('Checkpoint = buzz; Ziel = photo: genau EIN Auslöser (nach SHUTTER_AT), Blitz, dann Foto-Anzeige; ViewHand.takeShutter einmal', () => {
    const h = new ViewHand();
    h.setItem('phone');
    const inp = makeHandInput();
    h.update(1 / 60, inp);
    h.onEvent(CP(0.3));
    expect(h.state().trick).toBe('buzz');
    for (let f = 0; f < 60; f++) h.update(1 / 60, inp);
    h.onEvent(FINISH(true));
    expect(h.state().trick).toBe('photo');
    let shots = 0;
    let shotAt = -1;
    let flash = 0;
    for (let f = 1; f <= 60 * 3; f++) {
      h.update(1 / 60, inp);
      if (h.takeShutter()) {
        shots++;
        // Trick-Zeit (der Trick startet frisch: erster Frame t = 0).
        shotAt = h.state().trickTime;
      }
      flash = Math.max(flash, h.frame.propParam[P.flash]);
      if (shots > 0 && h.state().trick === 'photo') expect(h.frame.propParam[P.mode]).toBe(M.photo);
    }
    expect(shots).toBe(1);
    expect(shotAt).toBeGreaterThanOrEqual(SHUTTER_AT - 1e-9);
    expect(shotAt).toBeLessThan(SHUTTER_AT + 1 / 60 + 1e-9);
    expect(flash).toBeGreaterThan(0.8);
    // Selfie-Frame: Peace-Hand ohne Gegenstand, aktueller Skin.
    h.setGlove('cat');
    const sf = h.selfieFrame();
    expect(sf.item).toBe('none');
    expect(sf.glove).toBe('cat');
    expect(Array.from(sf.joints)).toEqual(Array.from(POSE_JOINTS[POSE.peace]));
    // Andere Gegenstände lösen nie aus.
    const c = new ViewHand();
    c.setItem('can');
    c.onEvent(FINISH(true));
    for (let f = 0; f < 180; f++) c.update(1 / 60, inp);
    expect(c.takeShutter()).toBe(false);
  });

  it('Gimbal: im Surf gleicht das Handy die Hand-Neigung aus (Lage hängt nicht an der Neigung)', () => {
    const rotAt = (tilt: number): number[] => {
      const ph = new PhoneTricks();
      ph.update(1 / 60, AIR(800));
      ph.onEvent({ type: 'surfStart' });
      const inp: PropFrameInput = { ...SURF(800), handTilt: tilt };
      for (let f = 0; f < 60; f++) {
        ph.update(1 / 60, inp);
        ph.afterPose(RUN_JOINTS, inp, 1 / 60);
      }
      return [ph.out.rot[0], ph.out.rot[1], ph.out.rot[2]];
    };
    const a = rotAt(0);
    const b = rotAt(12);
    // Gegen die Neigung gedreht: die Lage unterscheidet sich um genau die Neigung (≠ gleich).
    expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeGreaterThan(0.05);
  });

  it('Display-Upload höchstens 10 Hz und nur bei Änderung (echtes ViewModel, 144 Hz, Tacho wechselt jeden Frame)', () => {
    const vm = new ViewModel();
    vm.setResolution(480, 270);
    const h = new ViewHand();
    h.setItem('phone');
    const inp = makeHandInput();
    inp.onGround = false;
    const found: { tex: DataTexture | null } = { tex: null };
    let t = 0;
    const uploadsIn = (seconds: number, speedOf: (f: number) => number): number => {
      const v0 = found.tex?.version ?? 0;
      for (let f = 0; f < Math.round(seconds * 144); f++) {
        t += 1 / 144;
        inp.speed = speedOf(f);
        h.update(1 / 144, inp);
        vm.setTime(t);
        vm.apply(h.output(true));
        if (!found.tex) {
          vm.itemSocket.traverse((o) => {
            if (o instanceof Mesh && o.material instanceof ShaderMaterial) {
              const m: unknown = o.material.uniforms.uMap?.value;
              if (m instanceof DataTexture && m.image.width === 24) found.tex = m;
            }
          });
        }
      }
      return (found.tex?.version ?? 0) - v0;
    };
    uploadsIn(0.5, () => 600);
    // 2 s mit wechselndem Tempo: höchstens 10 Hz → ≤ 21 Uploads.
    const busy = uploadsIn(2, (f) => 600 + (f % 50));
    expect(found.tex).not.toBeNull();
    expect(busy).toBeGreaterThan(5);
    expect(busy).toBeLessThanOrEqual(21);
    // Gleicher Inhalt: kein Upload.
    const idle = uploadsIn(1, () => 600);
    expect(idle).toBeLessThanOrEqual(1);
  });
});

describe('Surf-Zustände der alten Gegenstände (KI8)', () => {
  it('Dose balanciert aufrecht auf der Zeigefinger-Spitze, Messer dreht als Helikopter (offen), Karte fächelt', () => {
    const can = new CanTricks();
    can.update(1 / 60, AIR(800));
    can.onEvent({ type: 'surfStart' });
    for (let f = 0; f < 60; f++) can.update(1 / 60, SURF(800, 0));
    expect(can.out.pose).toBe(POSE.point);
    // Aufrecht auf der Fingerspitze: im Bild deutlich höher als im Griff, Dosen-Achse zeigt nach oben.
    const o = can.out;
    expect(upOf(o.pos[0] - CAN_HOLD_POS[0], o.pos[1] - CAN_HOLD_POS[1], o.pos[2] - CAN_HOLD_POS[2])).toBeGreaterThan(5);
    const top = new Float64Array(3);
    socketPoint(o.pos, o.rot, o.spin, o.scale, 0, 1, 0, top);
    expect(upOf(top[0] - o.pos[0], top[1] - o.pos[1], top[2] - o.pos[2])).toBeGreaterThan(0.85);
    const k = new KnifeTricks();
    k.update(1 / 60, AIR(800));
    k.onEvent({ type: 'surfStart' });
    const tipX: number[] = [];
    for (let f = 0; f < 60; f++) {
      k.update(1 / 60, SURF(800));
      socketPoint(k.out.pos, k.out.rot, k.out.spin, k.out.scale, 0, -9, 0, top);
      tipX.push(top[0] * VIEW_AXES.right[0] + top[1] * VIEW_AXES.right[1] + top[2] * VIEW_AXES.right[2]);
    }
    expect(k.isOpen).toBe(true);
    // Rotor: das Griff-Ende läuft im Bild von links nach rechts und zurück (Radius ~9).
    expect(Math.max(...tipX) - Math.min(...tipX)).toBeGreaterThan(10);
    for (let f = 0; f < 90; f++) k.update(1 / 60, AIR(800));
    expect(k.trick).toBe('none');
    expect(k.out.knifeBlade).toBe(0);
    const c = new CardTricks();
    c.update(1 / 60, AIR(800));
    c.onEvent({ type: 'surfStart' });
    const edge: number[] = [];
    for (let f = 0; f < 60; f++) {
      c.update(1 / 60, SURF(800));
      socketPoint(c.out.pos, c.out.rot, c.out.spin, c.out.scale, 3.2, 0, 0, top);
      edge.push(top[0] * VIEW_AXES.cam[0] + top[1] * VIEW_AXES.cam[1] + top[2] * VIEW_AXES.cam[2]);
    }
    expect(c.trick).toBe('surfFan');
    // Fächeln: die Kartenkante schwingt zur Kamera und weg.
    expect(Math.max(...edge) - Math.min(...edge)).toBeGreaterThan(2.5);
  });

  it('bestehende Tricks unverändert: Zuordnung der Stufen und Namen der Plan-006-Tricks bleiben', () => {
    expect(CAN_TIER_TRICKS[3]).toEqual(['doubleFlip', 'behindThrow', 'highFlip', 'twirl']);
    expect(new CanTricks().trickNames.slice(0, 8)).toEqual(['tilt', 'crack', 'sip', 'flip', 'highFlip', 'twirl', 'doubleFlip', 'behindThrow']);
    expect(new CardTricks().trickNames.slice(0, 4)).toEqual(['spin', 'turn', 'tossSpin', 'vanish']);
    expect(new KnifeTricks().trickNames.slice(0, 5)).toEqual(['open', 'close', 'rollover', 'aerial', 'doubleAerial']);
  });
});
