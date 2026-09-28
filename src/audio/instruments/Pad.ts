import { lerp, makeFilter, makeGain, makePanner, midiToHz, releaseWhenEnded, smoothstep } from '../dsp';

const ATTACK = 1.8;
const RELEASE_TAU = 0.9;

/**
 * Pad/Drone für Stillstand und ruhige Momente: je Ton zwei verstimmte
 * Sägezähne (L/R), gemeinsamer Tiefpass ~800 Hz mit langsamem LFO, langsamer
 * Einsatz, viel Hall. Der Pegel hängt an der Energie: im Stand trägt das Pad,
 * im Flow tritt es zurück, im Overdrive kommt ein Hauch zurück (Weite).
 */
export class Pad {
  private readonly input: GainNode;
  private readonly level: GainNode;
  private readonly lp: BiquadFilterNode;
  private readonly lift: GainNode;

  constructor(
    private readonly ctx: BaseAudioContext,
    dest: AudioNode,
    hallSend: AudioNode,
    startAt: number,
  ) {
    this.input = makeGain(ctx, 1);
    const lp = makeFilter(ctx, 'lowpass', 800, 2);
    this.lp = lp;
    // LFO auf den Cutoff: das Pad atmet, auch wenn der Spieler steht.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoDepth = makeGain(ctx, 260);
    lfo.connect(lfoDepth).connect(lp.frequency);
    lfo.start(startAt);
    this.level = makeGain(ctx, 1);
    this.lift = makeGain(ctx, 1);
    this.input.connect(lp).connect(this.level).connect(this.lift);
    this.lift.connect(dest);
    const send = makeGain(ctx, 0.8);
    this.lift.connect(send).connect(hallSend);
  }

  setLevel(e: number, t: number, tau: number): void {
    // In L1/L2 nicht ganz weg: bis dahin ist das Pad der einzige tonale Mittenanteil.
    // Ab L3 übernimmt der Acid, dann tritt das Pad zurück (sein A2 läge sonst auf Kick und Bass).
    const v =
      e < 0.55
        ? lerp(1, 0.22, smoothstep(0, 0.5, e))
        : lerp(0.22, 0.11, smoothstep(0.55, 0.7, e)) + 0.12 * smoothstep(0.8, 1, e);
    this.level.gain.setTargetAtTime(v, t, tau);
  }

  /**
   * Öffnen (0..1) für Surf-Breakdown und Outro: Filter auf, Pegel hoch — ohne Kick
   * trägt das Pad den Raum. Unabhängig von setLevel (Energie), daher eigener Gain.
   */
  setOpen(x: number, t: number, tau: number): void {
    this.lp.frequency.setTargetAtTime(800 * (1 + 2.2 * x), t, tau);
    this.lift.gain.setTargetAtTime(1 + 2.4 * x, t, tau);
  }

  /** Akkord über `dur` Sekunden; überlappt mit dem nächsten durch den langen Release. */
  chord(t: number, notes: readonly number[], dur: number, vel: number): void {
    const ctx = this.ctx;
    for (let i = 0; i < notes.length; i++) {
      const f = midiToHz(notes[i]);
      // Grundton lauter, Farbtöne leiser — Drone statt Akkordbrei.
      const v = (i === 0 ? 1 : 0.55) * vel;
      const amp = makeGain(ctx, 0);
      amp.gain.setValueAtTime(0, t);
      amp.gain.linearRampToValueAtTime(v, t + ATTACK);
      amp.gain.setValueAtTime(v, t + dur);
      amp.gain.setTargetAtTime(0, t + dur, RELEASE_TAU);
      const end = t + dur + RELEASE_TAU * 8;
      const oscs: OscillatorNode[] = [];
      const pans: StereoPannerNode[] = [];
      for (const side of [-1, 1] as const) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f;
        o.detune.value = side * 7;
        const p = makePanner(ctx, side * 0.45);
        o.connect(p).connect(amp);
        o.start(t);
        o.stop(end);
        oscs.push(o);
        pans.push(p);
      }
      amp.connect(this.input);
      releaseWhenEnded(oscs, [amp, ...pans]);
    }
  }
}
