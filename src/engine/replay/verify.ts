import { Vector3 } from 'three';
import type { MutablePlayerInput } from '../../player/types';
import type { CompiledLevel } from '../../world/level/compileLevel';
import { GhostRecorder, levelSignature } from '../Ghost';
import type { GhostTrack } from '../Ghost';
import type { Replay } from './format';
import {
  BTN_BACK,
  BTN_FORWARD,
  BTN_JUMP,
  BTN_JUMP_PRESS,
  BTN_LEFT,
  BTN_RIGHT,
  KEYFRAME_EVERY,
  MAX_REPLAY_TICKS,
  PHYSICS_VERSION,
  PITCH_STEPS,
  YAW_STEPS,
  inputFromQuantized,
  replayConfig,
} from './format';
import { configHash, levelHash } from './hash';
import { RunSimulator } from './runSim';

/**
 * Verifier (Plan 009 §4): spielt ein Replay gegen das kompilierte Level nach und rechnet Zeit,
 * Checkpoints und Ziel selbst aus. DOM-frei, Node-tauglich — dieselbe Datei läuft später in der
 * Cloud Function. Der Client behauptet nur (Kopf: Zeit, Ticks, Endposition); gezählt wird, was hier
 * herauskommt.
 *
 * Geprüft wird in dieser Reihenfolge (erster Fehler gewinnt, `reason` ist ein stabiler Code):
 *  physics   Physik-Version passt nicht            level    falsches Level / Level-Hash
 *  config    Config-Hash ≠ Config aus den Settings tickrate Tickrate passt nicht zur Config
 *  ticks     Tickzahl außerhalb / Ziel-Tick ≠ letzter Tick
 *  input     unmögliche Eingabe (W+S, A+D, Druck ohne Halten, Pitch > 90°, Yaw-Sprung > 180°/Tick)
 *  events    Respawn-Ereignisse außerhalb/unsortiert oder vor CP 1
 *  desync    Positions-Probe weicht ab (anderer Client-Code/Engine — Tick im detail)
 *  early     Ziel vor dem Replay-Ende        noFinish  Ziel nicht erreicht
 *  claim     behauptete Zeit/Start/Splits/Endposition ≠ nachgerechnet
 */

export type VerifyReason = 'physics' | 'level' | 'config' | 'tickrate' | 'ticks' | 'input' | 'events' | 'desync' | 'early' | 'noFinish' | 'claim';

export interface VerifyResult {
  readonly valid: boolean;
  /** Nachgerechnete Laufzeit (RunState-Uhr), null ohne Ziel. */
  readonly time: number | null;
  readonly reason: VerifyReason | null;
  /** Lesbare Einzelheit zum Grund (Tick, Werte). */
  readonly detail: string | null;
  readonly ticks: number;
  /** Nachgerechnete Checkpoint-Zeiten (s). */
  readonly splits: readonly number[];
  /** Füße im Ziel-Tick. */
  readonly endPos: readonly [number, number, number] | null;
}

export interface VerifyOptions {
  /** Erwartete Level-ID (z. B. aus dem Upload-Pfad). */
  readonly levelId?: string;
}

function fail(reason: VerifyReason, detail: string, ticks: number): VerifyResult {
  return { valid: false, time: null, reason, detail, ticks, splits: [], endPos: null };
}

/** Statische Prüfungen (ohne Simulation). null = ok. */
export function checkReplay(rep: Replay, level: CompiledLevel, opts: VerifyOptions = {}): VerifyResult | null {
  const h = rep.header;
  const n = h.ticks;
  if (h.physicsVersion !== PHYSICS_VERSION) return fail('physics', `Physik ${h.physicsVersion}, Server ${PHYSICS_VERSION}`, n);
  if (h.levelId !== level.def.id || (opts.levelId !== undefined && opts.levelId !== h.levelId)) return fail('level', `Level ${h.levelId}`, n);
  const lh = levelHash(level);
  if (h.levelHash !== lh) return fail('level', `Level-Hash ${h.levelHash} ≠ ${lh}`, n);
  const cfg = replayConfig(h.settings);
  const ch = configHash(cfg);
  if (h.configHash !== ch) return fail('config', `Config-Hash ${h.configHash} ≠ ${ch} (Tuning-Panel?)`, n);
  if (h.tickRate !== cfg.tickRate) return fail('tickrate', `Tickrate ${h.tickRate} ≠ ${cfg.tickRate}`, n);
  if (!(n >= 1 && n <= MAX_REPLAY_TICKS) || rep.buttons.length !== n || rep.yaw.length !== n || rep.pitch.length !== n) return fail('ticks', `Tickzahl ${n}`, n);
  if (h.finishTick !== n - 1) return fail('ticks', `Ziel-Tick ${h.finishTick}, letzter Tick ${n - 1}`, n);
  if (rep.keyframes.length !== Math.floor(n / KEYFRAME_EVERY) * 3) return fail('ticks', 'Keyframe-Anzahl', n);
  for (let i = 0; i < n; i++) {
    const b = rep.buttons[i];
    if ((b & BTN_FORWARD && b & BTN_BACK) || (b & BTN_LEFT && b & BTN_RIGHT)) return fail('input', `Tick ${i}: Gegentasten gleichzeitig`, n);
    if (b & BTN_JUMP_PRESS && !(b & BTN_JUMP)) return fail('input', `Tick ${i}: Sprung gedrückt, aber nicht gehalten`, n);
    const p = rep.pitch[i];
    if (p > PITCH_STEPS || p < -PITCH_STEPS) return fail('input', `Tick ${i}: Pitch ${p}`, n);
    const y = rep.yaw[i];
    if (!Number.isSafeInteger(y)) return fail('input', `Tick ${i}: Yaw ${y}`, n);
    if (i > 0 && Math.abs(y - rep.yaw[i - 1]) > YAW_STEPS / 2) return fail('input', `Tick ${i}: Yaw-Sprung ${y - rep.yaw[i - 1]}`, n);
  }
  let prev = 0;
  for (const e of rep.events) {
    if (e.tick < 1 || e.tick >= n || e.tick < prev) return fail('events', `Respawn bei Tick ${e.tick}`, n);
    prev = e.tick;
  }
  return null;
}

/** Ergebnis der reinen Nachfahrt (ohne Prüfungen) — Verifier und Ghost teilen sie. */
interface Playback {
  readonly sim: RunSimulator;
  /** Ziel-Tick (−1 = keins), Start-Tick, Checkpoint-Ticks. */
  finishTick: number;
  startTick: number;
  readonly splitTicks: number[];
  /** Erster Fehler unterwegs (Desync, Respawn vor CP 1). */
  error: { reason: VerifyReason; detail: string } | null;
}

/**
 * Replay nachfahren. onTick bekommt nach jedem Tick (inkl. Respawn) den Simulator — Ghost-Aufnahme.
 * Stoppt am Ziel oder am ersten Fehler.
 */
function play(rep: Replay, level: CompiledLevel, checkKeyframes: boolean, onTick?: (sim: RunSimulator, cmdYaw: number, started: boolean) => void): Playback {
  const h = rep.header;
  const sim = new RunSimulator(level, replayConfig(h.settings));
  const pb: Playback = { sim, finishTick: -1, startTick: -1, splitTicks: [], error: null };
  const cmd: MutablePlayerInput = { forward: 0, side: 0, jumpHeld: false, jumpPressed: false, crouch: false, sprint: false, yaw: 0, pitch: 0 };
  sim.start();
  let ev = 0;
  const n = h.ticks;
  for (let i = 0; i < n; i++) {
    while (ev < rep.events.length && rep.events[ev].tick === i) {
      // Game nimmt ab einem Tod/F vor CP 1 neu auf — ein Respawn-Ereignis vor CP 1 gibt es nicht.
      if (sim.run.checkpoint === 0) {
        pb.error = { reason: 'events', detail: `Respawn vor CP 1 bei Tick ${i}` };
        return pb;
      }
      sim.manualRespawn();
      ev++;
    }
    inputFromQuantized(rep.buttons[i], rep.yaw[i], rep.pitch[i], cmd);
    const out = sim.step(cmd);
    const evs = sim.runEvents;
    let started = false;
    for (let k = 0; k < evs.length; k++) {
      const e = evs[k];
      if (e.type === 'runStart') {
        pb.startTick = i;
        pb.splitTicks.length = 0;
        started = true;
      } else if (e.type === 'checkpoint') pb.splitTicks.push(i);
    }
    // Ein Tod vor CP 1 setzt den Lauf zurück (Game nähme ab hier neu auf) — der Replay geht trotzdem weiter.
    if (sim.respawned && sim.run.checkpoint === 0) {
      pb.startTick = -1;
      pb.splitTicks.length = 0;
    }
    onTick?.(sim, cmd.yaw, started);
    if (checkKeyframes && (i + 1) % KEYFRAME_EVERY === 0) {
      const k = ((i + 1) / KEYFRAME_EVERY - 1) * 3;
      const p = sim.movement.state.pos;
      if (Math.fround(p.x) !== rep.keyframes[k] || Math.fround(p.y) !== rep.keyframes[k + 1] || Math.fround(p.z) !== rep.keyframes[k + 2]) {
        pb.error = {
          reason: 'desync',
          detail: `Tick ${i}: (${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${p.z.toFixed(3)}) ≠ (${rep.keyframes[k].toFixed(3)}, ${rep.keyframes[k + 1].toFixed(3)}, ${rep.keyframes[k + 2].toFixed(3)})`,
        };
        return pb;
      }
    }
    if (out === 'finish') {
      pb.finishTick = i;
      return pb;
    }
  }
  return pb;
}

/** Replay gegen das Level prüfen und nachrechnen. Synchron; ~0.1 s je Minute Lauf. */
export function verifyReplay(rep: Replay, level: CompiledLevel, opts: VerifyOptions = {}): VerifyResult {
  const bad = checkReplay(rep, level, opts);
  if (bad) return bad;
  const h = rep.header;
  const n = h.ticks;
  const pb = play(rep, level, true);
  if (pb.error) return fail(pb.error.reason, pb.error.detail, n);
  if (pb.finishTick < 0) return fail('noFinish', 'Ziel nicht erreicht', n);
  if (pb.finishTick !== n - 1) return fail('early', `Ziel bei Tick ${pb.finishTick}, Replay bis ${n - 1}`, n);
  const run = pb.sim.run;
  const time = run.time;
  if (time === null) return fail('noFinish', 'Timer lief nicht', n);
  // Zeit = Ticks zwischen Start und Ziel × dt (1/128 und 1/64 summieren exakt).
  if (pb.startTick < 0 || (pb.finishTick - pb.startTick) / h.tickRate !== time) return fail('claim', `Zeit ${time} passt nicht zu Start-Tick ${pb.startTick}`, n);
  if (!Object.is(h.time, time)) return fail('claim', `Zeit behauptet ${h.time}, nachgerechnet ${time}`, n);
  if (h.startTick !== pb.startTick) return fail('claim', `Start-Tick behauptet ${h.startTick}, nachgerechnet ${pb.startTick}`, n);
  if (h.splitTicks.length !== pb.splitTicks.length || h.splitTicks.some((t, i) => t !== pb.splitTicks[i])) {
    return fail('claim', `Checkpoints behauptet [${h.splitTicks.join(',')}], nachgerechnet [${pb.splitTicks.join(',')}]`, n);
  }
  const p = pb.sim.movement.state.pos;
  const endPos: [number, number, number] = [Math.fround(p.x), Math.fround(p.y), Math.fround(p.z)];
  if (endPos[0] !== h.endPos[0] || endPos[1] !== h.endPos[1] || endPos[2] !== h.endPos[2]) return fail('claim', `Endposition ${endPos.join(',')} ≠ ${h.endPos.join(',')}`, n);
  return { valid: true, time, reason: null, detail: null, ticks: n, splits: run.splits(), endPos };
}

/**
 * Ghost aus einem Replay (Plan 009 §5): nachfahren und wie Game aufnehmen (32 Hz ab 'runStart', Ziel-
 * Sample). Ohne Prüfungen — vorher verifyReplay. null = kein Ziel / zu kurz.
 */
export function replayToGhost(rep: Replay, level: CompiledLevel): GhostTrack | null {
  const rec = new GhostRecorder();
  const pos = new Vector3();
  let lastYaw = 0;
  const pb = play(rep, level, false, (sim, yaw, started) => {
    lastYaw = yaw;
    if (started) rec.reset();
    const run = sim.run;
    if (run.running) rec.sample(run.time ?? 0, sim.movement.state.pos, yaw);
    else if (sim.respawned && run.checkpoint === 0) rec.stop();
  });
  if (pb.finishTick < 0) return null;
  const run = pb.sim.run;
  const time = run.time ?? 0;
  pos.copy(pb.sim.movement.state.pos);
  rec.sample(time, pos, lastYaw);
  return rec.finish(levelSignature(level.def), time, run.splits());
}
