import { haasPair, makeFilter, makeGain, noiseBurst, percEnvelope, releaseWhenEnded, type Rng } from '../dsp';

/** Abklingen einer offenen Hat, wenn die nächste geschlossene sie abwürgt (909-Choke). */
const CHOKE_TAU = 0.006;

/**
 * Hi-Hats aus Rauschen: HP 7 kHz → BP ~10 kHz (breit). Closed 30–50 ms,
 * Open 200–300 ms. Filter liegen auf einem gemeinsamen Bus, pro Schlag nur
 * Quelle + Hüllkurve — billig genug für 16tel. Shaker hat eigenen, tieferen
 * Bandpass und einen weicheren Einsatz (Groove statt Kontur).
 *
 * Wie bei der 909 würgt die nächste geschlossene Hat eine offene ab — sonst
 * verschmiert der Offbeat in die folgenden 16tel und der Groove wird waschig.
 * Aufrufe kommen zeitlich aufsteigend (Sequencer), daher genügt die letzte offene.
 */
export class Hats {
  private readonly hatIn: GainNode;
  private readonly shakerIn: GainNode;
  private openEnv: GainNode | null = null;
  private openUntil = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly noise: AudioBuffer,
    private readonly rng: Rng,
    dest: AudioNode,
    verbSend: AudioNode,
  ) {
    this.hatIn = makeGain(ctx, 1);
    const hp = makeFilter(ctx, 'highpass', 7000, 0);
    const bp = makeFilter(ctx, 'bandpass', 10000, 0.8);
    // Etwas Rauschen am BP vorbei hält den Körper, der BP gibt den "tss"-Glanz.
    const body = makeGain(ctx, 0.45);
    const shine = makeGain(ctx, 1.3);
    // −2 dB: auf kleinen Lautsprechern (Laptop, HP ~200 Hz) blieben sonst vor allem Hats übrig.
    const out = makeGain(ctx, 0.8);
    this.hatIn.connect(hp);
    hp.connect(bp).connect(shine).connect(out);
    hp.connect(body).connect(out);
    // Breit statt Mono-Höhen (Kopfhörer!): links führt, rechts 10 ms später. 0.72 ≈ −3 dB gleicht die zwei Wege aus.
    haasPair(ctx, out, dest, -0.5, 0.01, 0.72);
    const verb = makeGain(ctx, 0.25);
    out.connect(verb).connect(verbSend);

    this.shakerIn = makeGain(ctx, 1);
    const sBP = makeFilter(ctx, 'bandpass', 5800, 1.6);
    const sHP = makeFilter(ctx, 'highpass', 3000, 0);
    this.shakerIn.connect(sHP).connect(sBP);
    // Shaker spiegelbildlich zu den Hats: rechts führt.
    haasPair(ctx, sBP, dest, 0.5, 0.012, 0.72);
  }

  /** `decay` = hörbare Länge in s (30–50 ms). */
  closed(t: number, vel: number, decay: number): void {
    const open = this.openEnv;
    if (open !== null && t < this.openUntil) open.gain.setTargetAtTime(0, t, CHOKE_TAU);
    this.openEnv = null;
    this.hit(this.hatIn, t, vel, 0.0008, decay / 3.5);
  }

  /** Offene Hat, 200–300 ms (sofern keine geschlossene sie vorher abwürgt). */
  open(t: number, vel: number, decay: number): void {
    const tau = decay / 3.2;
    this.openEnv = this.hit(this.hatIn, t, vel, 0.004, tau);
    this.openUntil = t + 0.004 + tau * 8;
  }

  shaker(t: number, vel: number): void {
    // Weicher Einsatz (8 ms): klingt nach geschütteltem Korn statt nach Metall.
    this.hit(this.shakerIn, t, vel, 0.009, 0.022);
  }

  private hit(dest: AudioNode, t: number, vel: number, attack: number, tau: number): GainNode {
    const ctx = this.ctx;
    const len = attack + tau * 8;
    const src = noiseBurst(ctx, this.noise, this.rng, t, len + 0.01);
    const env = makeGain(ctx, 0);
    percEnvelope(env.gain, t, vel, attack, tau);
    src.connect(env).connect(dest);
    releaseWhenEnded([src], [env]);
    return env;
  }
}
