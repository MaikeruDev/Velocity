import { makeFilter, makeGain, makePanner, noiseBurst, percEnvelope, releaseWhenEnded, type Rng } from '../dsp';
import { metallic } from './Ride';

export interface RiserHandle {
  /** Riser vorzeitig beenden (z. B. Layer 4 erreicht → Crash übernimmt). */
  cut(t: number, fade: number): void;
  readonly start: number;
  /** Oben angekommen (volle Lautstärke). */
  readonly end: number;
  /** Ende des Plateaus — danach klingt er aus. */
  readonly until: number;
}

/**
 * Übergangs-Effekte: Riser (Rausch-Sweep), Crash/Impact, Swell vor Fills.
 * Laufen auf den Musikbussen, damit sie im Raum-Filter mitklingen.
 */
export class Fx {
  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly noise: AudioBuffer,
    private readonly rng: Rng,
    private readonly dest: AudioNode,
    private readonly hallSend: AudioNode,
  ) {}

  /**
   * Rausch-Sweep 300 Hz → 9 kHz über `dur`, Pegel steigt mit (s/dur)^curve,
   * hält oben `hold` Sekunden (Spannung, bis der Crash kommt) und klingt dann
   * in `tail` aus, falls kein Crash ihn ablöst.
   */
  riser(t: number, dur: number, vel: number, curve = 1.3, tail = 0.25, hold = 0): RiserHandle {
    const ctx = this.ctx;
    const src = noiseBurst(ctx, this.noise, this.rng, t, dur + hold + tail + 0.05);
    const bp = makeFilter(ctx, 'bandpass', 300, 2.5);
    bp.frequency.setValueAtTime(300, t);
    bp.frequency.exponentialRampToValueAtTime(9000, t + dur);
    bp.Q.setValueAtTime(2.5, t);
    bp.Q.linearRampToValueAtTime(5, t + dur);
    const env = makeGain(ctx, 0);
    // Früh hörbar werden, zum Ende anziehen: der Aufbau soll schon ab der
    // Hälfte tragen (Exponent 2.2 war erst in den letzten ~20 % hörbar).
    // Als Kurve, weil eine Rampe nach setTargetAtTime dieses ersetzen würde.
    const n = 256;
    const total = dur + hold + tail;
    const values = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const s = (i / (n - 1)) * total;
      values[i] = s <= dur ? vel * Math.pow(s / dur, curve) : s <= dur + hold ? vel : vel * Math.max(0, 1 - (s - dur - hold) / tail);
    }
    values[n - 1] = 0;
    env.gain.setValueCurveAtTime(values, t, total);
    const cutGain = makeGain(ctx, 1);
    // Leichte Stereo-Bewegung
    const pan = makePanner(ctx, 0);
    pan.pan.setValueAtTime(-0.4, t);
    pan.pan.linearRampToValueAtTime(0.4, t + dur);
    src.connect(bp).connect(env).connect(cutGain).connect(pan);
    pan.connect(this.dest);
    const send = makeGain(ctx, 0.5);
    pan.connect(send).connect(this.hallSend);
    releaseWhenEnded([src], [bp, env, cutGain, pan, send]);
    return {
      start: t,
      end: t + dur,
      until: t + dur + hold,
      cut: (at: number, fade: number) => {
        cutGain.gain.setTargetAtTime(0, at, fade / 4);
      },
    };
  }

  /** Crash/Impact: Rauschen HP + 808-Metall + tiefer Boom, viel Hall. */
  crash(t: number, vel: number): void {
    const ctx = this.ctx;
    const src = noiseBurst(ctx, this.noise, this.rng, t, 2.6);
    const hp = makeFilter(ctx, 'highpass', 3500, 0);
    const env = makeGain(ctx, 0);
    percEnvelope(env.gain, t, vel * 0.5, 0.002, 0.32);
    const out = makeGain(ctx, 1);
    src.connect(hp).connect(env).connect(out);
    // Metall nur oberhalb 5 kHz — die Grundtöne der Rechtecke wären ein schiefer Akkord.
    // Der Bandpass danach glättet die Flanken-Nadeln, die ein reiner Hochpass aus Rechtecken macht.
    const mHP = makeFilter(ctx, 'highpass', 5000, 0);
    const mBP = makeFilter(ctx, 'bandpass', 7500, 0.6);
    mHP.connect(mBP).connect(out);
    metallic(ctx, mHP, t, vel * 0.6, 1.6, 2.3);
    out.connect(this.dest);
    const send = makeGain(ctx, 0.6);
    out.connect(send).connect(this.hallSend);

    const boom = ctx.createOscillator();
    boom.type = 'sine';
    boom.frequency.setValueAtTime(90, t);
    boom.frequency.exponentialRampToValueAtTime(34, t + 0.5);
    const bEnv = makeGain(ctx, 0);
    const bEnd = percEnvelope(bEnv.gain, t, vel * 0.45, 0.004, 0.14);
    boom.connect(bEnv).connect(this.dest);
    boom.start(t);
    boom.stop(bEnd);
    releaseWhenEnded([src, boom], [hp, env, out, send, bEnv, mHP, mBP]);
  }

  /** Kurzer ansteigender Swell über einen Beat (Kick-Drop-Fill). */
  swell(t: number, dur: number, vel: number): void {
    const ctx = this.ctx;
    const src = noiseBurst(ctx, this.noise, this.rng, t, dur + 0.02);
    const bp = makeFilter(ctx, 'bandpass', 800, 1.5);
    bp.frequency.setValueAtTime(800, t);
    bp.frequency.exponentialRampToValueAtTime(7000, t + dur);
    const env = makeGain(ctx, 0);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(vel, t + dur - 0.005);
    env.gain.linearRampToValueAtTime(0, t + dur);
    src.connect(bp).connect(env).connect(this.dest);
    releaseWhenEnded([src], [bp, env]);
  }
}
