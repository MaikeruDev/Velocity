import type { Vector3 } from 'three';
import type { Replay, ReplayEvent, ReplaySettings } from './format';
import { GAME_VERSION, KEYFRAME_EVERY, MAX_REPLAY_EVENTS, MAX_REPLAY_TICKS, MAX_SPLITS, PHYSICS_VERSION } from './format';

/**
 * Nimmt einen Lauf als Replay auf (Plan 009). Puffer einmal angelegt — im Tick-Pfad (record, after,
 * Marken) entsteht kein Objekt. finish() baut das Replay (allokiert, nur im Ziel).
 *
 * Ablauf in Game (ohne Lektion): begin() nach jedem Absetzen am Level-Spawn mit frischem RunState
 * (Levelstart, R, Tod/F vor CP 1) → je Tick record() VOR movement.tick, after() nach runTick →
 * respawn() bei Taste F (ab CP 1) → markStart/markSplit aus den Run-Events → finish() im Ziel.
 * Was den Lauf außerhalb der Eingaben verändert (Config-Wechsel, Teleport/Geschwindigkeit per
 * Debug-Handle), macht die Aufnahme ungültig: invalidate(grund).
 */

export interface ReplayMeta {
  readonly levelId: string;
  readonly levelHash: string;
  readonly configHash: string;
  readonly tickRate: number;
  readonly settings: ReplaySettings;
}

const MAX_KEYFRAMES = Math.floor(MAX_REPLAY_TICKS / KEYFRAME_EVERY) + 1;

export class ReplayRecorder {
  private readonly buttons = new Uint8Array(MAX_REPLAY_TICKS);
  private readonly yaw = new Float64Array(MAX_REPLAY_TICKS);
  private readonly pitch = new Int16Array(MAX_REPLAY_TICKS);
  private readonly keyframes = new Float32Array(MAX_KEYFRAMES * 3);
  private readonly eventTicks = new Int32Array(MAX_REPLAY_EVENTS);
  private readonly splitTicks = new Int32Array(MAX_SPLITS);
  private n = 0;
  private events = 0;
  private splits = 0;
  private startTick = -1;
  private meta: ReplayMeta | null = null;
  private active = false;
  private assisted = false;
  private invalidReason: string | null = null;

  /** Läuft eine Aufnahme (begin ohne finish/stop)? */
  get recording(): boolean {
    return this.active;
  }

  get ticks(): number {
    return this.n;
  }

  /** Grund, warum die laufende Aufnahme nicht einreichbar ist (null = gültig). */
  get invalid(): string | null {
    return this.invalidReason;
  }

  begin(meta: ReplayMeta): void {
    this.meta = meta;
    this.n = 0;
    this.events = 0;
    this.splits = 0;
    this.startTick = -1;
    this.active = true;
    this.assisted = false;
    this.invalidReason = null;
  }

  stop(): void {
    this.active = false;
  }

  invalidate(reason: string): void {
    if (this.active && this.invalidReason === null) this.invalidReason = reason;
  }

  /** Bot/Override hat diesen Tick gesteuert. */
  markAssisted(): void {
    this.assisted = true;
  }

  /** Eingabe des nächsten Ticks (quantisiert, InputQuantizer). */
  record(buttons: number, yawQ: number, pitchQ: number): void {
    if (!this.active) return;
    const i = this.n;
    if (i >= MAX_REPLAY_TICKS) {
      this.invalidate('zu lang');
      return;
    }
    this.buttons[i] = buttons;
    this.yaw[i] = yawQ;
    this.pitch[i] = pitchQ;
    this.n = i + 1;
  }

  /** Nach dem Tick (inkl. Respawn): Positions-Probe alle KEYFRAME_EVERY Ticks. */
  after(pos: Vector3): void {
    if (!this.active || this.n === 0 || this.n % KEYFRAME_EVERY !== 0) return;
    const k = (this.n / KEYFRAME_EVERY - 1) * 3;
    this.keyframes[k] = pos.x;
    this.keyframes[k + 1] = pos.y;
    this.keyframes[k + 2] = pos.z;
  }

  /** Taste F ab CP 1: Respawn vor dem nächsten Tick. */
  respawn(): void {
    if (!this.active) return;
    if (this.events >= MAX_REPLAY_EVENTS) {
      this.invalidate('zu viele Respawns');
      return;
    }
    this.eventTicks[this.events++] = this.n;
  }

  /** 'runStart' im zuletzt aufgenommenen Tick (auch ein Neustart nach Fehlstart). */
  markStart(): void {
    if (!this.active) return;
    this.startTick = this.n - 1;
    this.splits = 0;
  }

  /** 'checkpoint' im zuletzt aufgenommenen Tick. */
  markSplit(): void {
    if (!this.active || this.splits >= MAX_SPLITS) return;
    this.splitTicks[this.splits++] = this.n - 1;
  }

  /**
   * Ziel im zuletzt aufgenommenen Tick: fertiges Replay (allokiert). Die Aufnahme endet. null =
   * nichts aufgenommen (begin fehlt); ein ungültiger Lauf kommt trotzdem zurück — `invalid` sagt warum.
   */
  finish(time: number, endPos: Vector3): Replay | null {
    const meta = this.meta;
    const n = this.n;
    this.active = false;
    if (!meta || n === 0) return null;
    const events: ReplayEvent[] = [];
    for (let k = 0; k < this.events; k++) events.push({ tick: this.eventTicks[k], kind: 'respawn' });
    const kf = Math.floor(n / KEYFRAME_EVERY);
    return {
      header: {
        gameVersion: GAME_VERSION,
        physicsVersion: PHYSICS_VERSION,
        levelId: meta.levelId,
        levelHash: meta.levelHash,
        configHash: meta.configHash,
        tickRate: meta.tickRate,
        settings: meta.settings,
        assisted: this.assisted,
        ticks: n,
        startTick: this.startTick,
        finishTick: n - 1,
        time,
        splitTicks: Array.from(this.splitTicks.subarray(0, this.splits)),
        endPos: [Math.fround(endPos.x), Math.fround(endPos.y), Math.fround(endPos.z)],
      },
      buttons: this.buttons.slice(0, n),
      yaw: this.yaw.slice(0, n),
      pitch: this.pitch.slice(0, n),
      events,
      keyframes: this.keyframes.slice(0, kf * 3),
    };
  }
}
