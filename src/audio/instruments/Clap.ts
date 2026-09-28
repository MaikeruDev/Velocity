import { makeFilter, makeGain, makePanner, noiseBurst, releaseWhenEnded, type Rng } from '../dsp';

const BURST_GAP = 0.01;
const TAIL_START = 0.021;
const TAIL_TAU = 0.042;
const LENGTH = 0.36;
const CURVE_RATE = 4000;

/**
 * 909-artiger Clap: Rauschen durch BP ~1.2 kHz, drei kurze Stöße im
 * 10-ms-Abstand (mehrere Hände) und ein ~150 ms langer Schwanz, kräftig in
 * den Hall. Die Hüllkurve ist vorab als Kurve berechnet (setValueCurveAtTime),
 * weil sich die Stöße mit Rampen nicht sauber aneinanderreihen lassen.
 */
export class Clap {
  private readonly input: GainNode;
  private readonly curve: Float32Array<ArrayBuffer>;

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly noise: AudioBuffer,
    private readonly rng: Rng,
    dest: AudioNode,
    hallSend: AudioNode,
  ) {
    this.input = makeGain(ctx, 1);
    const bp = makeFilter(ctx, 'bandpass', 1200, 1.0);
    const hp = makeFilter(ctx, 'highpass', 450, 0);
    const out = makeGain(ctx, 1);
    const pan = makePanner(ctx, -0.04);
    this.input.connect(hp).connect(bp).connect(out);
    out.connect(pan).connect(dest);
    const send = makeGain(ctx, 0.55);
    out.connect(send).connect(hallSend);

    const n = Math.round(LENGTH * CURVE_RATE);
    this.curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const s = i / CURVE_RATE;
      let v = 0;
      for (let b = 0; b < 3; b++) {
        const tb = s - b * BURST_GAP;
        if (tb >= 0) v = Math.max(v, Math.min(1, tb / 0.0006) * Math.exp(-tb / 0.0032) * (1 - b * 0.12));
      }
      const tt = s - TAIL_START;
      if (tt >= 0) v = Math.max(v, 0.78 * Math.min(1, tt / 0.001) * Math.exp(-tt / TAIL_TAU));
      // Letzte 20 ms auf 0 ausblenden: Kurvenende muss exakt 0 sein.
      v *= Math.min(1, (LENGTH - s) / 0.02);
      this.curve[i] = v;
    }
    this.curve[n - 1] = 0;
  }

  /** `tone` > 1 = heller/höher (Fill-Rolls steigen an). */
  trigger(t: number, vel: number, tone = 1): void {
    const ctx = this.ctx;
    const src = noiseBurst(ctx, this.noise, this.rng, t, LENGTH + 0.01);
    const env = makeGain(ctx, 0);
    const scaled = new Float32Array(this.curve.length);
    for (let i = 0; i < scaled.length; i++) scaled[i] = this.curve[i] * vel;
    env.gain.setValueCurveAtTime(scaled, t, LENGTH);
    if (tone !== 1) {
      // Eigener Filter pro Schlag nur für Fills, damit der Bus-BP unangetastet bleibt.
      const tbp = makeFilter(ctx, 'peaking', 1200 * tone, 1.2);
      tbp.gain.value = 5;
      src.connect(tbp).connect(env).connect(this.input);
      releaseWhenEnded([src], [env, tbp]);
    } else {
      src.connect(env).connect(this.input);
      releaseWhenEnded([src], [env]);
    }
  }
}
