import { makeFilter, makeGain, makeShaper, noiseBurst, releaseWhenEnded, tanhCurve, type Rng } from '../dsp';

/**
 * Reserve der Sättigungskurve: Drive bis ~2.1 × Velocity 0.95 + Klick ergibt
 * Eingänge bis ~2.5. Die Kurve deckt ±3 ab (Eingang vorher ÷ 3), sonst hielte
 * der WaveShaper jenseits ±1 den Endwert — tanh würde zum harten Clipper.
 */
const SHAPER_RANGE = 3;

/**
 * Techno-Kick: Sinus mit exponentiellem Pitch-Fall 160 → 48 Hz (~90 ms),
 * 2 ms Attack, kurzer Hold, dann ~350 ms Abklingen. Dazu ein 3-ms-Klick
 * (Rauschen, HP 3 kHz) für die Kontur. Die Summe läuft durch tanh-Sättigung
 * (Punch, Obertöne für kleine Lautsprecher) und LP 8 kHz gegen Zischeln.
 */
export class Kick {
  private readonly input: GainNode;
  private readonly drive: GainNode;
  private readonly makeup: GainNode;
  private readonly dry: GainNode;

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly noise: AudioBuffer,
    private readonly rng: Rng,
    dest: AudioNode,
    rumbleSend: AudioNode,
  ) {
    this.input = makeGain(ctx, 1);
    this.drive = makeGain(ctx, 1.4 / SHAPER_RANGE);
    // 2x: bei vollem Drive wird die Welle fast eckig — ohne Oversampling spiegeln die Obertöne zurück.
    const shaper = makeShaper(ctx, tanhCurve(1.6, 4097, SHAPER_RANGE), '2x');
    const lp = makeFilter(ctx, 'lowpass', 8000, -1);
    // "Knock": der Punch-Bereich über dem Sub — das, was von der Kick auf Laptop-Lautsprechern bleibt.
    const knock = makeFilter(ctx, 'peaking', 220, 1.2);
    knock.gain.value = 3;
    this.makeup = makeGain(ctx, 0.4);
    this.input.connect(this.drive).connect(shaper).connect(knock).connect(lp).connect(this.makeup);
    this.dry = makeGain(ctx, 1);
    this.makeup.connect(this.dry).connect(dest);
    this.makeup.connect(rumbleSend);
  }

  /** Mehr Sättigung bei mehr Energie — der Kick wird mit dem Tempo härter. */
  setDrive(e: number, t: number, tau: number): void {
    this.drive.gain.setTargetAtTime((1.2 + 0.9 * e) / SHAPER_RANGE, t, tau);
    // Pegelausgleich, damit die Kick durch mehr Drive nicht lauter, nur dichter wird.
    this.makeup.gain.setTargetAtTime(0.4 / (0.9 + 0.25 * e), t, tau);
  }

  /** Nur den trockenen Weg stummschalten — Rumble und Sidechain laufen weiter (wie Mute am Mischpult). */
  setMuted(muted: boolean, t: number): void {
    this.dry.gain.cancelScheduledValues(t);
    this.dry.gain.setTargetAtTime(muted ? 0 : 1, t, 0.003);
  }

  trigger(t: number, vel: number): void {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(160, t);
    osc.frequency.exponentialRampToValueAtTime(48, t + 0.09);
    osc.frequency.exponentialRampToValueAtTime(44, t + 0.4);
    const amp = makeGain(ctx, 0);
    // 2 ms Attack, 25 ms Hold, dann tau 85 ms: bei 350 ms ≈ −33 dB.
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(vel, t + 0.002);
    amp.gain.setValueAtTime(vel, t + 0.027);
    amp.gain.setTargetAtTime(0, t + 0.027, 0.085);
    osc.connect(amp).connect(this.input);
    osc.start(t);
    osc.stop(t + 0.7);

    const click = noiseBurst(ctx, this.noise, this.rng, t, 0.006);
    const hp = makeFilter(ctx, 'highpass', 3000, 0);
    const cg = makeGain(ctx, 0);
    cg.gain.setValueAtTime(0, t);
    cg.gain.linearRampToValueAtTime(0.55 * vel, t + 0.0004);
    cg.gain.linearRampToValueAtTime(0, t + 0.003);
    click.connect(hp).connect(cg).connect(this.input);

    releaseWhenEnded([osc, click], [amp, hp, cg]);
  }
}
