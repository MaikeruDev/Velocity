import type { MusicDrive } from './types';
import { clamp01, smoothstep } from './dsp';

/**
 * Energie = wie "voll" die Musik ist, 0..1. Sie folgt dem Movement mit
 * schnellem Anstieg (Belohnung fühlt sich sofort an) und langem Abklingen
 * (ein verpatzter Hop reißt den Track nicht sofort ein).
 */

export const ENERGY_ATTACK = 0.3;
export const ENERGY_RELEASE = 2.5;

/**
 * Formel B (Plan 003, an den Aufzeichnungen geprüft): Speed allein bringt
 * höchstens 0.72, gesättigt schon bei 800 u/s (dort, wo Menschen hinkommen).
 * Der Rest ist Flow: Chain-Länge progressiv, aber nur mit Vortrieb — wer gegen
 * eine Wand hüpft (24 u/s), bekommt nichts.
 */
const SPEED_SHARE = 0.72;
const CHAIN_SHARE = 0.26;
const SYNC_BONUS = 0.07;
const SURF_BONUS = 0.15;

/**
 * Untere Schwellen der Layer 0..4 (Energie). Laufen 250 = L1, Auto-Hop mit
 * Chain 10 = L2 (Clap), ab ~450 u/s mit Chain L3, Bhop 600 + Chain + Sync = L4.
 */
export const LAYER_THRESHOLDS: readonly number[] = [0, 0.04, 0.25, 0.55, 0.86];

/**
 * Hysterese nach unten je Layer: ein Layer bleibt, solange die Energie nicht
 * deutlich unter seine Schwelle fällt. L1 kleiner als seine Schwelle, sonst
 * käme man im Stand nie zurück auf L0.
 */
export const LAYER_HYSTERESIS: readonly number[] = [0, 0.02, 0.05, 0.05, 0.05];

export const MAX_LAYER = 4;

/** Ziel-Energie aus dem Drive — ohne Glättung. */
export function targetEnergy(d: MusicDrive): number {
  // Gamma < 1 hebt den Bhop-Bereich an: 400–700 u/s soll hörbar Wirkung zeigen.
  let e = SPEED_SHARE * Math.pow(smoothstep(150, 800, d.speed), 0.75);
  const moving = smoothstep(150, 260, d.speed);
  e += CHAIN_SHARE * smoothstep(1, 10, d.hopChain) * moving;
  if (d.strafeSync > 0.7) e += SYNC_BONUS * moving;
  if (d.surfing) e += SURF_BONUS;
  return clamp01(e);
}

/** Höchster Layer, dessen Schwelle `e` erreicht. */
export function layerForEnergy(e: number): number {
  let l = 0;
  for (let i = 1; i <= MAX_LAYER; i++) if (e >= LAYER_THRESHOLDS[i]) l = i;
  return l;
}

/** Höchster Layer, den `e` mit Hysterese noch hält (für den Abstieg). */
export function layerToHold(e: number): number {
  let l = 0;
  for (let i = 1; i <= MAX_LAYER; i++) if (e >= LAYER_THRESHOLDS[i] - LAYER_HYSTERESIS[i]) l = i;
  return l;
}

export class EnergyModel {
  /** Geglättete Energie. */
  value = 0;
  /** Letzte Ziel-Energie. */
  target = 0;
  active = true;
  /**
   * Höchste geglättete Energie seit dem letzten takePeak() (Latch für den
   * Layer-Aufstieg): Die Musik tastet nur auf Beats ab — ein kurzer Gipfel
   * zwischen zwei Beats ging sonst verloren (Schwellen-Rennen).
   */
  private peak = 0;

  step(d: MusicDrive, dt: number): void {
    this.active = d.active;
    // Im Menü friert die Energie ein: nach der Pause geht es genau dort weiter.
    if (!d.active) return;
    this.target = targetEnergy(d);
    const tau = this.target > this.value ? ENERGY_ATTACK : ENERGY_RELEASE;
    const h = Math.min(Math.max(dt, 0), 0.25);
    this.value += (this.target - this.value) * (1 - Math.exp(-h / tau));
    if (this.value > this.peak) this.peak = this.value;
  }

  /** Sofort auf das Ziel springen (Offline-Messung im eingeschwungenen Zustand). */
  settle(d: MusicDrive): void {
    this.active = d.active;
    this.target = targetEnergy(d);
    this.value = this.target;
    this.peak = this.value;
  }

  /** Höchstwert seit dem letzten Aufruf (mindestens der aktuelle Wert); setzt den Latch zurück. */
  takePeak(): number {
    const p = Math.max(this.peak, this.value);
    this.peak = this.value;
    return p;
  }
}
