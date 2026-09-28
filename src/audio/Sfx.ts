import type { GameEvent, RespawnReason } from '../engine/events';
import type { MusicDrive } from './types';
import type { Mixer } from './Mixer';
import type { BeatClock } from './Music';
import {
  clamp,
  clamp01,
  createNoiseBuffer,
  createRng,
  expLerp,
  haasPair,
  makeFilter,
  makeGain,
  makePanner,
  midiToHz,
  noiseBurst,
  percEnvelope,
  releaseWhenEnded,
  smoothstep,
  type Rng,
} from './dsp';
import { Fx } from './instruments/Fx';
import { CHORD_AM9, Stabs } from './instruments/Stabs';
import { PENTATONIC } from './patterns';

/** Offline-Zeitleisten: Sprung so kurz nach einer nicht angekündigten Landung = Bhop, Landung abblenden. */
const BHOP_WINDOW = 0.07;
/**
 * Echtzeit: Eine nicht angekündigte Landung (jumpQueued false) wartet, bis nach dem
 * Land-Frame mindestens ein Tick (1/128 s) Framezeit gelaufen ist. Ein frisch
 * gedrückter Sprung im Folgetick ist trotzdem perfekt (fallen.md #54) — ohne
 * Aufschub knallte die Landung genau beim perfekten Tipp-Hop. Kostet 1 Frame
 * (60 Hz) statt früher fest 42 ms.
 */
const LAND_HOLD = 1 / 128;

/** Zurückgehaltene Landung (Echtzeit, siehe LAND_HOLD). Ohne Web Audio — testbar. */
export class LandHold {
  private impact = -1;
  /** Gelaufene Framezeit seit dem Land-Frame; −1 = der Land-Frame selbst läuft noch. */
  private elapsed = -1;

  get pending(): boolean {
    return this.impact >= 0;
  }

  hold(impact: number): void {
    this.impact = impact;
    this.elapsed = -1;
  }

  /** Einmal pro Frame nach den Ticks. Rückgabe: Aufprall, der jetzt voll klingen soll, sonst −1. */
  frame(dt: number): number {
    if (this.impact < 0) return -1;
    // Der Land-Frame zählt nicht: seine Ticks liefen schon vor diesem Aufruf.
    if (this.elapsed < 0) {
      this.elapsed = 0;
      return -1;
    }
    this.elapsed += dt;
    return this.elapsed >= LAND_HOLD ? this.take() : -1;
  }

  /** Aufprall abholen und vergessen (Sprung kam: leise Variante; oder Auflösung), −1 wenn nichts wartet. */
  take(): number {
    const i = this.impact;
    this.impact = -1;
    return i;
  }
}

/** −23 dB: Landung, auf die im nächsten Tick ein Sprung folgt (jumpQueued). */
const BHOP_LAND_GAIN = 0.07;
/** Respawns in dichterer Folge (Übungs-Loop) bekommen nur den leichten Tape-Stop. */
const RESPAWN_SERIES = 8;

/** Speed-Meilensteine 500/750/1000/1250/1500+: E5 A5 C6 E6 A6 (gespielt eine Oktave höher). */
const ZAP_NOTES = [76, 81, 84, 88, 93] as const;
const CHORD_AM9_UP: readonly number[] = CHORD_AM9.map((n) => n + 12);

/** Shepard-Blip: Teiltöne ab A3 in Oktaven, Glocke um 1.2 kHz (σ in Oktaven). */
const BLIP_ROOT = 57;
const BLIP_PARTIALS = 5;
const BLIP_CENTER_HZ = 1200;
const BLIP_SIGMA = 0.85;

/** Whoosh: Pegel ab dieser seitlichen Nähe (u), voll bei WHOOSH_NEAR. */
const WHOOSH_FAR = 160;
const WHOOSH_NEAR = 40;

/**
 * Pentatonik-Stufe des Chain-Blips (Chain 2 = Stufe 0). Endlos steigend: der
 * Shepard-Ton macht die Oktav-Wiederholung unhörbar, es gibt keinen Rücksprung mehr.
 */
export function blipIndex(chain: number): number {
  return Math.max(0, chain - 2);
}

/** Tonklasse (0..11 über A) der Pentatonik-Stufe. */
export function blipPitchClass(step: number): number {
  const s = Math.max(0, Math.floor(step));
  return (12 * Math.floor(s / 5) + PENTATONIC[s % 5]) % 12;
}

/**
 * Teiltöne des Shepard-Blips: Frequenz und Gewicht je Oktave. Die spektrale
 * Hüllkurve ist fest (Glocke um `center`), deshalb klingt jede Stufe höher, ohne
 * dass es je eine Oktave zurückspringt. Summe der Gewichte = 1.
 */
export function shepardPartials(step: number, center = BLIP_CENTER_HZ): { readonly hz: number[]; readonly w: number[] } {
  const f0 = midiToHz(BLIP_ROOT + blipPitchClass(step));
  const hz: number[] = [];
  const w: number[] = [];
  let sum = 0;
  for (let k = 0; k < BLIP_PARTIALS; k++) {
    const f = f0 * Math.pow(2, k);
    const d = Math.log2(f / center) / BLIP_SIGMA;
    const g = Math.exp(-0.5 * d * d);
    if (g < 0.02) continue;
    hz.push(f);
    w.push(g);
    sum += g;
  }
  for (let i = 0; i < w.length; i++) w[i] /= sum;
  return { hz, w };
}

/**
 * Pegel des Fahrtwinds über der Speed (ohne Gesamtpegel): ab 280 u/s, Gamma 0.5 —
 * im Bhop-Bereich (400–900 u/s) deutlich, oben Sättigung. Vorher Gamma 0.7 ab
 * 200 u/s mit Band 400 Hz–3 kHz: bei 600 u/s −17 LU unter der Musik, unhörbar.
 * Oben zurückgenommen: ab 900 u/s lag der Wind sonst gleichauf mit der Musik
 * (Replay l2: 0 LU) — dort tragen Musik (L4) und Surf-Zischen das Tempo.
 */
export function windCurve(speed: number): number {
  return Math.sqrt(smoothstep(280, 1200, speed)) * (1 - 0.6 * smoothstep(600, 1100, speed));
}

/** Whoosh-Nähe 0..1 aus der seitlichen Distanz (fehlend/Infinity = 0). */
export function whooshProximity(dist: number | undefined): number {
  if (dist === undefined || !Number.isFinite(dist)) return 0;
  return clamp01((WHOOSH_FAR - dist) / (WHOOSH_FAR - WHOOSH_NEAR));
}

interface PendingLand {
  /** Kontextzeit der Landung. */
  readonly time: number;
  readonly cancel: GainNode;
}

interface WhooshVoice {
  readonly bp: BiquadFilterNode;
  readonly gain: GainNode;
  lastDist: number;
  lastT: number;
  lastLevel: number;
}

/**
 * Sound-Effekte auf eigenem Bus (am Musikfilter vorbei). Alles in A-Moll,
 * damit Blips und Chimes mit dem Track verschmelzen statt dagegen zu piepsen.
 * Ereignisse laufen über `mixer.sfx` (wächst mit der Energie), Dauerklänge
 * (Wind, Surf, Whoosh) über `mixer.sfxBed`.
 */
export class Sfx {
  private readonly noise: AudioBuffer;
  private readonly rng: Rng;
  private readonly out: GainNode;
  private readonly bed: GainNode;
  private readonly fx: Fx;
  private readonly stabs: Stabs;

  private readonly windOut: GainNode;
  private readonly windLowOut: GainNode;
  private readonly windHop: GainNode;
  private readonly windBP: BiquadFilterNode[];
  private readonly whistleBP: BiquadFilterNode;
  private readonly whistleGain: GainNode;
  private readonly surfGain: GainNode;
  private readonly surfBP: BiquadFilterNode;
  private readonly surfLfo: OscillatorNode;
  private readonly whoosh: WhooshVoice[];

  private clock: BeatClock | null = null;
  private pendingLand: PendingLand | null = null;
  private readonly landHold = new LandHold();
  private lastJump = Number.NEGATIVE_INFINITY;
  private lastDuck = Number.NEGATIVE_INFINITY;
  private lastSpeed = -1;
  private lastActive = true;
  private lastSurf = false;
  private lastRespawn = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly mixer: Mixer,
    seed: number,
    startAt: number,
  ) {
    this.rng = createRng(seed + 303);
    this.noise = createNoiseBuffer(ctx, 3, createRng(seed + 404), 1);
    this.out = mixer.sfx;
    this.bed = mixer.sfxBed;
    this.fx = new Fx(ctx, this.noise, this.rng, this.out, mixer.sfxVerb);
    this.stabs = new Stabs(ctx, this.out, mixer.sfxDelay, mixer.sfxVerb);

    // --- Wind: zwei dekorrelierte Rauschquellen (L/R). Oben ein Band 4–9 kHz über den Hats
    // (dort maskiert der Mix am wenigsten), unten Körper am Kick-Sidechain.
    this.windOut = makeGain(ctx, 0);
    this.windHop = makeGain(ctx, 1);
    this.windLowOut = makeGain(ctx, 0);
    const merge = ctx.createChannelMerger(2);
    merge.connect(this.windHop).connect(this.windOut).connect(this.bed);
    const mergeLow = ctx.createChannelMerger(2);
    mergeLow.connect(this.windLowOut).connect(mixer.windDuck);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.17;
    const lfoPos = makeGain(ctx, 0.22);
    const lfoNeg = makeGain(ctx, -0.22);
    lfo.connect(lfoPos);
    lfo.connect(lfoNeg);
    lfo.start(startAt);
    this.windBP = [];
    const offsets = [0, 1.37];
    for (let ch = 0; ch < 2; ch++) {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      src.start(startAt, offsets[ch]);
      const bp = makeFilter(ctx, 'bandpass', 5000, 0.9);
      const g = makeGain(ctx, 0.78);
      src.connect(bp).connect(g);
      (ch === 0 ? lfoPos : lfoNeg).connect(g.gain);
      g.connect(merge, 0, ch);
      const low = makeFilter(ctx, 'lowpass', 260, 0);
      src.connect(low).connect(mergeLow, 0, ch);
      this.windBP.push(bp);
    }
    // Pfeifen ab ~500 u/s: schmaler Bandpass, steigt mit dem Tempo.
    const wsrc = ctx.createBufferSource();
    wsrc.buffer = this.noise;
    wsrc.loop = true;
    wsrc.start(startAt, 2.11);
    this.whistleBP = makeFilter(ctx, 'bandpass', 2000, 9);
    this.whistleGain = makeGain(ctx, 0);
    const wPan = makePanner(ctx, 0.2);
    wsrc.connect(this.whistleBP).connect(this.whistleGain).connect(wPan).connect(this.bed);

    // --- Surf-Zischen: Rauschen HP → BP 2–5 kHz, Körnung mit dem Surf-Tempo, breit ---
    const ssrc = ctx.createBufferSource();
    ssrc.buffer = this.noise;
    ssrc.loop = true;
    ssrc.start(startAt, 0.71);
    const shp = makeFilter(ctx, 'highpass', 1500, 0);
    // Q 1.5: Energie dort, wo die Musik Platz macht (2–4 kHz) — breiter trieb es nur die Lautheit hoch.
    this.surfBP = makeFilter(ctx, 'bandpass', 3000, 1.5);
    const grain = makeGain(ctx, 0.75);
    this.surfLfo = ctx.createOscillator();
    this.surfLfo.frequency.value = 7.3;
    const grainDepth = makeGain(ctx, 0.25);
    this.surfLfo.connect(grainDepth).connect(grain.gain);
    this.surfLfo.start(startAt);
    this.surfGain = makeGain(ctx, 0);
    ssrc.connect(shp).connect(this.surfBP).connect(grain).connect(this.surfGain);
    haasPair(ctx, this.surfGain, this.bed, -0.3, 0.011, 0.72);

    // --- Vorbeizieh-Whoosh: je Seite eine Rauschstimme, Pegel nach Nähe × Tempo ---
    this.whoosh = [];
    for (const side of [-1, 1] as const) {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      src.start(startAt, side < 0 ? 0.43 : 1.91);
      const bp = makeFilter(ctx, 'bandpass', 1200, 1.8);
      const gain = makeGain(ctx, 0);
      src.connect(bp).connect(gain).connect(makePanner(ctx, side * 0.85)).connect(this.bed);
      this.whoosh.push({ bp, gain, lastDist: Number.POSITIVE_INFINITY, lastT: Number.NEGATIVE_INFINITY, lastLevel: 0 });
    }
  }

  /** Beat-Raster für die Chain-Blips (vom Sequencer, nach dem Aufbau gesetzt). */
  setClock(clock: BeatClock): void {
    this.clock = clock;
  }

  /** Kontinuierliche Klänge (Wind, Surf, Whoosh) aus dem Drive. */
  updateContinuous(d: MusicDrive, t: number, tau: number): void {
    this.updateWhoosh(d, t);
    // Der Drive ist die Wahrheit (pro Frame); surfStart/surfEnd erzwingen nur ein sofortiges Update.
    // Sonst bliebe das Zischen hängen, wenn ein surfEnd fehlt (Respawn mitten im Surf).
    const surf = d.active && d.surfing;
    if (Math.abs(d.speed - this.lastSpeed) < 2 && d.active === this.lastActive && surf === this.lastSurf) return;
    this.lastSpeed = d.speed;
    this.lastActive = d.active;
    this.lastSurf = surf;
    const s = smoothstep(280, 1200, d.speed);
    const f = expLerp(4200, 6800, s);
    this.windBP[0].frequency.setTargetAtTime(f * 0.93, t, tau);
    this.windBP[1].frequency.setTargetAtTime(f * 1.07, t, tau);
    // Beim Surfen trägt das Zischen das Tempo: Wind −5 dB, sonst lägen beide zusammen über der Musik.
    const w = d.active ? windCurve(d.speed) * (surf ? 0.55 : 1) : 0;
    this.windOut.gain.setTargetAtTime(w * 0.42, t, tau);
    this.windLowOut.gain.setTargetAtTime(w * 0.22, t, tau);
    this.whistleBP.frequency.setTargetAtTime(expLerp(1800, 3600, smoothstep(500, 1400, d.speed)), t, tau);
    this.whistleGain.gain.setTargetAtTime(w * 0.28 * smoothstep(500, 1100, d.speed), t, tau);
    // Surf: +10 dB gegenüber vorher, Band und Körnung ziehen mit dem Surf-Tempo an.
    const sp = smoothstep(400, 1500, d.speed);
    const surfLevel = surf ? 0.92 + 0.65 * sp : 0;
    this.mixer.setSurfDip(surf, t);
    this.surfBP.frequency.setTargetAtTime(expLerp(2200, 4600, sp), t, tau);
    this.surfLfo.frequency.setTargetAtTime(6 + 9 * sp, t, tau);
    this.surfGain.gain.setTargetAtTime(surfLevel, t, surf ? 0.04 : 0.12);
  }

  /** Whoosh je Seite: Pegel ∝ Nähe × Tempo, Tonhöhe folgt der Distanzänderung (Doppler-Andeutung). */
  private updateWhoosh(d: MusicDrive, t: number): void {
    const moving = d.active ? smoothstep(250, 900, d.speed) : 0;
    const base = expLerp(700, 2200, smoothstep(300, 1400, d.speed));
    for (let i = 0; i < 2; i++) {
      const v = this.whoosh[i];
      const dist = i === 0 ? d.nearL : d.nearR;
      const near = whooshProximity(dist);
      const level = 2.2 * moving * near * Math.sqrt(near);
      if (level === 0 && v.lastLevel === 0) {
        v.lastDist = dist ?? Number.POSITIVE_INFINITY;
        v.lastT = t;
        continue;
      }
      const dt = t - v.lastT;
      const cur = dist ?? Number.POSITIVE_INFINITY;
      // Annäherung → heller, Entfernen → dunkler (±0.6 Oktaven).
      const rate = dt > 1e-3 && Number.isFinite(cur) && Number.isFinite(v.lastDist) ? (v.lastDist - cur) / dt : 0;
      const shift = clamp(rate / 900, -0.6, 0.6);
      v.bp.frequency.setTargetAtTime(base * (1 + 0.6 * near) * Math.pow(2, shift), t, 0.03);
      v.gain.gain.setTargetAtTime(level, t, 0.025);
      v.lastDist = cur;
      v.lastT = t;
      v.lastLevel = level;
    }
  }

  /** `wall` = performance.now() beim emit (Echtzeit), null für Offline-Zeitleisten. */
  play(e: GameEvent, t: number, wall: number | null = null): void {
    switch (e.type) {
      case 'jump':
        this.jump(t, e.chain, e.gain, wall);
        break;
      case 'land':
        this.land(t, e.impact, e.jumpQueued === true, wall);
        break;
      case 'footstep':
        this.footstep(t, e.speed, e.left);
        break;
      case 'duck':
        this.duck(t, e.down);
        break;
      case 'surfStart':
      case 'surfEnd':
        this.lastSpeed = -1;
        break;
      case 'runStart':
        this.runStart(t);
        break;
      case 'checkpoint':
        this.checkpoint(t);
        break;
      case 'finish':
        this.finish(t);
        break;
      case 'respawn':
        this.respawn(t, e.reason);
        break;
      case 'speedMilestone':
        this.zap(t, e.speed);
        break;
      case 'levelLoaded':
        break;
    }
  }

  // ------------------------------------------------------------ Bewegung

  /**
   * Weicher, kurzer "Whoomp" — muss auch beim hundertsten Hop angenehm sein: tief,
   * kurz, ±5 % Pitch, dazu ein leiser Luftstoß über 2 kHz, damit er über dem Bass
   * sitzt. Beides sofort (Reaktion); nur der tonale Blip rastet auf das Raster.
   */
  private jump(t: number, chain: number, gain: number, wall: number | null): void {
    // Perfekter Hop mit frischem Druck: die zurückgehaltene Landung klingt nur als Hauch (wie jumpQueued).
    const held = this.landHold.take();
    if (held >= 0) this.playLand(t, held, BHOP_LAND_GAIN);
    const pl = this.pendingLand;
    if (pl !== null) {
      // Offline-Zeitleisten: Sprung kurz nach einer nicht angekündigten Landung → abblenden.
      if (t - pl.time <= BHOP_WINDOW) pl.cancel.gain.setTargetAtTime(BHOP_LAND_GAIN, t, 0.004);
      this.pendingLand = null;
    }
    // Wind-Böe: Anstieg zum Apex (~0.38 s bei flachem Bhop), danach Abfall bis zur Landung.
    const hop = this.windHop.gain;
    hop.cancelScheduledValues(t);
    hop.setTargetAtTime(1.45, t, 0.11);
    hop.setTargetAtTime(0.72, t + 0.38, 0.22);
    if (t - this.lastJump < 0.04) return;
    this.lastJump = t;
    const ctx = this.ctx;
    const d = 1 + (this.rng() * 2 - 1) * 0.05;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    // Sweep über drei Terzbänder (125–200 Hz): im Overdrive sonst vom Bass verdeckt.
    osc.frequency.setValueAtTime(110 * d, t);
    osc.frequency.exponentialRampToValueAtTime(215 * d, t + 0.08);
    const env = makeGain(ctx, 0);
    const end = percEnvelope(env.gain, t, 0.26, 0.006, 0.04);
    osc.connect(env).connect(this.out);
    osc.start(t);
    osc.stop(end);

    const air = noiseBurst(ctx, this.noise, this.rng, t, 0.3);
    const lp = makeFilter(ctx, 'lowpass', 800 * d, 0);
    lp.frequency.setValueAtTime(700 * d, t);
    lp.frequency.exponentialRampToValueAtTime(1700 * d, t + 0.06);
    const aEnv = makeGain(ctx, 0);
    percEnvelope(aEnv.gain, t, 0.08, 0.008, 0.03);
    air.connect(lp).connect(aEnv).connect(this.out);

    // Transient: kurzer, weicher Luftstoß 2.5–6 kHz ("fft"), liegt über Bass und Acid.
    const puff = noiseBurst(ctx, this.noise, this.rng, t, 0.08);
    const pBP = makeFilter(ctx, 'bandpass', 3000 * d, 0.6);
    const pEnv = makeGain(ctx, 0);
    percEnvelope(pEnv.gain, t, 0.6, 0.0015, 0.024);
    puff.connect(pBP).connect(pEnv).connect(this.out);
    releaseWhenEnded([osc, air, puff], [env, lp, aEnv, pBP, pEnv]);

    if (chain >= 2) this.hopBlip(t, chain, gain, wall);
  }

  /**
   * Rez-Prinzip: der tonale Blip rastet auf das nächste 32tel ein (≤ 57 ms) und
   * steigt als Shepard-Ton endlos die Pentatonik hoch — der Spieler spielt die
   * Melodie. Speed-Gewinn verschiebt die Glocke leicht nach oben (heller).
   */
  private hopBlip(t: number, chain: number, gain: number, wall: number | null): void {
    const ctx = this.ctx;
    const at = this.nextGrid(t, wall !== null);
    const bright = clamp(gain / 25, -1, 1);
    const { hz, w } = shepardPartials(blipIndex(chain), BLIP_CENTER_HZ * Math.pow(2, 0.3 * bright));
    const env = makeGain(ctx, 0);
    const end = percEnvelope(env.gain, at, 0.2 + 0.05 * Math.max(0, bright), 0.004, 0.075 + 0.02 * Math.max(0, bright));
    const oscs: OscillatorNode[] = [];
    const gains: GainNode[] = [env];
    for (let i = 0; i < hz.length; i++) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = hz[i];
      const g = makeGain(ctx, w[i]);
      o.connect(g).connect(env);
      o.start(at);
      o.stop(end);
      oscs.push(o);
      gains.push(g);
    }
    env.connect(this.out);
    const send = makeGain(ctx, 0.28);
    env.connect(send).connect(this.mixer.sfxDelay);
    gains.push(send);
    releaseWhenEnded(oscs, gains);
  }

  /** Nächstes 32tel ≥ t. Echtzeit: mindestens 3 ms Vorlauf, sonst käme der Ton im laufenden Block zu spät. */
  private nextGrid(t: number, realtime: boolean): number {
    const c = this.clock;
    if (c === null) return t;
    const d = c.stepDur / 2;
    let at = c.originTime + Math.ceil((t - c.originTime) / d - 1e-9) * d;
    if (realtime && at - t < 0.003) at += d;
    return Math.max(at, t);
  }

  /**
   * Thump 90 → 50 Hz + Klick, Lautstärke nach Aufprall. Angekündigter Folgesprung
   * (jumpQueued: Puffer oder Auto-Hop gehalten): sofort und fast stumm (−23 dB).
   * Sonst in Echtzeit ein Tick Aufschub (LAND_HOLD), offline sofort.
   */
  private land(t: number, impact: number, jumpQueued: boolean, wall: number | null): void {
    // Landung ohne Folgesprung: Wind fällt kurz ab und kommt am Boden zurück.
    if (!jumpQueued) {
      const hop = this.windHop.gain;
      hop.cancelScheduledValues(t);
      hop.setTargetAtTime(0.7, t, 0.03);
      hop.setTargetAtTime(1, t + 0.12, 0.35);
    }
    if (smoothstep(120, 900, impact) < 0.02) return;
    if (jumpQueued) {
      this.playLand(t, impact, BHOP_LAND_GAIN);
      return;
    }
    if (wall !== null) {
      // Echtzeit: einen Tick zurückhalten (frame() löst auf), falls der Sprung frisch kommt.
      this.landHold.hold(impact);
      return;
    }
    this.pendingLand = { time: t, cancel: this.playLand(t, impact, 1) };
  }

  /** Einmal pro Frame nach den Ticks: löst eine zurückgehaltene Landung auf. */
  frame(dt: number, t: number): void {
    const impact = this.landHold.frame(dt);
    if (impact >= 0) this.playLand(t, impact, 1);
  }

  /** Klang der Landung; Rückgabe: Pegel-Knoten (für das nachträgliche Abblenden offline). */
  private playLand(t: number, impact: number, level: number): GainNode {
    const loud = smoothstep(120, 900, impact);
    const ctx = this.ctx;
    const cancel = makeGain(ctx, level);
    cancel.connect(this.out);

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(90, t);
    osc.frequency.exponentialRampToValueAtTime(50, t + 0.08);
    const env = makeGain(ctx, 0);
    const end = percEnvelope(env.gain, t, 0.36 * loud, 0.002, 0.032);
    osc.connect(env).connect(cancel);
    osc.start(t);
    osc.stop(end);

    const click = noiseBurst(ctx, this.noise, this.rng, t, 0.2);
    const bp = makeFilter(ctx, 'bandpass', 2200, 0.9);
    const cEnv = makeGain(ctx, 0);
    percEnvelope(cEnv.gain, t, 0.13 * loud, 0.0006, 0.006);
    // Harte Landungen bekommen Körper (tiefes Rauschen).
    const body = makeFilter(ctx, 'lowpass', 380, 0);
    const bEnv = makeGain(ctx, 0);
    percEnvelope(bEnv.gain, t, 0.17 * smoothstep(0.4, 1, loud), 0.003, 0.02);
    click.connect(bp).connect(cEnv).connect(cancel);
    click.connect(body).connect(bEnv).connect(cancel);
    releaseWhenEnded([osc, click], [env, bp, cEnv, body, bEnv, cancel]);
    return cancel;
  }

  private footstep(t: number, speed: number, left: boolean): void {
    const ctx = this.ctx;
    const r = this.rng;
    const loud = 0.03 + 0.03 * smoothstep(100, 320, speed);
    const pan = makePanner(ctx, left ? -0.28 : 0.28);
    pan.connect(this.out);
    const src = noiseBurst(ctx, this.noise, r, t, 0.12);
    const lp = makeFilter(ctx, 'lowpass', 1100 * (0.8 + 0.4 * r()), 0);
    const hp = makeFilter(ctx, 'highpass', 160, 0);
    const nEnv = makeGain(ctx, 0);
    percEnvelope(nEnv.gain, t, loud, 0.002, 0.016);
    src.connect(lp).connect(hp).connect(nEnv).connect(pan);
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 78 + 10 * r();
    const oEnv = makeGain(ctx, 0);
    const end = percEnvelope(oEnv.gain, t, loud * 0.9, 0.002, 0.02);
    osc.connect(oEnv).connect(pan);
    osc.start(t);
    osc.stop(end);
    releaseWhenEnded([src, osc], [lp, hp, nEnv, oEnv, pan]);
  }

  private duck(t: number, down: boolean): void {
    // Crouch-Jumps ducken bei jedem Hop — nur gelegentlich rascheln.
    if (t - this.lastDuck < 0.25) return;
    this.lastDuck = t;
    const ctx = this.ctx;
    const src = noiseBurst(ctx, this.noise, this.rng, t, 0.12);
    const bp = makeFilter(ctx, 'bandpass', down ? 700 : 1100, 0.8);
    const env = makeGain(ctx, 0);
    percEnvelope(env.gain, t, down ? 0.035 : 0.022, 0.006, 0.015);
    src.connect(bp).connect(env).connect(this.out);
    releaseWhenEnded([src], [bp, env]);
  }

  // ------------------------------------------------------------ Lauf

  private runStart(t: number): void {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(85, t);
    osc.frequency.exponentialRampToValueAtTime(42, t + 0.15);
    const env = makeGain(ctx, 0);
    const end = percEnvelope(env.gain, t, 0.22, 0.002, 0.06);
    osc.connect(env).connect(this.out);
    osc.start(t);
    osc.stop(end);
    const src = noiseBurst(ctx, this.noise, this.rng, t, 0.2);
    const lp = makeFilter(ctx, 'lowpass', 1500, 0);
    const nEnv = makeGain(ctx, 0);
    percEnvelope(nEnv.gain, t, 0.08, 0.001, 0.02);
    src.connect(lp).connect(nEnv).connect(this.out);
    releaseWhenEnded([osc, src], [env, lp, nEnv]);
    this.bell(t + 0.01, 81, 0.05);
  }

  /** Arpeggio A C E A mit Delay (+6 dB) und darüber ein breiter Stab-Akkord; die Musik duckt kurz. */
  private checkpoint(t: number): void {
    this.mixer.rewardDuck(t, 3.5, 0.2);
    const notes = [81, 84, 88, 93] as const;
    for (let i = 0; i < notes.length; i++) this.bell(t + i * 0.065, notes[i], 0.24 - i * 0.024);
    this.stabs.hit(t, 0.6, CHORD_AM9_UP, 1, 1, 0.1, 0.14);
  }

  private bell(t: number, midi: number, vel: number): void {
    const ctx = this.ctx;
    const f = midiToHz(midi);
    const env = makeGain(ctx, 0);
    const end = percEnvelope(env.gain, t, vel, 0.002, 0.22);
    const oscs: OscillatorNode[] = [];
    const partials = [
      [1, 1],
      [2, 0.28],
      [3.01, 0.1],
    ] as const;
    const gains: GainNode[] = [];
    for (const [mul, amp] of partials) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f * mul;
      const g = makeGain(ctx, amp);
      o.connect(g).connect(env);
      o.start(t);
      o.stop(end);
      oscs.push(o);
      gains.push(g);
    }
    env.connect(this.out);
    const dSend = makeGain(ctx, 0.45);
    const vSend = makeGain(ctx, 0.3);
    env.connect(dSend).connect(this.mixer.sfxDelay);
    env.connect(vSend).connect(this.mixer.sfxVerb);
    releaseWhenEnded(oscs, [...gains, env, dSend, vSend]);
  }

  private finish(t: number): void {
    this.mixer.rewardDuck(t, 4, 0.25);
    this.stabs.hit(t, 0.3, CHORD_AM9, 0.6, 1);
    this.fx.crash(t + 0.004, 0.36);
    this.fx.riser(t + 0.05, 1.4, 0.14);
    const notes = [69, 72, 76, 81, 84, 88] as const;
    for (let i = 0; i < notes.length; i++) this.bell(t + 0.12 + i * 0.07, notes[i], 0.08);
  }

  /**
   * Fallender Whoosh; die Musik macht parallel den Tape-Stop (Mixer). Voll nur
   * nach einem längeren Lauf ('fall'/'kill'); Restart und Respawn-Serien
   * (Übungs-Loop, "noch ein Versuch") bekommen einen kurzen Schluckauf —
   * sonst klänge der Track in genau diesem Kern-Loop dauernd dumpf.
   */
  private respawn(t: number, reason: RespawnReason): void {
    const series = t - this.lastRespawn < RESPAWN_SERIES;
    this.lastRespawn = t;
    this.pendingLand = null;
    this.landHold.take();
    const hop = this.windHop.gain;
    hop.cancelScheduledValues(t);
    hop.setTargetAtTime(1, t, 0.05);
    // Voll nur beim echten Absturz — Neustart und die Checkpoint-Taste sind gewollt, kein Scheitern.
    const full = (reason === 'fall' || reason === 'kill') && !series;
    this.mixer.tapeStop(t, full ? 'full' : 'light');
    const len = full ? 1 : 0.6;
    const lvl = full ? 1 : 0.55;
    const ctx = this.ctx;
    const src = noiseBurst(ctx, this.noise, this.rng, t, 0.6 * len);
    const bp = makeFilter(ctx, 'bandpass', 2500, 1.4);
    bp.frequency.setValueAtTime(2600, t);
    bp.frequency.exponentialRampToValueAtTime(170, t + 0.45 * len);
    const env = makeGain(ctx, 0);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.2 * lvl, t + 0.04);
    env.gain.setValueAtTime(0.2 * lvl, t + 0.2 * len);
    env.gain.linearRampToValueAtTime(0, t + 0.5 * len);
    src.connect(bp).connect(env).connect(this.out);
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(420, t);
    osc.frequency.exponentialRampToValueAtTime(55, t + 0.42 * len);
    const oEnv = makeGain(ctx, 0);
    oEnv.gain.setValueAtTime(0, t);
    oEnv.gain.linearRampToValueAtTime(0.1 * lvl, t + 0.02);
    oEnv.gain.linearRampToValueAtTime(0, t + 0.45 * len);
    osc.connect(oEnv).connect(this.out);
    osc.start(t);
    osc.stop(t + 0.47 * len);
    releaseWhenEnded([src, osc], [bp, env, oEnv]);
  }

  /**
   * Zap nach Meilenstein: eine Oktave höher als früher, als Stereo-Doppel (±9 Cent),
   * Filter reißt mit auf (Laser-Sweep), 90 ms Ausklang — sonst ging er in L3/L4 unter.
   * Die Musik duckt kurz.
   */
  private zap(t: number, speed: number): void {
    const ctx = this.ctx;
    this.mixer.rewardDuck(t, 3, 0.15);
    const idx = clamp(Math.round(speed / 250) - 2, 0, ZAP_NOTES.length - 1);
    const f = midiToHz(ZAP_NOTES[idx]);
    const env = makeGain(ctx, 0);
    const end = percEnvelope(env.gain, t, 0.55, 0.002, 0.09, 0.02);
    const oscs: OscillatorNode[] = [];
    const nodes: AudioNode[] = [env];
    for (const side of [-1, 1] as const) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.detune.value = side * 9;
      osc.frequency.setValueAtTime(f, t);
      osc.frequency.exponentialRampToValueAtTime(2 * f, t + 0.06);
      const lp = makeFilter(ctx, 'lowpass', 2 * f, 6);
      lp.frequency.setValueAtTime(2 * f, t);
      lp.frequency.exponentialRampToValueAtTime(Math.min(9 * f, 14000), t + 0.08);
      const g = makeGain(ctx, 0.5);
      const pan = makePanner(ctx, side * 0.55);
      osc.connect(lp).connect(g).connect(pan).connect(env);
      osc.start(t);
      osc.stop(end);
      oscs.push(osc);
      nodes.push(lp, g, pan);
    }
    env.connect(this.out);
    const send = makeGain(ctx, 0.35);
    env.connect(send).connect(this.mixer.sfxDelay);
    nodes.push(send);
    releaseWhenEnded(oscs, nodes);
  }
}

