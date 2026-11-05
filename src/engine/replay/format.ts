import type { MovementConfig, MovementPresetId } from '../../player/MovementConfig';
import { MOVEMENT_PRESETS, withMovement } from '../../player/MovementConfig';
import type { MutablePlayerInput, PlayerInput } from '../../player/types';

/**
 * Replay-Format (Plan 009): die PlayerInput jedes Physik-Ticks, quantisiert. DOM-frei (Node,
 * Cloud Function). Ein Replay ist ein Lauf ab dem Level-Spawn bis ins Ziel; der Verifier spielt
 * ihn mit derselben Physik nach (replay/verify.ts), der Ghost wird daraus abgeleitet (replay/ghost.ts).
 *
 * Quantisierung — die Physik läuft auch LIVE mit den quantisierten Werten (Game.onTick), sonst
 * stimmte das Nachspielen nicht:
 * - Tasten: forward/side nur −1/0/+1 (Tastatur und Bots liefern nichts anderes), als Bits.
 * - Yaw: ganzzahlig in 1/65536 Umdrehung (0.0055°), UNGEWICKELT (q darf beliebig groß/negativ
 *   sein): die Physik sieht exakt q · YAW_UNIT. Gewickelt wäre sin(x + 2πk) nicht bitgleich zu sin(x),
 *   und Coach/Training/Showkeys brauchen den stetigen Blick. Fehler ≤ 0.0028° — 1/16 eines Maus-
 *   Counts bei CS-Sens 2 (0.044°), 0.2 % des Strafe-Fensters bei 1000 u/s (sim: unverändert).
 * - Pitch: 1/16384 von 90° (Physik liest ihn nicht; nur für Ghost/Analyse).
 */

export const REPLAY_FORMAT_VERSION = 1;
/**
 * Version der Physik (PlayerMovement, RunState, Spawn-Logik). Bei JEDER Änderung, die das Ergebnis
 * eines Ticks ändern kann, erhöhen — der Config-Hash sieht nur MovementConfig, nicht den Code. Der
 * Verifier lehnt Replays einer anderen Physik-Version ab (Bestenliste je Version, Plan 009 §6).
 */
export const PHYSICS_VERSION = 1;
/** Spielversion (Anzeige/Diagnose, kein Prüfkriterium). */
export const GAME_VERSION = '0.1.0';

export const YAW_STEPS = 65536;
export const YAW_UNIT = (Math.PI * 2) / YAW_STEPS;
/** Pitch-Raster je 90°. */
export const PITCH_STEPS = 16384;
export const PITCH_UNIT = Math.PI / 2 / PITCH_STEPS;

/** Alle so viele Ticks eine Positions-Probe (Float32) — Desync-Diagnose im Verifier. */
export const KEYFRAME_EVERY = 128;
/** Längster aufnehmbarer Lauf in Ticks (20 min bei 128 Tick). */
export const MAX_REPLAY_TICKS = 20 * 60 * 128;
/** Höchstens so viele Ereignisse (manuelle Respawns) je Replay. */
export const MAX_REPLAY_EVENTS = 4096;
/** Höchstens so viele Checkpoints je Level. */
export const MAX_SPLITS = 64;

// Tasten-Bits eines Ticks.
export const BTN_FORWARD = 1;
export const BTN_BACK = 2;
export const BTN_LEFT = 4;
export const BTN_RIGHT = 8;
export const BTN_JUMP = 16;
export const BTN_JUMP_PRESS = 32;
export const BTN_CROUCH = 64;
export const BTN_SPRINT = 128;

/** Einstellungen, die die Physik beeinflussen (movementConfigFor) — mehr nicht. */
export interface ReplaySettings {
  readonly preset: MovementPresetId;
  readonly autoHop: boolean;
  readonly strafeAssist: boolean;
  readonly airControl: boolean;
}

/** Manueller Respawn (Taste F) VOR dem Tick `tick` — Absturz/Kill-Respawns ergeben sich aus der Physik. */
export interface ReplayEvent {
  readonly tick: number;
  readonly kind: 'respawn';
}

export interface ReplayHeader {
  readonly gameVersion: string;
  readonly physicsVersion: number;
  readonly levelId: string;
  /** levelHash(CompiledLevel) — Ebenen, Trigger, Spawn, killY (replay/hash.ts). */
  readonly levelHash: string;
  /** configHash(MovementConfig) der Config, mit der gespielt wurde. */
  readonly configHash: string;
  readonly tickRate: number;
  readonly settings: ReplaySettings;
  /** Bot oder Eingabe-Override (Debug-Handle) war während der Aufnahme aktiv. */
  readonly assisted: boolean;
  /** Anzahl Ticks. */
  readonly ticks: number;
  /** Behauptete Werte (der Verifier rechnet sie nach): Tick des Timer-Starts, Ziel-Tick, Zeit, Checkpoint-Ticks, Endposition. */
  readonly startTick: number;
  readonly finishTick: number;
  readonly time: number;
  readonly splitTicks: readonly number[];
  readonly endPos: readonly [number, number, number];
}

export interface Replay {
  readonly header: ReplayHeader;
  /** Tasten-Bits je Tick. */
  readonly buttons: Uint8Array;
  /** Yaw je Tick in YAW_UNIT (ganzzahlig, ungewickelt; Float64 für |q| > 2^31). */
  readonly yaw: Float64Array;
  /** Pitch je Tick in PITCH_UNIT (±PITCH_STEPS). */
  readonly pitch: Int16Array;
  readonly events: readonly ReplayEvent[];
  /** Füße (x, y, z als Float32) nach Tick (k+1)·KEYFRAME_EVERY − 1. */
  readonly keyframes: Float32Array;
}

/** Physik-Config eines Replays — dieselbe Regel wie engine/Settings.movementConfigFor (Test hält beide gleich). */
export function replayConfig(s: ReplaySettings): MovementConfig {
  const base = MOVEMENT_PRESETS[s.preset];
  return withMovement(base, { autoHop: s.autoHop, strafeAssist: s.strafeAssist, airControl: s.airControl ? base.airControl : 0 });
}

/** Tasten-Bits → PlayerInput (die einzige Abbildung; live und im Verifier dieselbe). */
export function inputFromQuantized(buttons: number, yawQ: number, pitchQ: number, out: MutablePlayerInput): MutablePlayerInput {
  out.forward = (buttons & BTN_FORWARD ? 1 : 0) - (buttons & BTN_BACK ? 1 : 0);
  out.side = (buttons & BTN_RIGHT ? 1 : 0) - (buttons & BTN_LEFT ? 1 : 0);
  out.jumpHeld = (buttons & BTN_JUMP) !== 0;
  out.jumpPressed = (buttons & BTN_JUMP_PRESS) !== 0;
  out.crouch = (buttons & BTN_CROUCH) !== 0;
  out.sprint = (buttons & BTN_SPRINT) !== 0;
  out.yaw = yawQ * YAW_UNIT;
  out.pitch = pitchQ * PITCH_UNIT;
  return out;
}

/**
 * Quantisiert die Tick-Eingabe (Game.onTick, Bots im Verifier-Werkzeug). Das Ergebnis-Objekt wird
 * wiederverwendet; buttons/yawQ/pitchQ gehören zum letzten apply(). Keine Allokation.
 */
export class InputQuantizer {
  readonly out: MutablePlayerInput = { forward: 0, side: 0, jumpHeld: false, jumpPressed: false, crouch: false, sprint: false, yaw: 0, pitch: 0 };
  buttons = 0;
  yawQ = 0;
  pitchQ = 0;

  apply(cmd: PlayerInput): PlayerInput {
    let b = 0;
    if (cmd.forward > 0) b |= BTN_FORWARD;
    else if (cmd.forward < 0) b |= BTN_BACK;
    if (cmd.side > 0) b |= BTN_RIGHT;
    else if (cmd.side < 0) b |= BTN_LEFT;
    // Ein Druck ist immer auch gehalten (InputState: jumpHeld = gehalten || gedrückt).
    if (cmd.jumpHeld || cmd.jumpPressed) b |= BTN_JUMP;
    if (cmd.jumpPressed) b |= BTN_JUMP_PRESS;
    if (cmd.crouch) b |= BTN_CROUCH;
    if (cmd.sprint) b |= BTN_SPRINT;
    this.buttons = b;
    // Nicht endlich → letzter Wert (wie PlayerMovement.readInput).
    const yq = Math.round(cmd.yaw / YAW_UNIT);
    if (yq - yq === 0) this.yawQ = yq;
    const pq = Math.round(cmd.pitch / PITCH_UNIT);
    this.pitchQ = pq - pq === 0 ? (pq > PITCH_STEPS ? PITCH_STEPS : pq < -PITCH_STEPS ? -PITCH_STEPS : pq) : 0;
    return inputFromQuantized(b, this.yawQ, this.pitchQ, this.out);
  }

  /** Neuer Lauf: Ausgangswerte vergessen. */
  reset(): void {
    this.buttons = 0;
    this.yawQ = 0;
    this.pitchQ = 0;
  }
}

export const PRESET_IDS: readonly MovementPresetId[] = ['velocity', 'cs2'];
