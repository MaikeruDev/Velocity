import type { EnergyModel } from './energy';
import { LAYER_HYSTERESIS, LAYER_THRESHOLDS, MAX_LAYER, layerForEnergy, layerToHold } from './energy';
import type { Mixer } from './Mixer';
import type { MusicDrive } from './types';
import { clamp, clamp01, createNoiseBuffer, createRng, expLerp, lerp, makeFilter, makeGain, makePanner, smoothstep, type Rng } from './dsp';
import { Acid } from './instruments/Acid';
import { Bass } from './instruments/Bass';
import { Clap } from './instruments/Clap';
import { Fx, type RiserHandle } from './instruments/Fx';
import { Hats } from './instruments/Hats';
import { Kick } from './instruments/Kick';
import { Pad } from './instruments/Pad';
import { Perc } from './instruments/Perc';
import { Ride } from './instruments/Ride';
import { CHORD_AM11, CHORD_AM9, Stabs } from './instruments/Stabs';
import {
  AcidLine,
  BassLine,
  makePercPattern,
  PAD_CHORDS,
  pickFill,
  pickStabFigure,
  type FillType,
  type PercPattern,
} from './patterns';

export const BPM = 132;

/** Beat-Raster, auf das Musik-Ereignisse (Outro-Downbeat) gelegt werden. Der Sequencer erfüllt das. */
export interface BeatClock {
  readonly originTime: number;
  readonly stepDur: number;
}

/** Velocity-Akzente der geschlossenen Hats pro 16tel im Beat: das "und" trägt. */
const HAT_ACCENTS = [0.55, 0.32, 0.95, 0.4] as const;
const SHAKER_ACCENTS = [0.45, 0.3, 0.75, 0.38] as const;
const BASS_ACCENTS = [0, 0.8, 1, 0.8] as const;
/** Leichter Swing auf 16tel-Offbeats (Anteil eines 16tels) — nur Hats/Shaker/Perc, Kick und Bass bleiben gerade. */
const SWING = 0.045;

const KICK_LOG = 16;
const LAYER_LOG = 16;
/** Langer Riser setzt so weit unter der L4-Schwelle ein (Energie). */
const RISER_WINDOW = 0.12;
/** Unter diesem Fortschritt ist ein langer Riser noch zu leise, um selbst in den Overdrive zu führen. */
const RISER_CARRIES = 0.45;
const EPS = 1e-6;

/**
 * Surf-Abschnitt endet erst nach so langer Luft ohne Surf (oder mit Bodenkontakt).
 * Rampenketten in Level 2 haben Flugphasen von 0.43–0.62 s zwischen den Flanken
 * (Aufzeichnungen l2/l2mid) — dort soll kein Drop kommen, sonst crasht es alle 1.5 s.
 */
const SURF_GAP = 0.8;
/** Ein bereits geplanter Beat darf nachträglich einen Drop/Akzent bekommen, wenn er so weit in der Zukunft liegt. */
const RETRO_MARGIN = 0.006;
/** Kick im Stand: ~9 dB leiser als im Groove — Stillstand ist ein Breakdown, kein Metronom. */
const L0_KICK = 0.31;
/** Outro: so viele Takte ohne Kick (Stab-Akkord, Pad, Hall), dann der Nebenraum-Loop. */
const OUTRO_BREAK_BARS = 2;
/** Energie, auf die der Raumfilter im Nebenraum-Loop des Outros zurückgeht. */
const NEBENRAUM_ENERGY = 0.12;
/** Mini-Drop beim Loslaufen erst nach so vielen Takten Stand. */
const MINI_DROP_IDLE_BARS = 2;
/** Respawns in dichterer Folge = Übungs-Loop: dann kein Mini-Drop. */
const RESPAWN_SERIES = 8;
/** L4+: über 1000 u/s geht der Acid weiter auf, eine zweite Stab-Figur kommt dazu. */
const PLUS_FROM = 1000;
const PLUS_FULL = 1300;
/** Drop nach dem Surf: ein Takt Stabs auf diesen 16teln. */
const DROP_STABS: readonly number[] = [0, 3, 6, 10, 14];
/** Steigende Terz (A5 → C6) für einen Checkpoint vor der Bestzeit. */
const THIRD_UP: readonly (readonly number[])[] = [[81], [84]];
const CHORD_AM9_UP: readonly number[] = CHORD_AM9.map((n) => n + 12);

/** Gruppen, die sich zum Abhören/Messen stummschalten lassen. */
export type MusicPart = 'kick' | 'hats' | 'clap' | 'perc' | 'bass' | 'rumble' | 'acid' | 'ride' | 'shaker' | 'stabs' | 'pad' | 'fx';

/** Was das Arrangement in einem Beat spielt. */
type Mode = 'normal' | 'breakdown' | 'outroBreak' | 'outroLoop';

/**
 * Das Arrangement: entscheidet pro 16tel, was spielt. Layer steigen auf den
 * nächsten Beat (sofortige Belohnung), fallen erst auf einer Taktgrenze nach
 * ≥ 2 Takten unter der Schwelle (ein kurzer Fehler killt den Flow nicht) und
 * dann eine Stufe pro Takt.
 *
 * Ausnahme Overdrive (L4): Er kommt im Spiel fast immer sprunghaft (Chain 8,
 * Sync) — ein Riser über Takte hätte keine Zeit. Deshalb läuft ab dem
 * nächsten Beat ein Anlauf (ein Beat Rausch-Sweep plus Clap-Roll, sofort
 * hörbar), und genau einen Beat später landet der Crash mit L4. Nähert sich
 * die Energie langsam, trägt ein langer Riser (2 Takte) den Aufbau schon vorher.
 *
 * Surf ist ein eigener Zustand: ab dem ersten Beat nach ≥ 1 Beat Surf ein
 * Breakdown (Kick, Bass, Clap raus; Pad und Acid auf; Riser an die Surf-Speed
 * gekoppelt). Endet der Surf-Abschnitt (Boden oder SURF_GAP in der Luft), kommt
 * auf dem nächsten Beat der Drop: volle Kick, Crash, ein Takt Stabs. Steigt die
 * Energie im Surf auf L4, ist der Drop die Ankunft.
 *
 * Ziel: Outro statt Pausen-Dumpf — auf dem nächsten Downbeat Schlussakkord
 * (Bestzeit: Riser davor, Crash, Oktav-Stab), 2 Takte ohne Kick, dann ein
 * Nebenraum-Loop.
 */
export class Music {
  readonly stepDur: number;
  readonly beatDur: number;
  readonly barDur: number;

  private readonly kick: Kick;
  private readonly hats: Hats;
  private readonly clap: Clap;
  private readonly ride: Ride;
  private readonly perc: Perc;
  private readonly bass: Bass;
  private readonly acid: Acid;
  private readonly stabs: Stabs;
  private readonly pad: Pad;
  private readonly fx: Fx;

  private rng: Rng;
  private readonly human: Rng;
  private acidLine: AcidLine;
  private bassLine: BassLine;
  private stabFigure: readonly number[];
  private stabFigure2: readonly number[];
  private percPattern: PercPattern;
  private fill: FillType;
  private pendingSeed: number | null = null;
  private clock: BeatClock | null = null;

  private layer = 0;
  private layerSince = 0;
  private belowBeats = 0;
  private prevBeatEnergy = 0;
  private riser: RiserHandle | null = null;
  private leadSweep: RiserHandle | null = null;
  /** Zeitpunkt, an dem der laufende Overdrive-Anlauf ankommt (−1 = keiner). */
  private leadInAt = -1;
  private leadInFrom = -1;
  private lastRiserBar = -100;
  private lastFillBar = -100;
  /** Zuletzt geplanter Takt/Beat — erkennt Taktanfänge auch, wenn deren erstes 16tel verworfen wurde. */
  private lastBar = -1;
  private lastBeat = -1;
  /** Zeit des zuletzt geplanten Beats und was er spielte (für nachträgliche Drops/Akzente). */
  private lastBeatTime = Number.NEGATIVE_INFINITY;
  private lastBeatMode: Mode = 'normal';
  private lastStepTime = Number.NEGATIVE_INFINITY;
  /** Bis dahin klingt der aktuelle Pad-Akkord. */
  private padUntil = Number.NEGATIVE_INFINITY;
  private mode: Mode = 'normal';

  // --- Surf-Breakdown
  private surfing = false;
  private surfSince = Number.NEGATIVE_INFINITY;
  private surfEndAt = Number.NEGATIVE_INFINITY;
  private onGround = true;
  private speed = 0;
  private breakdown = false;
  private breakdownSince = Number.NEGATIVE_INFINITY;
  private pendingDrop = false;
  private dropAt = Number.NEGATIVE_INFINITY;
  private readonly surfBP: BiquadFilterNode;
  private readonly surfRiser: GainNode;
  private riserSetAt = Number.NEGATIVE_INFINITY;
  private riserLevel = 0;
  /** Pad/Acid offen (Breakdown, Outro) und L4+-Anteil — wirken über setEnergy. */
  private open = 0;
  private plus = 0;
  private toneOpen = -1;
  private tonePlus = -1;

  // --- Outro
  private outro: 'none' | 'pending' | 'on' = 'none';
  private outroAt = Number.NEGATIVE_INFINITY;
  private outroBar = -1;
  private outroBest = false;

  // --- Akzente
  private accentSplit: number | null = null;
  private accentPending = false;
  private layer0Since = 0;
  private miniDropAt = -1;
  private lastRespawn = Number.NEGATIVE_INFINITY;
  private prevRespawn = Number.NEGATIVE_INFINITY;

  private readonly kickTimes = new Float64Array(KICK_LOG).fill(Number.NEGATIVE_INFINITY);
  private readonly kickVels = new Float32Array(KICK_LOG);
  private kickIdx = 0;
  private readonly layerTimes = new Float64Array(LAYER_LOG).fill(Number.NEGATIVE_INFINITY);
  private readonly layerVals = new Uint8Array(LAYER_LOG);
  private layerIdx = 0;

  private readonly muted = new Set<MusicPart>();

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly mixer: Mixer,
    private readonly energy: EnergyModel,
    seed: number,
    /** Startzeit der Dauer-Oszillatoren (Ride-Bank, Acid, Pad-LFO) — ihre Pegel stehen auf 0. */
    startAt: number,
  ) {
    this.beatDur = 60 / BPM;
    this.stepDur = this.beatDur / 4;
    this.barDur = this.beatDur * 4;
    const noise = createNoiseBuffer(ctx, 2, createRng(seed ^ 0x5eed), 1);
    this.human = createRng(seed + 101);
    const voiceRng = createRng(seed + 202);
    this.rng = createRng(seed);

    this.kick = new Kick(ctx, noise, voiceRng, mixer.drums, mixer.rumbleGate);
    this.hats = new Hats(ctx, noise, voiceRng, mixer.drums, mixer.drumVerb);
    this.clap = new Clap(ctx, noise, voiceRng, mixer.drums, mixer.hall);
    this.ride = new Ride(ctx, mixer.drums, mixer.drumVerb, startAt);
    this.perc = new Perc(ctx, noise, voiceRng, mixer.drums, mixer.drumVerb);
    this.bass = new Bass(ctx, mixer.duckHeavy);
    this.acid = new Acid(ctx, mixer.duckLight, mixer.delay, startAt);
    this.stabs = new Stabs(ctx, mixer.duckLight, mixer.delay, mixer.hall);
    this.pad = new Pad(ctx, mixer.duckHeavy, mixer.hall, startAt);
    this.fx = new Fx(ctx, noise, voiceRng, mixer.drums, mixer.hall);

    // Surf-Riser: Dauerstimme (Rauschen → Bandpass), Pegel steht auf 0 bis zum Breakdown.
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    src.start(startAt, 0.37);
    this.surfBP = makeFilter(ctx, 'bandpass', 600, 2.2);
    this.surfRiser = makeGain(ctx, 0);
    const pan = makePanner(ctx, 0.15);
    src.connect(this.surfBP).connect(this.surfRiser).connect(pan).connect(mixer.drums);
    const send = makeGain(ctx, 0.5);
    pan.connect(send).connect(mixer.hall);

    this.acidLine = new AcidLine(createRng(seed + 1));
    this.bassLine = new BassLine(createRng(seed + 2));
    this.stabFigure = pickStabFigure(this.rng);
    this.stabFigure2 = pickStabFigure(this.rng);
    this.percPattern = makePercPattern(createRng(seed + 3));
    this.fill = pickFill(this.rng);
  }

  get currentLayer(): number {
    return this.layer;
  }

  /** Breakdown (Surf) gerade aktiv — Dev/Messung. */
  get inBreakdown(): boolean {
    return this.breakdown;
  }

  /** Ergebnis-Zustand nach 'finish' (Outro geplant oder läuft). */
  get inOutro(): boolean {
    return this.outro !== 'none';
  }

  /** Ab hier darf der Ergebnis-Screen weich filtern (ca. 4 Takte nach dem Ziel). */
  get resultMenuFrom(): number {
    return this.outroAt + (OUTRO_BREAK_BARS + 2) * this.barDur;
  }

  /** Beat-Raster (vom Sequencer, nach dem Aufbau gesetzt). */
  setClock(clock: BeatClock): void {
    this.clock = clock;
  }

  /** Zum Abhören einzelner Spuren (Dev-Seite, Messungen). */
  setMuted(part: MusicPart, muted: boolean): void {
    if (muted) this.muted.add(part);
    else this.muted.delete(part);
    if (part === 'rumble') this.applyRumbleGate(this.ctx.currentTime);
    if (part === 'kick') this.kick.setMuted(muted, this.ctx.currentTime);
    // Monophone Acid-Stimme: ein offenes Slide-Gate würde sonst weiterklingen.
    if (part === 'acid' && muted) this.acid.silenceNow(this.ctx.currentTime);
    if (part === 'fx' && muted) this.surfRiser.gain.setTargetAtTime(0, this.ctx.currentTime, 0.01);
  }

  private on(part: MusicPart): boolean {
    return !this.muted.has(part);
  }

  /** Neue Patterns ab dem nächsten Takt (z. B. pro Level eigene Acid-Linie). */
  reseed(seed: number): void {
    this.pendingSeed = seed >>> 0;
  }

  /** Offline/Tests: Layer sofort passend zur Energie setzen, ohne Übergangs-Effekte. */
  settleLayer(t: number): void {
    this.layer = layerForEnergy(this.energy.value);
    this.layerSince = t;
    this.layer0Since = t;
    this.prevBeatEnergy = this.energy.value;
    this.logLayer(t, this.layer);
    this.mixer.setLayerLift(this.layer, t);
    this.applyRumbleGate(t);
  }

  /** Kontinuierliche, energieabhängige Klangparameter. */
  setEnergy(e: number, t: number, tau: number): void {
    this.acid.setTone(e, t, tau, this.open, this.plus);
    this.toneOpen = this.open;
    this.tonePlus = this.plus;
    this.kick.setDrive(e, t, tau);
    this.pad.setLevel(e, t, tau);
  }

  /** Haben sich Breakdown-Öffnung oder L4+ seit dem letzten setEnergy geändert? */
  get toneDirty(): boolean {
    return Math.abs(this.open - this.toneOpen) > 0.01 || Math.abs(this.plus - this.tonePlus) > 0.02;
  }

  /**
   * Zustand aus dem Drive (pro Frame bzw. pro 16tel offline): Surf, Boden,
   * Tempo. Der Drive ist die Wahrheit — Events verfeinern nur den Zeitpunkt.
   */
  setDrive(d: MusicDrive, t: number): void {
    this.setSurfing(d.surfing, t);
    this.onGround = d.onGround;
    this.speed = d.speed;
    this.plus = this.layer >= MAX_LAYER && this.mode === 'normal' ? smoothstep(PLUS_FROM, PLUS_FULL, d.speed) : 0;
    this.checkDrop(t);
    this.updateSurfRiser(t);
  }

  /** surfStart/surfEnd: Zeitpunkt genau am Tick statt am nächsten Frame. */
  setSurfing(surfing: boolean, t: number): void {
    if (surfing === this.surfing) return;
    this.surfing = surfing;
    if (surfing) this.surfSince = t;
    else this.surfEndAt = t;
  }

  /** Landung: Bodenkontakt beendet einen Surf-Abschnitt sofort. */
  onLand(t: number): void {
    this.onGround = true;
    this.checkDrop(t);
  }

  /** Checkpoint: Akzent auf dem nächsten Beat; vor der Bestzeit (split < 0) eine steigende Terz. */
  checkpoint(t: number, split: number | null): void {
    if (this.outro !== 'none') return;
    this.accentSplit = split;
    this.accentPending = true;
    // Ist der nächste Beat schon geplant, aber noch nicht hörbar: dort nachtragen.
    if (this.lastBeatTime > t + RETRO_MARGIN) this.playAccent(this.lastBeatTime);
  }

  /**
   * Ziel: das Outro landet auf dem nächsten Downbeat (Bestzeit: mindestens ein
   * Beat Vorlauf für den Riser). Ein laufender Breakdown bleibt bis dorthin —
   * das Outro ist sein Drop.
   */
  finish(t: number, best: boolean): void {
    if (this.outro !== 'none') return;
    this.pendingDrop = false;
    this.accentPending = false;
    const from = Math.max(t + (best ? this.beatDur : 0.03), this.lastStepTime + 1e-4);
    this.outroAt = this.nextBarTime(from);
    this.outroBest = best;
    this.outro = 'pending';
    if (best && this.on('fx')) this.fx.riser(t, Math.max(this.beatDur, this.outroAt - t), 0.5, 1.6, 0.05);
  }

  /** Respawn/Restart: Breakdown und Outro enden ohne Drop; Respawn-Serien merken (Mini-Drop). */
  onRespawn(t: number): void {
    this.prevRespawn = this.lastRespawn;
    this.lastRespawn = t;
    this.cancelBreakdown(t);
    this.endOutro(t);
    this.accentPending = false;
    this.miniDropAt = -1;
  }

  /** Neues Level: wie Respawn, ohne die Serie zu zählen. */
  onLevelLoaded(t: number): void {
    this.cancelBreakdown(t);
    this.endOutro(t);
    this.accentPending = false;
  }

  /**
   * Raumfilter-Energie im Outro (Nebenraum-Loop nach dem Kick-freien Teil),
   * sonst null — dann gilt die normale Energie.
   */
  roomEnergy(t: number): number | null {
    if (this.outro !== 'on') return null;
    return t >= this.outroAt + OUTRO_BREAK_BARS * this.barDur - 0.05 ? NEBENRAUM_ENERGY : null;
  }

  /** Kick-Hüllkurve zum Zeitpunkt `heard` (für den Neon-Puls). */
  kickEnvelope(heard: number): number {
    let best = Number.NEGATIVE_INFINITY;
    let vel = 0;
    for (let i = 0; i < KICK_LOG; i++) {
      const k = this.kickTimes[i];
      if (k <= heard && k > best) {
        best = k;
        vel = this.kickVels[i];
      }
    }
    if (best === Number.NEGATIVE_INFINITY) return 0;
    return vel * Math.exp(-(heard - best) / 0.12);
  }

  /** Layer, der zum Zeitpunkt `heard` klingt (Planung läuft ~120 ms voraus). */
  layerAt(heard: number): number {
    let best = Number.NEGATIVE_INFINITY;
    let val = 0;
    for (let i = 0; i < LAYER_LOG; i++) {
      const lt = this.layerTimes[i];
      if (lt <= heard && lt > best) {
        best = lt;
        val = this.layerVals[i];
      }
    }
    return val;
  }

  onStep(step: number, t: number): void {
    const e = this.energy.value;
    const s16 = step % 16;
    const sub = s16 % 4;
    const beatInBar = s16 >> 2;
    const bar = Math.floor(step / 16);
    this.lastStepTime = t;
    // Taktanfang und Beat am ersten GEPLANTEN Schritt erkennen, nicht nur an s16 === 0:
    // verwirft der Sequencer nach einem Ruckler den Taktanfang, laufen Phrasen,
    // Seeds, Layer-Abstieg und Pad trotzdem weiter.
    const newBar = bar !== this.lastBar;
    if (newBar) {
      this.lastBar = bar;
      this.onBar(bar, t);
    }
    const beat = Math.floor(step / 4);
    if (beat !== this.lastBeat) {
      this.lastBeat = beat;
      this.onBeat(bar, t, e, newBar);
    }

    const mode = this.mode;
    const normal = mode === 'normal';
    // Outro: kick-freier Teil hell wie L4 (Hats, Ride, Shaker), Nebenraum-Loop wie L2.
    const L = mode === 'outroBreak' ? 4 : mode === 'outroLoop' ? 2 : this.layer;
    const kickOut = mode === 'breakdown' || mode === 'outroBreak';
    const h = this.human;
    const sw = sub % 2 === 1 ? SWING * this.stepDur : 0;
    const fillBeat = normal && L >= 4 && bar % 8 === 7 && beatInBar === 3;
    const leadIn = normal && this.leadInAt >= 0 && t >= this.leadInFrom - EPS && t < this.leadInAt - EPS;

    // --- Kick + Sidechain ---
    if (sub === 0 && !kickOut) {
      const drop = fillBeat && this.fill === 'kickDrop';
      if (!drop) this.playKick(t, L === 0 ? L0_KICK : mode === 'outroLoop' ? 0.72 : 0.95, e);
      if (drop && this.on('fx')) this.fx.swell(t, this.beatDur, 0.22);
    }

    // --- Hats ---
    if (this.on('hats')) {
      if (L === 0) {
        // Leise Achtel — durch die Wand hört man nur das "tss" auf dem Offbeat.
        if (sub === 2) this.hats.closed(t, 0.45 * (0.9 + 0.2 * h()), 0.032);
        else if (sub === 0) this.hats.closed(t, 0.18, 0.028);
      } else if (L >= 2 && sub === 2) {
        this.hats.open(t, (mode === 'outroBreak' ? 0.32 : L >= 3 ? 0.24 : 0.21) * (0.92 + 0.16 * h()), lerp(0.2, 0.3, smoothstep(0.3, 1, e)));
      } else {
        const decay = lerp(0.03, 0.05, e);
        // L4: Ride und Shaker tragen die Höhen mit — Hats etwas zurück, sonst wird es spitz. Schlussteil ohne Kick: Hats vorn.
        const lvl = mode === 'outroBreak' ? 0.45 : L >= 4 ? 0.3 : L >= 3 ? 0.38 : 0.32;
        this.hats.closed(t + sw, HAT_ACCENTS[sub] * lvl * (0.88 + 0.24 * h()), decay);
      }
    }

    // --- Nebenraum-Fetzen im Stand: alle 8 Takte ein paar Claps und ein Stab durch die Wand ---
    if (normal && L === 0) {
      if (bar % 8 === 4 && sub === 0 && (beatInBar === 1 || beatInBar === 3) && this.on('clap')) this.clap.trigger(t, 1.2);
      if (bar % 8 === 6 && s16 === 6 && this.on('stabs')) this.stabs.hit(t, 0.55, CHORD_AM9, 0.3, 0.2);
    }

    // --- Clap 2 & 4 ---
    if (L >= 2 && !kickOut && this.on('clap')) {
      const rollNow = (fillBeat && this.fill === 'clapRoll') || leadIn;
      const vel = mode === 'outroLoop' ? 1.0 : 1.5;
      if (sub === 0 && (beatInBar === 1 || beatInBar === 3) && !rollNow) this.clap.trigger(t, vel);
      // Ghost-Clap vor dem Takt 1 der nächsten 4er-Gruppe.
      if (normal && L >= 3 && s16 === 15 && bar % 4 === 3 && !fillBeat && !leadIn) this.clap.trigger(t, 0.45);
    }

    // --- Overdrive-Anlauf: Clap-Roll in 16teln, zum Ende 32tel, Tonhöhe steigt in den Crash ---
    if (leadIn && this.on('clap')) {
      this.clap.trigger(t, 0.42 + 0.2 * sub, 1 + 0.16 * sub);
      if (sub >= 2) this.clap.trigger(t + this.stepDur / 2, 0.52 + 0.2 * sub, 1.08 + 0.16 * sub);
    }

    // --- Bestzeit: derselbe Roll im letzten Beat vor dem Schlussakkord (hörbar anders als ein normales Ziel) ---
    const bestRoll = this.outro === 'pending' && this.outroBest && t >= this.outroAt - this.beatDur - EPS && t < this.outroAt - EPS;
    if (bestRoll && this.on('clap')) {
      this.clap.trigger(t, 0.5 + 0.2 * sub, 1.05 + 0.16 * sub);
      this.clap.trigger(t + this.stepDur / 2, 0.58 + 0.2 * sub, 1.12 + 0.16 * sub);
    }

    // --- Percussion (breit: ±0.6, Rim gegenüber) ---
    if (L >= 2 && this.on('perc')) {
      const p = this.percPattern;
      const side = s16 % 8 < 4 ? -0.6 : 0.6;
      if (p.conga[s16]) this.perc.conga(t + sw, p.congaNotes[s16], 0.26 * (0.85 + 0.3 * h()), side);
      if (p.rim[s16]) this.perc.rim(t + sw, 0.24 * (0.85 + 0.3 * h()), -side * 0.9);
    }

    // --- Rolling Bass ---
    if (L >= 1 && !kickOut && this.on('bass')) {
      const n = this.bassLine.note(bar, s16, L);
      if (n !== null) {
        const cutoff = lerp(170, 950, smoothstep(0.12, 0.75, e));
        const envMul = 1.8 + 2.6 * smoothstep(0.25, 1, e);
        this.bass.note(t, n, BASS_ACCENTS[sub] * 0.16, cutoff, envMul, this.stepDur);
      }
    }

    // --- Acid (im Breakdown und im Schlussteil ohne Kick weiter, mit offenem Filter) ---
    if (this.layer >= 3 && mode !== 'outroLoop' && this.on('acid')) {
      const vel = 0.9 + 0.1 * h();
      this.acid.step(t, this.stepDur, this.acidLine.note(s16), vel);
    }

    // --- Ride (Offbeat-Achtel) + Shaker ---
    if (L >= 3) {
      // In L3 trägt die Ride die Höhen (der Acid-Squelch sitzt in den Mitten), in L4 teilt sie sie mit Stabs und Acid-Schrei.
      const ride = L >= 4 ? 0.7 : 0.85;
      if (this.on('ride') && sub === 2) this.ride.trigger(t, ride * (0.9 + 0.2 * h()));
      // Schlussteil ohne Kick: Ride auf jedem Viertel kräftig — die Höhen tragen das Outro (nicht der Pausen-Dumpf).
      if (this.on('ride') && L >= 4 && sub === 0) this.ride.trigger(t, mode === 'outroBreak' ? 0.65 : 0.3);
      // L4 etwas leiser: dort tragen Ride, offene Hats und der Acid-Schrei schon die Höhen.
      if (this.on('shaker')) this.hats.shaker(t + sw, SHAKER_ACCENTS[sub] * (L >= 4 ? 0.44 : 0.52) * (0.85 + 0.3 * h()));
    }

    // --- Stabs (synkopiert, alle 2 Takte; L4+ mit zweiter, hoher Figur) ---
    if (normal && L >= 4 && this.on('stabs')) {
      const chord = Math.floor(bar / 8) % 2 === 0 ? CHORD_AM9 : CHORD_AM11;
      if (this.stabFigure.includes(step % 32)) this.stabs.hit(t, 0.52, chord, 0.25 + 0.6 * smoothstep(0.86, 1, e), smoothstep(0.75, 1, e));
      else if (this.plus > 0.5 && this.stabFigure2.includes(step % 32)) this.stabs.hit(t, 0.4, CHORD_AM9_UP, 0.85, 1);
    }

    // --- Drop nach dem Surf: ein Takt Stabs ---
    const sinceDrop = Math.round((t - this.dropAt) / this.stepDur);
    if (normal && sinceDrop >= 0 && sinceDrop < 16 && this.on('stabs') && DROP_STABS.includes(sinceDrop)) {
      this.stabs.hit(t, 0.5, CHORD_AM9, 0.8, 1);
    }

    // --- Fills (letzter Beat jeder 8-Takt-Phrase im Overdrive) ---
    if (fillBeat) {
      this.lastFillBar = bar;
      if (this.fill === 'clapRoll' && this.on('clap')) {
        this.clap.trigger(t, 0.5 + 0.2 * sub, 1 + 0.18 * sub);
        if (sub >= 2) this.clap.trigger(t + this.stepDur / 2, 0.4 + 0.18 * sub, 1.1 + 0.18 * sub);
      } else if (this.fill === 'tomRun' && this.on('perc')) {
        const notes = [64, 62, 60, 57] as const;
        this.perc.conga(t, notes[sub], 0.5, sub % 2 === 0 ? -0.5 : 0.5);
      }
    }

    // --- Pad: minimale Schleife, 4 Takte je Akkord ---
    // Nicht nur auf Schritt 0 der 4er-Gruppe: klingt gerade keiner (Taktanfang
    // verworfen, Start nach Ruckler, Pad war stumm), setzt der Akkord am nächsten
    // Takt für den Rest der Gruppe ein. Das Pad ist in L0 und im Menü der einzige Ton.
    if (newBar && this.on('pad') && t >= this.padUntil - 1e-3) {
      const left = 4 - (bar % 4);
      const chord = PAD_CHORDS[Math.floor(bar / 4) % PAD_CHORDS.length];
      this.pad.chord(t, chord, this.barDur * left, 0.15);
      this.padUntil = t + this.barDur * left;
    }
  }

  private onBar(bar: number, t: number): void {
    if (this.pendingSeed !== null) {
      const s = this.pendingSeed;
      this.pendingSeed = null;
      this.rng = createRng(s);
      this.acidLine.reseed(createRng(s + 1));
      this.bassLine = new BassLine(createRng(s + 2));
      this.percPattern = makePercPattern(createRng(s + 3));
      this.stabFigure = pickStabFigure(this.rng);
      this.stabFigure2 = pickStabFigure(this.rng);
    }
    this.acidLine.onBar();
    this.acid.setWave(this.acidLine.squareMix, t);
    if (bar % 8 === 0) this.fill = pickFill(this.rng);
    if (bar % 16 === 0 && bar > 0 && this.rng() < 0.35) this.stabFigure = pickStabFigure(this.rng);

    if (this.outro === 'pending' && t >= this.outroAt - 1e-3) this.startOutro(bar, t);
    else if (this.outro === 'none' && !this.breakdown) {
      // Phrasenanfang nach einem Fill: Crash markiert den Neubeginn.
      if (this.layer >= 4 && bar === this.lastFillBar + 1 && this.on('fx')) this.fx.crash(t, 0.5);
      else if (this.layer >= 3 && bar % 16 === 0 && bar > 0 && this.on('fx')) this.fx.crash(t, 0.3);
    }
    if (this.miniDropAt >= 0 && t >= this.miniDropAt - 1e-3) {
      this.miniDropAt = -1;
      if (this.outro === 'none' && this.on('fx')) this.fx.crash(t, 0.4);
    }
  }

  private onBeat(bar: number, t: number, e: number, barStart: boolean): void {
    if (this.outro === 'on') {
      const mode: Mode = bar - this.outroBar < OUTRO_BREAK_BARS ? 'outroBreak' : 'outroLoop';
      if (mode !== this.mode) {
        this.mode = mode;
        this.applyRumbleGate(t);
        if (mode === 'outroLoop') {
          this.pad.setOpen(0.45, t, 1.2);
          this.acid.close(t);
          this.mixer.setLayerLift(2, t);
        }
      }
      this.energy.takePeak();
      this.prevBeatEnergy = e;
      this.markBeat(t);
      return;
    }

    // --- Surf-Breakdown und Drop (nicht mehr, sobald das Outro geplant ist) ---
    if (this.outro === 'none') {
      if (this.breakdown) {
        if (this.pendingDrop || this.dropReady(t)) this.drop(t, false);
      } else if (this.surfing && t - this.surfSince >= this.beatDur - EPS) {
        this.enterBreakdown(t);
      }
    }
    this.mode = this.breakdown ? 'breakdown' : 'normal';

    const thr4 = LAYER_THRESHOLDS[MAX_LAYER];
    const target = this.energy.target;

    // Anlauf vorbei: der Overdrive landet genau hier — oder bricht ab, wenn der Schwung weg ist.
    if (this.leadInAt >= 0 && t >= this.leadInAt - EPS) {
      this.leadInAt = -1;
      if (Math.max(e, target) >= thr4 - LAYER_HYSTERESIS[MAX_LAYER]) this.setLayer(MAX_LAYER, t, this.breakdown);
      else if (this.riser !== null) {
        this.riser.cut(t, 0.3);
        this.riser = null;
      }
    }

    // Aufstieg mit Latch: der höchste Wert seit dem letzten Beat zählt, nicht nur der Abtastwert.
    const up = layerForEnergy(this.energy.takePeak());
    const stay = layerToHold(e);
    // Abstieg nur, wenn auch das Ziel drunter liegt und die Energie nicht gerade steigt:
    // wer sich fängt und wieder Tempo aufbaut, verliert keine Spur (Flap im Aufwind).
    const falling = layerToHold(target) < this.layer && e <= this.prevBeatEnergy + 1e-4;
    // L4 steht fest, sobald die Ziel-Energie drüber liegt und die geglättete nah dran ist
    // (Attack 0.3 s: bis zur Ankunft einen Beat später ist sie praktisch da).
    const wantOverdrive = up >= MAX_LAYER || (this.layer >= 3 && target >= thr4 + 0.01 && e >= thr4 - RISER_WINDOW);
    if (this.layer < MAX_LAYER && wantOverdrive) {
      // Im Breakdown still aufsteigen: die Ankunft (Crash) ist der Drop am Ende des Surfs.
      if (this.breakdown) this.setLayer(MAX_LAYER, t, true);
      else {
        if (this.layer < 3) this.setLayer(3, t);
        if (this.leadInAt < 0) this.startLeadIn(t);
      }
      this.belowBeats = 0;
    } else if (up > this.layer) {
      this.setLayer(up, t, false, barStart);
      this.belowBeats = 0;
    } else if (stay < this.layer && falling) {
      this.belowBeats++;
      // ≥ 8 Beats (2 Takte) darunter und jetzt eine Taktgrenze: eine Stufe runter.
      // Danach je Takt eine weitere — der Track baut Schicht für Schicht ab statt abzureißen.
      if (barStart && this.belowBeats > 8) {
        this.setLayer(Math.max(stay, this.layer - 1), t);
        this.belowBeats = 5;
      }
    } else {
      this.belowBeats = 0;
    }

    // Langer Riser: L3 steht seit ≥ 1 Takt und die Energie läuft auf L4 zu.
    // Getimt auf die geschätzte Ankunft (Steigung des letzten Beats), damit er
    // nicht Takte vorher verpufft; kommt L4 doch nicht, klingt er einfach aus.
    const slope = (e - this.prevBeatEnergy) / this.beatDur;
    const eta = slope > 0.004 ? (thr4 - e) / slope : Number.POSITIVE_INFINITY;
    if (
      !this.breakdown &&
      this.layer === 3 &&
      this.leadInAt < 0 &&
      this.riser === null &&
      t - this.layerSince >= this.barDur - EPS &&
      e > thr4 - RISER_WINDOW &&
      eta >= this.barDur * 0.5 &&
      eta <= this.barDur * 2 &&
      bar - this.lastRiserBar >= 4 &&
      this.on('fx')
    ) {
      // + 1 Beat: auf die Überschreitung folgt noch der Anlauf-Beat bis zum Crash.
      // Die Schätzung ist eher zu früh (die Energie flacht zur Schwelle hin ab),
      // daher hält der Riser oben bis zu einem Takt, statt vorher zu verpuffen.
      const dur = clamp(eta + this.beatDur, this.barDur, this.barDur * 2);
      this.riser = this.fx.riser(t, dur, 0.4, 1.3, 0.3, this.barDur);
      this.lastRiserBar = bar;
    }
    if (this.riser !== null) {
      if (t >= this.riser.until) this.riser = null;
      else if (e < LAYER_THRESHOLDS[3]) {
        this.riser.cut(t, 0.4);
        this.riser = null;
      }
    }
    if (this.leadSweep !== null && t >= this.leadSweep.until) this.leadSweep = null;
    if (this.accentPending) this.playAccent(t);
    this.prevBeatEnergy = e;
    this.markBeat(t);
  }

  private markBeat(t: number): void {
    this.lastBeatTime = t;
    this.lastBeatMode = this.mode;
  }

  /** Ein Beat Anlauf in den Overdrive: Sweep (sofern kein langer Riser schon trägt); den Clap-Roll spielt onStep. */
  private startLeadIn(t: number): void {
    this.leadInFrom = t;
    this.leadInAt = t + this.beatDur;
    const r = this.riser;
    if (r !== null && (t - r.start) / (r.end - r.start) < RISER_CARRIES) {
      r.cut(t, 0.1);
      this.riser = null;
    }
    if (this.riser === null && this.on('fx')) this.leadSweep = this.fx.riser(t, this.beatDur, 0.45, 1.0, 0.2);
  }

  /** `quiet`: ohne Ankunfts-Crash (Aufstieg im Breakdown). `barStart`: dieser Beat ist ein Downbeat. */
  private setLayer(layer: number, t: number, quiet = false, barStart = false): void {
    const prev = this.layer;
    this.layer = layer;
    this.layerSince = t;
    this.logLayer(t, layer);
    this.applyRumbleGate(t);
    this.mixer.setLayerLift(layer, t);
    if (layer < 3) this.acid.close(t);
    if (layer === 0) this.layer0Since = t;
    if (layer >= MAX_LAYER && prev < MAX_LAYER && !quiet) {
      // Ankunft im Overdrive: Crash/Impact übernimmt, laufende Riser gehen darunter weg.
      this.cutRisers(t);
      if (this.on('fx')) this.fx.crash(t, 0.85);
    }
    // Erster Schritt nach längerem Stand: Mini-Drop auf dem nächsten Downbeat (nicht im Übungs-Loop).
    if (prev === 0 && layer > 0 && t - this.layer0Since >= MINI_DROP_IDLE_BARS * this.barDur - EPS && !this.respawnSeries(t)) {
      const at = barStart ? t : this.nextBarTime(t + EPS);
      if (at - t >= this.beatDur - EPS && this.on('fx')) this.fx.swell(at - this.beatDur, this.beatDur, 0.2);
      if (barStart) {
        if (this.on('fx')) this.fx.crash(t, 0.4);
      } else this.miniDropAt = at;
    }
  }

  private respawnSeries(t: number): boolean {
    return this.lastRespawn - this.prevRespawn < RESPAWN_SERIES && t - this.lastRespawn < 2 * RESPAWN_SERIES;
  }

  private cutRisers(t: number): void {
    for (const r of [this.riser, this.leadSweep]) r?.cut(t, 0.06);
    this.riser = null;
    this.leadSweep = null;
  }

  // ------------------------------------------------------------ Surf-Breakdown

  private dropReady(t: number): boolean {
    return !this.surfing && (this.onGround || t - this.surfEndAt >= SURF_GAP);
  }

  private checkDrop(t: number): void {
    if (!this.breakdown || this.pendingDrop || this.outro !== 'none' || !this.dropReady(t)) return;
    this.pendingDrop = true;
    // Der nächste Beat ist schon geplant (Vorlauf), aber noch nicht hörbar: Drop dort nachtragen.
    if (this.lastBeatMode === 'breakdown' && this.lastBeatTime > t + RETRO_MARGIN) this.drop(this.lastBeatTime, true);
  }

  private enterBreakdown(t: number): void {
    this.breakdown = true;
    this.breakdownSince = t;
    this.pendingDrop = false;
    this.riserLevel = -1;
    // Ein laufender Overdrive-Anlauf gehört jetzt dem Drop.
    this.leadInAt = -1;
    this.cutRisers(t);
    this.open = 1;
    this.pad.setOpen(1, t, 0.35);
    this.mode = 'breakdown';
    this.applyRumbleGate(t);
    this.updateSurfRiser(t);
  }

  /** Drop auf `t` (Beat). `retro`: der Beat ist schon geplant — Kick hier nachtragen. */
  private drop(t: number, retro: boolean): void {
    this.breakdown = false;
    this.pendingDrop = false;
    this.dropAt = t;
    this.open = 0;
    this.mode = 'normal';
    this.pad.setOpen(0, t, 0.08);
    this.surfRiser.gain.setTargetAtTime(0, t, 0.012);
    this.riserLevel = 0;
    this.applyRumbleGate(t);
    if (this.on('fx')) this.fx.crash(t, this.layer >= MAX_LAYER ? 0.9 : 0.65);
    if (retro) {
      this.playKick(t, 0.95, this.energy.value);
      this.lastBeatMode = 'normal';
      if (this.on('stabs')) this.stabs.hit(t, 0.5, CHORD_AM9, 0.8, 1);
    }
  }

  /** Ohne Drop beenden (Respawn, neues Level). */
  private cancelBreakdown(t: number): void {
    if (!this.breakdown && this.mode !== 'breakdown') return;
    this.breakdown = false;
    this.pendingDrop = false;
    this.open = 0;
    this.mode = 'normal';
    this.pad.setOpen(0, t, 0.1);
    this.surfRiser.gain.setTargetAtTime(0, t, 0.02);
    this.riserLevel = 0;
    this.applyRumbleGate(t);
  }

  /** Riser im Breakdown: steigt über 2 Takte und mit der Surf-Speed (Bandpass hoch, Pegel hoch). */
  private updateSurfRiser(t: number): void {
    if (!this.breakdown || !this.on('fx')) return;
    const at = Math.max(t, this.breakdownSince);
    if (at - this.riserSetAt < 0.05 && this.riserLevel >= 0) return;
    const p = clamp01((at - this.breakdownSince) / (2 * this.barDur));
    const s = smoothstep(500, 1400, this.speed);
    const x = clamp01(0.6 * p + 0.4 * s);
    this.surfBP.frequency.setTargetAtTime(expLerp(500, 8500, x), at, 0.15);
    this.surfBP.Q.setTargetAtTime(lerp(2.2, 4.5, x), at, 0.15);
    this.riserLevel = (0.06 + 0.16 * p) * (0.7 + 0.3 * s);
    this.surfRiser.gain.setTargetAtTime(this.riserLevel, at, 0.12);
    this.riserSetAt = at;
  }

  // ------------------------------------------------------------ Outro / Akzente

  private startOutro(bar: number, t: number): void {
    this.outro = 'on';
    this.outroBar = bar;
    this.outroAt = t;
    this.breakdown = false;
    this.pendingDrop = false;
    this.leadInAt = -1;
    this.cutRisers(t);
    this.surfRiser.gain.setTargetAtTime(0, t, 0.02);
    this.riserLevel = 0;
    this.open = 1;
    this.pad.setOpen(1, t, 0.25);
    // Pegel wie das Arrangement (Schlussteil hell wie L4), nicht wie der beim Ausrollen gefallene Layer.
    this.mixer.setLayerLift(MAX_LAYER, t);
    if (this.on('fx')) this.fx.crash(t, this.outroBest ? 1.0 : 0.8);
    if (this.on('stabs')) {
      // Schlussakkord mit langem Ausklang in Hall und Delay; Bestzeit: Oktav-Stab obendrauf.
      this.stabs.hit(t, 0.7, CHORD_AM9, 0.9, 1, 0.3, 0.55);
      if (this.outroBest) this.stabs.hit(t, 0.5, CHORD_AM9_UP, 1, 1, 0.25, 0.5);
    }
  }

  private endOutro(t: number): void {
    if (this.outro === 'none') return;
    this.outro = 'none';
    this.outroAt = Number.NEGATIVE_INFINITY;
    this.open = 0;
    this.mode = 'normal';
    this.pad.setOpen(0, t, 0.2);
    this.mixer.setLayerLift(this.layer, t);
    this.applyRumbleGate(t);
  }

  private playAccent(t: number): void {
    this.accentPending = false;
    if (this.on('fx')) this.fx.crash(t, 0.42);
    if (!this.on('stabs')) return;
    this.stabs.hit(t, 0.4, CHORD_AM9, 0.7, 0.9);
    if (this.accentSplit !== null && this.accentSplit < 0) {
      this.stabs.hit(t + this.stepDur, 0.42, THIRD_UP[0], 0.4, 1, 0.06, 0.09);
      this.stabs.hit(t + 3 * this.stepDur, 0.48, THIRD_UP[1], 0.4, 1, 0.08, 0.12);
    }
  }

  // ------------------------------------------------------------ Helfer

  private playKick(t: number, vel: number, e: number): void {
    this.kick.trigger(t, vel);
    this.mixer.duck(t, lerp(0.35, 0.12, smoothstep(0.2, 1, e)), lerp(0.8, 0.55, smoothstep(0.3, 1, e)));
    this.logKick(t, this.layer === 0 ? 0.55 : 1);
  }

  /** Erster Taktanfang ≥ x (Raster des Sequencers). */
  private nextBarTime(x: number): number {
    const c = this.clock;
    const origin = c?.originTime ?? 0;
    const bar = (c?.stepDur ?? this.stepDur) * 16;
    return origin + Math.ceil((x - origin) / bar - 1e-9) * bar;
  }

  private applyRumbleGate(t: number): void {
    const open = this.layer >= 2 && this.on('rumble') && this.mode !== 'breakdown' && this.mode !== 'outroBreak';
    this.mixer.rumbleGate.gain.setTargetAtTime(open ? 1 : 0, t, 0.08);
  }

  private logKick(t: number, vel: number): void {
    this.kickTimes[this.kickIdx] = t;
    this.kickVels[this.kickIdx] = vel;
    this.kickIdx = (this.kickIdx + 1) % KICK_LOG;
  }

  private logLayer(t: number, layer: number): void {
    this.layerTimes[this.layerIdx] = t;
    this.layerVals[this.layerIdx] = layer;
    this.layerIdx = (this.layerIdx + 1) % LAYER_LOG;
  }
}
