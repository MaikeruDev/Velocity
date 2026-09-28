import type { GameEvent } from '../../engine/events';
import type { GloveId } from '../../engine/settingsTypes';
import { VM_JOINT } from '../../render/types';
import { approach, bell, clamp, fin } from './anim';

/**
 * Skin-Effekte der View-Hand (Plan 007) → ViewModelFrame.skinFx (0..1) und Gelenk-Zusätze. Die
 * Bedeutung von skinFx hängt am Skin; der Renderer setzt sie um (render/viewmodel/skins):
 * - gold:     Funkeln an den Knöcheln bei verlustfreiem Hop (jump.clean, lobt wie Kamera und Landewelle,
 *             movement.md §6) — 1 beim Hop, klingt in 0.25 s auf 0 ab,
 * - robot:    Helligkeit des LED-Bands mit dem Tempo (weich; den Kick-Puls addiert der Renderer),
 * - cat:      Krallen: in Ruhe halb draußen (0.3), raus (τ 0.05 s) bei gutem Hop ab Flow-Tempo, Meilenstein,
 *             Checkpoint, Ziel, Trainings-Stufe (1.5 s bzw. bis zur Landung), rein bei der Landung (τ 0.12 s),
 * - skeleton: Klappern (Stärke): harte Landung → 1, klingt in 0.3 s ab; ab 1000 u/s in der Luft leichtes Flattern.
 * Gelenk-Zusätze (applyJoints, NUR auf den Frame, nie auf den Überblend-Zustand): Skelett-Finger zittern
 * ±3° mit 25 Hz × Klappern; die Katze "tretelt" ohne Gegenstand in Ruhe alle 6–9 s für 1.6 s
 * (Zeige+Ring gegen Mittel+Klein im Wechsel). Alles Funktion der Zeit → framerate-unabhängig.
 * motionFx 0: keine Bewegungs-Reaktionen (kein Funkeln, kein Klappern/Treteln, Krallen ruhig halb draußen);
 * die LED ist Licht, keine Bewegung. Tick-Pfad (onEvent) setzt nur Zahlen, keine Allokation.
 */

const SPARKLE_TIME = 0.25;
const LED_FROM = 250;
const LED_FULL = 1000;
const LED_TAU = 0.25;
/** Katze: Krallen in Ruhe halb draußen (Lead-Entscheid), raus/rein. */
export const CLAW_REST = 0.3;
const CLAW_OUT_TAU = 0.05;
const CLAW_IN_TAU = 0.12;
const CLAW_HOLD = 1.5;
const CLAW_HOP_SPEED = 500;
/** Skelett: harte Landung ab impact/550 ≥ 0.9, Abklingen 0.3 s; Flattern ab 1000 u/s in der Luft. */
const RATTLE_FROM = 0.9;
const RATTLE_TIME = 0.3;
const FLUTTER = 0.22;
const FLUTTER_SPEED = 1000;
export const RATTLE_DEG = 3;
const RATTLE_HZ = 25;
/** Katze: Treteln — Pause 6–9 s, Dauer 1.6 s, 2.5 Tritte/s, Beugung 28°. */
const KNEAD_TIME = 1.6;
const KNEAD_HZ = 2.5;
const KNEAD_DEG = 28;
const DEG = Math.PI / 180;

/** Zustand der Hand für die Skin-Effekte (ViewHand füllt es pro Frame). */
export interface SkinFxInput {
  readonly speed: number;
  readonly onGround: boolean;
  readonly surfing: boolean;
}

export class SkinFx {
  value = 0;
  private sparkle = 0;
  private led = 0;
  private claw = CLAW_REST;
  private clawHold = 0;
  /** Die Krallen kamen vom Hop (Landung zieht sie ein), nicht von Checkpoint/Ziel. */
  private clawFromHop = false;
  private clawIn = false;
  private rattle = 0;
  private flutter = 0;
  private t = 0;
  private kneadWait = 6.5;
  private kneadT = -1;
  private seed = 5;

  reset(): void {
    this.sparkle = 0;
    this.led = 0;
    this.claw = CLAW_REST;
    this.clawHold = 0;
    this.clawIn = false;
    this.rattle = 0;
    this.flutter = 0;
    this.kneadT = -1;
    this.kneadWait = 6.5;
    this.value = 0;
  }

  onEvent(e: GameEvent, glove: GloveId, motionFx: number): void {
    const moving = motionFx > 0;
    switch (e.type) {
      case 'jump':
        if (!moving) break;
        if (glove === 'gold' && e.clean && e.gain > 0) this.sparkle = 1;
        if (glove === 'cat' && e.clean && e.gain > 0 && e.speed >= CLAW_HOP_SPEED) this.clawsOut(true);
        break;
      case 'speedMilestone':
      case 'checkpoint':
      case 'finish':
      case 'lessonStage':
        if (moving && glove === 'cat') this.clawsOut(e.type === 'speedMilestone');
        break;
      case 'land':
        if (glove === 'cat' && this.clawFromHop) {
          this.clawHold = 0;
          this.clawIn = true;
        }
        if (moving && glove === 'skeleton' && clamp(fin(e.impact) / 550, 0, 2) >= RATTLE_FROM) this.rattle = 1;
        break;
      case 'respawn':
      case 'levelLoaded':
        this.sparkle = 0;
        this.clawHold = 0;
        this.rattle = 0;
        this.kneadT = -1;
        break;
      default:
        break;
    }
  }

  private clawsOut(fromHop: boolean): void {
    this.clawHold = CLAW_HOLD;
    this.clawFromHop = fromHop;
    this.clawIn = false;
  }

  /** `idle` = Stand am Boden ohne Gegenstand und ohne Posen-Wunsch (Treteln der Katze). */
  update(dt: number, glove: GloveId, inp: SkinFxInput, idle: boolean, motionFx: number): void {
    if (!(dt > 0)) return;
    this.t += dt;
    const moving = motionFx > 0;
    const speed = Math.max(0, fin(inp.speed));
    this.sparkle = moving ? Math.max(0, this.sparkle - dt / SPARKLE_TIME) : 0;
    const target = clamp((speed - LED_FROM) / (LED_FULL - LED_FROM), 0, 1);
    this.led = approach(this.led, target, LED_TAU, dt);
    this.updateCat(dt, moving);
    this.updateBones(dt, moving, speed, !inp.onGround && !inp.surfing);
    this.updateKnead(dt, glove === 'cat' && idle && moving && speed < 30 && inp.onGround && !inp.surfing);
    this.value = glove === 'gold' ? this.sparkle : glove === 'robot' ? this.led : glove === 'cat' ? this.claw : glove === 'skeleton' ? Math.max(this.rattle, this.flutter) : 0;
  }

  private updateCat(dt: number, moving: boolean): void {
    if (!moving) {
      this.claw = CLAW_REST;
      this.clawHold = 0;
      return;
    }
    this.clawHold = Math.max(0, this.clawHold - dt);
    const out = this.clawHold > 0 && !this.clawIn;
    this.claw = approach(this.claw, out ? 1 : CLAW_REST, out ? CLAW_OUT_TAU : CLAW_IN_TAU, dt);
  }

  private updateBones(dt: number, moving: boolean, speed: number, air: boolean): void {
    this.rattle = moving ? Math.max(0, this.rattle - dt / RATTLE_TIME) : 0;
    this.flutter = approach(this.flutter, moving && air && speed >= FLUTTER_SPEED ? FLUTTER : 0, 0.15, dt);
  }

  private updateKnead(dt: number, allowed: boolean): void {
    if (this.kneadT >= 0) {
      this.kneadT += dt;
      if (this.kneadT >= KNEAD_TIME || !allowed) {
        this.kneadT = -1;
        this.kneadWait = 6 + 3 * this.rand();
      }
      return;
    }
    if (!allowed) {
      this.kneadWait = Math.max(this.kneadWait, 2);
      return;
    }
    this.kneadWait -= dt;
    if (this.kneadWait <= 0) this.kneadT = 0;
  }

  /** Läuft gerade das Treteln (Tools/Tests)? */
  get kneading(): boolean {
    return this.kneadT >= 0;
  }

  /**
   * Gelenk-Zusätze auf die Frame-Gelenke (nach dem Überblenden, nie auf den Zustand): Skelett zittert,
   * Katze tretelt. Keine Allokation.
   */
  applyJoints(glove: GloveId, joints: Float32Array): void {
    if (glove === 'skeleton') {
      const a = Math.max(this.rattle, this.flutter);
      if (a <= 0.001) return;
      const w = Math.PI * 2 * RATTLE_HZ * this.t;
      for (let f = 0; f < 4; f++) {
        const b = VM_JOINT.finger + f * 4;
        joints[b + 2] += RATTLE_DEG * DEG * a * Math.sin(w + f * 1.7);
        joints[b + 3] += RATTLE_DEG * DEG * a * Math.sin(w * 1.13 + f * 2.3);
      }
      joints[VM_JOINT.thumbIp] += RATTLE_DEG * DEG * a * Math.sin(w * 0.93 + 0.4);
    } else if (glove === 'cat' && this.kneadT >= 0) {
      // Zeige + Ring gegen Mittel + Klein im Wechsel, weich ein- und ausgeblendet.
      const env = bell(this.kneadT / KNEAD_TIME) * 1.6;
      const s = Math.sin(Math.PI * 2 * KNEAD_HZ * this.kneadT);
      const a = KNEAD_DEG * DEG * Math.min(1, env) * Math.max(0, s);
      const b = KNEAD_DEG * DEG * Math.min(1, env) * Math.max(0, -s);
      for (let f = 0; f < 4; f++) {
        const k = VM_JOINT.finger + f * 4;
        const v = f === 0 || f === 2 ? a : b;
        joints[k + 1] += v;
        joints[k + 2] += v * 0.9;
        joints[k + 3] += v * 0.5;
      }
    }
  }

  private rand(): number {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }
}
