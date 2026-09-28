import { makeFilter, makeGain, makePanner, midiToHz, noiseBurst, percEnvelope, releaseWhenEnded, type Rng } from '../dsp';

/**
 * Percussion ab Layer 2: gestimmte Conga/Tom (Sinus mit kurzem Pitch-Fall,
 * in A-Moll gestimmt) und ein trockener Rim (Dreieck + Rauschklick).
 * Gibt dem Groove Mitten zwischen Kick und Hats.
 */
export class Perc {
  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly noise: AudioBuffer,
    private readonly rng: Rng,
    private readonly dest: AudioNode,
    private readonly verbSend: AudioNode,
  ) {}

  conga(t: number, midi: number, vel: number, pan: number): void {
    const ctx = this.ctx;
    const f = midiToHz(midi);
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(f * 1.6, t);
    osc.frequency.exponentialRampToValueAtTime(f, t + 0.014);
    const env = makeGain(ctx, 0);
    const end = percEnvelope(env.gain, t, vel, 0.001, 0.055);
    const p = makePanner(ctx, pan);
    osc.connect(env).connect(p).connect(this.dest);
    const send = makeGain(ctx, 0.25);
    p.connect(send).connect(this.verbSend);
    osc.start(t);
    osc.stop(end);

    // Fellanschlag
    const click = noiseBurst(ctx, this.noise, this.rng, t, 0.02);
    const bp = makeFilter(ctx, 'bandpass', 2800, 1.2);
    const cg = makeGain(ctx, 0);
    percEnvelope(cg.gain, t, vel * 0.3, 0.0005, 0.003);
    click.connect(bp).connect(cg).connect(p);
    releaseWhenEnded([osc, click], [env, p, send, bp, cg]);
  }

  rim(t: number, vel: number, pan: number): void {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = 1680;
    const env = makeGain(ctx, 0);
    const end = percEnvelope(env.gain, t, vel * 0.8, 0.0005, 0.011);
    const p = makePanner(ctx, pan);
    const bp = makeFilter(ctx, 'bandpass', 1700, 2);
    osc.connect(bp).connect(env).connect(p).connect(this.dest);
    osc.start(t);
    osc.stop(end);
    const click = noiseBurst(ctx, this.noise, this.rng, t, 0.02);
    const hp = makeFilter(ctx, 'bandpass', 3800, 1.5);
    const cg = makeGain(ctx, 0);
    percEnvelope(cg.gain, t, vel * 0.5, 0.0003, 0.004);
    click.connect(hp).connect(cg).connect(p);
    const send = makeGain(ctx, 0.35);
    p.connect(send).connect(this.verbSend);
    releaseWhenEnded([osc, click], [env, p, bp, hp, cg, send]);
  }
}
