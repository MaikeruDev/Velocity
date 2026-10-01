import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { Vector3 } from 'three';
import type { RunEvent } from '../src/engine/events';
import {
  CHAIN_MIN_SPEED,
  DEMO_TIP_TEXT,
  MISS_TEXT,
  NO_SPRINT_AFTER,
  PRESTRAFE_HOPS,
  SIDE_EVIDENCE,
  SLOW_TAKEOFF_HOPS,
  STUCK_AFTER,
  SURF_SLOW_AFTER,
  TIP_COOLDOWN,
  TrainingSession,
  VERDICT_REPEAT,
  createDemo,
  demoStyle,
  hullIn,
  lessonMovementConfig,
} from '../src/engine/Training';
import { BAND_HI_MAX, BAND_LO, MIN_TAKEOFF, PRESTRAFE_BAND_HI, PRESTRAFE_BAND_LO, VERDICT_TEXT } from '../src/engine/strafeJudge';
import { TRAINING_KEY, TrainingProgress, parseTrainingProgress, starsFor } from '../src/engine/TrainingProgress';
import type { StorageLike } from '../src/engine/Settings';
import { requirementMet } from '../src/engine/Unlocks';
import { VELOCITY_DEFAULT, withMovement } from '../src/player/MovementConfig';
import { PlayerMovement } from '../src/player/PlayerMovement';
import { NO_INPUT } from '../src/player/types';
import type { MutablePlayerInput, MutablePlayerSnapshot } from '../src/player/types';
import { BeginnerHand, HAND_MODELS } from '../src/player/bots/BeginnerHand';
import { GatedWorld } from '../src/world/collision/GatedWorld';
import { compileLevel } from '../src/world/level/compileLevel';
import type { CompiledLevel } from '../src/world/level/compileLevel';
import type { LevelFile, StageDef, TrainingIndexEntry } from '../src/world/level/LevelFormat';
import { hasGlyph } from '../src/ui/glyphs';
import { formatLevel } from '../tools/levels/build';
import { DEMO_MAX_FLIPS, DEMO_PLAIN_MAX, demoSpeedCap, runDemo, runStages } from '../tools/levels/training/check';
import { hand } from '../tools/levels/training/drivers';
import { LESSONS, buildTraining } from '../tools/levels/training/index';
import { EDGE, EDGE_BONUS } from '../tools/levels/training/t6';
import { T8_BONUS, T8_MASTER } from '../tools/levels/training/t8';
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
  /** Absprung Nummer `chain` der Physik-Kette mit Tempo `speed` (ein Tick). */
  hop(chain: number, speed = 320): void {
    this.step((p) => {
      p.hopChain = chain;
      p.speed = speed;
    });
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
    r.hop(1);
    r.hop(2);
    expect(r.session.hud.count).toBe(2);
    expect(r.session.done).toBe(false);
    r.hop(3);
    expect(r.of('lessonStage')[0]).toMatchObject({ index: 0, lessonDone: true });
    expect(r.session.done).toBe(true);
    expect(r.session.stars).toBe(1);
    for (let k = 4; k <= 12; k++) r.hop(k);
    expect(r.of('lessonStage')[1]).toMatchObject({ index: 1, rank: 'bonus', lessonDone: false });
    expect(r.session.stars).toBe(3); // ohne Meisterstufe ist die Meister-Bedingung erfüllt
  });

  it('hopChain: die Pips zeigen die laufende Kette — reißt sie, fallen sie zurück; Hämmern auf der Stelle zählt nicht', () => {
    const r = new Rig(lesson([REQ('kette', { kind: 'hopChain', count: 20 })]));
    for (let k = 1; k <= 15; k++) r.hop(k);
    expect(r.session.hud.count).toBe(15);
    r.step((p) => (p.hopChain = 0)); // Kette gerissen (Physik)
    expect(r.session.hud.count).toBe(0);
    r.hop(1);
    r.hop(2);
    expect(r.session.hud.count).toBe(2);
    // Neue Kette aus dem Stand (Physik zählt wieder ab 1): die Pips beginnen bei 1, nicht beim alten Stand + 1.
    r.hop(1);
    expect(r.session.hud.count).toBe(1);
    // Mausrad-Hämmern: Absprünge mit 40 u/s — die Physik zählt eine Kette, die Stufe nicht.
    r.step((p) => (p.hopChain = 0));
    for (let k = 1; k <= 8; k++) r.hop(k, CHAIN_MIN_SPEED - 160);
    expect(r.session.hud.count).toBe(0);
    expect(r.session.stageIndex).toBe(0);
  });

  it('speed: Balken bis min; holdHops zählt Landungen in Folge über min, eine darunter setzt zurück', () => {
    // Ohne Drehbalken (keine Strafe-Lektion): keine A/D-Pflicht — die prüft der eigene Test unten.
    const r = new Rig(lesson([REQ('v', { kind: 'speed', min: 400 }), REQ('halten', { kind: 'speed', min: 400, holdHops: 3 })], { hud: {} }));
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
    const r = new Rig(lesson([REQ('kurs', { kind: 'course', zones: ['a', 'b', 'c'], minSpeed: 300, airborne: true, groundGrace: 0.2 })], { hud: {} }));
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

  describe('A/D-Pflicht in Strafe-Stufen (hud.turnBand): nur W + schnelle Maus und W-Lenken bestanden T4/T5', () => {
    const A: MutablePlayerInput = { ...NO_INPUT, side: -1 };
    const W: MutablePlayerInput = { ...NO_INPUT, forward: 1 };
    /** Luftabschnitt von `s` Sekunden mit Eingabe `cmd` und Tempo `speed`, dann ein Landetick. */
    const hop = (r: Rig, cmd: MutablePlayerInput, speed: number, s = 0.6): void => {
      for (let i = 0; i < Math.round(s * CFG.tickRate); i++)
        r.step((p) => {
          p.onGround = false;
          p.speed = speed;
        }, cmd);
      r.step((p) => (p.onGround = true), cmd);
    };

    it('speed: Tempo ohne A/D füllt den Balken nur bis knapp unter das Ziel und erklärt es; mit A/D fertig', () => {
      const r = new Rig(lesson([REQ('v', { kind: 'speed', min: 400 })]));
      hop(r, W, 420);
      expect(r.session.stageIndex).toBe(0);
      expect(r.session.hud.count).toBe(399);
      expect(r.session.tip).toMatchObject({ text: MISS_TEXT[5], kind: 'verdict' });
      // A/D erst nach 0.15 s Reaktionszeit: zählt, sobald A SIDE_EVIDENCE (0.1 s) gehalten ist und ≥ ein Viertel des
      // Abschnitts ausmacht (19 + 13 Ticks) — vorher ist die Maus noch nicht gemessen.
      r.steps(Math.round(0.15 * CFG.tickRate), (p) => {
        p.onGround = false;
        p.speed = 380;
      });
      const need = Math.ceil(SIDE_EVIDENCE * CFG.tickRate);
      for (let k = 0; k < need - 1; k++) r.step((p) => (p.speed = 410), A);
      expect(r.session.stageIndex).toBe(0);
      r.step((p) => (p.speed = 410), A);
      expect(r.session.stageIndex).toBe(1);
    });

    it('holdHops: eine Landung nach einem Hop ohne A/D zählt nicht und reißt die Serie nicht', () => {
      const r = new Rig(lesson([REQ('halten', { kind: 'speed', min: 400, holdHops: 3 })]));
      hop(r, A, 420);
      hop(r, A, 430);
      expect(r.session.hud.count).toBe(2);
      hop(r, W, 450);
      expect(r.session.hud.count).toBe(2);
      hop(r, A, 440);
      expect(r.session.stageIndex).toBe(1);
    });

    it('course: ein Tor ohne A/D zählt nicht; der vorige A/D-Abschnitt trägt über die Reaktionszeit', () => {
      const r = new Rig(lesson([REQ('kurs', { kind: 'course', zones: ['a', 'b', 'c'], minSpeed: 300, airborne: true, groundGrace: 0.2 })]));
      const at = (x: number, cmd: MutablePlayerInput): void => {
        r.step((p) => {
          p.pos.set(x, 10, 150);
          p.speed = 350;
          p.onGround = false;
        }, cmd);
      };
      // Die ersten SIDE_EVIDENCE s eines Luftabschnitts ist offen, ob A/D noch kommt: kein Tipp.
      at(150, W);
      expect(r.session.hud.count).toBe(0);
      expect(r.session.tip.serial).toBe(0);
      for (let k = 0; k < Math.ceil(SIDE_EVIDENCE * CFG.tickRate); k++) r.step((p) => p.pos.set(0, 10, 150), W);
      at(150, W);
      expect(r.session.hud.count).toBe(0);
      expect(r.session.tip.text).toBe(MISS_TEXT[5]);
      // A/D in der Luft, dann Landung mit A/D-Anteil: auch das nächste Tor früh im neuen Hop zählt.
      for (let k = 0; k < Math.round(0.3 * CFG.tickRate); k++) r.step((p) => p.pos.set(0, 10, 150), A);
      for (const x of [150, 350]) at(x, A);
      expect(r.session.hud.count).toBe(2);
      r.step((p) => (p.onGround = true), A);
      r.step((p) => (p.onGround = false), NO_INPUT);
      at(550, NO_INPUT);
      expect(r.session.stageIndex).toBe(1);
    });

    it('Rückwärts-Strafer: A/D mit der Maus GEGEN die Taste zählt nicht (Tempo, Serie) — der Erklär-Tipp nennt die Maus', () => {
      // A + Maus rechts (yaw sinkt): fliegt rückwärts und gewinnt Tempo, jeder Hop "FALSCHE SEITE" — bestand vorher T4.
      const backHop = (r: Rig, speed: number, rateDeg = -90, s = 0.6): void => {
        const cmd: MutablePlayerInput = { ...NO_INPUT, side: -1 };
        for (let i = 0; i < Math.round(s * CFG.tickRate); i++) {
          cmd.yaw += (rateDeg * Math.PI) / 180 / CFG.tickRate;
          r.step((p) => {
            p.onGround = false;
            p.speed = speed;
          }, cmd);
        }
        r.step((p) => (p.onGround = true), cmd);
      };
      const v = new Rig(lesson([REQ('v', { kind: 'speed', min: 400 })]));
      backHop(v, 420);
      expect(v.session.stageIndex).toBe(0);
      expect(v.session.hud.count).toBe(399);
      expect(v.session.tip).toMatchObject({ text: MISS_TEXT[6], kind: 'verdict' });
      const h = new Rig(lesson([REQ('halten', { kind: 'speed', min: 400, holdHops: 2 })]));
      backHop(h, 420);
      backHop(h, 430);
      expect(h.session.hud.count).toBe(0);
      // Dieselbe Taste mit der Maus in Tastenrichtung (links, yaw steigt) zählt; eine ruhige Maus (0 °/s) auch.
      backHop(h, 440, 90);
      backHop(h, 450, 0);
      expect(h.session.stageIndex).toBe(1);
    });

    it('Prestrafe (speed am Boden) und Lektionen ohne Drehbalken: keine A/D-Pflicht', () => {
      const pre = new Rig(lesson([REQ('pre', { kind: 'speed', min: 350, ground: true })]));
      pre.steps(Math.round(0.7 * CFG.tickRate), (p) => (p.speed = 360));
      expect(pre.session.stageIndex).toBe(1);
      const plain = new Rig(lesson([REQ('v', { kind: 'speed', min: 400 })], { hud: {} }));
      hop(plain, W, 420);
      expect(plain.session.stageIndex).toBe(1);
    });
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

  it('suspended (Vorführung): nichts zählt, das HUD zeigt demo; geschafft öffnet die Tore nur für die Vorführung', () => {
    const r = new Rig(lesson([REQ('hin', { kind: 'reach', zone: 'a' }, { opens: ['g1'] }), REQ('zwei', { kind: 'reach', zone: 'b' })]));
    const s = r.session;
    s.suspended = true;
    expect(s.hud.demo).toBe(true);
    expect(s.demoPassed).toBe(false);
    r.step((p) => p.pos.set(150, 0, 150));
    // Stufe bleibt, kein Ereignis, kein Fortschritt — aber das Tor ist für die Vorführung offen (Kollision + Optik).
    expect(s.stageIndex).toBe(0);
    expect(s.demoPassed).toBe(true);
    expect(s.completedStageIds).toEqual([]);
    expect(r.of('gate')).toEqual([]);
    expect(r.of('lessonStage')).toEqual([]);
    expect(r.world.isOpen(0)).toBe(true);
    s.update(0.5);
    expect(s.gateOpen[0]).toBe(1);
    // Ende der Vorführung: Tor wieder zu (sofort, auch die Optik), Stand wie vorher.
    s.suspended = false;
    expect(r.world.isOpen(0)).toBe(false);
    s.update(0.01);
    expect(s.gateOpen[0]).toBe(0);
    expect(s.hud.demo).toBe(false);
    r.step((p) => p.pos.set(150, 0, 151));
    expect(s.stageIndex).toBe(1);
    expect(r.of('gate')).toEqual([{ type: 'gate', id: 'g1', open: true }]);
  });

  it('suspended: der Zählerstand des Spielers bleibt (goodHops/event), die Vorführung zählt im Schatten ab 0', () => {
    const r = new Rig(lesson([REQ('rutsch', { kind: 'event', event: 'slideStart', count: 3 }, { opens: ['g2'] })]));
    const s = r.session;
    s.onEvent({ type: 'slideStart', speed: 350, boost: true });
    r.step(() => undefined);
    expect(s.hud.count).toBe(1);
    s.suspended = true;
    for (let k = 0; k < 3; k++) s.onEvent({ type: 'slideStart', speed: 350, boost: false });
    r.step(() => undefined);
    expect(s.demoPassed).toBe(true);
    expect(s.hud.count).toBe(1); // die Anzeige zeigt weiter den Stand des Spielers
    expect(r.world.isOpen(1)).toBe(true);
    s.suspended = false;
    expect(s.hud.count).toBe(1);
    expect(s.stageCount).toBe(1);
    expect(r.world.isOpen(1)).toBe(false);
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
    for (let k = 1; k <= 5; k++) r.hop(k);
    expect(r.session.stars).toBe(2);
    for (let k = 6; k <= 14; k++) r.hop(k);
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
    expect(strafe.session.turnBand(320)).toEqual({ lo: BAND_LO, hi: BAND_HI_MAX });
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

describe('TrainingSession — Tipps (LessonTip, außerhalb des Vertrags)', () => {
  const secs = (s: number): number => Math.round(s * CFG.tickRate);
  const fired = (r: Rig): number => r.session.tip.serial;

  it("'air' im ersten Luft-Tick; der nächste Tipp wartet TIP_COOLDOWN", () => {
    const r = new Rig(
      lesson([
        REQ('x', { kind: 'reach', zone: 'c' }, {
          tips: [
            { on: 'air', text: 'LUFT' },
            { on: 'zone', zone: 'a', text: 'ZONE' },
          ],
        }),
      ]),
    );
    r.steps(secs(0.5), () => undefined);
    expect(fired(r)).toBe(0);
    r.step((p) => (p.onGround = false));
    expect(r.session.tip).toMatchObject({ text: 'LUFT', kind: 'stage', serial: 1 });
    // Sofort in die Zone: fällig, aber erst nach der Tipp-Sperre.
    r.steps(secs(TIP_COOLDOWN - 0.5), (p) => p.pos.set(150, 0, 150));
    expect(fired(r)).toBe(1);
    r.steps(secs(0.6), (p) => p.pos.set(150, 0, 150));
    expect(r.session.tip).toMatchObject({ text: 'ZONE', serial: 2 });
    // Jeder Tipp einmal je Stufe.
    r.steps(secs(TIP_COOLDOWN + 1), (p) => (p.onGround = !p.onGround));
    expect(fired(r)).toBe(2);
  });

  it("'land' ist ein Zustand: erst nach `after` s am Boden seit einer Landung — ein Bhop löst ihn nie aus", () => {
    const r = new Rig(lesson([REQ('x', { kind: 'reach', zone: 'c' }, { tips: [{ on: 'land', after: 0.5, text: 'STEHEN' }] })]));
    // Am Spawn stehen ist keine Landung.
    r.steps(secs(2), () => undefined);
    expect(fired(r)).toBe(0);
    // 20 Bhops: 0.6 s Luft, 2 Bodenticks.
    for (let k = 0; k < 20; k++) {
      r.steps(secs(0.6), (p) => (p.onGround = false));
      r.steps(2, (p) => (p.onGround = true));
    }
    expect(fired(r)).toBe(0);
    // Landung, 0.4 s stehen, wieder springen: bricht ab.
    r.steps(secs(0.6), (p) => (p.onGround = false));
    r.steps(secs(0.4), (p) => (p.onGround = true));
    r.steps(secs(0.6), (p) => (p.onGround = false));
    expect(fired(r)).toBe(0);
    // Landen und stehen bleiben: nach 0.5 s.
    r.steps(secs(0.45), (p) => (p.onGround = true));
    expect(fired(r)).toBe(0);
    r.steps(secs(0.1), (p) => (p.onGround = true));
    expect(r.session.tip).toMatchObject({ text: 'STEHEN', serial: 1 });
  });

  it("'surf' mit after: nur am Stück; 'stuck' nach after s ohne Fortschritt", () => {
    const r = new Rig(
      lesson([
        REQ('x', { kind: 'reach', zone: 'c' }, {
          tips: [
            { on: 'surf', after: 0.4, text: 'SURF' },
            { on: 'stuck', after: 12, text: 'HÄNGT' },
          ],
        }),
      ]),
    );
    const surf = (on: boolean, s: number): void =>
      r.steps(secs(s), (p) => {
        p.onGround = false;
        p.surfing = on;
      });
    surf(true, 0.3);
    surf(false, 0.05);
    surf(true, 0.3);
    expect(fired(r)).toBe(0);
    surf(true, 0.15);
    expect(r.session.tip).toMatchObject({ text: 'SURF', serial: 1 });
    // stuck: 12 s ohne Fortschritt ab Stufenbeginn (die Uhr lief schon ~0.8 s).
    r.steps(secs(10.5), () => undefined);
    expect(fired(r)).toBe(1);
    r.steps(secs(1), () => undefined);
    expect(r.session.tip).toMatchObject({ text: 'HÄNGT', serial: 2 });
  });

  it(`Stufe mit Vorführung: nach ${STUCK_AFTER} s ohne Fortschritt einmal "[H]"-Tipp (kind demo)`, () => {
    const r = new Rig(lesson([REQ('x', { kind: 'reach', zone: 'c' }, { demo: { kind: 'hand', rateDeg: 120, pattern: 'circle', seconds: 10 } })]));
    r.steps(secs(STUCK_AFTER - 0.5), () => undefined);
    expect(fired(r)).toBe(0);
    r.steps(secs(1), () => undefined);
    expect(r.session.tip).toMatchObject({ text: DEMO_TIP_TEXT, kind: 'demo', serial: 1 });
    r.steps(secs(STUCK_AFTER * 2), () => undefined);
    expect(fired(r)).toBe(1);
  });

  it('nach einer Vorführung, die das Ziel erreicht, zählt eigener Balken-Fortschritt wieder (kein "[H]"-Tipp)', () => {
    const r = new Rig(lesson([REQ('v', { kind: 'speed', min: 400 }, { demo: { kind: 'hand', rateDeg: 120, pattern: 'circle', seconds: 10 } })], { hud: {} }));
    const s = r.session;
    s.suspended = true;
    r.step((p) => (p.speed = 450));
    expect(s.demoPassed).toBe(true);
    s.suspended = false;
    // Eigener Balken 0 → 390 über 25 s: stetiger Fortschritt, nie fertig. Vorher blieb der Bestwert auf dem Ziel der
    // Vorführung (400) — nach 20 s kam "[H] ZEIGT ES DIR".
    const n = secs(25);
    for (let i = 0; i < n; i++) r.step((p) => (p.speed = (390 * i) / n));
    expect(s.hud.count).toBeGreaterThan(380);
    expect(fired(r)).toBe(0);
  });
});

describe('TrainingSession — Erklär-Tipps ohne Urteil (Anlauf, Sprint, Surf-Blick)', () => {
  const secs = (s: number): number => Math.round(s * CFG.tickRate);

  it('Erklär-Tipps im HUD-Font, 2 Zeilen à ≤ 40 Zeichen', () => {
    for (const t of MISS_TEXT) {
      const lines = t.split('\n');
      expect(lines.length).toBe(2);
      for (const l of lines) expect([...l].length, l).toBeLessThanOrEqual(40);
      for (const ch of t) if (ch !== '\n') expect(hasGlyph(ch), `"${ch}" in ${t}`).toBe(true);
    }
  });

  it(`ohne Anlauf (Absprung < ${MIN_TAKEOFF} u/s, kein Urteil): nach ${SLOW_TAKEOFF_HOPS} Hops Erklär-Tipp — nur in Stufen mit Urteil`, () => {
    // Leertaste + A ohne W hüpft mit 40 u/s: der Judge schweigt, vorher 20 s ohne Rückmeldung (Review training-ui).
    const standHop = (r: Rig): void => {
      r.steps(secs(0.75), (p) => {
        p.onGround = false;
        p.speed = 40;
      });
      r.steps(2, (p) => (p.onGround = true));
    };
    // Der Luft-Tipp der Stufe ist Strafe-Anleitung: ohne Anlauf wartet er (sonst sperrte er den Anlauf-Tipp 6 s).
    const r = new Rig(lesson([REQ('links', { kind: 'goodHops', count: 5, side: 'left' }, { tips: [{ on: 'air', text: 'LUFT' }] })]));
    r.cur.speed = 40;
    for (let k = 0; k < SLOW_TAKEOFF_HOPS - 1; k++) standHop(r);
    expect(r.session.tip.serial).toBe(0);
    standHop(r);
    expect(r.session.tip).toMatchObject({ text: MISS_TEXT[7], kind: 'verdict', serial: 1 });
    // Mit Anlauf (Absprung ≥ MIN_TAKEOFF) kommt der Luft-Tipp — nach der Tipp-Sperre.
    r.steps(secs(TIP_COOLDOWN), (p) => {
      p.onGround = true;
      p.speed = 320;
    });
    r.step((p) => (p.onGround = false));
    expect(r.session.tip).toMatchObject({ text: 'LUFT', kind: 'stage', serial: 2 });
    // Lektion ohne Drehbalken (T1/T2/T6): dort urteilt niemand, also auch kein Anlauf-Tipp.
    const plain = new Rig(lesson([REQ('g', { kind: 'reach', zone: 'c' })], { hud: {} }));
    plain.cur.speed = 40;
    for (let k = 0; k < 4; k++) standHop(plain);
    expect(plain.session.tip.serial).toBe(0);
  });

  it(`Rutschen/Prestrafe: W am Boden ohne Sprint (Shift gehalten) → nach ${NO_SPRINT_AFTER} s Tipp (Stufen-Tipp); mit Sprint nie`, () => {
    const walk: MutablePlayerInput = { ...NO_INPUT, forward: 1, sprint: false };
    const run: MutablePlayerInput = { ...NO_INPUT, forward: 1, sprint: true };
    for (const task of [{ kind: 'event', event: 'slideStart', count: 1 }, { kind: 'speed', min: 350, ground: true }] as const) {
      const r = new Rig(lesson([REQ('x', task)], { hud: {} }));
      for (let k = 0; k < secs(NO_SPRINT_AFTER) - 2; k++) r.step((p) => (p.speed = 250), walk);
      expect(r.session.tip.serial).toBe(0);
      for (let k = 0; k < 4; k++) r.step((p) => (p.speed = 250), walk);
      expect(r.session.tip).toMatchObject({ text: MISS_TEXT[9], kind: 'stage' });
      const ok = new Rig(lesson([REQ('x', task)], { hud: {} }));
      for (let k = 0; k < secs(3); k++) ok.step((p) => (p.speed = 250), run);
      expect(ok.session.tip.serial).toBe(0);
    }
    // Andere Stufen: kein Sprint-Tipp (Laufen mit Shift ist dort egal).
    const other = new Rig(lesson([REQ('x', { kind: 'reach', zone: 'c' })], { hud: {} }));
    for (let k = 0; k < secs(3); k++) other.step((p) => (p.speed = 250), walk);
    expect(other.session.tip.serial).toBe(0);
  });

  it(`surfSpeed: surfend langsamer werden (Blick in die Rampe) → nach ${SURF_SLOW_AFTER} s Tipp; schneller werden nie`, () => {
    const surf = (r: Rig, v0: number, dv: number, s: number): void => {
      let v = v0;
      r.steps(secs(s), (p) => {
        p.onGround = false;
        p.surfing = true;
        v += dv;
        p.speed = v;
      });
    };
    const slow = new Rig(lesson([REQ('v800', { kind: 'surfSpeed', min: 800 })], { hud: {} }));
    surf(slow, 600, -0.5, SURF_SLOW_AFTER - 0.05);
    expect(slow.session.tip.serial).toBe(0);
    surf(slow, 600 - 0.5 * secs(SURF_SLOW_AFTER), -0.5, 0.1);
    expect(slow.session.tip).toMatchObject({ text: MISS_TEXT[10], kind: 'stage' });
    // Einzelne schnellere Ticks (Zielrauschen) setzen den Zähler nicht zurück, sie gleichen nur aus.
    const noisy = new Rig(lesson([REQ('v800', { kind: 'surfSpeed', min: 800 })], { hud: {} }));
    let v = 600;
    noisy.steps(secs(1.5), (p, i) => {
      p.onGround = false;
      p.surfing = true;
      v += i % 4 === 0 ? 0.5 : -0.5;
      p.speed = v;
    });
    expect(noisy.session.tip.text).toBe(MISS_TEXT[10]);
    const fast = new Rig(lesson([REQ('v800', { kind: 'surfSpeed', min: 800 })], { hud: {} }));
    surf(fast, 500, 0.5, 3);
    expect(fast.session.tip.serial).toBe(0);
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

  const fresh = (stages: StageDef[]): { r: Rig; pm: PlayerMovement } => {
    const r = new Rig(lesson(stages));
    const pm = new PlayerMovement(r.level.world, CFG);
    pm.state.vel.set(0, 0, -320);
    pm.teleport(new Vector3(0, 0.01, 3000), { keepVelocity: true });
    return { r, pm };
  };

  it('gut, aber nicht gezählt: Erklär-Tipp mit der Seite, die jetzt dran ist (sonst sähe man "GUT" ohne Pip)', () => {
    const alt = fresh([REQ('wechsel', { kind: 'goodHops', count: 5, side: 'alternate' })]);
    hops(alt.r, alt.pm, [1, 1]); // zweimal A + Maus links: der zweite ist gut, zählt aber nicht
    expect(alt.r.of('lessonHop').map((e) => [e.verdict, e.counted])).toEqual([
      ['good', true],
      ['good', false],
    ]);
    expect(alt.r.session.tip).toMatchObject({ text: MISS_TEXT[0], kind: 'verdict' });
    const left = fresh([REQ('links', { kind: 'goodHops', count: 5, side: 'left' })]);
    hops(left.r, left.pm, [-1]); // D + Maus rechts in der Linkskurven-Stufe
    expect(left.r.of('lessonHop')[0]).toMatchObject({ verdict: 'good', counted: false });
    expect(left.r.session.tip.text).toBe(MISS_TEXT[2]);
  });

  it('Seite nach Taste UND Drehrichtung: A-Mehrheit mit Maus netto nach rechts ist keine Linkskurve (gut, zählt nicht)', () => {
    // Ein Hop: erst A + Maus langsam links (60 % der Luft), dann D + Maus schnell rechts — jede Taste mit ihrer Maus
    // ('against' greift nicht), die Taste überwiegend A, die Kurve aber netto rechts.
    const run = (split: number, leftRate: number, rightRate: number): { verdict: string; counted: boolean; side: number; turnSide: number } => {
      const { r, pm } = fresh([REQ('links', { kind: 'goodHops', count: 5, side: 'left' })]);
      const inp: MutablePlayerInput = { ...NO_INPUT };
      let yaw = 0;
      let airT = 0;
      for (let t = 0; t < CFG.tickRate * 2; t++) {
        const air = t > 0 && !pm.state.onGround;
        if (t > 0 && pm.state.onGround && airT > 0) break;
        if (air) airT += DT;
        const a = airT < split;
        if (air) yaw += (a ? leftRate : -rightRate) * (Math.PI / 180) * DT;
        inp.yaw = yaw;
        inp.jumpHeld = t === 0;
        inp.jumpPressed = t === 0;
        inp.forward = t === 0 ? 1 : 0;
        inp.side = air ? (a ? -1 : 1) : 0;
        pm.copySnapshot(r.prev);
        pm.tick(inp);
        pm.copySnapshot(r.cur);
        r.out.length = 0;
        r.session.tick(DT, r.prev, r.cur, inp, HULL, r.out);
        for (const e of r.out) r.events.push({ ...e });
      }
      const e = r.of('lessonHop')[0];
      return { verdict: e.verdict, counted: e.counted, side: r.session.judge.last.side, turnSide: r.session.judge.last.turnSide };
    };
    const mixed = run(0.45, 40, 200);
    expect(mixed).toMatchObject({ verdict: 'good', side: -1, turnSide: 1, counted: false });
    // Gegenprobe: dieselbe Mischung mit netto Linksdrehung zählt.
    expect(run(0.45, 200, 40)).toMatchObject({ verdict: 'good', side: -1, turnSide: -1, counted: true });
  });

  it(`dasselbe Fehlurteil ${VERDICT_REPEAT}× in Folge → Coach-Text des Urteils (kind verdict), nicht vorher`, () => {
    const { r, pm } = fresh([REQ('g', { kind: 'goodHops', count: 5, side: 'any' })]);
    hops(r, pm, [0]);
    expect(r.session.tip.serial).toBe(0);
    hops(r, pm, [0]);
    expect(r.of('lessonHop').map((e) => e.verdict)).toEqual(['noSide', 'noSide']);
    expect(r.session.tip).toMatchObject({ text: VERDICT_TEXT.noSide.long, kind: 'verdict', serial: 1 });
  });

  it('Stufen ohne Strafe-Bewertung (Lektion ohne Drehbalken): keine Urteils- und Erklär-Tipps — sie belegten die Tipp-Sperre', () => {
    const r = new Rig(lesson([REQ('g', { kind: 'goodHops', count: 5, side: 'left' }, { tips: [{ on: 'stuck', after: 3, text: 'HÄNGT' }] })], { hud: {} }));
    const pm = new PlayerMovement(r.level.world, CFG);
    pm.state.vel.set(0, 0, -320);
    pm.teleport(new Vector3(0, 0.01, 3000), { keepVelocity: true });
    hops(r, pm, [0, 0, -1]); // zweimal nichts (noSide), dann gut, aber falsche Seite (Erklär-Tipp)
    expect(r.of('lessonHop').map((e) => e.verdict)).toEqual(['noSide', 'noSide', 'good']);
    expect(r.session.tip.serial).toBe(0);
    // Der Stufen-Tipp kommt ohne Sperre (vorher: 6 s blockiert durch den versteckten Urteils-Tipp).
    r.steps(Math.round(2 * CFG.tickRate), () => undefined);
    expect(r.session.tip).toMatchObject({ text: 'HÄNGT', kind: 'stage', serial: 1 });
  });

  it(`Prestrafe-Stufe (speed am Boden): Hops ohne Urteil (kein "GUT" für einen Sprung), nach ${PRESTRAFE_HOPS} Hops der Tipp "ohne Sprung"`, () => {
    const { r, pm } = fresh([REQ('pre', { kind: 'speed', min: 350, ground: true })]);
    hops(r, pm, [1]);
    expect(r.of('lessonHop')).toEqual([]);
    expect(r.session.tip.serial).toBe(0);
    hops(r, pm, [1]);
    expect(r.of('lessonHop')).toEqual([]);
    expect(r.session.tip).toMatchObject({ text: MISS_TEXT[8], kind: 'verdict' });
    // Dieselben Hops in einer Luft-Tempo-Stufe werden beurteilt.
    const air = fresh([REQ('v', { kind: 'speed', min: 900 })]);
    hops(air.r, air.pm, [1, 1]);
    expect(air.r.of('lessonHop').map((e) => e.verdict)).toEqual(['good', 'good']);
  });

  it('Prestrafe-Stufe (speed am Boden): Drehbalken-Band 150–300 °/s statt des Luft-Bands', () => {
    const r = new Rig(lesson([REQ('pre', { kind: 'speed', min: 350, ground: true })]));
    expect(r.session.turnBand(320)).toEqual({ lo: PRESTRAFE_BAND_LO, hi: PRESTRAFE_BAND_HI });
    expect(PRESTRAFE_BAND_LO).toBe(150);
    expect(PRESTRAFE_BAND_HI).toBe(300);
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

  it('Admin (Phase 3): setStars setzt genau, auch nach unten; die Stufen tragen die Sterne; 0 = zurücksetzen', () => {
    const st = mem();
    const p = new TrainingProgress(st);
    p.setStars('t1', STAGES, 3);
    expect(p.stars('t1')).toBe(3);
    p.setStars('t1', STAGES, 1);
    expect(p.stars('t1')).toBe(1);
    expect([...p.completedStages('t1')].sort()).toEqual(['a', 'b']);
    p.setStars('t1', STAGES, 2);
    expect([...p.completedStages('t1')].sort()).toEqual(['a', 'b', 'x']);
    expect(new TrainingProgress(st).stars('t1')).toBe(2);
    p.setStars('t1', STAGES, 0);
    expect(p.stars('t1')).toBe(0);
    expect(p.completedStages('t1')).toEqual([]);
    expect(new TrainingProgress(st).stars('t1')).toBe(0);
    // Ein echter Abschluss danach steigt normal.
    expect(p.record('t1', STAGES, ['a', 'b'])).toBe(1);
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

  it('Zahlen in Stufentexten stimmen mit der Aufgabe und der Geometrie (T6 72 statt 76 war ein Fehler)', () => {
    for (const def of built) {
      for (const s of def.training?.stages ?? []) {
        const t = s.task;
        const targets = new Set<number>();
        if (t.kind === 'speed' || t.kind === 'surfSpeed') targets.add(t.min);
        if (t.kind === 'course') targets.add(t.minSpeed);
        // Jede Zahl ≥ 100 in Titel/Text ist ein Tempo-Ziel dieser Stufe.
        for (const m of `${s.title} ${s.text}`.matchAll(/\d+/g)) {
          const n = Number(m[0]);
          if (n >= 100) expect(targets.has(n), `${def.id}/${s.id}: "${m[0]}" ist kein Ziel der Aufgabe (${[...targets].join(', ')})`).toBe(true);
        }
      }
    }
    const t6 = built.find((d) => d.id === 't6')?.training?.stages ?? [];
    const kanten = t6.find((s) => s.id === 'kanten');
    const hoch = t6.find((s) => s.id === 'hoch');
    expect(kanten?.title).toContain(String(EDGE));
    expect(hoch?.title).toContain(String(EDGE_BONUS));
    expect(hoch?.text).toContain(String(EDGE_BONUS));
    for (const s of t6) expect(`${s.title} ${s.text}`, s.id).not.toMatch(/\b76\b/);
    const t8 = built.find((d) => d.id === 't8')?.training?.stages ?? [];
    expect(t8.find((s) => s.id === 'bonus')?.task).toEqual({ kind: 'surfSpeed', min: T8_BONUS });
    expect(t8.find((s) => s.id === 'meister')?.task).toEqual({ kind: 'surfSpeed', min: T8_MASTER });
  });

  it('public/levels/training ist aktuell (levels:build -- training)', () => {
    const index = 'public/levels/training/index.json';
    expect(existsSync(index)).toBe(true);
    const entries = JSON.parse(readFileSync(index, 'utf8')) as TrainingIndexEntry[];
    expect(entries.map((e) => e.id)).toEqual(built.map((l) => l.id));
    for (const def of built) expect(readFileSync(`public/levels/training/${def.id}.json`, 'utf8')).toBe(formatLevel(def));
  });
});

describe('Vorführung (TC3)', () => {
  it('T3: Demo-Hand im Spielmodus deterministisch — gleiche Stufenzeit über 3 Läufe, 100 % gute Hops', () => {
    const def = LESSONS.find((e) => e.id === 't3');
    expect(def).toBeDefined();
    if (!def) return;
    const level = compileLevel(def.build());
    const stages = level.def.training?.stages ?? [];
    for (let i = 0; i < stages.length; i++) {
      const runs = [0, 1, 2].map(() => runDemo(level, CFG, i));
      for (const o of runs) {
        expect(o.passed, `Stufe ${stages[i].id}`).toBe(true);
        expect(o.passAt).toBe(runs[0].passAt);
        const judged = Object.values(o.verdicts).reduce((a, b) => a + b, 0);
        expect(o.verdicts.good ?? 0).toBe(judged);
        expect(judged).toBeGreaterThan(0);
        expect(o.restored).toBe(true);
      }
    }
  });

  const lessonLevel = (id: string): CompiledLevel => {
    const e = LESSONS.find((x) => x.id === id);
    if (!e) throw new Error(`${id} fehlt`);
    return compileLevel(e.build());
  };
  const stageOf = (level: CompiledLevel, id: string): number => (level.def.training?.stages ?? []).findIndex((s) => s.id === id);

  it('createDemo Surf-Route (T7 HALTEN): SurfHand — nie Sprungtaste, an der Flanke A in die Rampe, kein W; schafft die Stufe im Spielmodus', () => {
    const t7 = lessonLevel('t7');
    const i = stageOf(t7, 'halten3');
    const st = t7.def.training?.stages[i];
    if (!st?.demo) throw new Error('T7 halten3 ohne Vorführung');
    expect(demoStyle(st.demo, t7)).toBe('surf');
    const world = new GatedWorld(t7.world, t7.gates);
    const pm = new PlayerMovement(world, CFG);
    const session = new TrainingSession(t7, CFG, { world });
    const sp = session.respawnPoint();
    pm.teleport(sp.pos.clone());
    const runner = createDemo(st.demo, t7, CFG, world, { pos: sp.pos.clone(), yaw: sp.yaw });
    let jumps = 0;
    let surfTicks = 0;
    let intoRamp = 0;
    let forwardOnFlank = 0;
    for (let k = 0; k < st.demo.seconds * CFG.tickRate; k++) {
      const cmd = runner.next(pm.state, pm.surfNormal);
      if (cmd.jumpHeld || cmd.jumpPressed) jumps++;
      pm.tick(cmd);
      if (pm.state.surfing) {
        surfTicks++;
        if (cmd.side === -1) intoRamp++; // Ostflanke: die Rampe liegt links → A
        if (cmd.forward !== 0) forwardOnFlank++;
      }
    }
    expect(jumps).toBe(0);
    expect(surfTicks).toBeGreaterThan(3 * CFG.tickRate);
    expect(intoRamp / surfTicks).toBeGreaterThan(0.95);
    expect(forwardOnFlank).toBe(0);
    const o = runDemo(t7, CFG, i);
    expect(o.passed).toBe(true);
    expect(o.restored).toBe(true);
  });

  it('Vorführung zeigt die gelehrte Technik (Phase 3): T1 LAUFEN nur W ohne Sprung, T2 HALTEN W + Leertaste ohne A/D — beide schaffen die Stufe', () => {
    for (const [id, stage, style] of [
      ['t1', 'laufen', 'walk'],
      ['t2', 'halten', 'hold'],
    ] as const) {
      const lv = lessonLevel(id);
      const i = stageOf(lv, stage);
      const st = lv.def.training?.stages[i];
      if (!st?.demo || st.demo.kind !== 'route') throw new Error(`${id} ${stage} ohne Routen-Vorführung`);
      expect(demoStyle(st.demo, lv)).toBe(style);
      // Eingaben der Vorführung auf echter Physik: nie A/D, W immer (bis zum Ziel), Sprung nur bei 'hold'.
      const pm = new PlayerMovement(lv.world, CFG);
      const session = new TrainingSession(lv, CFG, { world: null });
      session.jumpTo(i);
      const sp = session.respawnPoint();
      pm.teleport(sp.pos);
      const runner = createDemo(st.demo, lv, CFG, lv.world, sp);
      let jumps = 0;
      let side = 0;
      let maxSpeed = 0;
      for (let k = 0; k < 4 * CFG.tickRate; k++) {
        const cmd = runner.next(pm.state, pm.surfNormal);
        if (cmd.jumpHeld) jumps++;
        side = Math.max(side, Math.abs(cmd.side));
        pm.tick(cmd);
        maxSpeed = Math.max(maxSpeed, pm.state.speed);
      }
      expect(side, `${id} ${stage}: kein A/D`).toBe(0);
      if (style === 'walk') expect(jumps, 'LAUFEN: nie springen').toBe(0);
      else expect(jumps, 'HALTEN: Leertaste gehalten').toBeGreaterThan(0);
      // Kein Strafe-Bhop: höchstens Sprinttempo + Lande-Gnade-Rest (vorher 509 bzw. 608 u/s).
      expect(maxSpeed, `${id} ${stage}: Tempo ${maxSpeed.toFixed(0)}`).toBeLessThan(360);
      expect(runDemo(lv, CFG, i).passed, `${id} ${stage}: Vorführung schafft die Stufe`).toBe(true);
    }
  });

  it('jede Vorführung in Lektionen ohne Drehbalken (T1, T2, T6) zeigt kein A/D und kein Strafe-Tempo — und schafft ihre Stufe', () => {
    // Vorher strafte der RouteFollower in T2 LENKEN (Text "W HALTEN"), T1 SPRINGEN/STUFE ("NORMAL SPRINGEN"), T1 RUTSCHEN
    // und T6 mit A/D bis 640 u/s (Review rv-tc3). Jetzt: 'walk'/'hold' laut DemoDef, sonst 'jump' (Lektion ohne turnBand).
    let n = 0;
    for (const e of LESSONS) {
      const lv = compileLevel(e.build());
      if (lv.def.training?.hud?.turnBand) continue;
      (lv.def.training?.stages ?? []).forEach((st, i) => {
        if (!st.demo || demoStyle(st.demo, lv) === 'surf') return;
        n++;
        expect(['walk', 'hold', 'jump', 'flow'], `${e.id}/${st.id}`).toContain(demoStyle(st.demo, lv));
        const o = runDemo(lv, CFG, i);
        expect(o.passed, `${e.id}/${st.id}: schafft die Stufe`).toBe(true);
        expect(o.sideTicks, `${e.id}/${st.id}: A/D-Ticks`).toBe(0);
        // Höchstens Sprint + Rutsch-Schub (DEMO_PLAIN_MAX) oder das Tempo, das die Stufe selbst verlangt (T1 RINNE: Hang).
        expect(o.maxSpeed, `${e.id}/${st.id}: Tempo`).toBeLessThanOrEqual(demoSpeedCap(st));
        expect(demoSpeedCap(st)).toBeLessThan(DEMO_PLAIN_MAX + 150);
        expect(o.restored, `${e.id}/${st.id}`).toBe(true);
      });
    }
    expect(n).toBeGreaterThanOrEqual(10);
  });

  it('PRESTRAFE (T4) hat eine Vorführung: PrestrafeHand — Anlauf mit W, dann W + A und Maus links, nie ein Sprung; schafft die Stufe', () => {
    const t4 = lessonLevel('t4');
    const i = stageOf(t4, 'prestrafe');
    const st = t4.def.training?.stages[i];
    if (!st?.demo) throw new Error('T4 prestrafe ohne Vorführung');
    expect(demoStyle(st.demo, t4)).toBe('prestrafe');
    // Dieselbe DemoDef in einer anderen Stufe ist eine gewöhnliche Strafe-Hand (die Stufe entscheidet).
    expect(demoStyle({ ...st.demo }, t4)).toBe('hand');
    const sp = { pos: new Vector3(), yaw: 0 };
    const runner = createDemo(st.demo, t4, CFG, t4.world, sp);
    const s = PlayerMovement.createSnapshot();
    let lastYaw = 0;
    let turnedLeft = 0;
    let aTicks = 0;
    for (let k = 0; k < 2 * CFG.tickRate; k++) {
      const cmd = runner.next(s, new Vector3());
      expect(cmd.jumpHeld || cmd.jumpPressed).toBe(false);
      expect(cmd.forward).toBe(1);
      if (cmd.side === -1) aTicks++;
      if (cmd.yaw > lastYaw) turnedLeft++;
      lastYaw = cmd.yaw;
    }
    expect(aTicks).toBeGreaterThan(CFG.tickRate); // nach 0.5 s Anlauf durchgehend A
    expect(turnedLeft).toBe(aTicks); // Maus links genau in den A-Ticks
    const o = runDemo(t4, CFG, i);
    expect(o.passed).toBe(true);
    expect(o.jumpTicks).toBe(0);
    expect(o.restored).toBe(true);
  });

  it("jede Stufe hat eine Vorführung (T6 FLUSS seit der zweiten Fix-Runde: 'flow')", () => {
    const missing: string[] = [];
    for (const e of LESSONS) for (const st of e.build().training?.stages ?? []) if (!st.demo) missing.push(`${e.id}/${st.id}`);
    expect(missing).toEqual([]);
  });

  it("'flow'-Vorführung (T6 FLUSS): W + Leertaste im Rhythmus, nie A/D, nach der ersten Kante nie länger als 0.25 s am Boden, nie unter 250 u/s — schafft den Fluss", () => {
    const lv = lessonLevel('t6');
    const i = stageOf(lv, 'fluss');
    const st = lv.def.training?.stages[i];
    if (!st?.demo) throw new Error('T6 fluss ohne Vorführung');
    expect(demoStyle(st.demo, lv)).toBe('flow');
    const world = new GatedWorld(lv.world, lv.gates);
    const pm = new PlayerMovement(world, CFG);
    const session = new TrainingSession(lv, CFG, { world });
    session.jumpTo(i);
    const sp = session.respawnPoint();
    pm.teleport(sp.pos);
    session.suspended = true;
    const runner = createDemo(st.demo, lv, CFG, world, { pos: sp.pos.clone(), yaw: sp.yaw });
    const prev = PlayerMovement.createSnapshot();
    const cur = PlayerMovement.createSnapshot();
    const out: RunEvent[] = [];
    let ground = 0;
    let maxGround = 0;
    let minSpeed = Infinity;
    let crouchJumps = 0;
    let passed = false;
    for (let k = 0; k < st.demo.seconds * CFG.tickRate && !passed; k++) {
      const cmd = runner.next(pm.state, pm.surfNormal);
      expect(cmd.side).toBe(0);
      pm.copySnapshot(prev);
      pm.tick(cmd);
      pm.copySnapshot(cur);
      out.length = 0;
      session.tick(DT, prev, cur, cmd, pm.hullMaxs.y, out);
      if (cmd.crouch && !prev.ducked && !cur.onGround) crouchJumps++;
      // Ab der ersten Kante (Kurs läuft): Bodenzeit am Stück und Tempo wie die Stufe sie prüft.
      if (session.stageCount > 0) {
        ground = cur.onGround ? ground + DT : 0;
        maxGround = Math.max(maxGround, ground);
        minSpeed = Math.min(minSpeed, cur.speed);
      }
      passed = session.demoPassed;
    }
    expect(passed).toBe(true);
    expect(crouchJumps).toBe(3);
    expect(maxGround).toBeLessThanOrEqual(0.25);
    expect(minSpeed).toBeGreaterThanOrEqual(250);
  });

  it(`T5: Vorführung fliegt die Tore wie ein Mensch — eine Seite je Hop (≤ ${DEMO_MAX_FLIPS} A/D-Wechsel je s), nur gute Hops, jede Stufe`, () => {
    // Vorher der RouteFollower: A/D wechselte alle 0.03–0.1 s (Showkeys flackerten), bis 940 u/s.
    const t5 = lessonLevel('t5');
    (t5.def.training?.stages ?? []).forEach((st, i) => {
      if (!st.demo) return;
      expect(demoStyle(st.demo, t5), st.id).toBe('route');
      const o = runDemo(t5, CFG, i);
      expect(o.passed, st.id).toBe(true);
      expect(o.sideFlips, st.id).toBeLessThanOrEqual(Math.ceil(o.passAt * DEMO_MAX_FLIPS));
      const judged = Object.values(o.verdicts).reduce((a, b) => a + b, 0);
      expect(o.verdicts.good ?? 0, st.id).toBe(judged);
      expect(o.restored, st.id).toBe(true);
    });
  });

  it("'jump'-Vorführung (T6 KANTEN): springt an den jump-Knoten und duckt erst in der Luft (Crouch-Jump), nie A/D", () => {
    const t6 = lessonLevel('t6');
    const i = stageOf(t6, 'kanten');
    const st = t6.def.training?.stages[i];
    if (!st?.demo) throw new Error('T6 kanten ohne Vorführung');
    expect(demoStyle(st.demo, t6)).toBe('jump');
    const world = new GatedWorld(t6.world, t6.gates);
    const session = new TrainingSession(t6, CFG, { world });
    session.jumpTo(i);
    const sp = session.respawnPoint();
    const pm = new PlayerMovement(world, CFG);
    pm.teleport(sp.pos.clone());
    const runner = createDemo(st.demo, t6, CFG, world, { pos: sp.pos.clone(), yaw: sp.yaw });
    let presses = 0;
    let groundCrouch = 0;
    let airCrouch = 0;
    let side = 0;
    for (let k = 0; k < 6 * CFG.tickRate; k++) {
      const cmd = runner.next(pm.state, pm.surfNormal);
      if (cmd.jumpPressed) presses++;
      if (cmd.crouch && pm.state.onGround) groundCrouch++;
      if (cmd.crouch && !pm.state.onGround) airCrouch++;
      if (cmd.side !== 0) side++;
      pm.tick(cmd);
    }
    expect(presses).toBe(3); // drei Kanten, je ein Sprung
    expect(side).toBe(0);
    expect(airCrouch).toBeGreaterThan(0);
    expect(groundCrouch).toBe(0);
    expect(pm.state.pos.y).toBeGreaterThanOrEqual(48 + 3 * EDGE - 1);
  });

  it('createDemo Route mit niedriger Decke (T1 RUTSCHEN) im Spielmodus: das Tunneltor öffnet nur für die Vorführung, sie rutscht hindurch', () => {
    const t1 = lessonLevel('t1');
    const i = stageOf(t1, 'rutschen');
    const st = t1.def.training?.stages[i];
    if (!st?.demo) throw new Error('T1 rutschen ohne Vorführung');
    expect(demoStyle(st.demo, t1)).toBe('jump');
    const o = runDemo(t1, CFG, i);
    expect(o.passed).toBe(true);
    // Hinter dem Tunneltor (z −5300 … −5324): früher stand die Vorführung bei z −5284 vor dem geschlossenen Tor.
    expect(o.pos.z).toBeLessThan(-5324);
    // Sprint + C, kein Strafen (vorher A/D 18 % der Ticks und ein Hüpfer vor dem Ducken).
    expect(o.sideTicks).toBe(0);
    // Danach: Tor wieder zu, HUD-Zähler des Spielers unverändert, Stufe nicht erledigt.
    expect(o.restored).toBe(true);
  });

  it('Lehr-Config: VELOCITY-Movement mit allen Hilfen, egal was der Spieler eingestellt hat', () => {
    const c = lessonMovementConfig();
    expect(c).toEqual(VELOCITY_DEFAULT);
    expect(c.autoHop).toBe(true);
    expect(c.strafeAssist).toBe(true);
    expect(c.airControl).toBeGreaterThan(0);
    expect(c.slideMinSpeed).toBeGreaterThan(0);
    expect(lessonMovementConfig()).toBe(c);
  });

  it('Vorführungen tragen auch mit Auto-Hop aus (falls die Spieler-Config durchschlägt): die Hand drückt je Landung frisch', () => {
    const noAuto = withMovement(VELOCITY_DEFAULT, { autoHop: false });
    const t3 = lessonLevel('t3');
    const i = stageOf(t3, 'links');
    const o = runDemo(t3, noAuto, i);
    expect(o.passed).toBe(true);
    expect(o.verdicts.good ?? 0).toBeGreaterThanOrEqual(5);
    // Die Hand selbst: frischer Druck im ersten Bodentick nach Luft, sonst keiner.
    const hand = new BeginnerHand(noAuto, HAND_MODELS.demo, { seed: 1 });
    const s = PlayerMovement.createSnapshot();
    s.onGround = true;
    const presses: boolean[] = [];
    for (const ground of [true, true, false, false, true, true]) {
      s.onGround = ground;
      presses.push(hand.next(s).jumpPressed);
    }
    expect(presses).toEqual([false, false, false, false, true, false]);
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
