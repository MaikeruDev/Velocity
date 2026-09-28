import type { GameEvent } from '../../engine/events';
import type { HudData } from '../types';

/**
 * Deterministischer Fake-Lauf für die UI-Preview: Anlauf, Bhop-Kette mit
 * Gains (inkl. einem verpatzten Hop), Checkpoints, Surf-Abschnitt, Bremsen,
 * Ziel mit neuer Bestzeit. Gleiche Zeit → gleicher Zustand (für Screenshots).
 */

const HOP_T = 0.755;
const HOP_START = 1.6;
const GAINS = [60, 58, 52, 48, 44, 40, -20, 36, 34, 30, 28, 26, 24, 22];
const SURF_START = HOP_START + GAINS.length * HOP_T; // ≈ 12.17
const SURF_END = SURF_START + 3;
const BRAKE_END = SURF_END + 0.9;
const FINISH_AT = 18;
const RUN_START = 1;
export const FAKE_RUN_LENGTH = 22;

interface Timed {
  readonly at: number;
  readonly e: GameEvent;
}

function hopSpeed(k: number): number {
  let s = 250;
  for (let i = 0; i < k; i++) s += GAINS[i];
  return s;
}

const SURF_TOP = 1120;

function speedAt(t: number): number {
  if (t < RUN_START) return 0;
  if (t < HOP_START) return Math.min(250, ((t - RUN_START) / 0.5) * 250);
  if (t < SURF_START) {
    const k = Math.floor((t - HOP_START) / HOP_T);
    const frac = (t - HOP_START) / HOP_T - k;
    return hopSpeed(k) + GAINS[k] * frac;
  }
  if (t < SURF_END) {
    const u = (t - SURF_START) / (SURF_END - SURF_START);
    return lerp(hopSpeed(GAINS.length), SURF_TOP, 1 - (1 - u) * (1 - u));
  }
  if (t < BRAKE_END) return Math.max(320, SURF_TOP - (t - SURF_END) * 900);
  return 320;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function buildTimeline(): Timed[] {
  const out: Timed[] = [];
  out.push({ at: 0, e: { type: 'levelLoaded', id: 'sandbox', name: 'Sandbox' } });
  out.push({ at: RUN_START, e: { type: 'runStart' } });
  for (let k = 0; k <= GAINS.length; k++) {
    const at = HOP_START + k * HOP_T;
    const gain = k === 0 ? 0 : GAINS[k - 1];
    out.push({
      at,
      e: { type: 'jump', speed: hopSpeed(k), gain, perfect: gain >= 0, chain: k + 1, sync: gain >= 0 ? 0.86 : 0.41, crouched: false, coyote: false },
    });
  }
  out.push({ at: 6.2, e: { type: 'checkpoint', index: 1, total: 3, time: 6.2 - RUN_START, split: -0.42 } });
  out.push({ at: 11.0, e: { type: 'checkpoint', index: 2, total: 3, time: 11.0 - RUN_START, split: 0.31 } });
  out.push({ at: SURF_START, e: { type: 'surfStart' } });
  out.push({ at: SURF_END, e: { type: 'surfEnd' } });
  out.push({ at: 16.4, e: { type: 'checkpoint', index: 3, total: 3, time: 16.4 - RUN_START, split: null } });
  out.push({ at: FINISH_AT, e: { type: 'finish', time: FINISH_AT - RUN_START, best: true, previousBest: 17.84 } });
  // Speed-Meilensteine an den echten Überschreitungen.
  let prev = 0;
  for (let t = 0; t < FAKE_RUN_LENGTH; t += 1 / 240) {
    const s = speedAt(t);
    for (const m of [500, 750, 1000]) if (prev < m && s >= m) out.push({ at: t, e: { type: 'speedMilestone', speed: m } });
    prev = s;
  }
  return out.sort((a, b) => a.at - b.at);
}

const TIMELINE = buildTimeline();

export class FakeRun {
  t = 0;
  private next = 0;
  levelName = 'Sandbox';
  levelSubtitle = 'Testgelände für Entwickler';

  reset(): void {
    this.t = 0;
    this.next = 0;
  }

  /** Zeit vorspulen; gibt alle Ereignisse zurück, die dabei fällig wurden. */
  advance(dt: number): GameEvent[] {
    this.t += dt;
    const fired: GameEvent[] = [];
    while (this.next < TIMELINE.length && TIMELINE[this.next].at <= this.t) {
      fired.push(TIMELINE[this.next].e);
      this.next++;
    }
    return fired;
  }

  data(opts: { paused: boolean; showSpeedometer: boolean; showKeys?: boolean }): HudData {
    const t = this.t;
    const speed = speedAt(t);
    const inBhop = t >= HOP_START && t < SURF_START;
    const hopFrac = inBhop ? (t - HOP_START) / HOP_T - Math.floor((t - HOP_START) / HOP_T) : 0;
    const surfing = t >= SURF_START && t < SURF_END;
    // Landung ≈ ein Frame am Boden (echtes Spiel: ein Boden-Tick pro Hop) — die HUD-Entprellung muss das schlucken.
    const onGround = !surfing && !(inBhop && hopFrac > 0.02);
    const k = inBhop ? Math.floor((t - HOP_START) / HOP_T) : 0;
    const hopChain = inBhop ? k + 1 : surfing ? GAINS.length + 1 : 0;
    const strafeSync = inBhop ? (GAINS[k] < 0 ? 0.41 : 0.78 + 0.1 * Math.sin(k)) : surfing ? 0.9 : 0;
    const runTime = t < RUN_START ? null : Math.min(t, FINISH_AT) - RUN_START;
    const cpIndex = t >= 16.4 ? 3 : t >= 11 ? 2 : t >= 6.2 ? 1 : 0;
    return {
      speed,
      hopChain,
      strafeSync,
      onGround,
      surfing,
      runTime,
      running: t >= RUN_START && t < FINISH_AT,
      checkpoint: { index: cpIndex, total: 3 },
      levelName: this.levelName,
      levelSubtitle: this.levelSubtitle,
      bestTime: 17.84,
      showSpeedometer: opts.showSpeedometer,
      showKeys: opts.showKeys ?? true,
      keys: {
        // Zickzack-Strafe im Bhop: A/D wechseln im Hop-Takt, Maus dreht mit (gut) — jeder 4. Hop dagegen (rot).
        forward: inBhop ? 0 : 1,
        side: inBhop ? (k % 2 === 0 ? -1 : 1) : surfing ? -1 : 0,
        jump: inBhop && hopFrac < 0.1,
        crouch: false,
        turnDeg: inBhop ? (k % 2 === 0 ? 1 : -1) * (k % 4 === 3 ? -140 : 140) : 0,
        inAir: inBhop && !onGround,
        strafe: inBhop && !onGround ? (k % 4 === 3 ? -1 : 1) : 0,
        forwardInAirMs: 0,
      },
      paused: opts.paused,
    };
  }
}
