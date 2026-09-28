import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { Vector3 } from 'three';
import type { RunEvent } from '../src/engine/events';
import { TrainingSession, createDemo, hullIn } from '../src/engine/Training';
import { TRAINING_KEY, TrainingProgress, parseTrainingProgress, starsFor } from '../src/engine/TrainingProgress';
import type { StorageLike } from '../src/engine/Settings';
import { requirementMet } from '../src/engine/Unlocks';
import { VELOCITY_DEFAULT } from '../src/player/MovementConfig';
import { PlayerMovement } from '../src/player/PlayerMovement';
import { NO_INPUT } from '../src/player/types';
import type { MutablePlayerInput, MutablePlayerSnapshot } from '../src/player/types';
import { HAND_MODELS } from '../src/player/bots/BeginnerHand';
import { GatedWorld } from '../src/world/collision/GatedWorld';
import { compileLevel } from '../src/world/level/compileLevel';
import type { CompiledLevel } from '../src/world/level/compileLevel';
import type { LevelFile, StageDef, TrainingIndexEntry } from '../src/world/level/LevelFormat';
import { hasGlyph } from '../src/ui/glyphs';
import { formatLevel } from '../tools/levels/build';
import { runStages } from '../tools/levels/training/check';
import { demo, hand } from '../tools/levels/training/drivers';
import { LESSONS, buildTraining } from '../tools/levels/training/index';
import { box, makeLevel } from '../tools/sim/levels';

/**
 * Trainingsmodus (Plan 007, TC2–TC5): TrainingSession (Zählregeln, Tore, Ereignisse, Sterne), TrainingProgress
 * (velocity.training.v1), Vorführung, Lektions-Maps T1–T8. Die Bot-Matrix je Lektion läuft in levels:check.
 */

const CFG = VELOCITY_DEFAULT;
const DT = 1 / CFG.tickRate;
const HULL = 72;

// ---------------------------------------------------------------- Hilfs-Lektion mit jeder Aufgabe

function lesson(stages: StageDef[], extra: Partial<NonNullable<LevelFile['training']>> = {}): CompiledLevel {
  const def: LevelFile = {
    ...makeLevel([box([-4096, -64, -4096], [4096, 0, 4096])], { id: 'tx' }),
    training: {
      lesson: 9,
      short: 'T9',
      group: 'advanced',
      zones: [
        { id: 'a', min: [100, 0, 100], max: [200, 100, 200] },
        { id: 'b', min: [300, 0, 100], max: [400, 100, 200] },
        { id: 'c', min: [500, 0, 100], max: [600, 100, 200] },
        { id: 'hoch', min: [-100, 40, -100], max: [100, 200, 100] },
      ],
      gates: [
        { id: 'g1', min: [-50, 0, -300], max: [50, 200, -290] },
        { id: 'g2', min: [-50, 0, -400], max: [50, 200, -390] },
      ],
      stages,
      hud: { turnBand: true },
      ...extra,
    },
  };
  return compileLevel(def);
}

const REQ = (id: string, task: StageDef['task'], more: Partial<StageDef> = {}): StageDef => ({ id, title: id.toUpperCase(), text: id, task, ...more });

/** Session + Snapshots zum Füttern von Hand. */
class Rig {
  readonly session: TrainingSession;
  readonly world: GatedWorld;
  readonly prev: MutablePlayerSnapshot = PlayerMovement.createSnapshot();
  readonly cur: MutablePlayerSnapshot = PlayerMovement.createSnapshot();
  readonly out: RunEvent[] = [];
  readonly events: RunEvent[] = [];
  constructor(readonly level: CompiledLevel) {
    this.world = new GatedWorld(level.world, level.gates);
    this.session = new TrainingSession(level, CFG, { world: this.world });
    this.cur.onGround = true;
    this.cur.pos.set(0, 0, 1000);
  }
  /** Ein Tick: vorheriger Zustand = aktueller, dann `patch` auf den aktuellen. */
  step(patch: (s: MutablePlayerSnapshot) => void, cmd = NO_INPUT): RunEvent[] {
    this.prev.pos.copy(this.cur.pos);
    this.prev.vel.copy(this.cur.vel);
    Object.assign(this.prev, { onGround: this.cur.onGround, speed: this.cur.speed, surfing: this.cur.surfing, ducked: this.cur.ducked, hopChain: this.cur.hopChain, sliding: this.cur.sliding });
    patch(this.cur);
    this.out.length = 0;
    this.session.tick(DT, this.prev, this.cur, cmd, HULL, this.out);
    // Ereignis-Objekte kommen aus Ringen (werden wiederverwendet): für die Prüfung kopieren.
    for (const e of this.out) this.events.push({ ...e });
    return this.out;
  }
  steps(n: number, patch: (s: MutablePlayerSnapshot, i: number) => void): void {
    for (let i = 0; i < n; i++) this.step((s) => patch(s, i));
  }
  of<T extends RunEvent['type']>(type: T): Extract<RunEvent, { type: T }>[] {
    return this.events.filter((e): e is Extract<RunEvent, { type: T }> => e.type === type);
  }
}

describe('TrainingSession — Aufgaben', () => {
  it('reach: Zone berührt → Stufe fertig, Tor sofort offen (Kollision), Optik löst sich in 0.4 s auf', () => {
    const r = new Rig(lesson([REQ('hin', { kind: 'reach', zone: 'a' }, { opens: ['g1'] }), REQ('zwei', { kind: 'hopChain', count: 3 })]));
    const s = r.session;
    expect(s.hud.stageTitle).toBe('HIN');
    expect(s.hud.stageTotal).toBe(2);
    r.step((p) => p.pos.set(150, 0, 150));
    expect(r.of('gate')).toEqual([{ type: 'gate', id: 'g1', open: true }]);
    expect(r.of('lessonStage')).toEqual([{ type: 'lessonStage', index: 0, total: 2, rank: 'required', lessonDone: false }]);
    expect(r.world.isOpen(0)).toBe(true);
    expect(r.world.isOpen(1)).toBe(false);
    expect(s.gateOpen[0]).toBe(0);
    s.update(0.2);
    expect(s.gateOpen[0]).toBeCloseTo(0.5, 6);
    s.update(0.3);
    expect(s.gateOpen[0]).toBe(1);
    expect(s.gateOpen[1]).toBe(0);
    expect(s.stageIndex).toBe(1);
    expect(s.hud.stageTitle).toBe('ZWEI');
    expect(s.completedStageIds).toEqual(['hin']);
  });

  it('hopChain: Zähler folgt der Kette, fertig bei count; letzte Pflichtstufe meldet lessonDone', () => {
    const r = new Rig(lesson([REQ('kette', { kind: 'hopChain', count: 3 }), REQ('bonus', { kind: 'hopChain', count: 9 }, { rank: 'bonus' })]));
    r.step((p) => (p.hopChain = 2));
    expect(r.session.hud.count).toBe(2);
    expect(r.session.done).toBe(false);
    r.step((p) => (p.hopChain = 3));
    expect(r.of('lessonStage')[0]).toMatchObject({ index: 0, lessonDone: true });
    expect(r.session.done).toBe(true);
    expect(r.session.stars).toBe(1);
    r.step((p) => (p.hopChain = 9));
    expect(r.of('lessonStage')[1]).toMatchObject({ index: 1, rank: 'bonus', lessonDone: false });
    expect(r.session.stars).toBe(3); // ohne Meisterstufe ist die Meister-Bedingung erfüllt
  });

  it('speed: Balken bis min; holdHops zählt Landungen in Folge über min, eine darunter setzt zurück', () => {
    const r = new Rig(lesson([REQ('v', { kind: 'speed', min: 400 }), REQ('halten', { kind: 'speed', min: 400, holdHops: 3 })]));
    r.step((p) => (p.speed = 250));
    expect(r.session.hud.style).toBe('bar');
    expect(r.session.hud.count).toBe(250);
    r.step((p) => (p.speed = 401));
    expect(r.session.stageIndex).toBe(1);
    expect(r.session.hud.style).toBe('pips');
    const hop = (speed: number): void => {
      r.steps(40, (p) => {
        p.onGround = false;
        p.speed = speed;
      });
      r.step((p) => (p.onGround = true));
    };
    hop(420);
    hop(430);
    expect(r.session.hud.count).toBe(2);
    hop(380);
    expect(r.session.hud.count).toBe(0);
    hop(410);
    hop(420);
    hop(430);
    expect(r.session.stageIndex).toBe(2);
  });

  it('surfHold: Lücken ≤ 0.15 s zählen weiter, längere setzen zurück', () => {
    const r = new Rig(lesson([REQ('halten', { kind: 'surfHold', seconds: 1 })]));
    const surf = (on: boolean, s: number): void => r.steps(Math.round(s * CFG.tickRate), (p) => {
      p.onGround = false;
      p.surfing = on;
    });
    surf(true, 0.6);
    surf(false, 0.12);
    surf(true, 0.3);
    expect(r.session.hud.count).toBeGreaterThanOrEqual(8);
    surf(false, 0.2);
    expect(r.session.hud.count).toBe(0);
    surf(true, 0.95);
    expect(r.session.stageIndex).toBe(0);
    surf(true, 0.06);
    expect(r.session.stageIndex).toBe(1);
  });

  it('surfSpeed: nur beim Surfen (Lücke ≤ 0.15 s)', () => {
    const r = new Rig(lesson([REQ('s', { kind: 'surfSpeed', min: 800 })]));
    r.step((p) => {
      p.onGround = false;
      p.speed = 900;
    });
    expect(r.session.stageIndex).toBe(0);
    r.step((p) => (p.surfing = true));
    expect(r.session.stageIndex).toBe(1);
  });

  it('crouchLand: nur geduckt in der Luft, oben in der Zone, Füße ≥ 40 u über dem Absprung', () => {
    const r = new Rig(lesson([REQ('kante', { kind: 'crouchLand', zone: 'hoch', count: 2 })]));
    const jump = (ducked: boolean, landY: number): void => {
      r.step((p) => p.pos.set(0, 0, 150));
      r.steps(30, (p) => {
        p.onGround = false;
        p.ducked = ducked;
        p.pos.set(0, 30, 120);
      });
      r.step((p) => {
        p.onGround = true;
        p.ducked = false;
        p.pos.set(0, landY, 0);
      });
    };
    jump(false, 66);
    expect(r.session.hud.count).toBe(0);
    jump(true, 30);
    expect(r.session.hud.count).toBe(0);
    jump(true, 66);
    expect(r.session.hud.count).toBe(1);
    jump(true, 66);
    expect(r.session.stageIndex).toBe(1);
  });

  it('course: Zonen der Reihe nach mit Tempo; zu lange am Boden oder zu langsam → von vorn', () => {
    const r = new Rig(lesson([REQ('kurs', { kind: 'course', zones: ['a', 'b', 'c'], minSpeed: 300, airborne: true, groundGrace: 0.2 })]));
    const at = (x: number, speed = 350, ground = false): void => {
      r.step((p) => {
        p.pos.set(x, 10, 150);
        p.speed = speed;
        p.onGround = ground;
      });
    };
    at(150);
    at(350);
    expect(r.session.hud.count).toBe(2);
    r.steps(Math.round(0.25 * CFG.tickRate), (p) => {
      p.onGround = true;
      p.pos.set(450, 0, 150);
    });
    expect(r.session.hud.count).toBe(0);
    at(150);
    at(250, 230); // unter 0.8 × 300
    expect(r.session.hud.count).toBe(0);
    at(150);
    at(350);
    at(250);
    at(150); // wieder durch die erste Zone: neuer Anlauf ab 1
    expect(r.session.hud.count).toBe(1);
    at(350);
    at(550);
    expect(r.session.stageIndex).toBe(1);
  });

  it('event: Spiel-Ereignis zählt (onEvent), abgeschlossen im nächsten Tick; Respawn lässt Zähler dieser Art', () => {
    const r = new Rig(lesson([REQ('rutsch', { kind: 'event', event: 'slideStart', count: 2 }, { opens: ['g2'] })]));
    r.session.onEvent({ type: 'slideStart', speed: 350, boost: true });
    r.session.onEvent({ type: 'respawn', reason: 'manual' });
    r.session.onEvent({ type: 'footstep', speed: 300, left: true });
    expect(r.session.hud.count).toBe(1);
    r.session.onEvent({ type: 'slideStart', speed: 350, boost: false });
    expect(r.session.stageIndex).toBe(0);
    r.step(() => undefined);
    expect(r.session.stageIndex).toBe(1);
    expect(r.of('gate')).toEqual([{ type: 'gate', id: 'g2', open: true }]);
  });

  it('suspended (Vorführung): nichts zählt, das HUD zeigt demo', () => {
    const r = new Rig(lesson([REQ('hin', { kind: 'reach', zone: 'a' })]));
    r.session.suspended = true;
    expect(r.session.hud.demo).toBe(true);
    r.step((p) => p.pos.set(150, 0, 150));
    expect(r.session.stageIndex).toBe(0);
    r.session.suspended = false;
    r.step((p) => p.pos.set(150, 0, 151));
    expect(r.session.stageIndex).toBe(1);
  });
});

describe('TrainingSession — Ablauf', () => {
  const stages = [
    REQ('eins', { kind: 'reach', zone: 'a' }, { opens: ['g1'], spawn: { pos: [1, 0, 2], yaw: 90 } }),
    REQ('zwei', { kind: 'reach', zone: 'b' }),
    REQ('drei', { kind: 'reach', zone: 'c' }, { opens: ['g2'], spawn: { pos: [5, 0, 6], yaw: 180 } }),
    REQ('bonus', { kind: 'hopChain', count: 5 }, { rank: 'bonus' }),
    REQ('meister', { kind: 'hopChain', count: 9 }, { rank: 'master' }),
  ];

  it('respawnPoint: Spawn der Stufe, sonst der vorigen, sonst des Levels', () => {
    const r = new Rig(lesson(stages));
    expect(r.session.respawnPoint().pos.toArray()).toEqual([1, 0, 2]);
    expect(r.session.respawnPoint().yaw).toBe(90);
    r.session.jumpTo(1);
    expect(r.session.respawnPoint().pos.toArray()).toEqual([1, 0, 2]);
    r.session.jumpTo(2);
    expect(r.session.respawnPoint().yaw).toBe(180);
    const plain = new Rig(lesson([REQ('x', { kind: 'reach', zone: 'a' })]));
    expect(plain.session.respawnPoint().pos.toArray()).toEqual([0, 0, 0]);
  });

  it('skipStage: öffnet Tore, zählt nicht für Sterne; Ereignisse kommen mit dem nächsten Tick', () => {
    const r = new Rig(lesson(stages));
    r.session.skipStage();
    expect(r.world.isOpen(0)).toBe(true);
    expect(r.session.completedStageIds).toEqual([]);
    r.step(() => undefined);
    expect(r.of('gate')).toEqual([{ type: 'gate', id: 'g1', open: true }]);
    expect(r.of('lessonStage')[0]).toMatchObject({ index: 0 });
    r.step((p) => p.pos.set(350, 0, 150));
    r.step((p) => p.pos.set(550, 0, 150));
    expect(r.session.done).toBe(true);
    expect(r.session.stars).toBe(0); // 'eins' übersprungen
    expect(r.session.completedStageIds).toEqual(['zwei', 'drei']);
  });

  it('Sterne: Pflicht 1, + Bonus 2, + Meister 3; restartLesson schließt die Tore wieder', () => {
    const r = new Rig(lesson(stages));
    r.step((p) => p.pos.set(150, 0, 150));
    r.step((p) => p.pos.set(350, 0, 150));
    r.step((p) => p.pos.set(550, 0, 150));
    expect(r.session.stars).toBe(1);
    r.step((p) => (p.hopChain = 5));
    expect(r.session.stars).toBe(2);
    r.step((p) => (p.hopChain = 9));
    expect(r.session.stars).toBe(3);
    expect(r.session.stage).toBeNull();
    r.events.length = 0;
    r.session.restartLesson();
    expect(r.world.isOpen(0)).toBe(false);
    expect(r.world.isOpen(1)).toBe(false);
    expect(Array.from(r.session.gateOpen)).toEqual([0, 0]);
    expect(r.session.stageIndex).toBe(0);
    expect(r.session.completedStageIds).toEqual([]);
    r.step((p) => (p.pos.set(0, 0, 1000), (p.hopChain = 0)));
    expect(r.of('gate').map((e) => e.open)).toEqual([false, false]);
  });

  it('turnBand nur in Strafe-Stufen (goodHops/speed/course) und nur mit hud.turnBand', () => {
    const strafe = new Rig(lesson([REQ('g', { kind: 'goodHops', count: 3, side: 'left' }), REQ('r', { kind: 'reach', zone: 'a' })]));
    expect(strafe.session.turnBand(320)).toEqual({ lo: 40, hi: 360 });
    strafe.session.skipStage();
    expect(strafe.session.turnBand(320)).toBeNull();
    const off = new Rig(lesson([REQ('g', { kind: 'goodHops', count: 3, side: 'left' })], { hud: {} }));
    expect(off.session.turnBand(320)).toBeNull();
  });

  it('hullIn: Hull 32 breit, Höhe hullH, Füße bei pos', () => {
    const z = lesson([REQ('x', { kind: 'reach', zone: 'a' })]).zones.get('a');
    expect(z).toBeDefined();
    if (!z) return;
    expect(hullIn(z, new Vector3(85, 0, 150), 72)).toBe(true); // Rand 100 − 16 = 84
    expect(hullIn(z, new Vector3(83, 0, 150), 72)).toBe(false);
    expect(hullIn(z, new Vector3(150, -71, 150), 72)).toBe(true);
    expect(hullIn(z, new Vector3(150, -73, 150), 72)).toBe(false);
  });
});

describe('TrainingSession — echte Hops (Judge)', () => {
  /** Hops auf flachem Boden: je Eintrag Seite (+1 = A/links, −1 = D/rechts, 0 = nichts), Maus 90 °/s. */
  function hops(r: Rig, pm: PlayerMovement, seq: readonly number[]): void {
    const inp: MutablePlayerInput = { ...NO_INPUT };
    let yaw = 0;
    for (const side of seq) {
      let left = false;
      for (let t = 0; t < CFG.tickRate * 2; t++) {
        const air = t > 0 && !pm.state.onGround;
        if (t > 0 && pm.state.onGround && left) break;
        if (air) left = true;
        if (air) yaw += side * 90 * (Math.PI / 180) * DT;
        inp.yaw = yaw;
        inp.jumpHeld = t === 0;
        inp.jumpPressed = t === 0;
        inp.forward = t === 0 ? 1 : 0;
        inp.side = air ? -side : 0;
        pm.copySnapshot(r.prev);
        pm.tick(inp);
        pm.copySnapshot(r.cur);
        r.out.length = 0;
        r.session.tick(DT, r.prev, r.cur, inp, HULL, r.out);
        for (const e of r.out) r.events.push({ ...e });
      }
    }
  }

  it("goodHops 'alternate' verzeiht: gleiche Seite oder ein schlechter Hop setzen nichts zurück", () => {
    const r = new Rig(lesson([REQ('wechsel', { kind: 'goodHops', count: 3, side: 'alternate' }), REQ('ende', { kind: 'reach', zone: 'a' })]));
    const pm = new PlayerMovement(r.level.world, CFG);
    pm.state.vel.set(0, 0, -320);
    pm.teleport(new Vector3(0, 0.01, 3000), { keepVelocity: true });
    hops(r, pm, [1, 1, -1, 0, 1]);
    const judged = r.of('lessonHop');
    expect(judged.map((e) => e.verdict)).toEqual(['good', 'good', 'good', 'noSide', 'good']);
    expect(judged.map((e) => e.counted)).toEqual([true, false, true, false, true]);
    // Urteil vor dem Stufenabschluss, mit dem Zählerstand der Stufe (Pips 3/3).
    expect(judged[4]).toMatchObject({ count: 3, goal: 3 });
    const types = r.events.map((e) => e.type);
    expect(types.lastIndexOf('lessonHop')).toBeLessThan(types.indexOf('lessonStage'));
    expect(r.session.stageIndex).toBe(1);
  });
});

describe('TrainingProgress (velocity.training.v1)', () => {
  const mem = (init: Record<string, string> = {}): StorageLike & { data: Record<string, string> } => {
    const data = { ...init };
    return {
      data,
      getItem: (k) => data[k] ?? null,
      setItem: (k, v) => {
        data[k] = v;
      },
      removeItem: (k) => {
        delete data[k];
      },
    };
  };
  const STAGES = [{ id: 'a' }, { id: 'b' }, { id: 'x', rank: 'bonus' as const }, { id: 'm', rank: 'master' as const }];

  it('Sterne aus Stufen-IDs; überlebt Neuladen; Sterne fallen nie', () => {
    const st = mem();
    const p = new TrainingProgress(st);
    expect(p.started).toBe(false);
    expect(p.record('t3', STAGES, ['a'])).toBe(0);
    expect(p.record('t3', STAGES, ['b', 'x'])).toBe(2);
    expect(p.started).toBe(true);
    const again = new TrainingProgress(st);
    expect(again.stars('t3')).toBe(2);
    expect([...again.completedStages('t3')].sort()).toEqual(['a', 'b', 'x']);
    // Eine neue Lektionsfassung mit mehr Pflichtstufen nimmt verdiente Sterne nicht weg.
    expect(again.record('t3', [...STAGES, { id: 'neu' }], [])).toBe(2);
    expect(again.record('t3', STAGES, ['m', 'unbekannt'])).toBe(3);
    expect(again.completedStages('t3')).not.toContain('unbekannt');
  });

  it('kaputter oder fremder Stand lädt leer, ohne Wurf', () => {
    for (const raw of ['{kaputt', 'null', '[]', '{"v":2,"lessons":{}}', '{"v":1,"lessons":[]}', '{"v":1}']) {
      const p = new TrainingProgress(mem({ [TRAINING_KEY]: raw }));
      expect(p.stars('t1')).toBe(0);
      expect(p.started).toBe(false);
    }
    const mixed = parseTrainingProgress({ v: 1, lessons: { t1: { stages: ['a', 3, 'a'], stars: 7 }, t2: 'x', t3: { stages: 'a' } } });
    expect([...mixed.keys()]).toEqual(['t1']);
    expect(mixed.get('t1')).toMatchObject({ stages: ['a'], stars: 0 });
  });

  it('Admin: complete gibt 3 Sterne, reset je Lektion oder alles; onChange meldet', () => {
    const st = mem();
    const p = new TrainingProgress(st);
    let changes = 0;
    const off = p.onChange(() => changes++);
    p.complete('t1', STAGES);
    p.complete('t2', STAGES);
    expect(p.stars('t1')).toBe(3);
    p.reset('t1');
    expect(p.stars('t1')).toBe(0);
    expect(p.stars('t2')).toBe(3);
    p.reset();
    expect(new TrainingProgress(st).stars('t2')).toBe(0);
    off();
    p.complete('t1', STAGES);
    expect(changes).toBe(4);
  });

  it('Speicher voll/gesperrt: Fortschritt gilt für die Sitzung, kein Wurf', () => {
    const p = new TrainingProgress({
      getItem: () => {
        throw new Error('gesperrt');
      },
      setItem: () => {
        throw new Error('voll');
      },
      removeItem: () => undefined,
    });
    expect(p.record('t1', STAGES, ['a', 'b'])).toBe(1);
    expect(p.stars('t1')).toBe(1);
  });

  it('starsFor: 0 ohne alle Pflichtstufen; fehlende Bonus-/Meisterstufen gelten als erfüllt', () => {
    expect(starsFor(STAGES, new Set(['a']))).toBe(0);
    expect(starsFor(STAGES, new Set(['a', 'b', 'm']))).toBe(1);
    expect(starsFor([{ id: 'a' }], new Set(['a']))).toBe(3);
    expect(starsFor([{ id: 'x', rank: 'bonus' }], new Set(['x']))).toBe(0);
  });

  it('Freischaltung aus dem Fortschritt: Grundlagen = jede basics-Lektion ≥ 1 Stern', () => {
    const p = new TrainingProgress(mem());
    const entries: TrainingIndexEntry[] = LESSONS.map((e, i) => ({ id: e.id, name: e.id, file: `${e.id}.json`, lesson: i + 1, short: `T${i + 1}`, group: i < 4 ? 'basics' : 'advanced' }));
    const basics = { kind: 'training', group: 'basics', minStars: 1 } as const;
    const all = { kind: 'training', group: 'all', minStars: 1 } as const;
    expect(requirementMet(basics, [], () => null, p)).toBe(false); // Index nicht geladen
    p.setLessons(entries);
    for (const e of entries.slice(0, 4)) p.record(e.id, [{ id: 'a' }], ['a']);
    expect(requirementMet(basics, [], () => null, p)).toBe(true);
    expect(requirementMet(all, [], () => null, p)).toBe(false);
  });
});

describe('Lektionen T1–T8 (tools/levels/training)', () => {
  const built = buildTraining() ?? [];

  it('acht Lektionen, Nummern 1–8, T1–T4 Grundlagen, T5–T8 Fortgeschritten', () => {
    expect(built.map((l) => l.id)).toEqual(['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8']);
    expect(built.map((l) => l.training?.lesson)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(built.map((l) => l.training?.short)).toEqual(['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8']);
    expect(built.map((l) => l.training?.group)).toEqual(['basics', 'basics', 'basics', 'basics', 'advanced', 'advanced', 'advanced', 'advanced']);
  });

  for (const def of built) {
    it(`${def.id}: kompiliert, ≥ 1 Tor, keine Kill-Zone, kein Timer, Stufen Pflicht → Bonus → Meister, Pflicht mit Vorführung`, () => {
      const level = compileLevel(def);
      const t = def.training;
      expect(t).toBeDefined();
      if (!t) return;
      expect(def.medals).toBeUndefined();
      expect(def.parTime).toBeUndefined();
      expect(level.gates.length).toBeGreaterThanOrEqual(1);
      expect(level.triggers.filter((x) => x.kind === 'kill')).toEqual([]);
      expect(level.triggers.filter((x) => x.kind === 'finish').length).toBe(1);
      const order = { required: 0, bonus: 1, master: 2 } as const;
      const ranks = t.stages.map((s) => order[s.rank ?? 'required']);
      expect([...ranks].sort()).toEqual(ranks);
      expect(ranks).toContain(1);
      expect(ranks).toContain(2);
      for (const s of t.stages) {
        expect([...s.title].length).toBeLessThanOrEqual(16);
        for (const line of s.text.split('\n')) expect([...line].length).toBeLessThanOrEqual(40);
        for (const ch of s.title + s.text + (s.tips ?? []).map((x) => x.text).join('')) if (ch !== '\n') expect(hasGlyph(ch), `${def.id}/${s.id}: "${ch}"`).toBe(true);
        if ((s.rank ?? 'required') === 'required') expect(s.demo, `${def.id}/${s.id} ohne Vorführung`).toBeDefined();
      }
      // Das Ausgangstor öffnet spätestens mit der letzten Pflichtstufe.
      const lastReq = t.stages.filter((s) => (s.rank ?? 'required') === 'required').pop();
      const opened = new Set(t.stages.slice(0, t.stages.indexOf(lastReq ?? t.stages[0]) + 1).flatMap((s) => s.opens ?? []));
      expect(opened.size).toBeGreaterThanOrEqual(1);
    });
  }

  it('public/levels/training ist aktuell (levels:build -- training)', () => {
    const index = 'public/levels/training/index.json';
    expect(existsSync(index)).toBe(true);
    const entries = JSON.parse(readFileSync(index, 'utf8')) as TrainingIndexEntry[];
    expect(entries.map((e) => e.id)).toEqual(built.map((l) => l.id));
    for (const def of built) expect(readFileSync(`public/levels/training/${def.id}.json`, 'utf8')).toBe(formatLevel(def));
  });
});

describe('Vorführung (TC3)', () => {
  it('T3: Demo-Hand deterministisch — gleiche Stufenzeiten über 3 Läufe, 100 % gute Hops', () => {
    const def = LESSONS.find((e) => e.id === 't3');
    expect(def).toBeDefined();
    if (!def) return;
    const level = compileLevel(def.build());
    const stages = level.def.training?.stages ?? [];
    for (let i = 0; i < stages.length; i++) {
      const runs = [0, 1, 2].map(() => runStages(level, CFG, i, i, demo(), 1, 30));
      for (const o of runs) {
        expect(o.passed, `Stufe ${stages[i].id}`).toBe(true);
        expect(o.stageTimes).toEqual(runs[0].stageTimes);
        const judged = Object.values(o.verdicts).reduce((a, b) => a + b, 0);
        expect(o.verdicts.good ?? 0).toBe(judged);
        expect(judged).toBeGreaterThan(0);
      }
    }
  });

  it('createDemo: Surf-Route → SurfHand (Taste in die Rampe), Tunnel → ducken statt hüpfen', () => {
    const t1 = compileLevel(LESSONS[0].build());
    const st = t1.def.training?.stages.find((s) => s.id === 'rutschen');
    expect(st?.demo).toBeDefined();
    if (!st?.demo) return;
    const i = t1.def.training?.stages.indexOf(st) ?? 0;
    const o = runStages(t1, CFG, i, i, demo(), 1, 6);
    expect(o.passed).toBe(true);
    const world = new GatedWorld(t1.world, t1.gates);
    const runner = createDemo(st.demo, t1, CFG, world, { pos: new Vector3(0, 48, -4650), yaw: 0 });
    expect(runner.seconds).toBe(6);
  });

  it('Anfänger-Hand besteht T3 (Stichprobe 5 Seeds), die Fehlerhand "nur W" nie', () => {
    const def = LESSONS.find((e) => e.id === 't3');
    if (!def) throw new Error('t3 fehlt');
    const level = compileLevel(def.build());
    const plan = (si: number) => (si === 0 ? { pattern: 'circle' as const, side: 'left' as const, goal: null } : si === 1 ? { pattern: 'circle' as const, side: 'right' as const, goal: null } : { pattern: 'zigzag' as const, goal: { x: 0, z: 0 } });
    let ok = 0;
    for (let seed = 1; seed <= 5; seed++) if (runStages(level, CFG, 0, 2, hand(HAND_MODELS.anfaenger, plan), seed, 120).passed) ok++;
    expect(ok).toBeGreaterThanOrEqual(4);
    for (let seed = 1; seed <= 3; seed++) expect(runStages(level, CFG, 0, 0, hand(HAND_MODELS.nurW, plan), seed, 40).passed).toBe(false);
  });
});
