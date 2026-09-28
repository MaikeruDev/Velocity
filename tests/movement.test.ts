import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { compileLevel, type CompiledLevel } from '../src/world/level/compileLevel';
import type { BrushDef, RouteNode } from '../src/world/level/LevelFormat';
import { CS2_CLASSIC, VELOCITY_DEFAULT, airSpeedCapAt, withMovement, type MovementConfig } from '../src/player/MovementConfig';
import { PlayerMovement, CHAIN_GRACE_TICKS } from '../src/player/PlayerMovement';
import { lerpSnapshot } from '../src/player/interpolate';
import type { MovementEvent, PlayerInput } from '../src/player/types';
import { NaiveBot, StrafeBot, runRoute, mulberry32, type Bot } from '../src/player/bots';
import { box, flatLevel, makeLevel, readLevelFile } from '../tools/sim/levels';
import { makeInput } from '../tools/sim/harness';
import { surfWorld } from '../tools/sim/scenarios';

const CFG = VELOCITY_DEFAULT;
const DT = 1 / CFG.tickRate;
const NONE = makeInput();
const JUMP = makeInput({ jumpPressed: true, jumpHeld: true });

const FLAT = compileLevel(flatLevel(8192));
const SANDBOX = compileLevel(readLevelFile('public/levels/sandbox.json'));
const SURF = surfWorld();

function player(level: CompiledLevel, pos: Vector3 | [number, number, number], cfg: MovementConfig = CFG, vel?: [number, number, number]): PlayerMovement {
  const pm = new PlayerMovement(level.world, cfg);
  if (vel) pm.state.vel.set(...vel);
  pm.teleport(Array.isArray(pos) ? new Vector3(...pos) : pos, { keepVelocity: vel !== undefined });
  return pm;
}

function level(brushes: BrushDef[]): CompiledLevel {
  return compileLevel(makeLevel(brushes));
}

/** Yaw für Laufrichtung (dx, dz). */
function yawOf(dx: number, dz: number): number {
  return Math.atan2(-dx, -dz);
}

function run(pm: PlayerMovement, input: PlayerInput, ticks: number, events?: MovementEvent[]): void {
  for (let i = 0; i < ticks; i++) {
    const ev = pm.tick(input);
    if (events) for (const e of ev) events.push({ ...e });
  }
}

/** Ticks bis zur ersten Landung (Event), -1 wenn keine. */
function ticksUntilLand(pm: PlayerMovement, input: PlayerInput, max: number): number {
  for (let i = 1; i <= max; i++) {
    if (pm.tick(input).some((e) => e.type === 'land')) return i;
  }
  return -1;
}

function botRun(bot: Bot, cfg: MovementConfig, hops: number): number[] {
  const pm = player(FLAT, [0, 0, 7000], cfg, [0, 0, -cfg.runSpeed]);
  const speeds: number[] = [];
  for (let t = 0; t < 60 * cfg.tickRate && speeds.length < hops; t++) {
    for (const e of pm.tick(bot.next(pm.state))) if (e.type === 'land') speeds.push(e.speed);
  }
  return speeds;
}

describe('Sprung', () => {
  it('Sprunghöhe 57 ± 1 u, Luftzeit ~0.755 s, Landung meldet Aufprall', () => {
    const pm = player(FLAT, [0, 0, 0]);
    const y0 = pm.state.pos.y;
    const ev: MovementEvent[] = [];
    run(pm, JUMP, 1, ev);
    let top = 0;
    let airTicks = 1;
    for (let i = 0; i < 200; i++) {
      const out = pm.tick(NONE);
      top = Math.max(top, pm.state.pos.y - y0);
      airTicks++;
      const land = out.find((e) => e.type === 'land');
      if (land && land.type === 'land') {
        expect(land.airTime).toBeGreaterThan(0.74);
        expect(land.airTime).toBeLessThan(0.765);
        expect(land.impact).toBeGreaterThan(280);
        expect(land.impact).toBeLessThan(310);
        break;
      }
    }
    expect(top).toBeGreaterThan(56);
    expect(top).toBeLessThan(58);
    expect(airTicks * DT).toBeCloseTo(0.755, 1);
    expect(ev[0]).toMatchObject({ type: 'jump', chain: 1, coyote: false });
  });

  it('Sprung aus dem Stand am Boden wird erkannt, in der Luft nicht nochmal', () => {
    const pm = player(FLAT, [0, 0, 0]);
    const ev: MovementEvent[] = [];
    run(pm, JUMP, 1, ev);
    run(pm, NONE, 10, ev);
    run(pm, JUMP, 1, ev); // kein Double-Jump, kein Coyote nach eigenem Sprung
    expect(ev.filter((e) => e.type === 'jump').length).toBe(1);
  });

  const BOX_LEVEL = (h: number): CompiledLevel => level([box([-512, -64, -1024], [512, 0, 512]), box([-256, 0, -700], [256, h, -300], 'box')]);

  /** Probiert Absprungpunkte vor der Kiste durch; true wenn einer oben ankommt. */
  function canClear(h: number, crouch: boolean): boolean {
    const lvl = BOX_LEVEL(h);
    // Start außerhalb der Kiste (Front bei z = -300, Hull 16 u).
    for (let z0 = -80; z0 >= -280; z0 -= 5) {
      const pm = player(lvl, [0, 0, z0], CFG, [0, 0, -250]);
      const input = makeInput({ forward: 1, crouch });
      pm.tick({ ...input, jumpPressed: true, jumpHeld: true });
      run(pm, input, Math.round(1.2 * CFG.tickRate));
      if (pm.state.onGround && pm.state.pos.y > h - 0.5) return true;
    }
    return false;
  }

  it('64-u-Kiste nur per Crouch-Jump, 76 u nie, 48 u normal', () => {
    expect(canClear(48, false)).toBe(true);
    expect(canClear(64, false)).toBe(false);
    expect(canClear(64, true)).toBe(true);
    expect(canClear(76, false)).toBe(false);
    expect(canClear(76, true)).toBe(false);
  });

  it('Sandbox: Kisten 48/64/76 aus dem Lauf', () => {
    // box64 bei x 600..660, z -200..-140. Anlauf von +z Richtung -z.
    const tryBox = (x: number, h: number, crouch: boolean): boolean => {
      for (let z0 = -40; z0 >= -130; z0 -= 4) {
        const pm = player(SANDBOX, [x, 0, z0], CFG, [0, 0, -200]);
        const input = makeInput({ forward: 1, crouch });
        pm.tick({ ...input, jumpPressed: true, jumpHeld: true });
        // Über der Kiste abbremsen, damit er nicht drüber fliegt.
        for (let i = 0; i < 1.2 * CFG.tickRate; i++) pm.tick(pm.state.pos.z < -170 ? makeInput({ crouch }) : input);
        if (pm.state.onGround && pm.state.pos.y > h - 0.5) return true;
      }
      return false;
    };
    expect(tryBox(530, 48, false)).toBe(true);
    expect(tryBox(630, 64, false)).toBe(false);
    expect(tryBox(630, 64, true)).toBe(true);
    expect(tryBox(730, 76, true)).toBe(false);
  });
});

describe('Boden', () => {
  it('Boden-Max = runSpeed bzw. sprintSpeed (±1), diagonal nicht schneller', () => {
    const pm = player(FLAT, [0, 0, 0]);
    run(pm, makeInput({ forward: 1 }), 2 * CFG.tickRate);
    expect(pm.state.speed).toBeGreaterThan(CFG.runSpeed - 1);
    expect(pm.state.speed).toBeLessThan(CFG.runSpeed + 1);
    run(pm, makeInput({ forward: 1, side: 1 }), 2 * CFG.tickRate);
    expect(pm.state.speed).toBeLessThan(CFG.runSpeed + 1);
    run(pm, makeInput({ forward: 1, sprint: true }), 2 * CFG.tickRate);
    expect(pm.state.speed).toBeGreaterThan(CFG.sprintSpeed - 1);
    expect(pm.state.speed).toBeLessThan(CFG.sprintSpeed + 1);
    run(pm, makeInput({ forward: 1, crouch: true }), 2 * CFG.tickRate);
    expect(pm.state.speed).toBeCloseTo(CFG.runSpeed * CFG.duckSpeedScale, 0);
    // Ducken ist unabhängig von Sprint (Auto-Sprint hält Sprint dauerhaft).
    run(pm, makeInput({ forward: 1, sprint: true }), 2 * CFG.tickRate);
    run(pm, makeInput({ forward: 1, crouch: true, sprint: true }), 2 * CFG.tickRate);
    expect(pm.state.speed).toBeCloseTo(CFG.runSpeed * CFG.duckSpeedScale, 0);
  });

  it('Pitch beeinflusst die Bewegung nicht', () => {
    const a = player(FLAT, [0, 0, 0]);
    const b = player(FLAT, [0, 0, 0]);
    run(a, makeInput({ forward: 1, yaw: 0.3, pitch: 0 }), 100);
    run(b, makeInput({ forward: 1, yaw: 0.3, pitch: 1.2 }), 100);
    expect(a.state.pos.distanceTo(b.state.pos)).toBe(0);
  });

  it('Stopp aus 250 u/s plausibel (< 10 u/s in 0.3–0.6 s), 0 → 250 in 0.15–0.3 s', () => {
    const pm = player(FLAT, [0, 0, 0]);
    let t = 0;
    while (pm.state.speed < CFG.runSpeed - 0.5 && t < 256) {
      pm.tick(makeInput({ forward: 1 }));
      t++;
    }
    expect(t * DT).toBeGreaterThan(0.15);
    expect(t * DT).toBeLessThan(0.3);
    run(pm, makeInput({ forward: 1 }), 64);
    t = 0;
    while (pm.state.speed >= 10 && t < 512) {
      pm.tick(NONE);
      t++;
    }
    expect(t * DT).toBeGreaterThan(0.3);
    expect(t * DT).toBeLessThan(0.6);
    run(pm, NONE, 64);
    expect(pm.state.speed).toBe(0);
  });

  it('Treppe 16 u geht, 20 u blockiert', () => {
    const stairs = (h: number): CompiledLevel => level([
      box([-512, -64, -1024], [512, 0, 512]),
      ...Array.from({ length: 6 }, (_, k) => box([-256, 0, -100 - (k + 1) * 32], [256, h * (k + 1), -100 - k * 32])),
      box([-256, 0, -900], [256, h * 6, -292], 'top'),
    ]);
    const up = player(stairs(16), [0, 0, 0]);
    run(up, makeInput({ forward: 1 }), 1.5 * CFG.tickRate);
    expect(up.state.pos.y).toBeCloseTo(96, 0);
    expect(up.state.onGround).toBe(true);

    const blocked = player(stairs(20), [0, 0, 0]);
    run(blocked, makeInput({ forward: 1 }), 2 * CFG.tickRate);
    expect(blocked.state.pos.y).toBeLessThan(1);
    expect(blocked.state.pos.z).toBeGreaterThan(-100 + 16 - 0.5);
  });

  it('Sandbox-Treppe (16er Stufen) hoch bis 96 u', () => {
    // Die Treppe steht frei (kein Boden drumherum): auf stair0 starten, Richtung +x.
    const pm = player(SANDBOX, [272, 16, 360]);
    const input = makeInput({ forward: 1, yaw: yawOf(1, 0) });
    for (let i = 0; i < 3 * CFG.tickRate && pm.state.pos.x < 425; i++) {
      pm.tick(input);
      expect(pm.state.onGround).toBe(true);
    }
    expect(pm.state.pos.x).toBeGreaterThanOrEqual(425);
    expect(pm.state.pos.y).toBeCloseTo(96, 0);
  });

  it('Rampen runterlaufen ohne Abheben (Sandbox 14° und 40°-Rampe mit Sprint)', () => {
    const pm = player(SANDBOX, [1300, 64, 0]);
    const input = makeInput({ forward: 1, sprint: true, yaw: yawOf(-1, 0) });
    for (let i = 0; i < 3 * CFG.tickRate && pm.state.pos.x > 650; i++) {
      pm.tick(input);
      expect(pm.state.onGround).toBe(true);
    }
    expect(pm.state.pos.x).toBeLessThanOrEqual(650);
    expect(pm.state.pos.y).toBeLessThan(1);

    // 40°: Oberseite steigt Richtung -z von y=0 (z=-100) bis y≈419 (z=-600).
    const steep = level([
      box([-512, -64, -1400], [512, 0, 512]),
      { type: 'wedge', min: [-256, 0, -600], max: [256, 419.5, -100], rise: '-z', mat: 'floor' },
      box([-256, 0, -1100], [256, 419.5, -600]),
    ]);
    const p2 = player(steep, [0, 419.5, -800]);
    const down = makeInput({ forward: 1, sprint: true, yaw: 0 + Math.PI });
    let airborne = 0;
    for (let i = 0; i < 3 * CFG.tickRate && p2.state.pos.z < 0; i++) {
      p2.tick(down);
      if (!p2.state.onGround) airborne++;
    }
    expect(p2.state.pos.z).toBeGreaterThanOrEqual(0);
    expect(airborne).toBe(0);
  });

  /** Boden y = 0, steile Rampe steigt ab z = -100 Richtung -z. */
  const steepFoot = (deg: number, len = 300): CompiledLevel => {
    const h = Math.tan((deg * Math.PI) / 180) * len;
    return level([
      box([-512, -64, -3000], [512, 0, 512]),
      { type: 'wedge', min: [-256, 0, -100 - len], max: [256, h, -100], rise: '-z', mat: 'floor' },
      box([-256, 0, -100 - len - 1000], [256, h, -100 - len]),
    ]);
  };

  it.each([50, 60])('Fuß einer %i°-Rampe mit W: bleibt am Boden, kriecht nicht hoch, Sprung klappt', (deg) => {
    for (const cfg of [CFG, CS2_CLASSIC]) {
      const pm = player(steepFoot(deg), [0, 0, 0], cfg);
      const walk = makeInput({ forward: 1, sprint: true });
      run(pm, walk, 2 * cfg.tickRate);
      expect(pm.state.onGround).toBe(true);
      expect(pm.state.pos.y).toBeLessThan(0.1);
      expect(pm.state.pos.z).toBeGreaterThan(-100 + 16 - 1); // an der Rampe angekommen
      expect(pm.state.pos.z).toBeLessThan(-100 + 16 + 1);
      const ev = pm.tick({ ...walk, jumpPressed: true, jumpHeld: true });
      expect(ev.some((e) => e.type === 'jump')).toBe(true);
    }
  });

  it.each([46, 60, 70])('in der Luft an einer %i°-Flanke mit W: kein Hochkriechen', (deg) => {
    for (const cfg of [CFG, CS2_CLASSIC]) {
      const tan = Math.tan((deg * Math.PI) / 180);
      // Hull bei z = -140: die bergseitige Unterkante (z = -156) liegt 1 u über der Flanke. Stillstand.
      const y0 = tan * 56 + 1;
      const pm = player(steepFoot(deg), [0, y0, -140], cfg);
      let maxY = pm.state.pos.y;
      let surfTicks = 0;
      for (let i = 0; i < 4 * cfg.tickRate; i++) {
        pm.tick(makeInput({ forward: 1 }));
        maxY = Math.max(maxY, pm.state.pos.y);
        if (!pm.state.onGround && pm.state.surfing) surfTicks++;
      }
      expect(surfTicks).toBeGreaterThan(cfg.tickRate); // lag wirklich an der Flanke
      expect(maxY).toBeLessThan(y0 + 0.5);
    }
  });

  it('Sprint die Rampe hoch (33°/40°/44°): nie in der Luft, Schritte, schneller als Gehen', () => {
    for (const deg of [33, 40, 44]) {
      const lvl = steepFoot(deg, 600);
      const top = -700;
      const time = (sprint: boolean): { t: number; air: number; steps: number } => {
        const pm = player(lvl, [0, 0, 200]);
        const inp = makeInput({ forward: 1, sprint });
        let t = 0;
        let air = 0;
        let steps = 0;
        for (; t < 10 * CFG.tickRate && pm.state.pos.z > top; t++) {
          for (const e of pm.tick(inp)) if (e.type === 'footstep') steps++;
          if (!pm.state.onGround) air++;
        }
        return { t, air, steps };
      };
      const sprint = time(true);
      const walk = time(false);
      expect(sprint.air).toBe(0);
      expect(walk.air).toBe(0);
      expect(sprint.t).toBeLessThan(walk.t);
      expect(sprint.steps).toBeGreaterThan(8);
    }
  });

  it('diagonal gegen eine Wand → gleitet entlang', () => {
    const lvl = level([box([-512, -64, -2048], [512, 0, 512]), box([100, 0, -2048], [164, 256, 512], 'wall')]);
    const pm = player(lvl, [0, 0, 0]);
    run(pm, makeInput({ forward: 1, yaw: yawOf(1, -1) }), 2 * CFG.tickRate);
    expect(pm.state.pos.x).toBeGreaterThan(100 - 16 - 0.1);
    expect(pm.state.pos.x).toBeLessThan(100 - 16);
    expect(pm.state.pos.z).toBeLessThan(-300);
    expect(pm.state.speed).toBeGreaterThan(150);
    expect(Math.abs(pm.state.vel.x)).toBeLessThan(1e-6);
  });

  it('Schritt-Events wechseln links/rechts, Schrittlänge 64–80 u', () => {
    const pm = player(FLAT, [0, 0, 0]);
    const ev: MovementEvent[] = [];
    run(pm, makeInput({ forward: 1 }), CFG.tickRate / 2);
    const z0 = pm.state.pos.z;
    run(pm, makeInput({ forward: 1 }), 2 * CFG.tickRate, ev);
    const steps = ev.filter((e) => e.type === 'footstep');
    const dist = Math.abs(pm.state.pos.z - z0);
    expect(steps.length).toBeGreaterThan(dist / 80 - 1);
    expect(steps.length).toBeLessThan(dist / 64 + 1);
    for (let i = 1; i < steps.length; i++) {
      const a = steps[i - 1];
      const b = steps[i];
      if (a.type === 'footstep' && b.type === 'footstep') expect(a.left).not.toBe(b.left);
    }
    expect(pm.state.stridePhase).toBeGreaterThanOrEqual(0);
    expect(pm.state.stridePhase).toBeLessThan(1);
  });
});

describe('Bhop & Strafe', () => {
  it('Geradeaus-Bhop mit W gewinnt nichts', () => {
    const speeds = botRun(new NaiveBot(CFG), CFG, 10);
    expect(speeds.length).toBe(10);
    for (const s of speeds) expect(s).toBeLessThanOrEqual(CFG.runSpeed + 0.01);
  });

  it('StrafeBot nach 10 Hops deutlich schneller als NaiveBot', () => {
    const strafe = botRun(new StrafeBot(CFG, { sync: 1 }), CFG, 20);
    const naive = botRun(new NaiveBot(CFG), CFG, 10);
    expect(strafe[9]).toBeGreaterThan(naive[9] * 1.8);
    // Tuning-Korridor (movement-tuning.md: Cap 24, tempoabhängig 32 → 24 zwischen 350 und 700 u/s)
    expect(strafe[4]).toBeGreaterThan(640);
    expect(strafe[4]).toBeLessThan(700);
    expect(strafe[9]).toBeGreaterThan(820);
    expect(strafe[9]).toBeLessThan(880);
    // Skill-Decke: höchstens +5 % gegenüber konstantem Cap 24 (1084).
    expect(strafe[19]).toBeLessThanOrEqual(1140);
  });

  it('gleiche Hand wird nie schlechter belohnt als in CS2 mit 64 Tick (2°/4° Zielfehler)', () => {
    // Vorher Parität (±5 %). Mit dem tempoabhängigen Cap liegen die ersten Hops bewusst
    // darüber; über 700 u/s ist die Physik identisch mit Cap 24 (Test unten).
    const avgH10 = (cfg: MovementConfig, aim: number): number => {
      const v = [1, 2, 3, 4].map((seed) => botRun(new StrafeBot(cfg, { aimNoiseDeg: aim, seed }), cfg, 10)[9]);
      return v.reduce((a, b) => a + b, 0) / v.length;
    };
    for (const aim of [2, 4]) expect(avgH10(CFG, aim) / avgH10(CS2_CLASSIC, aim)).toBeGreaterThan(0.95);
  });

  it('tempoabhängiger Cap: 32 bis 350 u/s, ab 700 u/s pro Tick identisch mit Cap 24; CS2 konstant 30', () => {
    expect(airSpeedCapAt(CFG, 0)).toBe(32);
    expect(airSpeedCapAt(CFG, 350)).toBe(32);
    expect(airSpeedCapAt(CFG, 525)).toBeCloseTo(28, 9);
    expect(airSpeedCapAt(CFG, 700)).toBe(24);
    for (const v of [0, 400, 800, 2000]) expect(airSpeedCapAt(CS2_CLASSIC, v)).toBe(30);
    const fixed = withMovement(CFG, { airSpeedCapLow: 0 });
    for (const speed of [700, 800, 1000, 1500]) {
      for (const turn of [0.3, 0.9, 1.4, 1.6]) {
        // Ein Luft-Tick mit reinem D, Blick um `turn` rad neben der Flugrichtung.
        const a = player(FLAT, [0, 2000, 0], CFG, [0, 0, -speed]);
        const b = player(FLAT, [0, 2000, 0], fixed, [0, 0, -speed]);
        const inp = makeInput({ side: 1, yaw: turn });
        a.tick(inp);
        b.tick(inp);
        expect(a.state.vel.equals(b.state.vel)).toBe(true);
      }
    }
  });

  it('unsauberer StrafeBot (sync 0.7) klar unter perfekt, aber > 330 bei Hop 10', () => {
    const perfect = botRun(new StrafeBot(CFG, { sync: 1 }), CFG, 10)[9];
    const sloppy = [1, 2, 3].map((seed) => botRun(new StrafeBot(CFG, { sync: 0.7, seed }), CFG, 10)[9]);
    const avg = sloppy.reduce((a, b) => a + b, 0) / sloppy.length;
    expect(avg).toBeGreaterThan(330);
    expect(avg).toBeLessThan(perfect - 80);
  });

  it('absolutes Menschenmodell: 2.5° Zielfehler (gemessener Sync ~0.7) > 330 bei Hop 10, 4° klar schlechter', () => {
    const hop10 = (aim: number): { speed: number; sync: number } => {
      let speed = 0;
      let sync = 0;
      for (const seed of [1, 2, 3]) {
        const pm = player(FLAT, [0, 0, 7000], CFG, [0, 0, -CFG.runSpeed]);
        const bot = new StrafeBot(CFG, { aimNoiseDeg: aim, seed: seed * 7919 });
        const lands: number[] = [];
        let s = 0;
        let n = 0;
        for (let t = 0; t < 30 * CFG.tickRate && lands.length < 10; t++) {
          for (const e of pm.tick(bot.next(pm.state))) {
            if (e.type === 'land') lands.push(e.speed);
            if (e.type === 'jump' && e.chain > 1) {
              s += e.sync;
              n++;
            }
          }
        }
        speed += lands[9] / 3;
        sync += s / n / 3;
      }
      return { speed, sync };
    };
    const mid = hop10(2.5);
    expect(mid.sync).toBeGreaterThan(0.6);
    expect(mid.sync).toBeLessThan(0.8);
    expect(mid.speed).toBeGreaterThan(330);
    expect(hop10(4).speed).toBeLessThan(mid.speed - 40);
  });

  it('konstante Drehrate 150°/s gewinnt stetig (Menschenmodell B)', () => {
    const speeds = botRun(new StrafeBot(CFG, { turnRateDeg: 150 }), CFG, 10);
    expect(speeds[9]).toBeGreaterThan(450);
    for (let i = 1; i < speeds.length; i++) expect(speeds[i]).toBeGreaterThan(speeds[i - 1]);
  });

  it('perfekter Hop: 0 Friction-Ticks, Kette zählt, gain = Speed-Differenz', () => {
    const pm = player(FLAT, [0, 0, 7000], CFG, [0, 0, -CFG.runSpeed]);
    const bot = new StrafeBot(CFG, { sync: 1 });
    const jumps: MovementEvent[] = [];
    for (let t = 0; t < 5 * CFG.tickRate; t++) {
      for (const e of pm.tick(bot.next(pm.state))) if (e.type === 'jump') jumps.push({ ...e });
    }
    expect(jumps.length).toBeGreaterThan(4);
    let prev = 0;
    jumps.forEach((e, i) => {
      if (e.type !== 'jump') return;
      expect(e.chain).toBe(i + 1);
      if (i > 0) {
        expect(e.perfect).toBe(true);
        expect(e.gain).toBeCloseTo(e.speed - prev, 6);
        expect(e.gain).toBeGreaterThan(0);
        expect(e.sync).toBeGreaterThan(0.99);
      }
      prev = e.speed;
    });
    expect(pm.state.strafeSync).toBeGreaterThan(0.99);
  });

  it('Kette: Gnadenfrist hält, Stehenbleiben setzt auf 0', () => {
    const cfg = withMovement(CFG, { autoHop: false, jumpBufferTime: 0 });
    const pm = player(FLAT, [0, 0, 0], cfg);
    const ev: MovementEvent[] = [];
    run(pm, JUMP, 1, ev);
    const landAt = ticksUntilLand(pm, NONE, 200);
    expect(landAt).toBeGreaterThan(0);
    run(pm, NONE, CHAIN_GRACE_TICKS, ev); // innerhalb der Frist
    run(pm, JUMP, 1, ev);
    const j2 = ev.filter((e) => e.type === 'jump')[1];
    expect(j2).toMatchObject({ chain: 2, perfect: false });
    ticksUntilLand(pm, NONE, 200);
    run(pm, NONE, CHAIN_GRACE_TICKS + 2);
    expect(pm.state.hopChain).toBe(0);
    run(pm, JUMP, 1, ev);
    expect(ev.filter((e) => e.type === 'jump')[2]).toMatchObject({ chain: 1 });
  });

  it('strafeSync ist ein Zeitfenster: nach 2 s Stehen 0, erster Sprung danach sync 0', () => {
    const pm = player(FLAT, [0, 0, 7000], CFG, [0, 0, -CFG.runSpeed]);
    const bot = new StrafeBot(CFG, { sync: 1 });
    for (let t = 0; t < 5 * CFG.tickRate; t++) pm.tick(bot.next(pm.state));
    expect(pm.state.strafeSync).toBeGreaterThan(0.99);
    run(pm, NONE, 2 * CFG.tickRate);
    expect(pm.state.strafeSync).toBe(0);
    const j = pm.tick(JUMP).find((e) => e.type === 'jump');
    expect(j).toMatchObject({ type: 'jump', sync: 0, chain: 1 });
  });

  it('Sprint wirkt nur am Boden: in der Luft gleiche Physik mit und ohne Shift', () => {
    const a = player(FLAT, [0, 200, 0], CFG, [0, 0, -400]);
    const b = player(FLAT, [0, 200, 0], CFG, [0, 0, -400]);
    for (let i = 0; i < 40; i++) {
      a.tick(makeInput({ forward: -1, side: 1, yaw: 0.3 }));
      b.tick(makeInput({ forward: -1, side: 1, yaw: 0.3, sprint: true }));
    }
    expect(a.state.onGround).toBe(false);
    expect(b.state.vel.equals(a.state.vel)).toBe(true);
  });

  it('Strafe-Assist: in der Luft ist W+A gleich reinem A, am Boden nicht; CS2 ohne Assist', () => {
    const air = (cfg: MovementConfig, forward: number): Vector3 => {
      const pm = player(FLAT, [0, 300, 0], cfg, [0, 0, -400]);
      // Blick folgt der Flugrichtung, knapp rechts davon: A liegt im Gewinnfenster.
      for (let i = 0; i < 40; i++) {
        const v = pm.state.vel;
        pm.tick(makeInput({ forward, side: -1, yaw: Math.atan2(-v.x, -v.z) - 0.03 }));
      }
      expect(pm.state.onGround).toBe(false);
      return pm.state.vel.clone();
    };
    expect(air(CFG, 1).equals(air(CFG, 0))).toBe(true);
    expect(air(CFG, -1).equals(air(CFG, 0))).toBe(true);
    // Gewinn: mit Assist kommt W+A auf den Speed von reinem A, ohne bleibt es darunter.
    const noAssist = withMovement(CFG, { strafeAssist: false });
    const withW = air(CFG, 1);
    expect(Math.hypot(withW.x, withW.z)).toBeGreaterThan(405);
    const oldW = air(noAssist, 1);
    expect(Math.hypot(oldW.x, oldW.z)).toBeLessThan(Math.hypot(withW.x, withW.z) - 5);
    expect(CS2_CLASSIC.strafeAssist).toBe(false);
    // Boden: W+A bleibt diagonal (Assist nur in der Luft).
    const g = player(FLAT, [0, 0, 0]);
    run(g, makeInput({ forward: 1, side: -1 }), CFG.tickRate);
    expect(Math.abs(g.state.vel.x)).toBeGreaterThan(100);
    expect(Math.abs(g.state.vel.z)).toBeGreaterThan(100);
  });

  it('CS2-Preset ohne autoHop: gehaltene Taste hüpft nicht weiter, Flanke schon', () => {
    const pm = player(FLAT, [0, 0, 0], CS2_CLASSIC);
    const ev: MovementEvent[] = [];
    run(pm, JUMP, 1, ev);
    run(pm, makeInput({ jumpHeld: true }), 2 * CS2_CLASSIC.tickRate, ev);
    expect(ev.filter((e) => e.type === 'jump').length).toBe(1);
    run(pm, JUMP, 1, ev);
    expect(ev.filter((e) => e.type === 'jump').length).toBe(2);
  });
});

describe('Smart-Auto-Hop', () => {
  /** Alte Semantik (gehaltene Taste springt immer sofort) als Gegenprobe. */
  const RAW_HOP = withMovement(CFG, { autoHopSpeedShare: 0, autoHopGroundTime: 0 });

  function standing(cfg: MovementConfig, sprint: boolean): { dist: number; speed: number; firstJump: number } {
    const pm = player(FLAT, [0, 0, 0], cfg);
    const inp = makeInput({ forward: 1, jumpHeld: true, sprint });
    let firstJump = -1;
    for (let t = 0; t < 2 * cfg.tickRate; t++) {
      for (const e of pm.tick(inp)) if (e.type === 'jump' && firstJump < 0) firstJump = t * DT;
    }
    return { dist: Math.hypot(pm.state.pos.x, pm.state.pos.z), speed: pm.state.speed, firstJump };
  }

  it('W+Space aus dem Stand gehalten: erst Anlauf, dann Hops mit Lauftempo (statt 24-u/s-Kriechen)', () => {
    const run2 = standing(CFG, false);
    const sprint2 = standing(CFG, true);
    expect(run2.dist).toBeGreaterThanOrEqual(300);
    expect(sprint2.dist).toBeGreaterThanOrEqual(380);
    expect(run2.speed).toBeGreaterThanOrEqual(240);
    expect(sprint2.speed).toBeGreaterThanOrEqual(305);
    expect(run2.firstJump).toBeGreaterThan(0.1);
    expect(run2.firstJump).toBeLessThanOrEqual(0.21);
    // Gegenprobe: ohne Smart-Hop kriecht man mit dem Luft-Cap (32 u/s → < 70 u in 2 s).
    expect(standing(RAW_HOP, true).dist).toBeLessThan(70);
  });

  it('perfekter StrafeBot ab 320: Smart-Hop ändert nichts, auch nur mit gehaltener Taste', () => {
    const lands = (cfg: MovementConfig, heldOnly: boolean): number[] => {
      const pm = player(FLAT, [0, 0, 7000], cfg, [0, 0, -320]);
      const bot = new StrafeBot(cfg, { seed: 7, heading: 0 });
      const out: number[] = [];
      for (let t = 0; t < 30 * cfg.tickRate && out.length < 10; t++) {
        const inp = bot.next(pm.state);
        for (const e of pm.tick(heldOnly ? { ...inp, jumpPressed: false } : inp)) if (e.type === 'land') out.push(e.speed);
      }
      return out;
    };
    const raw = lands(RAW_HOP, false);
    expect(raw.length).toBe(10);
    expect(lands(CFG, false)).toEqual(raw);
    expect(lands(CFG, true)).toEqual(raw);
  });

  it('frischer Druck springt sofort, auch aus dem Stand mit Bewegungstaste', () => {
    const pm = player(FLAT, [0, 0, 0]);
    const ev = pm.tick(makeInput({ forward: 1, jumpHeld: true, jumpPressed: true }));
    expect(ev.some((e) => e.type === 'jump')).toBe(true);
  });

  it('Wand bei Speed 0: gehaltene Taste springt nach ≤ 0.21 s, ohne Bewegungstaste sofort', () => {
    const lvl = level([box([-512, -64, -1024], [512, 0, 512]), box([-256, 0, -700], [256, 64, -300], 'wall')]);
    const pm = player(lvl, [0, 0, -200]);
    const inp = makeInput({ forward: 1, sprint: true, jumpHeld: true });
    let lastLand = -1;
    const waits: number[] = [];
    const chains: number[] = [];
    for (let t = 0; t < 6 * CFG.tickRate; t++) {
      for (const e of pm.tick(inp)) {
        if (e.type === 'land') lastLand = t;
        if (e.type === 'jump' && lastLand >= 0 && pm.state.speed < 5) {
          waits.push((t - lastLand) * DT);
          chains.push(e.chain);
        }
      }
    }
    expect(waits.length).toBeGreaterThan(3); // hüpft weiter, kein Festkleben
    // Wand-Hüpfen ist keine Hop-Kette (HUD/Musik zählten sie früher hoch).
    expect(chains.every((c) => c === 1)).toBe(true);
    for (const w of waits) {
      expect(w).toBeGreaterThan(0.15); // kein Mondhüpfen im Lande-Tick
      expect(w).toBeLessThanOrEqual(0.21);
    }
    const still = player(lvl, [0, 0, -284]);
    expect(still.tick(makeInput({ jumpHeld: true })).some((e) => e.type === 'jump')).toBe(true);
  });

  it('Treppe mit gehaltener Taste: kommt oben an (alte Semantik hängt mit 24 u/s)', () => {
    const stairs = level([
      box([-512, -64, -1600], [512, 0, 512]),
      ...Array.from({ length: 6 }, (_, k) => box([-256, 0, -100 - (k + 1) * 48], [256, 16 * (k + 1), -100 - k * 48])),
      box([-256, 0, -1500], [256, 96, -388], 'top'),
    ]);
    const climb = (cfg: MovementConfig): { t: number; speed: number } => {
      const pm = player(stairs, [0, 0, 0], cfg, [0, 0, -320]);
      const inp = makeInput({ forward: 1, sprint: true, jumpHeld: true });
      let t = 0;
      for (; t < 6 * cfg.tickRate && pm.state.pos.z > -700; t++) pm.tick(inp);
      return { t: t * DT, speed: pm.state.speed };
    };
    const smart = climb(CFG);
    expect(smart.t).toBeLessThan(4);
    expect(smart.speed).toBeGreaterThan(250);
    expect(climb(RAW_HOP).t).toBeGreaterThanOrEqual(6);
  });

  it('land.jumpQueued folgt der Smart-Hop-Bedingung', () => {
    const lands = (pm: PlayerMovement, input: PlayerInput, n: number): boolean[] => {
      const out: boolean[] = [];
      for (let t = 0; t < 10 * CFG.tickRate && out.length < n; t++) for (const e of pm.tick(input)) if (e.type === 'land') out.push(e.jumpQueued);
      return out;
    };
    // Bhop mit Tempo, Taste gehalten → Sprung folgt.
    const fast = player(FLAT, [0, 0, 0], CFG, [0, 0, -400]);
    fast.tick(makeInput({ forward: 1, jumpHeld: true, jumpPressed: true }));
    expect(lands(fast, makeInput({ forward: 1, jumpHeld: true }), 2)).toEqual([true, true]);
    // Landung ohne Taste → kein Sprung.
    const none = player(FLAT, [0, 0, 0]);
    none.tick(JUMP);
    expect(lands(none, NONE, 1)).toEqual([false]);
    // Langsam mit W + gehaltener Taste: Smart-Hop wartet → false; ohne Bewegungstaste → true.
    const slowW = player(FLAT, [0, 0, 0]);
    slowW.tick(JUMP);
    expect(lands(slowW, makeInput({ forward: 1, jumpHeld: true }), 1)).toEqual([false]);
    const slowStill = player(FLAT, [0, 0, 0]);
    slowStill.tick(JUMP);
    expect(lands(slowStill, makeInput({ jumpHeld: true }), 1)).toEqual([true]);
  });

  it('gehaltene Taste nach Luftphase: knapp unter Lauftempo springt sofort, Kriechtempo wartet', () => {
    // Prüfung 27.09.: mit 0.97 × 320 hing jede Strafe-Landung < 310 u/s bis 0.2 s am Boden.
    const hop = (v: number): { queued: boolean; groundTicks: number } => {
      const pm = player(FLAT, [0, 0, 0], CFG, [0, 0, -v]);
      pm.tick(makeInput({ forward: 1, jumpPressed: true, jumpHeld: true }));
      const held = makeInput({ side: 1, sprint: true, jumpHeld: true });
      let queued = false;
      let landed = false;
      let g = 0;
      for (let t = 0; t < 3 * CFG.tickRate; t++) {
        for (const e of pm.tick(held)) {
          if (e.type === 'land' && !landed) { landed = true; queued = e.jumpQueued; }
          if (e.type === 'jump' && landed) return { queued, groundTicks: g };
        }
        if (landed && pm.state.onGround) g++;
      }
      return { queued, groundTicks: g };
    };
    const fast = hop(280);
    expect(fast.queued).toBe(true);
    expect(fast.groundTicks).toBeLessThanOrEqual(1);
    const slow = hop(150);
    expect(slow.queued).toBe(false);
    expect(slow.groundTicks).toBeGreaterThan(1);
  });
});

describe('Puffer & Coyote', () => {
  /** Landetick eines Sprungs auf FLAT bestimmen (Trockenlauf). */
  function landTick(cfg: MovementConfig): number {
    const pm = player(FLAT, [0, 0, 0], cfg);
    pm.tick(JUMP);
    return ticksUntilLand(pm, NONE, 300);
  }

  it('Jump-Buffer: 0.1 s vor der Landung gedrückt → perfekter Sprung im Landetick', () => {
    const L = landTick(CFG);
    const pm = player(FLAT, [0, 0, 0]);
    const ev: MovementEvent[] = [];
    run(pm, JUMP, 1, ev);
    const pressAt = L - Math.round(0.1 * CFG.tickRate);
    for (let i = 1; i <= L + 2; i++) {
      for (const e of pm.tick(i === pressAt ? makeInput({ jumpPressed: true, jumpHeld: false }) : NONE)) ev.push({ ...e });
    }
    const types = ev.map((e) => e.type);
    const landIdx = types.indexOf('land');
    expect(landIdx).toBeGreaterThan(0);
    expect(types[landIdx + 1]).toBe('jump');
    const j = ev[landIdx + 1];
    expect(j).toMatchObject({ type: 'jump', perfect: true, chain: 2 });
  });

  it('Jump-Buffer: 0.2 s vorher (autoHop aus, Taste gehalten) → kein Sprung', () => {
    const cfg = withMovement(CFG, { autoHop: false });
    const L = landTick(cfg);
    const pm = player(FLAT, [0, 0, 0], cfg);
    const ev: MovementEvent[] = [];
    run(pm, JUMP, 1, ev);
    const pressAt = L - Math.round(0.2 * cfg.tickRate);
    for (let i = 1; i <= L + 20; i++) {
      const input = i === pressAt ? JUMP : i > pressAt ? makeInput({ jumpHeld: true }) : NONE;
      for (const e of pm.tick(input)) ev.push({ ...e });
    }
    expect(ev.filter((e) => e.type === 'jump').length).toBe(1);
    expect(pm.state.onGround).toBe(true);
  });

  function walkOff(): { pm: PlayerMovement; walk: PlayerInput } {
    const lvl = level([box([-512, -64, -200], [512, 0, 512])]);
    const pm = player(lvl, [0, 0, 0]);
    const walk = makeInput({ forward: 1 });
    run(pm, walk, CFG.tickRate / 2);
    let guard = 0;
    while (pm.state.onGround && guard++ < 1000) pm.tick(walk);
    return { pm, walk };
  }

  it('Coyote: 0.08 s nach der Kante → Sprung', () => {
    const { pm, walk } = walkOff();
    run(pm, walk, Math.round(0.08 * CFG.tickRate) - 1);
    const ev = pm.tick({ ...walk, jumpPressed: true, jumpHeld: true });
    const j = ev.find((e) => e.type === 'jump');
    expect(j).toMatchObject({ type: 'jump', coyote: true });
    expect(pm.state.vel.y).toBeGreaterThan(250);
  });

  it('Coyote: 0.2 s nach der Kante → kein Sprung', () => {
    const { pm, walk } = walkOff();
    run(pm, walk, Math.round(0.2 * CFG.tickRate) - 1);
    const ev = pm.tick({ ...walk, jumpPressed: true, jumpHeld: true });
    expect(ev.some((e) => e.type === 'jump')).toBe(false);
    expect(pm.state.vel.y).toBeLessThan(0);
  });
});

describe('Ducken', () => {
  it('Luft-Duck hebt die Füße um 18 u, Auge bleibt in Weltkoordinaten', () => {
    const a = player(FLAT, [0, 0, 0]);
    const b = player(FLAT, [0, 0, 0]);
    a.tick(JUMP);
    b.tick(JUMP);
    run(a, NONE, 20);
    run(b, NONE, 19);
    const eyeBefore = b.state.pos.y + b.state.eyeHeight;
    const ev = b.tick(makeInput({ crouch: true }));
    expect(ev.some((e) => e.type === 'duck' && e.down)).toBe(true);
    expect(b.state.ducked).toBe(true);
    expect(b.state.pos.y - a.state.pos.y).toBeCloseTo(18, 6);
    expect(b.state.pos.y + b.state.eyeHeight).toBeCloseTo(a.state.pos.y + a.state.eyeHeight, 6);
    // Auge bewegt sich nur um die Flugbahn, kein Ruck
    expect(Math.abs(b.state.pos.y + b.state.eyeHeight - eyeBefore)).toBeLessThan(3);
    expect(b.hullMaxs.y).toBe(CFG.hull.duckHeight);
    // Wieder aufstehen in der Luft: Füße runter, Auge bleibt
    const eye2 = b.state.pos.y + b.state.eyeHeight;
    b.tick(NONE);
    a.tick(NONE);
    expect(b.state.ducked).toBe(false);
    expect(b.state.pos.y).toBeCloseTo(a.state.pos.y, 6);
    expect(Math.abs(b.state.pos.y + b.state.eyeHeight - eye2)).toBeLessThan(3);
  });

  it('Boden-Duck: Auge sinkt weich über duckTime, Hull danach geduckt', () => {
    const pm = player(FLAT, [0, 0, 0]);
    const crouch = makeInput({ crouch: true });
    pm.tick(crouch);
    expect(pm.state.eyeHeight).toBeLessThan(CFG.hull.standEye);
    expect(pm.state.eyeHeight).toBeGreaterThan(CFG.hull.standEye - 2);
    run(pm, crouch, Math.ceil(CFG.duckTime * CFG.tickRate));
    expect(pm.state.eyeHeight).toBeCloseTo(CFG.hull.duckEye, 6);
    expect(pm.state.ducked).toBe(true);
    const y = pm.state.pos.y;
    run(pm, NONE, Math.ceil(CFG.duckTime * CFG.tickRate) + 1);
    expect(pm.state.ducked).toBe(false);
    expect(pm.state.eyeHeight).toBeCloseTo(CFG.hull.standEye, 6);
    expect(pm.state.pos.y).toBeCloseTo(y, 6);
  });

  it('Crouch-Jump auch nach langem Vor-Ducken: Füße +18, Welt-Auge ohne Sprung', () => {
    for (const preMs of [160, 250, 500]) {
      const a = player(FLAT, [0, 0, 0]);
      const b = player(FLAT, [0, 0, 0]);
      run(a, makeInput({ crouch: true }), Math.round((preMs / 1000) * CFG.tickRate));
      run(b, NONE, Math.round((preMs / 1000) * CFG.tickRate));
      expect(a.state.ducked).toBe(true);
      const eye = (p: PlayerMovement): number => p.state.pos.y + p.state.eyeHeight;
      const eye0 = eye(a);
      const y0 = b.state.pos.y;
      a.tick(makeInput({ crouch: true, jumpPressed: true, jumpHeld: true }));
      b.tick(JUMP);
      // Im Sprung-Tick: Füße um 18 höher als beim Normalsprung, Auge nur ballistisch bewegt.
      expect(a.state.pos.y - b.state.pos.y).toBeCloseTo(18, 6);
      expect(eye(a) - eye0).toBeCloseTo(b.state.pos.y - y0, 6);
      let feet = 0;
      let prev = eye(a) - eye(b);
      const rate = ((CFG.hull.standEye - CFG.hull.duckEye) / CFG.duckTime) * DT;
      for (let i = 0; i < CFG.tickRate && !b.state.onGround; i++) {
        a.tick(makeInput({ crouch: true }));
        b.tick(NONE);
        if (b.state.onGround) break; // danach bewegt sich nur noch a
        feet = Math.max(feet, a.state.pos.y - y0);
        const d = eye(a) - eye(b);
        // Zusatz-Bewegung gegenüber dem Normalsprung höchstens mit Duck-Rate (kein Ruck).
        expect(Math.abs(d - prev)).toBeLessThanOrEqual(rate + 1e-9);
        prev = d;
      }
      expect(feet).toBeGreaterThanOrEqual(74.5);
    }
  });

  it('Vor-Ducken unter niedriger Decke: kein Hub, nicht im Solid', () => {
    // Decke 60 u: geduckt (54) passt, stehend (72) nicht → kein Platz für +18.
    const lvl = level([box([-512, -64, -1024], [512, 0, 512]), box([-256, 60, -400], [256, 100, 100], 'ceiling')]);
    const pm = player(lvl, [0, 0, 0]);
    run(pm, makeInput({ crouch: true }), CFG.tickRate / 2);
    expect(pm.state.ducked).toBe(true);
    pm.tick(makeInput({ crouch: true, jumpPressed: true, jumpHeld: true }));
    expect(pm.state.pos.y).toBeLessThan(3);
    run(pm, makeInput({ crouch: true }), CFG.tickRate);
    expect(lvl.world.testBox(pm.state.pos, pm.hullMins, pm.hullMaxs)).toBe(false);
  });

  it('Aufstehen unter einer Decke ist blockiert', () => {
    const lvl = level([box([-512, -64, -1024], [512, 0, 512]), box([-256, 60, -400], [256, 100, -100], 'ceiling')]);
    const pm = player(lvl, [0, 0, 0]);
    const crouch = makeInput({ crouch: true });
    run(pm, crouch, CFG.tickRate / 2);
    expect(pm.state.ducked).toBe(true);
    const fwd = makeInput({ crouch: true, forward: 1 });
    for (let i = 0; i < 6 * CFG.tickRate && pm.state.pos.z > -250; i++) pm.tick(fwd);
    expect(pm.state.pos.z).toBeLessThanOrEqual(-250);
    run(pm, NONE, CFG.tickRate / 2);
    expect(pm.state.ducked).toBe(true);
    expect(pm.state.eyeHeight).toBeCloseTo(CFG.hull.duckEye, 6);
    // Raus aus dem Tunnel → steht automatisch auf
    const out = makeInput({ forward: 1 });
    for (let i = 0; i < 6 * CFG.tickRate && pm.state.ducked; i++) pm.tick(out);
    expect(pm.state.ducked).toBe(false);
    expect(pm.state.pos.z).toBeLessThan(-400 + 17);
  });

  it('Stehend passt man nicht unter die Sandbox-Duck-Decke, geduckt schon', () => {
    // duckCeiling: x 300..460, y 60..90, z -240..-160
    const stand = player(SANDBOX, [380, 0, -80]);
    run(stand, makeInput({ forward: 1 }), CFG.tickRate);
    expect(stand.state.pos.z).toBeGreaterThan(-160 + 16 - 0.5);
    const duck = player(SANDBOX, [380, 0, -80]);
    run(duck, makeInput({ crouch: true }), CFG.tickRate / 2);
    for (let i = 0; i < 4 * CFG.tickRate && duck.state.pos.z > -210; i++) duck.tick(makeInput({ crouch: true, forward: 1 }));
    expect(duck.state.pos.z).toBeLessThanOrEqual(-210);
    expect(duck.state.ducked).toBe(true);
  });
});

describe('Surf', () => {
  it('in der Luft an der Surf-Flanke: nicht am Boden, gleitet, gewinnt abwärts Speed', () => {
    // Sandbox-Prisma: rechte Flanke von (-644, 0) nach (-388, -400), Achse z 400..2400.
    // Box-Unterkante knapp über der Flanke (dort y ≈ -169 unter der linken Hull-Kante).
    const pm = player(SANDBOX, [-520, -160, 700], CFG, [0, 0, 300]);
    const ev: MovementEvent[] = [];
    let contactTicks = 0;
    let minSpeed = Infinity;
    const y0 = pm.state.pos.y;
    // Die Flanke ist 400 u hoch: nach ~0.9 s ist man unten raus — bis dahin messen.
    for (let i = 0; i < 110; i++) {
      for (const e of pm.tick(NONE)) ev.push({ ...e });
      expect(pm.state.onGround).toBe(false);
      if (pm.state.surfing) contactTicks++;
      minSpeed = Math.min(minSpeed, pm.state.speed);
    }
    expect(ev.some((e) => e.type === 'surfStart')).toBe(true);
    expect(contactTicks).toBeGreaterThan(80);
    expect(pm.state.surfing).toBe(true);
    expect(pm.state.pos.y).toBeLessThan(y0 - 150);
    expect(pm.state.speed).toBeGreaterThan(400);
    expect(pm.state.vel.z).toBeGreaterThan(299);
    expect(minSpeed).toBeGreaterThan(299);
  });

  it('surfNormal: auf der Surf-Rampe Einheitsvektor mit n.y < 0.7, in freier Luft 0', () => {
    const pm = player(SURF, [200, -250, -200], CFG, [0, 0, -400]);
    const hold = makeInput({ side: -1, yaw: 0 });
    run(pm, hold, CFG.tickRate / 2);
    expect(pm.state.surfing).toBe(true);
    const snap = PlayerMovement.createSnapshot();
    pm.copySnapshot(snap);
    expect(snap.surfNormal.length()).toBeCloseTo(1, 6);
    expect(snap.surfNormal.y).toBeLessThan(0.7);
    expect(snap.surfNormal.y).toBeGreaterThan(0);
    const air = player(FLAT, [0, 500, 0]);
    run(air, NONE, 10);
    air.copySnapshot(snap);
    expect(snap.surfNormal.toArray()).toEqual([0, 0, 0]);
  });

  it('Taste in die Rampe hält auf der Flanke', () => {
    const pm = player(SANDBOX, [-520, -160, 700], CFG, [0, 0, 300]);
    // Blick +z (yaw = π): rechts ist dann -x → D drückt in die Rampe.
    const input = makeInput({ side: 1, yaw: Math.PI });
    run(pm, input, 2 * CFG.tickRate);
    expect(pm.state.surfing).toBe(true);
    expect(pm.state.onGround).toBe(false);
    expect(pm.state.pos.y).toBeGreaterThan(-400);
    expect(pm.state.pos.z).toBeGreaterThan(1200);
  });
});

describe('Robustheit', () => {
  it('Stuck-Schutz: Teleport in eine Wand wird im ersten Tick befreit', () => {
    const lvl = level([box([-512, -64, -512], [512, 0, 512]), box([100, 0, -512], [164, 256, 512], 'wall')]);
    const pm = new PlayerMovement(lvl.world, CFG);
    pm.teleport(new Vector3(95, 0, 0));
    pm.tick(NONE);
    expect(lvl.world.testBox(pm.state.pos, pm.hullMins, pm.hullMaxs)).toBe(false);
  });

  it('Respawn im Duck-Tunnel: geduckt am Ort statt aufs Tunneldach', () => {
    // Sandbox duckCeiling: x 300..460, y 60..90, z -240..-160
    const pm = new PlayerMovement(SANDBOX.world, CFG);
    pm.teleport(new Vector3(380, 0, -200));
    expect(pm.state.ducked).toBe(true);
    expect(pm.state.pos.y).toBeLessThan(1);
    expect(Math.hypot(pm.state.pos.x - 380, pm.state.pos.z + 200)).toBeLessThan(1);
    pm.tick(NONE);
    expect(SANDBOX.world.testBox(pm.state.pos, pm.hullMins, pm.hullMaxs)).toBe(false);
  });

  it('Stuck-Suche ohne Erfolg wird gedrosselt (kein Box-Test-Sturm pro Tick)', () => {
    const lvl = level([box([-4096, -4096, -4096], [4096, 4096, 4096], 'solid')]);
    let calls = 0;
    const world = {
      traceBox: lvl.world.traceBox.bind(lvl.world),
      testBox: (p: Vector3, mins: Vector3, maxs: Vector3): boolean => {
        calls++;
        return lvl.world.testBox(p, mins, maxs);
      },
    };
    const pm = new PlayerMovement(world, CFG);
    pm.teleport(new Vector3(0, 0, 0));
    const perTick: number[] = [];
    for (let i = 0; i < 40; i++) {
      calls = 0;
      pm.tick(NONE);
      perTick.push(calls);
    }
    // Eine volle Suche kostet > 1000 Tests; höchstens alle 16 Ticks eine.
    expect(perTick.filter((c) => c > 100).length).toBeLessThanOrEqual(3);
    expect(Number.isFinite(pm.state.pos.x + pm.state.pos.y + pm.state.pos.z)).toBe(true);
  });

  it('NaN in der Eingabe führt nicht zu NaN im Zustand', () => {
    const pm = player(FLAT, [0, 0, 0]);
    run(pm, makeInput({ forward: Number.NaN, side: Number.POSITIVE_INFINITY, yaw: Number.NaN }), 50);
    expect(Number.isFinite(pm.state.pos.x + pm.state.pos.y + pm.state.pos.z)).toBe(true);
    expect(Number.isFinite(pm.state.vel.x + pm.state.vel.y + pm.state.vel.z)).toBe(true);
  });

  it('maxVelocity kappt pro Achse', () => {
    const lvl = level([box([-64, -64, -64], [64, 0, 64])]);
    const pm = player(lvl, [0, 20000, 0], CFG, [5000, 0, -5000]);
    run(pm, NONE, 20 * CFG.tickRate);
    expect(Math.abs(pm.state.vel.x)).toBeLessThanOrEqual(CFG.maxVelocity);
    expect(Math.abs(pm.state.vel.y)).toBeLessThanOrEqual(CFG.maxVelocity);
    expect(Math.abs(pm.state.vel.z)).toBeLessThanOrEqual(CFG.maxVelocity);
  });

  it('deterministisch: gleiche Eingaben → gleicher Zustand', () => {
    const a = player(SANDBOX, SANDBOX.spawnPos);
    const b = player(SANDBOX, SANDBOX.spawnPos);
    const ba = new StrafeBot(CFG, { sync: 0.8, seed: 5 });
    const bb = new StrafeBot(CFG, { sync: 0.8, seed: 5 });
    for (let i = 0; i < 500; i++) {
      a.tick(ba.next(a.state));
      b.tick(bb.next(b.state));
    }
    expect(a.state.pos.equals(b.state.pos)).toBe(true);
  });

  it('Teleport setzt Kette, Sync, Hull und Surf zurück', () => {
    const pm = player(FLAT, [0, 0, 7000], CFG, [0, 0, -300]);
    const bot = new StrafeBot(CFG, { sync: 1 });
    for (let i = 0; i < 3 * CFG.tickRate; i++) pm.tick(bot.next(pm.state));
    pm.tick(makeInput({ crouch: true }));
    pm.teleport(new Vector3(0, 0, 0));
    expect(pm.state.hopChain).toBe(0);
    expect(pm.state.strafeSync).toBe(0);
    expect(pm.state.ducked).toBe(false);
    expect(pm.state.eyeHeight).toBe(CFG.hull.standEye);
    expect(pm.state.vel.length()).toBe(0);
    expect(pm.state.onGround).toBe(true);
  });

  it('setConfig schaltet live um (Tickrate, Cap)', () => {
    const pm = player(FLAT, [0, 0, 0]);
    run(pm, makeInput({ forward: 1 }), 64);
    pm.setConfig(CS2_CLASSIC);
    expect(pm.config).toBe(CS2_CLASSIC);
    run(pm, makeInput({ forward: 1 }), 64);
    expect(pm.state.speed).toBeCloseTo(250, 0);
  });

  it.each([1, 2, 3, 4])('FUZZ Seed %i: 20k Ticks Zufallseingaben in der Sandbox — nie im Solid, nie NaN', (seed) => {
    const rand = mulberry32(seed * 104729);
    const pm = player(SANDBOX, SANDBOX.spawnPos);
    const world = SANDBOX.world;
    const input = makeInput();
    let hold = 0;
    let yaw = 0;
    const spots: Array<[number, number, number]> = [
      [0, 0, 128], [0, 0, -500], [500, 0, 0], [1300, 64, 0], [-520, 0, 700], [380, 0, -200], [350, 0, 360], [1300, 200, -650],
    ];
    for (let t = 0; t < 20000; t++) {
      if (hold-- <= 0) {
        hold = 1 + Math.floor(rand() * 40);
        input.forward = [-1, 0, 1, 1][Math.floor(rand() * 4)];
        input.side = [-1, 0, 1][Math.floor(rand() * 3)];
        input.crouch = rand() < 0.25;
        input.sprint = rand() < 0.4;
        input.jumpHeld = rand() < 0.5;
        if (rand() < 0.1) yaw = rand() * Math.PI * 2;
      }
      yaw += (rand() - 0.5) * 0.2;
      input.yaw = yaw;
      input.jumpPressed = input.jumpHeld && rand() < 0.2;
      if (rand() < 0.0015 || pm.state.pos.y < SANDBOX.def.killY) {
        const s = spots[Math.floor(rand() * spots.length)];
        const vel: [number, number, number] = [(rand() - 0.5) * 1600, (rand() - 0.5) * 600, (rand() - 0.5) * 1600];
        pm.state.vel.set(...vel);
        pm.teleport(new Vector3(s[0], s[1] + rand() * 40, s[2]), { keepVelocity: true });
      }
      pm.tick(input);
      const p = pm.state.pos;
      const v = pm.state.vel;
      if (!Number.isFinite(p.x + p.y + p.z + v.x + v.y + v.z + pm.state.eyeHeight)) {
        throw new Error(`NaN in Tick ${t}`);
      }
      if (world.testBox(p, pm.hullMins, pm.hullMaxs)) {
        throw new Error(`Hull im Solid in Tick ${t} bei ${p.toArray().join(',')} (ducked ${pm.state.ducked})`);
      }
    }
  });
});

describe('RouteFollower', () => {
  const ROUTE: RouteNode[] = [
    { pos: [0, 0, 100], note: 'anlauf' },
    { pos: [0, 0, -238], jump: true, note: 'kante start' },
    { pos: [0, 0, -622], jump: true, note: 'kante hop0' },
    { pos: [0, 0, -1000], note: 'hop1' },
  ];

  it.each([1.0, 0.8])('fährt die Sandbox-Hop-Reihe bis hop1 (sync %s)', (sync) => {
    const r = runRoute(SANDBOX, CFG, { route: ROUTE, sync, seed: 3, timeout: 20 });
    expect(r.status).toBe('finished');
    expect(r.reached).toBe(ROUTE.length);
    expect(r.nodes.map((n) => n.index)).toEqual([0, 1, 2, 3]);
    expect(r.time).toBeGreaterThan(1);
    expect(r.time).toBeLessThan(10);
  });

  it('meldet Absturz (killY/kill-Trigger) statt endlos zu laufen', () => {
    const r = runRoute(SANDBOX, CFG, { route: [{ pos: [0, 0, -300] }, { pos: [0, 0, -3500] }], timeout: 20 });
    expect(r.status).toBe('failed');
    expect(['fell', 'kill']).toContain(r.reason);
  });

  /**
   * Nachbau des alten Level-2-Surf-Einstiegs (Review): Plattform, Sprung,
   * ~270 u Fall auf eine 60°-Flanke (Aufprall mit ~−650 u/s), Knotenlinie 180 u
   * unter dem First. Der alte Regler (Druck nur "unter der Linie") rutschte hier ab.
   */
  function surfEntryLevel(): CompiledLevel {
    const ax = 1152;
    const z0 = -3076;
    const len = 1024;
    const half = 224;
    const h = half * Math.tan(Math.PI / 3);
    const apexAt = (s: number): number => -48 + (-256 * s) / len;
    const pts: Array<[number, number, number]> = [];
    for (const s of [0, len]) pts.push([ax, apexAt(s), z0 - s], [ax - half, apexAt(s) - h, z0 - s], [ax + half, apexAt(s) - h, z0 - s]);
    const rider = (s: number): [number, number, number] => [ax + 180 / Math.tan(Math.PI / 3) + 16, Math.max(apexAt(Math.max(0, s - 16)), apexAt(Math.min(len, s + 16))) - 178, z0 - s];
    const route: RouteNode[] = [
      { pos: [1280, 0, -2700], note: 'start' },
      { pos: [1280, 0, -2988], jump: true, note: 'Surf-Einstieg' },
      { pos: rider(320), surf: true },
      { pos: rider(700), surf: true },
      { pos: rider(1000), surf: true },
      { pos: [1272, -640, -4500], note: 'Ziel' },
    ];
    return compileLevel({
      ...makeLevel([
        box([1056, -64, -3012], [1504, 0, -2628], 'entry'),
        { type: 'hull', points: pts, mat: 'surf', tag: 'surf1' },
        box([1000, -700, -4800], [1500, -640, -4180], 'catch'),
      ], { spawn: [1280, 0, -2660], killY: -1500 }),
      route,
    });
  }

  it.each([1.0, 0.8])('Surf-Einstieg mit hartem Aufprall: bleibt auf der Flanke und kommt an (sync %s)', (sync) => {
    const r = runRoute(surfEntryLevel(), CFG, { sync, seed: 11, timeout: 20 });
    expect(r.status).toBe('finished');
    expect(r.reached).toBe(6);
    // Auf der Flanke wird er schneller (Speed aus Höhe + Strafe).
    expect(r.nodes[4].speed).toBeGreaterThan(r.nodes[2].speed);
  });

  /**
   * Zwei Rampen mit Drop (wie Level 2): Rampe B beginnt 96 u vor dem Ende von A,
   * 128 u tiefer. Knoten auf A 178 u unter dem First, der letzte vor dem Drop nur
   * 24 u darunter und 100 u nach dem vorigen — so schnell steigt kein Surfer.
   */
  function surfDropLevel(): CompiledLevel {
    const ax = 1152;
    const half = 224;
    const t60 = Math.tan(Math.PI / 3);
    const ramps = [
      { z0: -3076, apex0: -48 },
      { z0: -3076 - 928, apex0: -48 - 232 - 128 },
    ];
    const len = 1024;
    const apexAt = (r: number, s: number): number => ramps[r].apex0 - s / 4;
    const brushes: BrushDef[] = [box([1056, -64, -3012], [1504, 0, -2628], 'entry')];
    ramps.forEach((r, i) => {
      const pts: Array<[number, number, number]> = [];
      for (const s of [0, len]) pts.push([ax, apexAt(i, s), r.z0 - s], [ax - half, apexAt(i, s) - half * t60, r.z0 - s], [ax + half, apexAt(i, s) - half * t60, r.z0 - s]);
      brushes.push({ type: 'hull', points: pts, mat: 'surf', tag: `surf${i}` });
    });
    const rider = (r: number, s: number, depth = 178): [number, number, number] => [
      ax + (depth + 2) / t60 + 16,
      Math.max(apexAt(r, Math.max(0, s - 16)), apexAt(r, Math.min(len, s + 16))) - depth,
      ramps[r].z0 - s,
    ];
    const catchZ = ramps[1].z0 - len - 200;
    const catchY = apexAt(1, len) - 500;
    brushes.push(box([1000, catchY - 60, catchZ - 400], [1500, catchY, catchZ + 200], 'catch'));
    const route: RouteNode[] = [
      { pos: [1280, 0, -2700] },
      { pos: [1280, 0, -2988], jump: true },
      { pos: rider(0, 320), surf: true },
      { pos: rider(0, 800), surf: true },
      { pos: rider(0, 900, 24), surf: true },
      { pos: rider(1, 400), surf: true },
      { pos: rider(1, 900), surf: true },
      { pos: [1272, catchY, catchZ - 150] },
    ];
    return compileLevel({ ...makeLevel(brushes, { spawn: [1280, 0, -2660], killY: -2000 }), route });
  }

  it('Surf-Knoten, den er surfend darunter passiert, überspringt er statt umzudrehen', () => {
    // Ohne diese Regel zählte der Knoten nie (zu tief, zu weit außen): nach dem Drop
    // lag er hinter und über dem Bot, der drehte um und blieb an der Flanke stehen
    // (Level 2, 3°-Hand, E2E-Review). Gegenprobe ohne die Regel: 'stall'.
    const r = runRoute(surfDropLevel(), CFG, { sync: 1, seed: 11, timeout: 20, stallTimeout: 4 });
    expect(r.status).toBe('finished');
    expect(r.reached).toBe(8);
  });

  it.each([1.0, 0.8])('Level 2 (echte Level-JSON) mit sync %s bis ins Ziel', (sync) => {
    const lvl = compileLevel(readLevelFile('public/levels/level2.json'));
    const r = runRoute(lvl, CFG, { sync, seed: 11 });
    expect(r.status).toBe('finished');
    expect(r.touchedFinish).toBe(true);
  });

  it.each([1.0, 0.8])('Level 1 (echte Level-JSON) mit sync %s bis ins Ziel', (sync) => {
    const lvl = compileLevel(readLevelFile('public/levels/level1.json'));
    const r = runRoute(lvl, CFG, { sync, seed: 11 });
    expect(r.status).toBe('finished');
    expect(r.touchedFinish).toBe(true);
  });

  it('Pflichtweg für die 3°-Hand: beide Level bis ins Ziel (Menschenmodell, 6 von 8 Seeds)', () => {
    // Mehrere Seeds statt einem: ein Einzellauf hängt am Zufall der Hand (E2E-Review,
    // Seed-Sweep); der Validator berichtet dieselbe Quote (FULL_RUN_SEEDS).
    for (const file of ['level1', 'level2']) {
      const lvl = compileLevel(readLevelFile(`public/levels/${file}.json`));
      let ok = 0;
      for (let seed = 1; seed <= 8; seed++) if (runRoute(lvl, CFG, { aimNoiseDeg: 3, seed }).touchedFinish) ok++;
      expect(ok, file).toBeGreaterThanOrEqual(6);
    }
  });

  it('Stop-and-Go: Absprungknoten mitten auf der Plattform, zu langsam → läuft zur Kante und springt dort', () => {
    // Plattform A (600 tief), 230 u Lücke, Plattform B. Aus dem Stand fällt ein
    // Sprung vom Knoten 60 u vor der Kante in die Lücke — auch gebremst, zurück
    // auf A reicht es nicht —, ein Sprint-Kantensprung trägt. Ohne Stop-and-Go: Absturz.
    const lvl = compileLevel(
      makeLevel([box([-128, -64, -600], [128, 0, 0], 'a'), box([-128, -64, -1300], [128, 0, -830], 'b')], { spawn: [0, 0, -40], killY: -500 }),
    );
    const route: RouteNode[] = [
      { pos: [0, 0, -40] },
      { pos: [0, 0, -540], jump: true, minSpeed: 250 },
      { pos: [0, 0, -1000] },
    ];
    const r = runRoute(lvl, CFG, { route, sync: 1, seed: 3, timeout: 10 });
    expect(r.status).toBe('finished');
    expect(r.reached).toBe(3);
  });

  it('zählt keine Knoten, die er weit darunter im Fall passiert', () => {
    // Knoten schweben 200 u über dem Boden-Ende: wer darunter vorbeifällt, hat sie nicht erreicht.
    const r = runRoute(SANDBOX, CFG, { route: [{ pos: [0, 0, -300] }, { pos: [0, 200, -700] }, { pos: [0, 200, -1400] }], timeout: 10 });
    expect(r.status).toBe('failed');
    expect(r.reached).toBeLessThanOrEqual(1);
  });

  it('Bhop-Korridor: nach einem jump-Knoten hüpft er durch und wird schneller', () => {
    const r = runRoute(FLAT, CFG, {
      route: [{ pos: [0, 0, -100], jump: true }, { pos: [0, 0, -4000] }],
      sync: 1,
      timeout: 20,
      start: { x: 0, z: 0 },
    });
    expect(r.status).toBe('finished');
    expect(r.nodes[1].speed).toBeGreaterThan(450);
    expect(r.jumps).toBeGreaterThan(5);
  });
});

describe('Interpolation', () => {
  it('lerpSnapshot: pos/eyeHeight/vel linear, Rest vom neueren Snapshot', () => {
    const a = PlayerMovement.createSnapshot();
    const b = PlayerMovement.createSnapshot();
    a.pos.set(0, 0, 0);
    b.pos.set(10, 20, -30);
    a.vel.set(100, 0, 0);
    b.vel.set(200, 0, 0);
    a.eyeHeight = 64;
    b.eyeHeight = 46;
    b.onGround = true;
    b.hopChain = 3;
    b.stridePhase = 0.7;
    const out = PlayerMovement.createSnapshot();
    lerpSnapshot(a, b, 0.25, out);
    expect(out.pos.toArray()).toEqual([2.5, 5, -7.5]);
    expect(out.vel.x).toBe(125);
    expect(out.eyeHeight).toBe(59.5);
    expect(out.onGround).toBe(true);
    expect(out.hopChain).toBe(3);
    expect(out.stridePhase).toBe(0.7);
    lerpSnapshot(a, b, 1, a); // out darf a sein
    expect(a.pos.toArray()).toEqual([10, 20, -30]);
  });

  it('copySnapshot entkoppelt vom Live-Zustand', () => {
    const pm = player(FLAT, [0, 0, 0]);
    const snap = PlayerMovement.createSnapshot();
    pm.copySnapshot(snap);
    const z0 = snap.pos.z;
    run(pm, makeInput({ forward: 1 }), 10);
    expect(snap.pos.z).toBe(z0);
    expect(pm.state.pos.z).toBeLessThan(z0);
    expect(snap.pos).not.toBe(pm.state.pos);
  });
});
