import type { AudioVolumes } from './types';
import {
  clamp01,
  createImpulseResponse,
  expLerp,
  lerp,
  makeFilter,
  makeGain,
  makePanner,
  makeShaper,
  smoothstep,
  softClipCurve,
  tanhCurve,
  impulseResponseData,
  type ImpulseOptions,
} from './dsp';

/**
 * Signalfluss:
 *
 *   drums ────────────────┐
 *   duckHeavy (SC) ───────┤ Bass, Pad
 *   duckRumble (SC, lang) ┤ Rumble
 *   duckLight (SC) ───────┼─ musicSum ─ M/S ─┬─ roomLP ─┬─ roomGain ─ layerLift ─ rewardDuck ─ menuLP ─ tapeLP ─ tapeGain ─ menuGain ─ musicVol ─┐
 *   Hall/Delay-Returns ───┘  (über duckLight) └─ leak ───┘                                                                                        ├─ Limiter ─ master ─ Clipper ─ out
 *                                          sfx (Ereignisse) ─ sfxBoost ─┬─ sfxVol ─────────────────────────────────────────────────────────────┘
 *                                          sfxBed (Wind, Surf, Whoosh) ─┘
 *
 * Der Raum-Tiefpass ist das "Nebenraum"-Gefühl: bei Stillstand hört man den
 * Club durch die Wand (Tiefpass ~300 Hz, ein Hauch Höhen leckt durch), mit
 * Tempo geht die Tür auf. SFX laufen am Musikfilter vorbei. Ereignis-SFX
 * wachsen mit der Energie mit (sfxBoost), sonst gingen Belohnungen genau dort
 * unter, wo die Musik voll ist; Dauerklänge (sfxBed) sind selbst kalibriert.
 */

/**
 * Chromiums DynamicsCompressor verzögert um 6 ms Pre-Delay (gemessen: 264/288/576
 * Frames bei 44.1/48/96 kHz) — beat() rechnet das heraus.
 */
const LIMITER_PREDELAY = 0.006;

/** Die drei Hall-Impulsantworten (Seed-Offset relativ zum Mixer-Seed). */
const IR_HALL: ImpulseOptions = { seconds: 2.2, preDelay: 0.018, brightHz: 7000, darkHz: 900, channels: 2 };
const IR_RUMBLE: ImpulseOptions = { seconds: 2.6, preDelay: 0.01, brightHz: 700, darkHz: 180, channels: 1 };
const IR_SFX: ImpulseOptions = { seconds: 1.4, preDelay: 0.012, brightHz: 8000, darkHz: 1500, channels: 2 };
const IMPULSES: readonly (readonly [number, ImpulseOptions])[] = [
  [0, IR_HALL],
  [1, IR_RUMBLE],
  [2, IR_SFX],
];

/**
 * IR-Rohdaten vorab berechnen (Leerlauf vor unlock()), damit der Aufbau in
 * der User-Geste nichts rechnen muss. Liefert false, solange noch welche fehlen.
 * Pro Aufruf höchstens eine IR — hält einzelne Leerlauf-Häppchen kurz.
 */
export function prewarmImpulses(sampleRate: number, seed: number, index: number): boolean {
  const spec = IMPULSES[index];
  if (spec === undefined) return true;
  impulseResponseData(sampleRate, seed + spec[0], spec[1]);
  return index + 1 >= IMPULSES.length;
}

/**
 * Regler (0..1) → Gain. Vorher quadratisch: die Defaults 0.8/0.8 ergaben
 * Master × Musik = −7.7 dB, Läufe lagen bei −18 LUFS (Browser-Umfeld ~−14).
 * Jetzt gleitender Exponent 2 − 1.25·x: 0.8 → −1.9 dB (Defaults zusammen −3.9 dB),
 * unten bleibt die Kurve wahrnehmungsnah (0.5 → −8.3 dB, 0.2 → −24 dB).
 */
export function volumeGain(x: number): number {
  const v = clamp01(x);
  if (v <= 0) return 0;
  return Math.pow(v, 2 - 1.25 * v);
}

/** Pegel-Aufschlag der Ereignis-SFX über der Energie: L4 etwa +5 dB (Belohnungen gehen sonst unter). */
export function sfxBoost(e: number): number {
  return 1 + 0.8 * smoothstep(0.3, 1, e);
}

/**
 * M/S-Breite über der Energie: Stillstand schmal (Nebenraum ist mono), ab L2
 * 1.15–1.2 (Club statt Demo), Overdrive noch breiter.
 */
export function stereoWidth(e: number): number {
  if (e < 0.25) return lerp(0.55, 1.2, Math.pow(e / 0.25, 0.8));
  return 1.2 + 0.25 * smoothstep(0.8, 1, e);
}

/**
 * Pegelstufe je Layer (dB): der Overdrive kommt auch über Pegel, nicht nur über Dichte.
 * Kalibriert an den Replays (Defaults 0.8): Läufe ~−14 LUFS, L4 ≥ 1.2 LU über L3,
 * L2 ≤ L3 (Lautheit steigt mit dem Layer), Stand etwas lauter (der Nebenraum ist
 * leise genug durch Raumfilter und leise Kick).
 */
const LAYER_LIFT_DB: readonly number[] = [1.0, -1.5, -2.0, -2.8, -0.3];

export interface MixerOptions {
  /** Sicherheits-Clipper hinter dem Limiter (Default an). Aus nur für Messungen: dann sieht man, was er kaschieren würde. */
  readonly clipper?: boolean;
}

/** Tape-Stop-Stärken: voll (Absturz nach längerem Lauf) oder kurzer Schluckauf (Restart, Respawn-Serien). */
export type TapeStopDepth = 'full' | 'light';

const SIDECHAIN_ATTACK = 0.004;
const SIDECHAIN_HOLD = 0.045;
/** Ergebnis-Screen: weicher Filter statt Pausen-Dumpf (650 Hz), erst nach dem Outro. */
const RESULT_MENU_HZ = 2000;
const RESULT_MENU_GAIN = 0.86;

export class Mixer {
  readonly ctx: BaseAudioContext;
  /** Trockene Drums (nicht geduckt). */
  readonly drums: GainNode;
  /** Hall-Send der Drums — Menge hängt an der Energie (weit weg = mehr Raum). */
  readonly drumVerb: GainNode;
  /** Stark geduckt: Bass, Pad. */
  readonly duckHeavy: GainNode;
  /** Leicht geduckt: Acid, Stabs, Hall- und Delay-Rücklauf. */
  readonly duckLight: GainNode;
  /** Fester Hall-Send (Clap, Pad, Stabs, Crash). */
  readonly hall: GainNode;
  /** Ping-Pong-Delay, punktierte Achtel. */
  readonly delay: GainNode;
  /** Kick → Rumble-Kette. Gate gehört dem Arrangement (ab Layer 2). */
  readonly rumbleGate: GainNode;
  /** Ereignis-SFX (wachsen mit der Energie mit). */
  readonly sfx: GainNode;
  /** Dauer-SFX (Wind, Surf-Zischen, Whoosh): eigener Pegel, ohne Energie-Aufschlag. */
  readonly sfxBed: GainNode;
  /** Tiefer Windanteil atmet mit der Kick (Sidechain wie duckLight). */
  readonly windDuck: GainNode;
  readonly sfxVerb: GainNode;
  readonly sfxDelay: GainNode;
  /** Zusätzliche Latenz der Master-Kette in Sekunden. */
  readonly latency: number;

  private readonly musicSum: GainNode;
  private readonly wDirect: GainNode[];
  private readonly wCross: GainNode[];
  private readonly roomLP: BiquadFilterNode;
  private readonly leak: GainNode;
  private readonly roomGain: GainNode;
  private readonly layerLift: GainNode;
  private readonly rewardGain: GainNode;
  /** Präsenz-Lücke (um 3 kHz) im Musikbus, solange gesurft wird: dort sitzt das Surf-Zischen. */
  private readonly surfDip: BiquadFilterNode;
  private surfDipOn = false;
  /** Eigener Sidechain für den Rumble: tief und langsam — er atmet zwischen den Kicks ein. */
  private readonly duckRumble: GainNode;
  private readonly menuLP: BiquadFilterNode;
  private readonly menuGain: GainNode;
  private readonly tapeLP: BiquadFilterNode;
  private readonly tapeGain: GainNode;
  private readonly musicVol: GainNode;
  private readonly sfxVol: GainNode;
  private readonly sfxBoostGain: GainNode;
  private readonly masterGain: GainNode;
  private readonly openHz: number;
  private tapeBusyUntil = -1;

  constructor(ctx: BaseAudioContext, irSeed: number, destination: AudioNode, opts: MixerOptions = {}) {
    this.ctx = ctx;
    this.openHz = Math.min(20000, ctx.sampleRate * 0.45);
    this.latency = LIMITER_PREDELAY;

    // --- Master ---
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 1;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.12;
    this.masterGain = makeGain(ctx, 1);
    limiter.connect(this.masterGain);
    if (opts.clipper ?? true) {
      const clipper = makeShaper(ctx, softClipCurve(0.86, 0.985), 'none');
      this.masterGain.connect(clipper).connect(destination);
    } else {
      this.masterGain.connect(destination);
    }

    this.musicVol = makeGain(ctx, 1);
    this.sfxVol = makeGain(ctx, 1);
    this.musicVol.connect(limiter);
    this.sfxVol.connect(limiter);

    // --- Musik-Summe + M/S-Breite ---
    this.musicSum = makeGain(ctx, 1);
    // Explizit stereo, sonst liefert der Splitter bei reinen Mono-Quellen rechts Stille.
    this.musicSum.channelCount = 2;
    this.musicSum.channelCountMode = 'explicit';
    this.musicSum.channelInterpretation = 'speakers';
    const split = ctx.createChannelSplitter(2);
    const merge = ctx.createChannelMerger(2);
    this.musicSum.connect(split);
    // L' = a·L + b·R, R' = a·R + b·L mit a = (1+w)/2, b = (1−w)/2. w = 1: neutral.
    const dL = makeGain(ctx, 1);
    const dR = makeGain(ctx, 1);
    const cRL = makeGain(ctx, 0);
    const cLR = makeGain(ctx, 0);
    split.connect(dL, 0);
    split.connect(dR, 1);
    split.connect(cRL, 1);
    split.connect(cLR, 0);
    dL.connect(merge, 0, 0);
    cRL.connect(merge, 0, 0);
    dR.connect(merge, 0, 1);
    cLR.connect(merge, 0, 1);
    this.wDirect = [dL, dR];
    this.wCross = [cRL, cLR];

    // --- Raum ("Nebenraum") ---
    this.roomLP = makeFilter(ctx, 'lowpass', 300, -1);
    this.leak = makeGain(ctx, 0.18);
    // Die Wand dämpft auch den Pegel; mit Energie schwillt der Track an.
    this.roomGain = makeGain(ctx, 0.5);
    merge.connect(this.roomLP).connect(this.roomGain);
    merge.connect(this.leak).connect(this.roomGain);
    this.layerLift = makeGain(ctx, 1);
    this.rewardGain = makeGain(ctx, 1);
    this.surfDip = makeFilter(ctx, 'peaking', 3000, 0.8);
    this.surfDip.gain.value = 0;

    this.menuLP = makeFilter(ctx, 'lowpass', this.openHz, -1);
    this.tapeLP = makeFilter(ctx, 'lowpass', this.openHz, 0);
    this.tapeGain = makeGain(ctx, 1);
    this.menuGain = makeGain(ctx, 1);
    this.roomGain
      .connect(this.layerLift)
      .connect(this.rewardGain)
      .connect(this.surfDip)
      .connect(this.menuLP)
      .connect(this.tapeLP)
      .connect(this.tapeGain)
      .connect(this.menuGain)
      .connect(this.musicVol);

    // --- Eingangsbusse ---
    this.drums = makeGain(ctx, 1);
    this.drums.connect(this.musicSum);
    this.duckHeavy = makeGain(ctx, 1);
    this.duckHeavy.connect(this.musicSum);
    this.duckLight = makeGain(ctx, 1);
    this.duckLight.connect(this.musicSum);

    // --- Hall (2.2 s, dunkler werdender Schwanz) ---
    this.hall = makeGain(ctx, 1);
    this.drumVerb = makeGain(ctx, 0.3);
    const hallConv = ctx.createConvolver();
    hallConv.buffer = createImpulseResponse(ctx, irSeed, IR_HALL);
    const hallHP = makeFilter(ctx, 'highpass', 180, 0);
    const hallRet = makeGain(ctx, 0.55);
    this.hall.connect(hallHP);
    this.drumVerb.connect(hallHP);
    hallHP.connect(hallConv).connect(hallRet).connect(this.duckLight);

    // --- Ping-Pong-Delay, punktierte Achtel bei 132 BPM ---
    this.delay = makeGain(ctx, 1);
    const dotted8 = (60 / 132) * 0.75;
    const delayRet = makeGain(ctx, 0.9);
    this.buildPingPong(this.delay, delayRet, dotted8, 0.4, 2600, 280);
    delayRet.connect(this.duckLight);

    // --- Rumble: Kick → langer dunkler Hall → LP 120 → Verzerrung → geduckt ---
    this.rumbleGate = makeGain(ctx, 0);
    const rumbleConv = ctx.createConvolver();
    rumbleConv.buffer = createImpulseResponse(ctx, irSeed + 1, IR_RUMBLE);
    const rLP1 = makeFilter(ctx, 'lowpass', 120, 0);
    const rLP2 = makeFilter(ctx, 'lowpass', 120, 0);
    const rDrive = makeGain(ctx, 7);
    const rShaper = makeShaper(ctx, tanhCurve(2.5), 'none');
    const rPost = makeFilter(ctx, 'lowpass', 240, 0);
    const rHP = makeFilter(ctx, 'highpass', 32, -3);
    const rOut = makeGain(ctx, 0.06);
    this.duckRumble = makeGain(ctx, 1);
    this.rumbleGate.connect(rumbleConv).connect(rLP1).connect(rLP2).connect(rDrive).connect(rShaper);
    rShaper.connect(rPost).connect(rHP).connect(rOut).connect(this.duckRumble).connect(this.musicSum);

    // --- SFX ---
    this.sfx = makeGain(ctx, 1);
    this.sfxBoostGain = makeGain(ctx, 1);
    this.sfx.connect(this.sfxBoostGain).connect(this.sfxVol);
    this.sfxBed = makeGain(ctx, 1);
    this.sfxBed.connect(this.sfxVol);
    this.windDuck = makeGain(ctx, 1);
    this.windDuck.connect(this.sfxBed);
    this.sfxVerb = makeGain(ctx, 1);
    const sfxConv = ctx.createConvolver();
    sfxConv.buffer = createImpulseResponse(ctx, irSeed + 2, IR_SFX);
    const sfxVerbRet = makeGain(ctx, 0.5);
    this.sfxVerb.connect(sfxConv).connect(sfxVerbRet).connect(this.sfxBoostGain);
    this.sfxDelay = makeGain(ctx, 1);
    const sfxDelayRet = makeGain(ctx, 0.7);
    this.buildPingPong(this.sfxDelay, sfxDelayRet, dotted8 * 0.5, 0.35, 5000, 400);
    sfxDelayRet.connect(this.sfxBoostGain);
  }

  /**
   * Echo springt L ↔ R, jede Wiederholung dunkler und leiser (Dub-Charakter).
   * Bewusst OHNE Rückkopplungsschleife, sondern ausgerollt als Kette: Chromium
   * bricht Zyklen an unbestimmter Stelle auf (± ein Render-Quantum Versatz je
   * Umlauf) — Echos wären weder exakt im Takt noch offline reproduzierbar.
   */
  private buildPingPong(input: AudioNode, out: AudioNode, time: number, feedback: number, lpHz: number, hpHz: number, taps = 6): void {
    const ctx = this.ctx;
    let prev: AudioNode = makeFilter(ctx, 'highpass', hpHz, 0);
    input.connect(prev);
    for (let k = 0; k < taps; k++) {
      const d = ctx.createDelay(time + 0.05);
      d.delayTime.value = time;
      prev.connect(d);
      d.connect(makePanner(ctx, k % 2 === 0 ? -0.85 : 0.85)).connect(out);
      if (k === taps - 1) break;
      const lp = makeFilter(ctx, 'lowpass', lpHz, 0);
      const g = makeGain(ctx, feedback);
      d.connect(lp).connect(g);
      prev = g;
    }
  }

  /** Sidechain: alles Geduckte macht bei jeder Kick Platz und atmet wieder ein. */
  duck(t: number, heavyDepth: number, lightDepth: number): void {
    const r = this.duckRumble.gain;
    r.setTargetAtTime(0.03, t, SIDECHAIN_ATTACK);
    r.setTargetAtTime(1, t + 0.06, 0.21);
    const h = this.duckHeavy.gain;
    h.setTargetAtTime(heavyDepth, t, SIDECHAIN_ATTACK);
    h.setTargetAtTime(1, t + SIDECHAIN_HOLD, 0.075);
    const l = this.duckLight.gain;
    l.setTargetAtTime(lightDepth, t, SIDECHAIN_ATTACK);
    l.setTargetAtTime(1, t + SIDECHAIN_HOLD, 0.06);
    // Windkörper atmet mit: Fahrtwind pumpt im Takt, statt die Kick zuzudecken.
    const w = this.windDuck.gain;
    w.setTargetAtTime(0.35, t, SIDECHAIN_ATTACK);
    w.setTargetAtTime(1, t + SIDECHAIN_HOLD, 0.09);
  }

  /** Kontinuierliche Parameter aus der Energie — immer über setTargetAtTime, nie sprunghaft. */
  setEnergy(e: number, t: number, tau: number): void {
    const x = Math.pow(clamp01(e / 0.35), 0.8);
    this.roomLP.frequency.setTargetAtTime(expLerp(300, this.openHz, x), t, tau);
    this.leak.gain.setTargetAtTime(0.18 * (1 - x), t, tau);
    // Pegel steigt früher als der Filter aufgeht (Wurzel statt 0.8): Laufen/erste Hops
    // sollen nicht leise wirken, die Tür (Filter) öffnet trotzdem erst mit Tempo.
    const swell = e < 0.35 ? lerp(0.5, 0.86, Math.sqrt(clamp01(e / 0.35))) : lerp(0.86, 1, smoothstep(0.35, 1, e));
    this.roomGain.gain.setTargetAtTime(swell, t, tau);
    const w = stereoWidth(e);
    const a = (1 + w) / 2;
    const b = (1 - w) / 2;
    for (const g of this.wDirect) g.gain.setTargetAtTime(a, t, tau);
    for (const g of this.wCross) g.gain.setTargetAtTime(b, t, tau);
    const verb = lerp(0.3, 0.07, smoothstep(0, 0.5, e)) + 0.07 * smoothstep(0.75, 1, e);
    this.drumVerb.gain.setTargetAtTime(verb, t, tau);
    this.sfxBoostGain.gain.setTargetAtTime(sfxBoost(e), t, tau);
  }

  /** Pegelstufe des Layers — setzt mit dem Layer-Wechsel ein (L4-Ankunft ist auch lauter). */
  setLayerLift(layer: number, t: number): void {
    const db = LAYER_LIFT_DB[Math.max(0, Math.min(LAYER_LIFT_DB.length - 1, layer))];
    this.layerLift.gain.setTargetAtTime(Math.pow(10, db / 20), t, 0.03);
  }

  /** Belohnung: Musik kurz um `depthDb` ducken, damit Checkpoint/Meilenstein/Ziel oben liegen. */
  rewardDuck(t: number, depthDb: number, hold: number): void {
    const g = this.rewardGain.gain;
    g.setTargetAtTime(Math.pow(10, -depthDb / 20), t, 0.012);
    g.setTargetAtTime(1, t + hold, 0.07);
  }

  /** Surfen: Musik macht in den Präsenzen Platz (−6 dB um 3 kHz), weich ein- und ausgeblendet. */
  setSurfDip(on: boolean, t: number): void {
    if (on === this.surfDipOn) return;
    this.surfDipOn = on;
    this.surfDip.gain.setTargetAtTime(on ? -6 : 0, t, on ? 0.08 : 0.25);
  }

  /** Menü/Pause: dumpf, nicht stumm. Hebt einen geplanten Ergebnis-Filter auf. */
  setMenu(active: boolean, t: number): void {
    this.menuLP.frequency.cancelScheduledValues(t);
    this.menuGain.gain.cancelScheduledValues(t);
    this.menuLP.frequency.setTargetAtTime(active ? this.openHz : 650, t, 0.12);
    this.menuGain.gain.setTargetAtTime(active ? 1 : 0.72, t, 0.12);
  }

  /**
   * Ergebnis-Screen: das Outro soll klingen, nicht die Pause. Erst ab `from`
   * (ca. 4 Takte nach dem Ziel) und weich: 2 kHz statt 650 Hz, −1.3 dB statt −2.9 dB.
   */
  setResultMenu(from: number, t: number): void {
    const at = Math.max(from, t);
    this.menuLP.frequency.cancelScheduledValues(t);
    this.menuGain.gain.cancelScheduledValues(t);
    this.menuLP.frequency.setTargetAtTime(this.openHz, t, 0.12);
    this.menuGain.gain.setTargetAtTime(1, t, 0.12);
    this.menuLP.frequency.setTargetAtTime(RESULT_MENU_HZ, at, 0.9);
    this.menuGain.gain.setTargetAtTime(RESULT_MENU_GAIN, at, 0.9);
  }

  /**
   * Respawn: Musik "fällt" wie ein Band, das angehalten wird — Tiefpass
   * stürzt ab, Pegel taucht ~0.4 s ein, dann kommt alles zurück. 'light' ist
   * ein kurzer, flacher Schluckauf (0.26 s, LP 1.2 kHz): wer im Übungs-Loop
   * alle paar Sekunden neu startet, soll den Track nicht dauernd dumpf hören.
   */
  tapeStop(t: number, depth: TapeStopDepth = 'full'): void {
    // Überlappende Wertekurven wirft die Web-Audio-API als Fehler — der laufende Dip deckt es ab.
    if (t < this.tapeBusyUntil) return;
    const full = depth === 'full';
    const dur = full ? 0.62 : 0.26;
    const fall = full ? 0.14 : 0.05;
    const holdEnd = full ? 0.4 : 0.1;
    const n = full ? 125 : 53;
    const freq = new Float32Array(n);
    const gain = new Float32Array(n);
    const lo = Math.log(full ? 170 : 1200);
    const hi = Math.log(this.openHz);
    const floor = full ? 0.32 : 0.7;
    for (let i = 0; i < n; i++) {
      const s = (i / (n - 1)) * dur;
      // abstürzen, unten halten, dann wieder auf
      const down = s < fall ? smoothstep(0, fall, s) : s < holdEnd ? 1 : 1 - smoothstep(holdEnd, dur, s);
      freq[i] = Math.exp(lerp(hi, lo, down));
      gain[i] = lerp(1, floor, down);
    }
    freq[n - 1] = this.openHz;
    gain[n - 1] = 1;
    this.tapeLP.frequency.setValueCurveAtTime(freq, t, dur);
    this.tapeGain.gain.setValueCurveAtTime(gain, t, dur);
    this.tapeBusyUntil = t + dur + 0.01;
  }

  /** Lautstärken wirken sofort (nur gegen Knackser geglättet). Kurve: volumeGain. */
  setVolumes(v: AudioVolumes, t: number): void {
    this.masterGain.gain.setTargetAtTime(volumeGain(v.master), t, 0.02);
    this.musicVol.gain.setTargetAtTime(volumeGain(v.music), t, 0.02);
    this.sfxVol.gain.setTargetAtTime(volumeGain(v.sfx), t, 0.02);
  }
}
