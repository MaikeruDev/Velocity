import { clamp, clamp01, makeFilter, makeGain, makePanner, makeShaper, midiToHz, smoothstep, tanhCurve } from '../dsp';

/**
 * Acid spielt erst ab Layer 3 (Energie ≳ 0.55). Die Cutoff-Formel
 * 200 + x²·4000 läuft deshalb über den Acid-Bereich (x = 0 bei e = 0.5,
 * x = 1 bei e = 1) statt über 0..1 — sonst stünde das Filter beim Einsatz
 * schon bei 1.5 kHz und der typische 303-Squelch (Resonanz zieht durch
 * 300–1200 Hz) käme in keinem Layer vor. Bewusste Abweichung vom Rezept.
 */
const ACID_E0 = 0.5;
/** Kurvenreserve: resonante Spitzen erreichen am Shaper-Eingang bis ~6 (siehe tanhCurve). */
const SHAPER_RANGE = 4;
const OUT_LEVEL = 0.24;
/**
 * Rezept: 200 + x²·4000. Oben 3.2 kHz statt 4 kHz: bei 4.2 kHz Grund-Cutoff landen
 * Resonanz und ihre verzerrten Obertöne über 5 kHz — der Schrei wird zum Zischen
 * und dominiert kleine Lautsprecher (gemessen: Laptop-Anteil > 5 kHz 30 % statt ~21 %).
 */
const CUTOFF_SPAN = 3200;
/** Deckel der Filter-Hüllkurve: der Schrei gehört in 3–6 kHz, darüber ist es nur Zischeln (und hinter dem Post-LP). */
const ENV_CEILING_HZ = 6000;

export interface AcidNote {
  readonly midi: number;
  readonly accent: boolean;
  /** Gleitet in die nächste Note (Gate bleibt offen, kein Filter-Retrigger). */
  readonly slide: boolean;
}

/**
 * 303-artige Acid-Stimme — monophon und dauerhaft laufend, weil Slides nur
 * mit einem durchgehenden Oszillator gehen. Säge/Rechteck → zwei kaskadierte
 * resonante Tiefpässe → VCA → tanh-Verzerrung.
 *
 * Trennung der Automationen (keine Kollisionen): `frequency`/`Q` der Filter
 * gehören der Energie (kontinuierlich), `detune` der Filter der
 * Noten-Hüllkurve (Cent, multiplikativ), der VCA dem Sequencer.
 */
export class Acid {
  private readonly saw: OscillatorNode;
  private readonly square: OscillatorNode;
  private readonly sawGain: GainNode;
  private readonly squareGain: GainNode;
  private readonly lp1: BiquadFilterNode;
  private readonly lp2: BiquadFilterNode;
  private readonly vca: GainNode;
  private readonly drive: GainNode;
  private readonly out: GainNode;
  private readonly post: BiquadFilterNode;
  private readonly hp: BiquadFilterNode;
  private readonly hp2: BiquadFilterNode;
  private gateOpen = false;
  private slidePending = false;
  private base = 200;
  private envScale = 1;
  private envCeiling = ENV_CEILING_HZ;

  constructor(ctx: BaseAudioContext, dest: AudioNode, delaySend: AudioNode, startAt: number) {
    this.saw = ctx.createOscillator();
    this.saw.type = 'sawtooth';
    this.saw.frequency.value = midiToHz(45);
    this.square = ctx.createOscillator();
    this.square.type = 'square';
    this.square.frequency.value = midiToHz(45);
    this.sawGain = makeGain(ctx, 1);
    this.squareGain = makeGain(ctx, 0);
    this.lp1 = makeFilter(ctx, 'lowpass', 300, 8);
    this.lp2 = makeFilter(ctx, 'lowpass', 300, 9);
    this.vca = makeGain(ctx, 0);
    this.drive = makeGain(ctx, 0.5 / SHAPER_RANGE);
    const shaper = makeShaper(ctx, tanhCurve(2.6, 4097, SHAPER_RANGE), '2x');
    this.post = makeFilter(ctx, 'lowpass', 3800, -1);
    // Hochpass 160 → 240 Hz mit der Energie (setTone): beim Einsatz bleibt der
    // Grundton als Wärme im Squelch, offen läge er sonst auf Kick und Bass.
    // Zwei Stufen (24 dB/Okt.): mit 12 dB/Okt. läge der A2 im Overdrive noch messbar im Kick-Band.
    this.hp = makeFilter(ctx, 'highpass', 160, 0);
    this.hp2 = makeFilter(ctx, 'highpass', 160, 0);
    this.out = makeGain(ctx, OUT_LEVEL);
    const pan = makePanner(ctx, -0.12);
    this.saw.connect(this.sawGain).connect(this.lp1);
    this.square.connect(this.squareGain).connect(this.lp1);
    this.lp1.connect(this.lp2).connect(this.vca).connect(this.drive).connect(shaper);
    shaper.connect(this.post).connect(this.hp).connect(this.hp2).connect(this.out).connect(pan).connect(dest);
    const send = makeGain(ctx, 0.28);
    this.out.connect(send).connect(delaySend);
    this.saw.start(startAt);
    this.square.start(startAt);
  }

  /**
   * Energie → Cutoff 200 + x²·3200 Hz (x über den Acid-Bereich, s. ACID_E0 und CUTOFF_SPAN),
   * Resonanz (Q in dB, kaskadiert, je 8–18) und Verzerrung. Das ist der
   * hörbarste Reaktionshebel: beim Einsatz quäkt die Resonanz tief, im
   * Overdrive schreit sie oben.
   *
   * `open` (0..1): Surf-Breakdown — ohne Kick darf der Filter weiter auf.
   * `plus` (0..1): L4+ über 1000 u/s — mehr Spanne, Resonanz und Pegel (Acid-Schrei offen),
   * damit Tempo jenseits der gesättigten Energie noch hörbar wird.
   */
  setTone(e: number, t: number, tau: number, open = 0, plus = 0): void {
    const xa = clamp01((e - ACID_E0) / (1 - ACID_E0) + 0.35 * open);
    this.base = 200 + xa * xa * (CUTOFF_SPAN + 900 * plus);
    const x = smoothstep(0.5, 1, e);
    this.envCeiling = ENV_CEILING_HZ + 2500 * plus;
    this.lp1.frequency.setTargetAtTime(this.base, t, tau);
    this.lp2.frequency.setTargetAtTime(this.base * 1.08, t, tau);
    this.lp1.Q.setTargetAtTime(8 + 4 * x + 2 * plus, t, tau);
    this.lp2.Q.setTargetAtTime(9 + 9 * x + 4 * plus, t, tau);
    // Nach dem Shaper: oben zu glätten, aber nie unter die Hüllkurven-Spitzen.
    this.post.frequency.setTargetAtTime(3800 + 1200 * x + 2200 * plus, t, tau);
    // Öffnet das Filter oben, macht der HP unten Platz: im Overdrive gehört das Tiefband Kick und Bass.
    for (const f of [this.hp, this.hp2]) f.frequency.setTargetAtTime(160 + 80 * x, t, tau);
    this.drive.gain.setTargetAtTime((0.45 + 1.4 * x + 0.4 * plus) / SHAPER_RANGE, t, tau);
    // Mehr Drive → dichter, aber nicht leiser: im Overdrive soll der Acid vorne stehen (Acid schreit).
    this.out.gain.setTargetAtTime((OUT_LEVEL * (1 + 0.4 * plus)) / (0.85 + 0.25 * x), t, tau);
    this.envScale = 0.8 + 0.4 * x;
  }

  /** 0 = Säge, 1 = Rechteck (Variation pro Phrase). */
  setWave(squareMix: number, t: number): void {
    this.sawGain.gain.setTargetAtTime(1 - squareMix * 0.8, t, 0.05);
    this.squareGain.gain.setTargetAtTime(squareMix * 0.75, t, 0.05);
  }

  /** Ein 16tel. `note === null` ist eine Pause. */
  step(t: number, stepDur: number, note: AcidNote | null, vel: number): void {
    if (note === null) {
      this.close(t);
      return;
    }
    const f = midiToHz(note.midi);
    const legato = this.gateOpen && this.slidePending;
    for (const o of [this.saw, this.square]) {
      if (legato) o.frequency.setTargetAtTime(f, t, 0.022);
      else o.frequency.setValueAtTime(f, t);
    }
    const peak = vel * (note.accent ? 1 : 0.6);
    this.vca.gain.setTargetAtTime(peak, t, legato ? 0.01 : 0.0015);

    if (!legato || note.accent) {
      // Hüllkurve in Cent, gedeckelt (ENV_CEILING_HZ): mit 12 kHz stand die Resonanz im Overdrive
      // fast die halbe Note hinter dem Post-Tiefpass, der Schrei ging verloren.
      const maxCents = 1200 * Math.log2(this.envCeiling / this.base);
      const cents = clamp((note.accent ? 3100 : 2100) * this.envScale, 0, maxCents);
      for (const lp of [this.lp1, this.lp2]) {
        lp.detune.setTargetAtTime(cents, t, 0.0015);
        lp.detune.setTargetAtTime(0, t + 0.004, note.accent ? 0.075 : 0.16);
      }
    }

    this.gateOpen = true;
    this.slidePending = note.slide;
    if (!note.slide) {
      this.vca.gain.setTargetAtTime(0, t + stepDur * 0.55, 0.01);
      this.gateOpen = false;
    }
  }

  /**
   * Sofort verstummen, auch wenn der Sequencer schon Noten vorausgeplant hat
   * (Mute auf der Werkbank). Hält den aktuellen Wert, damit nichts knackt.
   */
  silenceNow(t: number): void {
    this.vca.gain.cancelAndHoldAtTime(t);
    this.vca.gain.setTargetAtTime(0, t, 0.008);
    this.gateOpen = false;
    this.slidePending = false;
  }

  /** Gate schließen (Pause oder Layer weg). */
  close(t: number): void {
    if (this.gateOpen) this.vca.gain.setTargetAtTime(0, t, 0.008);
    this.gateOpen = false;
    this.slidePending = false;
  }
}
