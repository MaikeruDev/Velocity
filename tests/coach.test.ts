import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { Coach } from '../src/engine/Coach';
import type { HintId } from '../src/engine/Coach';
import { PlayerMovement } from '../src/player/PlayerMovement';
import { VELOCITY_DEFAULT } from '../src/player/MovementConfig';
import { StrafeBot } from '../src/player/bots';
import type { MutablePlayerInput, MutablePlayerSnapshot, PlayerInput } from '../src/player/types';
import { NO_INPUT } from '../src/player/types';
import type { RouteNode } from '../src/world/level/LevelFormat';
import { compileLevel } from '../src/world/level/compileLevel';
import { box, flatLevel, makeLevel } from '../tools/sim/levels';

/**
 * Hinweise im Moment (U1) mit echter Physik: PlayerMovement + Coach wie in
 * Game.onTick (Events zuerst, dann coach.tick mit Zustand vor/nach dem Tick).
 */

const CFG = VELOCITY_DEFAULT;
const DT = 1 / CFG.tickRate;

interface Harness {
  readonly pm: PlayerMovement;
  readonly coach: Coach;
  readonly hints: HintId[];
  readonly gains: number[];
  step(input: PlayerInput): void;
}

function harness(level: ReturnType<typeof compileLevel>, route: readonly RouteNode[] | undefined, start: Vector3, vel: Vector3): Harness {
  const pm = new PlayerMovement(level.world, CFG);
  pm.state.vel.copy(vel);
  pm.teleport(start, { keepVelocity: true });
  const coach = new Coach();
  coach.setLevel(route);
  const hints: HintId[] = [];
  const gains: number[] = [];
  coach.onHint = (id) => hints.push(id);
  const prev: MutablePlayerSnapshot = PlayerMovement.createSnapshot();
  const cur: MutablePlayerSnapshot = PlayerMovement.createSnapshot();
  pm.copySnapshot(cur);
  return {
    pm,
    coach,
    hints,
    gains,
    step(input) {
      pm.copySnapshot(prev);
      const events = pm.tick(input);
      for (const e of events) {
        if (e.type === 'jump' && e.chain >= 2) gains.push(e.gain);
        coach.onEvent(e);
      }
      pm.copySnapshot(cur);
      coach.tick(DT, prev, cur, input);
    },
  };
}

describe('Coach — Strafe-Hinweis', () => {
  /**
   * Zickzack-Hand: bei jedem Absprung wechselt die Seite (links/rechts), die Maus
   * dreht in der Luft mit `rate` °/s in diese Richtung, A/D passend oder dagegen.
   * Auto-Hop gehalten. rate 0 = Maus steht, nur A/D wechseln.
   */
  function zigzag(against: boolean, rate: number, seconds: number): Harness {
    const lvl = compileLevel(flatLevel(30000));
    const h = harness(lvl, undefined, new Vector3(0, 1, 20000), new Vector3(0, 0, -320));
    const inp: MutablePlayerInput = { ...NO_INPUT, jumpHeld: true };
    let dir = 1; // +1 = links drehen
    let yaw = 0;
    let wasGround = true;
    for (let i = 0; i < CFG.tickRate * seconds; i++) {
      const ground = h.pm.state.onGround;
      if (wasGround && !ground) dir = -dir;
      wasGround = ground;
      if (!ground) yaw += (dir * rate * Math.PI) / 180 / CFG.tickRate;
      const match = dir > 0 ? -1 : 1; // links drehen ↔ A
      inp.side = ground ? 0 : against ? -match : match;
      inp.yaw = yaw;
      inp.jumpPressed = i === 0;
      h.step(inp);
    }
    return h;
  }

  it('Taste gegen die Maus (60 °/s) → Hinweis nach drei Sprüngen', () => {
    // Gemessen je Luftabschnitt: +1.6, −109, −74, −55 u/s bei Sync 0.00–0.01.
    const h = zigzag(true, 60, 3.5);
    expect(h.hints).toEqual(['strafe']);
    expect(h.coach.isLearned('strafe')).toBe(false);
  });

  it('A/D ohne Mausbewegung → Hinweis (kein Gewinn)', () => {
    const h = zigzag(false, 0, 6);
    expect(h.hints).toContain('strafe');
  });

  it('passender Zickzack (60/120 °/s) → kein Hinweis, gilt als gelernt', () => {
    for (const rate of [60, 120]) {
      const h = zigzag(false, rate, 6);
      expect(h.hints, `rate ${rate}`).toEqual([]);
      expect(h.coach.isLearned('strafe')).toBe(true);
    }
  });

  it('sauberer Strafe (StrafeBot sync 1) → kein Hinweis, gilt als gelernt', () => {
    const lvl = compileLevel(flatLevel(30000));
    const h = harness(lvl, undefined, new Vector3(0, 1, 20000), new Vector3(0, 0, -320));
    const bot = new StrafeBot(CFG, { sync: 1, heading: 0 });
    for (let i = 0; i < CFG.tickRate * 6; i++) h.step(bot.next(h.pm.state));
    expect(h.hints).toEqual([]);
    expect(h.coach.isLearned('strafe')).toBe(true);
  });

  it('nur W + Sprung (kein A/D) → kein Strafe-Hinweis', () => {
    const lvl = compileLevel(flatLevel(30000));
    const h = harness(lvl, undefined, new Vector3(0, 1, 20000), new Vector3(0, 0, -320));
    const inp: MutablePlayerInput = { ...NO_INPUT, forward: 1, jumpHeld: true };
    for (let i = 0; i < CFG.tickRate * 5; i++) {
      inp.jumpPressed = i === 0;
      h.step(inp);
    }
    expect(h.hints).toEqual([]);
  });
});

describe('Coach — Crouch-Kante', () => {
  // Boden y = 0 bis z = −400, dahinter eine 64-u-Kante (wie L1 H7 → Kante): ohne Ducken nicht zu schaffen.
  const level = compileLevel(
    makeLevel([box([-512, -64, -400], [512, 0, 2000]), box([-512, -64, -1400], [512, 64, -400])], { spawn: [0, 0, 1000] }),
  );
  const route: RouteNode[] = [
    { pos: [0, 0, 600] },
    { pos: [0, 0, -150], jump: true, crouch: true },
    { pos: [0, 64, -700] },
  ];

  it('zwei Bonks ohne Ducken → Hinweis; danach Crouch-Jump → gelernt, kein Hinweis mehr', () => {
    const h = harness(level, route, new Vector3(0, 1, 300), new Vector3(0, 0, -300));
    const inp: MutablePlayerInput = { ...NO_INPUT, forward: 1, jumpHeld: true };
    for (let i = 0; i < CFG.tickRate * 5 && h.hints.length === 0; i++) {
      inp.jumpPressed = i === 0;
      h.step(inp);
    }
    expect(h.hints).toEqual(['crouch']);
    expect(h.pm.state.pos.y).toBeLessThan(10);

    // Jetzt richtig: zurück, anlaufen, springen und in der Luft ducken.
    h.pm.state.vel.set(0, 0, -320);
    h.pm.teleport(new Vector3(0, 1, 300), { keepVelocity: true });
    const cj: MutablePlayerInput = { ...NO_INPUT, forward: 1, jumpHeld: true };
    for (let i = 0; i < CFG.tickRate * 3; i++) {
      cj.jumpPressed = i === 0;
      cj.crouch = !h.pm.state.onGround;
      h.step(cj);
    }
    expect(h.pm.state.pos.y).toBeGreaterThan(60);
    expect(h.coach.isLearned('crouch')).toBe(true);
  });

  it('weit weg von der Kante zählen Wand-Stopps nicht', () => {
    const h = harness(level, [{ pos: [0, 0, 1900], crouch: true }, { pos: [0, 0, 1800] }], new Vector3(0, 1, 300), new Vector3(0, 0, -300));
    const inp: MutablePlayerInput = { ...NO_INPUT, forward: 1, jumpHeld: true };
    for (let i = 0; i < CFG.tickRate * 5; i++) {
      inp.jumpPressed = i === 0;
      h.step(inp);
    }
    expect(h.hints).toEqual([]);
  });
});

describe('Coach — Surf', () => {
  function snap(surfing: boolean): MutablePlayerSnapshot {
    const s = PlayerMovement.createSnapshot();
    s.surfing = surfing;
    s.onGround = false;
    s.speed = 400;
    return s;
  }

  it('W ohne A/D auf der Rampe → Hinweis nach 0.3 s; Tod nach Surf-Kontakt → sofort wieder; Checkpoint danach → nie mehr', () => {
    const c = new Coach();
    const hints: HintId[] = [];
    c.onHint = (id) => hints.push(id);
    const w: PlayerInput = { ...NO_INPUT, forward: 1 };
    const a = snap(true);
    let t = 0;
    while (hints.length === 0 && t < 2) {
      c.tick(DT, a, a, w);
      t += DT;
    }
    expect(hints).toEqual(['surf']);
    expect(t).toBeGreaterThan(0.3);
    expect(t).toBeLessThan(0.35);
    c.onEvent({ type: 'respawn', reason: 'kill' });
    expect(hints).toEqual(['surf', 'surf']);
    // Nächster Versuch mit A in die Rampe, Checkpoint erreicht → gelernt.
    c.tick(DT, a, a, { ...NO_INPUT, side: -1 });
    c.onEvent({ type: 'checkpoint', index: 3, total: 4, time: 12, split: null });
    expect(c.isLearned('surf')).toBe(true);
    for (let i = 0; i < CFG.tickRate; i++) c.tick(DT, a, a, w);
    c.onEvent({ type: 'respawn', reason: 'kill' });
    expect(hints).toEqual(['surf', 'surf']);
  });

  it('abgeschaltet (showHints aus) → nichts', () => {
    const c = new Coach();
    c.enabled = false;
    const hints: HintId[] = [];
    c.onHint = (id) => hints.push(id);
    const a = snap(true);
    for (let i = 0; i < CFG.tickRate; i++) c.tick(DT, a, a, { ...NO_INPUT, forward: 1 });
    c.onEvent({ type: 'respawn', reason: 'kill' });
    expect(hints).toEqual([]);
  });
});
