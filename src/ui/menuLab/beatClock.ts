import type { FrontDoorBeat } from './types';

/** Was das Menü von der Audio-Engine braucht (AudioApi erfüllt das; main.ts reicht sie durch). */
export interface MenuAudio {
  readonly unlocked: boolean;
  unlock(): Promise<void>;
  beat(): {
    readonly bpm: number;
    readonly beat: number;
    readonly beatPhase: number;
    readonly barPhase: number;
    readonly kick: number;
    readonly energy: number;
  };
}

/** BPM des Tracks (audio/Music.BPM) — hier dupliziert, damit das Menü kein Audio-Modul importiert (Test hält beide gleich). */
export const FALLBACK_BPM = 132;
/** Abfall der Ersatz-Kick (s), wie die echte Hüllkurve (~150 ms). */
const FALLBACK_KICK_DECAY = 0.15;
const FALLBACK_ENERGY = 0.35;

type MutableBeat = { -readonly [K in keyof FrontDoorBeat]: FrontDoorBeat[K] };

/**
 * Takt für Front Doors: echte Musik, wenn der AudioContext läuft, sonst eine deterministische Uhr
 * (132 BPM ab nowMs = 0). Ein Objekt, pro Aufruf überschrieben — keine Allokation im rAF.
 */
export class BeatClock {
  private readonly out: MutableBeat = { bpm: FALLBACK_BPM, beat: 0, phase: 0, bar: 0, barPhase: 0, kick: 0, energy: FALLBACK_ENERGY, live: false };
  audio: MenuAudio | null = null;

  read(nowMs: number): FrontDoorBeat {
    const o = this.out;
    const a = this.audio;
    if (a !== null && a.unlocked) {
      const b = a.beat();
      o.bpm = b.bpm;
      o.beat = b.beat;
      o.phase = b.beatPhase;
      o.bar = Math.floor(b.beat / 4);
      o.barPhase = b.barPhase;
      o.kick = b.kick;
      o.energy = b.energy;
      o.live = true;
      return o;
    }
    const beatDur = 60 / FALLBACK_BPM;
    const beats = Math.max(0, nowMs / 1000 / beatDur);
    const phase = beats - Math.floor(beats);
    const bars = beats / 4;
    o.bpm = FALLBACK_BPM;
    o.beat = beats;
    o.phase = phase;
    o.bar = Math.floor(bars);
    o.barPhase = bars - Math.floor(bars);
    o.kick = Math.exp(-(phase * beatDur) / FALLBACK_KICK_DECAY);
    o.energy = FALLBACK_ENERGY;
    o.live = false;
    return o;
  }
}
