import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileLevel } from '../src/world/level/compileLevel';
import type { CompiledLevel } from '../src/world/level/compileLevel';
import type { LevelFile } from '../src/world/level/LevelFormat';
import { BotRun, recordBotRun } from '../src/engine/replay/botRun';
import { decodeReplayBody, encodeReplayBody, packReplay, unpackReplay, bytesToBase64, base64ToBytes, ReplayFormatError } from '../src/engine/replay/codec';
import type { Replay, ReplayHeader } from '../src/engine/replay/format';
import { BTN_BACK, BTN_FORWARD, InputQuantizer, PHYSICS_VERSION, YAW_UNIT, inputFromQuantized, replayConfig } from '../src/engine/replay/format';
import { configHash, levelHash } from '../src/engine/replay/hash';
import { ReplayRecorder } from '../src/engine/replay/recorder';
import { replayToGhost, verifyReplay } from '../src/engine/replay/verify';
import { movementConfigFor } from '../src/engine/Settings';
import { DEFAULT_SETTINGS } from '../src/engine/settingsTypes';
import { Vector3 } from 'three';
import { PlayerMovement } from '../src/player/PlayerMovement';
import { StrafeBot } from '../src/player/bots';
import { VELOCITY_DEFAULT } from '../src/player/MovementConfig';
import { flatLevel } from '../tools/sim/levels';

/**
 * Plan 009: Replay-Format, Verifier, Ghost aus Replay. Echte Bot-Läufe auf L1–L4 (RouteFollower mit
 * 1° Zielfehler) müssen verifizieren; manipulierte Replays nicht.
 */

const LEVELS = ['level1', 'level2', 'level3', 'level4'];

function loadLevel(id: string): CompiledLevel {
  const dir = join(process.cwd(), 'public', 'levels');
  const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as { id: string; file: string }[];
  const file = index.find((e) => e.id === id)?.file ?? `${id}.json`;
  return compileLevel(JSON.parse(readFileSync(join(dir, file), 'utf8')) as LevelFile);
}

const levels = new Map<string, CompiledLevel>();
const replays = new Map<string, Replay>();

beforeAll(() => {
  for (const id of LEVELS) {
    const lv = loadLevel(id);
    levels.set(id, lv);
    const rep = recordBotRun(lv, { follower: { aimNoiseDeg: 1, seed: 1 } });
    if (!rep) throw new Error(`Bot kam in ${id} nicht ins Ziel`);
    replays.set(id, rep);
  }
});

function get(id: string): { level: CompiledLevel; rep: Replay } {
  const level = levels.get(id);
  const rep = replays.get(id);
  if (!level || !rep) throw new Error(id);
  return { level, rep };
}

function withHeader(rep: Replay, patch: Partial<ReplayHeader>): Replay {
  return { ...rep, header: { ...rep.header, ...patch } };
}

describe('Quantisierung', () => {
  it('apply() == inputFromQuantized(), Yaw-Fehler ≤ halbe Stufe, stetig über 2π hinaus', () => {
    const q = new InputQuantizer();
    const out = { forward: 0, side: 0, jumpHeld: false, jumpPressed: false, crouch: false, sprint: false, yaw: 0, pitch: 0 };
    for (const yaw of [0, 0.1234567, -3.5, 7.1, 100.25, -1234.5678]) {
      const r = q.apply({ forward: 1, side: -1, jumpHeld: false, jumpPressed: true, crouch: true, sprint: false, yaw, pitch: 0.3 });
      expect(r).toEqual(inputFromQuantized(q.buttons, q.yawQ, q.pitchQ, out));
      expect(Math.abs(r.yaw - yaw)).toBeLessThanOrEqual(YAW_UNIT / 2 + 1e-12);
      expect(r.jumpHeld).toBe(true); // Druck ⇒ gehalten
    }
  });

  it('Gefühl: perfekter Strafe-Bot mit quantisiertem Blick verliert nichts Messbares (< 0.1 % nach 20 Hops)', () => {
    const lv = compileLevel(flatLevel(40000));
    const speeds = (quant: boolean): number => {
      const pm = new PlayerMovement(lv.world, VELOCITY_DEFAULT);
      pm.teleport(new Vector3(0, 1, 30000));
      pm.state.vel.set(0, 0, -VELOCITY_DEFAULT.runSpeed);
      const bot = new StrafeBot(VELOCITY_DEFAULT, { sync: 1, seed: 1, heading: 0 });
      const q = new InputQuantizer();
      let hops = 0;
      let last = 0;
      for (let t = 0; t < 128 * 30 && hops < 20; t++) {
        const cmd = bot.next(pm.state);
        for (const e of pm.tick(quant ? q.apply(cmd) : cmd)) if (e.type === 'land') {
          hops++;
          last = e.speed;
        }
      }
      return last;
    };
    const a = speeds(false);
    const b = speeds(true);
    expect(a).toBeGreaterThan(900);
    expect(Math.abs(b - a) / a).toBeLessThan(0.001);
  });
});

describe('Kodierung', () => {
  it('Rumpf: Roundtrip exakt', () => {
    const { rep } = get('level1');
    const back = decodeReplayBody(encodeReplayBody(rep));
    expect(back.header).toEqual(rep.header);
    expect(Array.from(back.buttons)).toEqual(Array.from(rep.buttons));
    expect(Array.from(back.yaw)).toEqual(Array.from(rep.yaw));
    expect(Array.from(back.pitch)).toEqual(Array.from(rep.pitch));
    expect(back.events).toEqual(rep.events);
    expect(Array.from(back.keyframes)).toEqual(Array.from(rep.keyframes));
  });

  it('Container mit deflate: Roundtrip, Base64, kaputte Daten werfen', async () => {
    const { rep } = get('level4');
    const bytes = await packReplay(rep);
    expect(bytes[4] & 1).toBe(1); // komprimiert
    const back = await unpackReplay(base64ToBytes(bytesToBase64(bytes)));
    expect(back.header).toEqual(rep.header);
    expect(Array.from(back.yaw)).toEqual(Array.from(rep.yaw));
    await expect(unpackReplay(bytes.subarray(0, bytes.length - 7))).rejects.toThrow(ReplayFormatError);
    await expect(unpackReplay(new Uint8Array([1, 2, 3, 4, 5, 6]))).rejects.toThrow(ReplayFormatError);
  });

  it('Größe: Bot-Läufe L1–L4 und 60 s Menschen-Maus (144 Hz) < 40 KB', async () => {
    const sizes: string[] = [];
    for (const id of LEVELS) {
      const { rep } = get(id);
      const b = await packReplay(rep);
      const per60 = (b.length / rep.header.ticks) * 60 * rep.header.tickRate;
      sizes.push(`${id} ${b.length} B / ${rep.header.time.toFixed(1)} s`);
      expect(per60).toBeLessThan(40000);
    }
    // Synthetisch: Maus als Zufallsweg pro Frame (144 Hz), Ticks nach Tick-Zeit linear verteilt wie InputState;
    // Tasten wechseln alle ~0.3 s (Strafen), Sprung in Bursts. 60 s.
    const n = 128 * 60;
    const rec = new ReplayRecorder();
    rec.begin({ levelId: 'x', levelHash: '0', configHash: '0', tickRate: 128, settings: { preset: 'velocity', autoHop: true, strafeAssist: true, airControl: true } });
    let seed = 7;
    const rnd = (): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed / 4294967296;
    };
    let rate = 0;
    let yaw = 0;
    let frameStart = 0;
    let frameEnd = 0;
    let nextFrame = 0;
    const q = new InputQuantizer();
    let side = 1;
    for (let i = 0; i < n; i++) {
      const t = (i + 1) / 128;
      while (t > nextFrame) {
        frameStart = frameEnd;
        rate += (rnd() - 0.5) * 2; // rad/s Zufallsweg
        rate *= 0.98;
        frameEnd = frameStart + rate / 144;
        nextFrame += 1 / 144;
      }
      const u = 1 - (nextFrame - t) * 144;
      yaw = frameStart + (frameEnd - frameStart) * u;
      if (rnd() < 1 / 40) side = -side;
      q.apply({ forward: 0, side, jumpHeld: rnd() < 0.8, jumpPressed: rnd() < 0.02, crouch: false, sprint: true, yaw, pitch: Math.sin(i / 300) * 0.2 });
      rec.record(q.buttons, q.yawQ, q.pitchQ);
      rec.after(new Vector3(i, 0, -i));
    }
    const rep = rec.finish(59.5, new Vector3());
    if (!rep) throw new Error('kein Replay');
    const raw = encodeReplayBody(rep).length;
    const packed = (await packReplay(rep)).length;
    sizes.push(`Mensch 60 s: Rumpf ${raw} B, gepackt ${packed} B`);
    expect(packed).toBeLessThan(40000);
    console.log(`Replay-Größen: ${sizes.join(' · ')}`);
  });
});

describe('Verifier', () => {
  it.each(LEVELS)('%s: Bot-Replay gültig, Zeit = Aufnahme, Node deterministisch', async (id) => {
    const { level, rep } = get(id);
    const res = verifyReplay(rep, level);
    expect(res.reason, res.detail ?? '').toBeNull();
    expect(res.valid).toBe(true);
    expect(res.time).toBe(rep.header.time);
    // Nach Packen/Entpacken und ein zweites Mal: identisch.
    const again = verifyReplay(await unpackReplay(await packReplay(rep)), level);
    expect(again).toEqual(res);
  });

  it('Zeit manipuliert → claim', () => {
    const { level, rep } = get('level1');
    const res = verifyReplay(withHeader(rep, { time: rep.header.time - 1 / 128 }), level);
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('claim');
  });

  it('Ticks gekürzt (Ziel abgeschnitten) → noFinish', () => {
    const { level, rep } = get('level2');
    const n = rep.header.ticks - 64;
    const cut: Replay = {
      ...withHeader(rep, { ticks: n, finishTick: n - 1 }),
      buttons: rep.buttons.slice(0, n),
      yaw: rep.yaw.slice(0, n),
      pitch: rep.pitch.slice(0, n),
      keyframes: rep.keyframes.slice(0, Math.floor(n / 128) * 3),
    };
    const res = verifyReplay(cut, level);
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('noFinish');
  });

  it('Ziel-Tick ≠ letzter Tick → ticks', () => {
    const { level, rep } = get('level2');
    expect(verifyReplay(withHeader(rep, { finishTick: rep.header.finishTick - 5 }), level).reason).toBe('ticks');
  });

  it('Eingabe geändert (Yaw ab der Mitte gedreht) → desync/claim/noFinish', () => {
    const { level, rep } = get('level3');
    const yaw = rep.yaw.slice();
    for (let i = Math.floor(yaw.length / 2); i < yaw.length; i++) yaw[i] += 200;
    const res = verifyReplay({ ...rep, yaw }, level);
    expect(res.valid).toBe(false);
    expect(['desync', 'claim', 'noFinish', 'early']).toContain(res.reason);
  });

  it('Eingabe geändert (ein Tick W statt nichts, nach dem letzten Keyframe) → claim oder noFinish', () => {
    const { level, rep } = get('level1');
    const buttons = rep.buttons.slice();
    // Viele Ticks vor dem Ziel: S statt der eigenen Tasten → das Ziel kommt später oder gar nicht.
    for (let i = buttons.length - 120; i < buttons.length; i++) buttons[i] = (buttons[i] & ~BTN_FORWARD) | BTN_BACK;
    const res = verifyReplay({ ...rep, buttons }, level);
    expect(res.valid).toBe(false);
    expect(['claim', 'noFinish', 'desync', 'early', 'input']).toContain(res.reason);
  });

  it('Unmögliche Eingabe (W+S gleichzeitig) → input', () => {
    const { level, rep } = get('level1');
    const buttons = rep.buttons.slice();
    buttons[100] |= BTN_FORWARD | BTN_BACK;
    expect(verifyReplay({ ...rep, buttons }, level).reason).toBe('input');
  });

  it('Falsches Level → level; anderes Level gleicher ID (Hash) → level', () => {
    const { rep } = get('level1');
    expect(verifyReplay(rep, get('level2').level).reason).toBe('level');
    const def = get('level1').level.def;
    expect(verifyReplay(rep, compileLevel({ ...def, killY: def.killY - 1 })).reason).toBe('level');
  });

  it('Settings ohne passenden Config-Hash → config; andere Physik-Version → physics', () => {
    const { level, rep } = get('level1');
    expect(verifyReplay(withHeader(rep, { settings: { ...rep.header.settings, autoHop: false } }), level).reason).toBe('config');
    expect(verifyReplay(withHeader(rep, { physicsVersion: PHYSICS_VERSION + 1 }), level).reason).toBe('physics');
  });

  it('Keyframe manipuliert → desync', () => {
    const { level, rep } = get('level4');
    const keyframes = rep.keyframes.slice();
    keyframes[4] += 1;
    const res = verifyReplay({ ...rep, keyframes }, level);
    expect(res.reason).toBe('desync');
    expect(res.detail).toContain('Tick 255');
  });

  it('Respawn-Ereignis vor CP 1 → events', () => {
    const { level, rep } = get('level1');
    expect(verifyReplay({ ...rep, events: [{ tick: 10, kind: 'respawn' }] }, level).reason).toBe('events');
  });
});

describe('Ghost aus Replay', () => {
  it('Zielzeit und Splits wie der Lauf, Samples im 32-Hz-Raster', () => {
    const { level, rep } = get('level2');
    const g = replayToGhost(rep, level);
    expect(g).not.toBeNull();
    if (!g) return;
    expect(g.time).toBe(rep.header.time);
    expect(g.splits.length).toBe(rep.header.splitTicks.length);
    expect(g.count).toBeGreaterThanOrEqual(Math.floor(g.time * 32));
  });
});

describe('Hashes und Config', () => {
  it('replayConfig == movementConfigFor für alle Schalter-Kombinationen', () => {
    for (const preset of ['velocity', 'cs2'] as const) {
      for (let m = 0; m < 8; m++) {
        const s = { preset, autoHop: (m & 1) !== 0, strafeAssist: (m & 2) !== 0, airControl: (m & 4) !== 0 };
        const fromSettings = movementConfigFor({ ...DEFAULT_SETTINGS, movementPreset: preset, autoHop: s.autoHop, strafeAssist: s.strafeAssist, airControl: s.airControl });
        expect(configHash(replayConfig(s))).toBe(configHash(fromSettings));
      }
    }
  });

  it('Level-Hash stabil je Kompilierung, ändert sich mit der Geometrie', () => {
    const a = get('level3').level;
    expect(levelHash(compileLevel(structuredClone(a.def)))).toBe(levelHash(a));
    // Eine Ebene minimal verschoben (Spawn bleibt): erster Box-Brush 0.001 u breiter.
    const i = a.def.brushes.findIndex((b) => b.type === 'box');
    const brushes = a.def.brushes.map((b, k) => (k === i && b.type === 'box' ? { ...b, max: [b.max[0] + 0.001, b.max[1], b.max[2]] as const } : b));
    expect(i).toBeGreaterThanOrEqual(0);
    expect(levelHash(compileLevel({ ...a.def, brushes }))).not.toBe(levelHash(a));
  });

  it('BotRun schrittweise == am Stück', () => {
    const { level } = get('level1');
    const run = new BotRun(level, { follower: { aimNoiseDeg: 1, seed: 1 } });
    while (run.step(97) === 'running') {
      // Stückweise wie im Mock (Browser gibt zwischendurch ab).
    }
    expect(run.result?.header).toEqual(get('level1').rep.header);
  });
});
