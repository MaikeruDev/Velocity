import { haasPair, makeFilter, makeGain, percEnvelope, releaseWhenEnded } from '../dsp';

/** Die sechs Rechteck-Oszillatoren der TR-808-Becken (Hz) — inharmonisch, daher metallisch. */
const METAL_808 = [205.3, 304.4, 369.6, 522.7, 540, 800] as const;

/**
 * Ride im 808-Stil: sechs inharmonische Rechtecke → HP 6 kHz → BP ~8.5 kHz.
 * Die Obertöne der Rechtecke oberhalb des HP ergeben das dichte, nicht-tonale
 * Metallspektrum. Die Rechteckbank läuft dauerhaft (wie in der 808), pro
 * Schlag wird nur die Hüllkurve eines VCA neu gestartet — sonst kosteten
 * Offbeat-Achtel sechs neue Oszillatoren pro Schlag.
 */
export class Ride {
  private readonly vca: GainNode;

  constructor(ctx: BaseAudioContext, dest: AudioNode, verbSend: AudioNode, startAt: number) {
    const bank = makeGain(ctx, 1 / METAL_808.length);
    for (const f of METAL_808) {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = f;
      o.connect(bank);
      o.start(startAt);
    }
    this.vca = makeGain(ctx, 0);
    const hp = makeFilter(ctx, 'highpass', 6000, 0);
    const bp = makeFilter(ctx, 'bandpass', 8500, 0.9);
    const out = makeGain(ctx, 1);
    bank.connect(this.vca).connect(hp).connect(bp).connect(out);
    // Rechts führt, links 8.5 ms später: das Metall liegt breit über dem Mix statt als Punkt rechts.
    haasPair(ctx, out, dest, 0.5, 0.0085, 0.72);
    const verb = makeGain(ctx, 0.3);
    out.connect(verb).connect(verbSend);
  }

  /**
   * Neuer Schlag: die Hüllkurve startet vom aktuellen Wert neu (weicher
   * Retrigger, kein Knacks). Aufrufe kommen zeitlich aufsteigend (Sequencer).
   */
  trigger(t: number, vel: number, decay = 0.9): void {
    const g = this.vca.gain;
    g.setTargetAtTime(vel, t, 0.0006);
    g.setTargetAtTime(0, t + 0.004, decay / 5);
  }
}

/** Sechs Rechtecke pro Schlag mit eigener Hüllkurve — für seltene Einzelschläge (Crash-Glanz). */
export function metallic(ctx: BaseAudioContext, dest: AudioNode, t: number, vel: number, decay: number, pitch: number): void {
  const env = makeGain(ctx, 0);
  // Stopp bei −56 dB statt −70: unter dem Mix unhörbar, spart Oszillator-Laufzeit.
  const tau = decay / 5;
  const end = percEnvelope(env.gain, t, vel / METAL_808.length, 0.001, tau) - tau * 1.5;
  const oscs: OscillatorNode[] = [];
  for (const f of METAL_808) {
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = f * pitch;
    o.connect(env);
    o.start(t);
    o.stop(end);
    oscs.push(o);
  }
  env.connect(dest);
  releaseWhenEnded(oscs, [env]);
}
