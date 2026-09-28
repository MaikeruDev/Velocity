import { makeFilter, makeGain, makePanner, midiToHz, releaseWhenEnded } from '../dsp';

/** Am9 (A C E G B) in enger Lage um A3 — der klassische Dub-Techno-Akkord. */
export const CHORD_AM9: readonly number[] = [57, 60, 64, 67, 71];
/** Am11-Variante (D statt B) für Abwechslung über Phrasen. */
export const CHORD_AM11: readonly number[] = [57, 60, 62, 67, 72];

const DETUNE_CENTS = 8;

/**
 * Chord-Stab: pro Akkordton zwei Sägezähne (±8 Cent) auf L und R verteilt
 * (Breite wächst mit der Energie). Kurzer Tiefpass-
 * Zupfer, dann ab ins punktierte Achtel-Delay und in den Hall — die Echos
 * machen den Groove, der trockene Stab ist nur der Anstoß.
 */
export class Stabs {
  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly dest: AudioNode,
    private readonly delaySend: AudioNode,
    private readonly hallSend: AudioNode,
  ) {}

  /** `hold`/`tau`: Länge der Hüllkurve — kurz im Groove, lang als Schlussakkord (Outro). */
  hit(t: number, vel: number, chord: readonly number[], width: number, bright: number, hold = 0.05, tau = 0.07): void {
    const ctx = this.ctx;
    const left = makeGain(ctx, 1);
    const right = makeGain(ctx, 1);
    const panL = makePanner(ctx, -width);
    const panR = makePanner(ctx, width);
    const lp = makeFilter(ctx, 'lowpass', 300, 2.5);
    const peakHz = 1400 + 3600 * bright;
    lp.frequency.setValueAtTime(300, t);
    lp.frequency.linearRampToValueAtTime(peakHz, t + 0.006);
    lp.frequency.setTargetAtTime(380, t + 0.006, 0.075 + 0.5 * hold);
    const amp = makeGain(ctx, 0);
    const level = vel / chord.length;
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(level, t + 0.003);
    amp.gain.setValueAtTime(level, t + hold);
    amp.gain.setTargetAtTime(0, t + hold, tau);
    const end = t + hold + tau * 8;

    const oscs: OscillatorNode[] = [];
    for (let i = 0; i < chord.length; i++) {
      const f = midiToHz(chord[i]);
      // Verstimmung pro Akkordton abwechselnd links/rechts: breit, aber keine kohärente Summe auf einer Seite.
      const flip = i % 2 === 0 ? 1 : -1;
      for (const side of [-1, 1] as const) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f;
        o.detune.value = side * DETUNE_CENTS;
        o.connect(side * flip < 0 ? left : right);
        o.start(t);
        o.stop(end);
        oscs.push(o);
      }
    }
    left.connect(panL).connect(lp);
    right.connect(panR).connect(lp);
    lp.connect(amp);
    amp.connect(this.dest);
    const dSend = makeGain(ctx, 0.75);
    const hSend = makeGain(ctx, 0.3);
    amp.connect(dSend).connect(this.delaySend);
    amp.connect(hSend).connect(this.hallSend);
    releaseWhenEnded(oscs, [left, right, panL, panR, lp, amp, dSend, hSend]);
  }
}
