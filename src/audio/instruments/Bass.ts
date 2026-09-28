import { makeFilter, makeGain, makeShaper, midiToHz, releaseWhenEnded, tanhCurve } from '../dsp';

/**
 * Rolling Bass: Offbeat-16tel (2./3./4. Sechzehntel jedes Beats), zwei leicht
 * verstimmte Sägezähne plus wenig Sinus-Sub, Tiefpass mit eigener Hüllkurve
 * pro Note. Grundton A1 (55 Hz), aber der Sub gehört der Kick: Hochpass
 * 50 Hz und nur ein Hauch Sinus — der Bass rollt im Mittelbass (80–400 Hz).
 * Platz in der Zeit schafft der Sidechain (Bus ist duckHeavy).
 */
export class Bass {
  private readonly bus: BiquadFilterNode;

  constructor(
    private readonly ctx: BaseAudioContext,
    dest: AudioNode,
  ) {
    this.bus = makeFilter(ctx, 'highpass', 50, -1);
    // Groove: +3.5 dB im Mittelbass (Glocke um 230 Hz, ~130–400 Hz). Das Tiefband unter
    // 100 Hz bleibt fast unberührt — es gehört der Kick (audiocheck: Tiefband-Besitz).
    const body = makeFilter(ctx, 'peaking', 230, 0.9);
    body.gain.value = 3.5;
    // Unter 90 Hz −2 dB: mit leiseren Layer-Stufen (Mixer) drückt der Limiter den Bass
    // nicht mehr mit — sonst stieg er im Tiefband zu nah an die Kick (< 4 dB Abstand).
    const sub = makeFilter(ctx, 'lowshelf', 90, 0);
    sub.gain.value = -2;
    this.bus.connect(body).connect(sub).connect(dest);
    // Parallele Sättigung NUR über ~240 Hz (Growl): Obertöne, die auf kleinen
    // Lautsprechern (unter ~200 Hz taub) den Bass tragen — das Tiefband bleibt
    // unberührt, es gehört der Kick. Kurve deckt ±3 ab (Eingang ÷ 3).
    const split = makeFilter(ctx, 'highpass', 240, 0);
    // Zweiter Hochpass: der starke 55-Hz-Grundton käme durch 12 dB/Okt. noch durch und würde mitverzerrt.
    const split2 = makeFilter(ctx, 'highpass', 240, 0);
    const pre = makeGain(ctx, 8 / 3);
    const shaper = makeShaper(ctx, tanhCurve(1.2, 4097, 3), '2x');
    const tame = makeFilter(ctx, 'lowpass', 2200, -1);
    const wet = makeGain(ctx, 0.09);
    this.bus.connect(split).connect(split2).connect(pre).connect(shaper).connect(tame).connect(wet).connect(dest);
  }

  /**
   * @param cutoff Grund-Cutoff in Hz (Energie: zu ~180 Hz, offen ~900 Hz)
   * @param envMul Filter-Hüllkurve: Startwert = cutoff · envMul
   * @param len    Notenlänge in s
   */
  note(t: number, midi: number, vel: number, cutoff: number, envMul: number, len: number): void {
    const ctx = this.ctx;
    const f = midiToHz(midi);
    const saw1 = ctx.createOscillator();
    saw1.type = 'sawtooth';
    saw1.frequency.value = f;
    const saw2 = ctx.createOscillator();
    saw2.type = 'sawtooth';
    saw2.frequency.value = f;
    saw2.detune.value = 9;
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = f;

    const mix = makeGain(ctx, 0.5);
    const subGain = makeGain(ctx, 0.1);
    const lp = makeFilter(ctx, 'lowpass', cutoff, 6);
    lp.frequency.setValueAtTime(Math.min(cutoff * envMul, 12000), t);
    lp.frequency.setTargetAtTime(cutoff, t + 0.004, 0.035);

    const amp = makeGain(ctx, 0);
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(vel, t + 0.004);
    amp.gain.setValueAtTime(vel, t + len * 0.45);
    amp.gain.setTargetAtTime(0, t + len * 0.45, 0.022);
    const end = t + len * 0.45 + 0.022 * 8;

    saw1.connect(mix);
    saw2.connect(mix);
    mix.connect(lp);
    lp.connect(amp);
    sub.connect(subGain).connect(amp);
    amp.connect(this.bus);
    for (const o of [saw1, saw2, sub]) {
      o.start(t);
      o.stop(end);
    }
    releaseWhenEnded([saw1, saw2, sub], [mix, subGain, lp, amp]);
  }
}
