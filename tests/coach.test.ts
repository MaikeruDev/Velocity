import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { Coach, JUDGE_MAX_SPEED, NO_STRAFE_HOPS, NO_STRAFE_MAX_SPEED, hintText } from '../src/engine/Coach';
import type { HintId } from '../src/engine/Coach';
import { VERDICTS } from '../src/engine/trainingTypes';
import type { Verdict } from '../src/engine/trainingTypes';
import { PlayerMovement } from '../src/player/PlayerMovement';
import { VELOCITY_DEFAULT } from '../src/player/MovementConfig';
import type { MovementConfig } from '../src/player/MovementConfig';
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
  /** Fehlurteil je Hinweis (null bei Crouch/Surf). */
  readonly verdicts: (Verdict | null)[];
  readonly gains: number[];
  step(input: PlayerInput): void;
}

function harness(
  level: ReturnType<typeof compileLevel>,
  route: readonly RouteNode[] | undefined,
  start: Vector3,
  vel: Vector3,
  lesson = false,
  cfg: MovementConfig = CFG,
): Harness {
  const pm = new PlayerMovement(level.world, cfg);
  pm.state.vel.copy(vel);
  pm.teleport(start, { keepVelocity: true });
  const coach = new Coach(cfg);
  coach.lesson = lesson;
  coach.setLevel(route);
  const hints: HintId[] = [];
  const verdicts: (Verdict | null)[] = [];
  const gains: number[] = [];
  coach.onHint = (id, v) => {
    hints.push(id);
    verdicts.push(v);
  };
  const prev: MutablePlayerSnapshot = PlayerMovement.createSnapshot();
  const cur: MutablePlayerSnapshot = PlayerMovement.createSnapshot();
  pm.copySnapshot(cur);
  return {
    pm,
    coach,
    hints,
    verdicts,
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
  function zigzag(against: boolean, rate: number, seconds: number, speed = 320, lesson = false, cfg: MovementConfig = CFG, holdW = false): Harness {
    const lvl = compileLevel(flatLevel(30000));
    const h = harness(lvl, undefined, new Vector3(0, 1, 20000), new Vector3(0, 0, -speed), lesson, cfg);
    const inp: MutablePlayerInput = { ...NO_INPUT, jumpHeld: true, forward: holdW ? 1 : 0 };
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

  it('Taste gegen die Maus (60 °/s) → Hinweis nach drei Sprüngen, Text "dieselbe Richtung"', () => {
    // Drei Urteile 'against' (Absprung ≥ 200 u/s), danach ist man zu langsam für weitere Urteile.
    const h = zigzag(true, 60, 3.5);
    expect(h.hints).toEqual(['strafe']);
    expect(h.verdicts).toEqual(['against']);
    expect(hintText('strafe', 'against', 'C')).toContain('DIESELBE RICHTUNG');
    expect(h.coach.isLearned('strafe')).toBe(false);
  });

  it('A/D ohne Mausbewegung: drei Urteile noMouse → Hinweis mit Maus-Text', () => {
    const h = zigzag(false, 0, 6);
    expect(h.hints[0]).toBe('strafe');
    expect(h.verdicts[0]).toBe('noMouse');
    const text = hintText('strafe', h.verdicts[0], 'C');
    expect(text).toContain('MAUS');
    // Coach-Band: höchstens zwei Zeilen à ≤ 40 Zeichen.
    expect(text.split('\n').length).toBeLessThanOrEqual(2);
    for (const line of text.split('\n')) expect(line.length).toBeLessThanOrEqual(40);
  });

  it('Judge-Hinweis nur unter 600 u/s: bei 700 u/s dieselben Fehler ohne Hinweis', () => {
    expect(JUDGE_MAX_SPEED).toBe(600);
    const h = zigzag(false, 0, 6, 700);
    // A/D ohne Maus hält das Tempo — alle Absprünge liegen über der Grenze.
    expect(h.pm.state.speed).toBeGreaterThan(JUDGE_MAX_SPEED);
    expect(h.hints).toEqual([]);
    // Direkt gefüttert: drei noMouse bei 700 → nichts, bei 320 → Hinweis.
    const c = new Coach(CFG);
    const got: HintId[] = [];
    c.onHint = (id) => got.push(id);
    for (let i = 0; i < 3; i++) c.judged('noMouse', 700);
    expect(got).toEqual([]);
    for (let i = 0; i < 3; i++) c.judged('noMouse', 320);
    expect(got).toEqual(['strafe']);
  });

  it('dreimal DASSELBE Fehlurteil: gemischte Fehler zählen je Art, ein guter Hop setzt zurück', () => {
    const c = new Coach(CFG);
    const got: (Verdict | null)[] = [];
    c.onHint = (_id, v) => got.push(v);
    c.judged('noMouse', 320);
    c.judged('tooSlow', 320);
    c.judged('noMouse', 320);
    c.judged('good', 320);
    // gelernt → kein Hinweis mehr, egal wie viele Fehler folgen
    for (let i = 0; i < 6; i++) c.judged('noMouse', 320);
    expect(got).toEqual([]);
    const d = new Coach(CFG);
    d.onHint = (_id, v) => got.push(v);
    for (const v of ['noMouse', 'tooSlow', 'noMouse', 'late', 'noMouse'] as const) d.judged(v, 320);
    expect(got).toEqual(['noMouse']);
  });

  it('in Lektionen: 0 Coach-Hinweise (gegen die Maus, Maus steht, Surf mit W)', () => {
    expect(zigzag(true, 60, 3.5, 320, true).hints).toEqual([]);
    expect(zigzag(false, 0, 6, 320, true).hints).toEqual([]);
    const c = new Coach(CFG);
    c.lesson = true;
    const got: HintId[] = [];
    c.onHint = (id) => got.push(id);
    const s = PlayerMovement.createSnapshot();
    s.surfing = true;
    s.onGround = false;
    for (let i = 0; i < CFG.tickRate; i++) c.tick(DT, s, s, { ...NO_INPUT, forward: 1 });
    c.onEvent({ type: 'respawn', reason: 'kill' });
    for (let i = 0; i < 3; i++) c.judged('noMouse', 320);
    expect(got).toEqual([]);
  });

  it('Strafe-Assist aus (Coach mit der gespeicherten Config, wie Game ihn baut): W + passende Seite → Hinweis wHeld', () => {
    // Regression: Game baute den Coach ohne Config (Assist an) — 'W in der Luft' hieß dann "Maus weiter ziehen".
    const off: MovementConfig = { ...CFG, strafeAssist: false };
    for (const rate of [30, 60]) {
      const h = zigzag(false, rate, 8, 320, false, off, true);
      expect(h.verdicts[0], `rate ${rate}`).toBe('wHeld');
      expect(hintText('strafe', h.verdicts[0], 'C')).toContain('W LOSLASSEN');
    }
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

  /** W + Leertaste geradeaus (Luftlenkung legitim, kein Strafe-Versuch), `seconds` lang. */
  function wHop(seconds: number, lesson = false, speed = 320): Harness {
    const lvl = compileLevel(flatLevel(30000));
    const h = harness(lvl, undefined, new Vector3(0, 1, 20000), new Vector3(0, 0, -speed), lesson);
    const inp: MutablePlayerInput = { ...NO_INPUT, forward: 1, jumpHeld: true };
    for (let i = 0; i < CFG.tickRate * seconds; i++) {
      inp.jumpPressed = i === 0;
      h.step(inp);
    }
    return h;
  }

  it('nur W + Sprung (kein A/D): kein Strafe-FEHLER-Hinweis, nach 6 langsamen Hops einmal der Anstoß "Schneller?"', () => {
    expect(NO_STRAFE_HOPS).toBe(6);
    // 3 s: weniger als 6 bewertete Hops → nichts.
    expect(wHop(3).hints).toEqual([]);
    // 20 s: genau ein Anstoß (einmal je Sitzung), nie ein 'strafe'-Fehlertext.
    const h = wHop(20);
    expect(h.hints).toEqual(['noStrafe']);
    expect(h.verdicts).toEqual([null]);
    expect(h.pm.state.speed).toBeLessThan(NO_STRAFE_MAX_SPEED);
    const text = hintText('noStrafe', null, 'C');
    expect(text).toContain('A ODER D');
    expect(text).toContain('TRAINING');
  });

  it('Anstoß "Schneller?" nicht bei ≥ 400 u/s, nicht nach einem guten Hop, nicht in Lektionen', () => {
    const fast = new Coach(CFG);
    const got: HintId[] = [];
    fast.onHint = (id) => got.push(id);
    for (let i = 0; i < 12; i++) fast.judged('wOnly', NO_STRAFE_MAX_SPEED);
    expect(got).toEqual([]);
    // Wer schon gut gestrafet hat, kennt die Technik.
    const good = new Coach(CFG);
    good.onHint = (id) => got.push(id);
    good.judged('good', 320);
    for (let i = 0; i < 12; i++) good.judged('noSide', 320);
    expect(got).toEqual([]);
    expect(wHop(20, true).hints).toEqual([]);
    // Gemischt wOnly/noSide zählen zusammen (beides kein Strafe-Versuch).
    const mixed = new Coach(CFG);
    mixed.onHint = (id) => got.push(id);
    for (let i = 0; i < 5; i++) mixed.judged(i % 2 === 0 ? 'wOnly' : 'noSide', 320);
    expect(got).toEqual([]);
    mixed.judged('noSide', 320);
    expect(got).toEqual(['noStrafe']);
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
    const c = new Coach(CFG);
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
    const c = new Coach(CFG);
    c.enabled = false;
    const hints: HintId[] = [];
    c.onHint = (id) => hints.push(id);
    const a = snap(true);
    for (let i = 0; i < CFG.tickRate; i++) c.tick(DT, a, a, { ...NO_INPUT, forward: 1 });
    c.onEvent({ type: 'respawn', reason: 'kill' });
    expect(hints).toEqual([]);
  });
});

describe('Coach-Band (Plan 007 TU2): Texte passen', () => {
  it('jeder Hinweis ≤ 2 Zeilen à ≤ 40 Zeichen, auch für jedes Fehlurteil (eine Quelle mit der Lektion)', () => {
    const texts = [hintText('crouch', null, 'CTRL'), hintText('surf', null, 'C'), hintText('strafe', null, 'C'), hintText('noStrafe', null, 'C')];
    for (const v of VERDICTS) texts.push(hintText('strafe', v, 'C'));
    for (const t of texts) {
      const lines = t.split('\n');
      expect(lines.length, t).toBeLessThanOrEqual(2);
      for (const l of lines) expect(l.length, l).toBeLessThanOrEqual(40);
    }
    // 'good' hat keinen Fehlertext — dann der allgemeine Strafe-Hinweis, nie ein leeres Band.
    expect(hintText('strafe', 'good', 'C').length).toBeGreaterThan(0);
  });
});
