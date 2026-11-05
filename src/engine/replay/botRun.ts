import type { RouteFollowerOptions } from '../../player/bots';
import { RouteFollower } from '../../player/bots';
import type { CompiledLevel } from '../../world/level/compileLevel';
import type { Replay, ReplaySettings } from './format';
import { InputQuantizer, replayConfig } from './format';
import { configHash, levelHash } from './hash';
import { ReplayRecorder } from './recorder';
import { RunSimulator } from './runSim';

/**
 * Bot-Lauf als Replay (Plan 009): RouteFollower fährt das Level wie im Spiel (RunSimulator,
 * quantisierte Eingaben, ReplayRecorder) — Testdaten für den Verifier und "Rivalen" der Mock-
 * Bestenliste. Schrittweise (step), damit der Mock im Browser zwischendurch abgeben kann.
 * Ein Tod beendet den Versuch (der Bot fände nach einem Checkpoint-Respawn seinen Knoten nicht wieder).
 */

export type BotRunStatus = 'running' | 'finished' | 'failed';

export interface BotRunOptions {
  readonly settings?: ReplaySettings;
  readonly follower?: RouteFollowerOptions;
  /** Längste Laufzeit (s). */
  readonly timeout?: number;
}

export const DEFAULT_REPLAY_SETTINGS: ReplaySettings = { preset: 'velocity', autoHop: true, strafeAssist: true, airControl: true };

export class BotRun {
  readonly sim: RunSimulator;
  private readonly bot: RouteFollower;
  private readonly q = new InputQuantizer();
  private readonly rec = new ReplayRecorder();
  private readonly maxTicks: number;
  private tick = 0;
  private state: BotRunStatus = 'running';
  private replay: Replay | null = null;

  constructor(level: CompiledLevel, opts: BotRunOptions = {}) {
    const settings = opts.settings ?? DEFAULT_REPLAY_SETTINGS;
    const cfg = replayConfig(settings);
    const route = level.def.route ?? [];
    if (route.length === 0) throw new Error(`Level ${level.def.id} hat keine Route`);
    this.sim = new RunSimulator(level, cfg);
    this.bot = new RouteFollower(route, cfg, {
      killY: level.def.killY,
      world: level.world,
      start: { x: level.spawnPos.x, z: level.spawnPos.z },
      stallTimeout: 12,
      ...opts.follower,
    });
    this.maxTicks = Math.ceil((opts.timeout ?? 180) * cfg.tickRate);
    this.sim.start();
    this.rec.begin({ levelId: level.def.id, levelHash: levelHash(level), configHash: configHash(cfg), tickRate: cfg.tickRate, settings });
    this.rec.markAssisted();
  }

  get status(): BotRunStatus {
    return this.state;
  }

  /** Bis zu `ticks` Ticks fahren. */
  step(ticks: number): BotRunStatus {
    const sim = this.sim;
    const m = sim.movement;
    for (let k = 0; k < ticks && this.state === 'running'; k++) {
      const cmd = this.q.apply(this.bot.next(m.state, m.surfNormal));
      this.rec.record(this.q.buttons, this.q.yawQ, this.q.pitchQ);
      const out = sim.step(cmd);
      for (const e of sim.runEvents) {
        if (e.type === 'runStart') this.rec.markStart();
        else if (e.type === 'checkpoint') this.rec.markSplit();
      }
      this.rec.after(m.state.pos);
      this.tick++;
      if (out === 'finish') {
        this.replay = this.rec.finish(sim.run.time ?? 0, m.state.pos);
        this.state = this.replay ? 'finished' : 'failed';
      } else if (sim.respawned || this.bot.status === 'failed' || this.tick >= this.maxTicks) {
        this.rec.stop();
        this.state = 'failed';
      }
    }
    return this.state;
  }

  /** Replay nach 'finished', sonst null. */
  get result(): Replay | null {
    return this.replay;
  }
}

/** Ganzer Bot-Lauf am Stück (Node, Tests). null = nicht ins Ziel gekommen. */
export function recordBotRun(level: CompiledLevel, opts: BotRunOptions = {}): Replay | null {
  const run = new BotRun(level, opts);
  while (run.step(4096) === 'running') {
    // weiter
  }
  return run.result;
}
