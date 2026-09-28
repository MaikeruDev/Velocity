import type { GameEvent } from '../engine/events';
import type { AudioApi, AudioVolumes, BeatInfo, MusicDrive } from './types';
import { SILENT_BEAT } from './types';
import { hashString } from './dsp';
import { EnergyModel } from './energy';
import { Mixer, prewarmImpulses } from './Mixer';
import { BPM, Music, type MusicPart } from './Music';
import { Sequencer, type SequencerStats } from './Sequencer';
import { Sfx } from './Sfx';

export interface TechnoAudioOptions {
  /** Eigener Kontext (z. B. OfflineAudioContext für deterministische Renders). Ohne: unlock() erzeugt einen AudioContext. */
  readonly context?: BaseAudioContext;
  readonly seed?: number;
  /** Sicherheits-Clipper hinter dem Limiter (Default an). Aus nur für Messungen (audiocheck). */
  readonly clipper?: boolean;
}

interface Engine {
  readonly ctx: BaseAudioContext;
  readonly realtime: boolean;
  readonly mixer: Mixer;
  readonly music: Music;
  readonly sfx: Sfx;
  readonly seq: Sequencer;
}

type MutableBeatInfo = { -readonly [K in keyof BeatInfo]: BeatInfo[K] };

const DEFAULT_SEED = 0x7ec4;
/** Seed-Versatz der Hall-Impulsantworten (Mixer) — auch für die Vorberechnung. */
const IR_SEED_OFFSET = 7;
/**
 * Feste Rate statt der des Geräts: auf 96/192-kHz-Interfaces kostete die
 * Engine sonst das 2–4-Fache (Convolver-Länge, Biquad-Koeffizienten pro
 * Sample, Aufbau). Chromium resampelt selbst; die Offline-Messungen (44.1 kHz)
 * gelten damit auch in Echtzeit.
 */
const REALTIME_SAMPLE_RATE = 48000;
/** Erster Schritt so weit nach dem fertigen Aufbau — die ersten Hüllkurven dürfen nicht in der Vergangenheit liegen. */
const START_LEAD = 0.1;
const OFFLINE_START = 0.02;
/** Kleine Rücksprünge der Hörzeit-Schätzung glätten, größere (Resync) durchlassen. */
const HEARD_JITTER = 0.05;
/**
 * getOutputTimestamp() liefert bei jedem Aufruf ein neues Objekt (~7 KiB/s bei 60 fps,
 * der größte src/-Posten im Dauerbetrieb). Die Zuordnung Kontext-Zeit ↔ performance.now
 * ist linear — alle 0.25 s neu holen reicht, dazwischen wird fortgeschrieben.
 */
const OUTPUT_TS_REFRESH_MS = 250;

/** Echtzeit-Kontext? (In Node/Tests existiert AudioContext nicht.) */
function isRealtime(ctx: BaseAudioContext): ctx is AudioContext {
  return typeof AudioContext !== 'undefined' && ctx instanceof AudioContext;
}

function createRealtimeContext(): AudioContext {
  try {
    return new AudioContext({ latencyHint: 'interactive', sampleRate: REALTIME_SAMPLE_RATE });
  } catch {
    // Ältere Browser ohne freie Rate: Geräte-Rate (IRs werden dann im Aufbau berechnet).
    return new AudioContext({ latencyHint: 'interactive' });
  }
}

/** Im Leerlauf ausführen (vor unlock), ohne den Spiel-Start zu bremsen. */
function whenIdle(fn: () => void): void {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: 2000 });
  else setTimeout(fn, 30);
}

/** Glättung der kontinuierlichen Parameter pro Frame (die Energie selbst ist schon geglättet). */
const PARAM_TAU = 0.06;
const IDLE_DRIVE: MusicDrive = {
  speed: 0,
  onGround: true,
  hopChain: 0,
  strafeSync: 0,
  airTime: 0,
  surfing: false,
  active: true,
};

/**
 * Prozeduraler, reaktiver Techno (132 BPM) + SFX. Implementiert den
 * AudioApi-Vertrag; darüber hinaus Offline-Hilfen (settle, scheduleOffline,
 * emitAt) für deterministische Renders und Messungen.
 *
 * Lebenszyklus: new → unlock() (aus User-Geste) → pro Frame update() und
 * beat(), Ereignisse per emit() → dispose().
 */
export class TechnoAudio implements AudioApi {
  private readonly seed: number;
  private readonly injected: BaseAudioContext | null;
  private readonly clipper: boolean;
  private readonly energy = new EnergyModel();
  /** Kontext ab dem ersten unlock() (auch während der Aufbau noch auf resume() wartet). */
  private ctx: BaseAudioContext | null = null;
  private engine: Engine | null = null;
  private unlocking: Promise<void> | null = null;
  /** Zählt dispose()-Aufrufe: ein Aufbau, der danach fertig wird, verwirft sich selbst. */
  private generation = 0;
  private volumes: AudioVolumes = { master: 1, music: 1, sfx: 1 };
  private drive: MusicDrive = IDLE_DRIVE;
  private lastAppliedEnergy = -1;
  private lastApplyTime = Number.NEGATIVE_INFINITY;
  private lastActive = true;
  private readonly mutedParts = new Set<MusicPart>();
  /** Level-Seed aus einem levelLoaded vor unlock() — sonst spielte das erste Level die Default-Patterns. */
  private pendingLevelSeed: number | null = null;
  private readonly beatState: MutableBeatInfo = { ...SILENT_BEAT };
  private lastHeard = Number.NEGATIVE_INFINITY;
  /** Zuletzt geholter Output-Zeitstempel (Kontext-Zeit s, performance.now ms); perf < 0 = keiner. */
  private tsContext = 0;
  private tsPerf = -1;
  private tsFetched = Number.NEGATIVE_INFINITY;

  constructor(opts?: TechnoAudioOptions) {
    this.seed = (opts?.seed ?? DEFAULT_SEED) >>> 0;
    this.injected = opts?.context ?? null;
    this.clipper = opts?.clipper ?? true;
    if (this.injected === null && typeof window !== 'undefined') this.prewarm();
  }

  get unlocked(): boolean {
    return this.engine !== null;
  }

  /** Der verwendete Kontext (null vor unlock()). */
  get context(): BaseAudioContext | null {
    return this.engine?.ctx ?? null;
  }

  /** Aktueller Layer, wie er gerade geplant wird (für Dev-Anzeigen). */
  get scheduledLayer(): number {
    return this.engine?.music.currentLayer ?? 0;
  }

  get energyValue(): number {
    return this.energy.value;
  }

  /** Surf-Breakdown gerade geplant (Dev/Messung). */
  get inBreakdown(): boolean {
    return this.engine?.music.inBreakdown ?? false;
  }

  /** Planungs-Diagnose (Dev/Tests). */
  get stats(): SequencerStats {
    return this.engine?.seq.stats ?? { late: 0, dropped: 0, resyncs: 0 };
  }

  /** Aktueller Planungs-Vorlauf in s (0.12 normal, 0.35 nach Rucklern/beim Start, 1.2 im Hintergrund-Tab). */
  get lookahead(): number {
    return this.engine?.seq.lookahead ?? 0;
  }

  /** IR-Rohdaten für die Echtzeit-Rate im Leerlauf vorberechnen, eine pro Häppchen. */
  private prewarm(): void {
    let index = 0;
    const step = (): void => {
      if (this.engine !== null) return;
      if (!prewarmImpulses(REALTIME_SAMPLE_RATE, this.seed + IR_SEED_OFFSET, index++)) whenIdle(step);
    };
    whenIdle(step);
  }

  unlock(): Promise<void> {
    let ctx = this.ctx;
    if (ctx === null) {
      try {
        ctx = this.injected ?? createRealtimeContext();
      } catch (err: unknown) {
        return Promise.reject(err);
      }
      this.ctx = ctx;
    }
    // Jeder Aufruf aus einer Geste weckt den Kontext — auch wenn ein früherer
    // Aufruf ohne Geste noch in resume() hängt (dessen Promise löst sich dann mit).
    const resumed = isRealtime(ctx) && ctx.state === 'suspended' ? ctx.resume() : null;
    if (this.engine !== null) return resumed ?? Promise.resolve();
    // Das Ergebnis hängt am Aufbau; dieses Promise darf nicht unbehandelt verwaisen.
    resumed?.catch(() => undefined);
    if (this.unlocking === null) {
      const gen = this.generation;
      const building = ctx;
      this.unlocking = this.build(building, gen).catch((err: unknown) => {
        if (gen === this.generation) {
          // Später neu versuchen können (kein Audiogerät, Geste fehlte); ein geschlossener Kontext wird ersetzt.
          this.unlocking = null;
          if (isRealtime(building) && building.state === 'closed') this.ctx = null;
        }
        throw err;
      });
    }
    return this.unlocking;
  }

  private async build(ctx: BaseAudioContext, gen: number): Promise<void> {
    if (isRealtime(ctx) && ctx.state !== 'running') {
      try {
        await ctx.resume();
      } catch (err: unknown) {
        if (gen !== this.generation) return;
        throw err;
      }
    }
    // dispose() kam dazwischen: es hat den Kontext bereits geschlossen.
    if (gen !== this.generation) return;
    const realtime = isRealtime(ctx);
    // Dauer-Oszillatoren starten sofort (ihre Pegel stehen auf 0) …
    const nodeStart = ctx.currentTime;
    const mixer = new Mixer(ctx, this.seed + IR_SEED_OFFSET, ctx.destination, { clipper: this.clipper });
    const music = new Music(ctx, mixer, this.energy, this.seed, nodeStart);
    const sfx = new Sfx(ctx, mixer, this.seed, nodeStart);
    if (this.pendingLevelSeed !== null) {
      music.reseed(this.pendingLevelSeed);
      this.pendingLevelSeed = null;
    }
    // … der Takt-Anker aber erst NACH dem Aufbau: dauert der länger als der
    // Vorlauf, verwürfe der Sequencer sonst Schritt 0 (erste Kick, Pad-Einsatz).
    const origin = ctx.currentTime + (realtime ? START_LEAD : OFFLINE_START);
    const seq = new Sequencer(ctx, BPM, (step, time) => music.onStep(step, time));
    seq.start(origin);
    // Outro-Downbeat und Chain-Blips rasten auf dasselbe Raster wie die Musik.
    music.setClock(seq);
    sfx.setClock(seq);
    this.engine = { ctx, realtime, mixer, music, sfx, seq };
    this.lastHeard = Number.NEGATIVE_INFINITY;
    this.tsFetched = Number.NEGATIVE_INFINITY;
    this.tsPerf = -1;
    for (const p of this.mutedParts) music.setMuted(p, true);
    mixer.setVolumes(this.volumes, ctx.currentTime);
    mixer.setMenu(this.drive.active, ctx.currentTime);
    this.lastActive = this.drive.active;
    music.setDrive(this.drive, ctx.currentTime);
    this.applyContinuous(ctx.currentTime, 0.001);
    if (realtime) seq.startTimer();
  }

  update(drive: MusicDrive, dt: number): void {
    this.drive = drive;
    this.energy.step(drive, dt);
    const eng = this.engine;
    if (eng === null) return;
    const now = eng.ctx.currentTime;
    eng.music.setDrive(drive, now);
    if (drive.active !== this.lastActive) {
      this.lastActive = drive.active;
      this.applyMenu(drive.active, now);
    }
    // Nur neu automatisieren, wenn sich etwas tut — sonst wächst die Event-Liste der Params pro Frame.
    const e = this.energy.value;
    if (Math.abs(e - this.lastAppliedEnergy) > 0.002 || now - this.lastApplyTime > 0.5 || eng.music.toneDirty) {
      this.applyContinuous(now, PARAM_TAU);
    }
    eng.sfx.updateContinuous(drive, now, 0.07);
    eng.sfx.frame(dt, now);
  }

  emit(event: GameEvent): void {
    const eng = this.engine;
    this.dispatch(event, eng?.ctx.currentTime ?? 0, typeof performance !== 'undefined' ? performance.now() : null);
  }

  /** Ereignis zu einer bestimmten Kontextzeit (Offline-Zeitleisten). */
  emitAt(event: GameEvent, time: number): void {
    this.dispatch(event, time, null);
  }

  private dispatch(event: GameEvent, time: number, wall: number | null): void {
    const eng = this.engine;
    if (event.type === 'levelLoaded') {
      // Jedes Level klingt anders — und zwar immer gleich, egal ob vor oder nach unlock() geladen.
      const seed = (hashString(event.id) ^ this.seed) >>> 0;
      if (eng !== null) {
        eng.music.reseed(seed);
        eng.music.onLevelLoaded(time);
        this.refreshMenu(time);
      } else this.pendingLevelSeed = seed;
      return;
    }
    if (eng === null) return;
    // Musikalische Reaktionen (Outro, Akzente, Surf-Zeitpunkte); die SFX spielen immer sofort.
    switch (event.type) {
      case 'finish':
        eng.music.finish(time, event.best);
        break;
      case 'checkpoint':
        eng.music.checkpoint(time, event.split);
        break;
      case 'respawn':
        eng.music.onRespawn(time);
        this.refreshMenu(time);
        break;
      case 'surfStart':
        eng.music.setSurfing(true, time);
        break;
      case 'surfEnd':
        eng.music.setSurfing(false, time);
        break;
      case 'land':
        eng.music.onLand(time);
        break;
      default:
        break;
    }
    eng.sfx.play(event, time, wall);
  }

  /**
   * Inaktiv nach dem Ziel = Ergebnis-Screen: Outro klingen lassen, erst ca. 4 Takte
   * nach dem Ziel weich filtern. Sonst (Pause, Menü) wie bisher dumpf.
   */
  private applyMenu(active: boolean, t: number): void {
    const eng = this.engine;
    if (eng === null) return;
    if (!active && eng.music.inOutro) eng.mixer.setResultMenu(eng.music.resultMenuFrom, t);
    else eng.mixer.setMenu(active, t);
  }

  /** Nach Outro-Ende im Menü: vom Ergebnis- auf den Pausen-Filter zurück. */
  private refreshMenu(t: number): void {
    if (!this.lastActive) this.applyMenu(false, t);
  }

  setVolumes(v: AudioVolumes): void {
    this.volumes = v;
    const eng = this.engine;
    if (eng !== null) eng.mixer.setVolumes(v, eng.ctx.currentTime);
  }

  /**
   * Beat-Zustand zu dem, was gerade aus dem Lautsprecher kommt. Das
   * zurückgegebene Objekt wird bei jedem Aufruf wiederverwendet (keine
   * Allokation pro Frame) — Werte lesen, nicht aufbewahren.
   */
  beat(): BeatInfo {
    const b = this.beatState;
    b.energy = this.energy.value;
    const eng = this.engine;
    if (eng === null) {
      b.beat = 0;
      b.beatPhase = 0;
      b.barPhase = 0;
      b.kick = 0;
      b.layer = 0;
      return b;
    }
    const heard = this.heardTime(eng);
    const seq = eng.seq;
    const beats = Math.max(0, (heard - seq.originTime) / seq.beatDur);
    const bar = beats / 4;
    b.bpm = seq.bpm;
    b.beat = beats;
    b.beatPhase = beats - Math.floor(beats);
    b.barPhase = bar - Math.floor(bar);
    b.kick = eng.music.kickEnvelope(heard);
    b.layer = eng.music.layerAt(heard);
    return b;
  }

  /**
   * Kontextzeit des Samples, das gerade hörbar ist. getOutputTimestamp()
   * + Wanduhr-Extrapolation ist glatt (gemessen < 1 ms Zittern);
   * currentTime springt in Audio-Blöcken (±4 ms → sichtbares Flimmern des
   * Neon-Pulses). Dazu die 6 ms Pre-Delay des Limiters.
   */
  private heardTime(eng: Engine): number {
    const ctx = eng.ctx;
    let t = ctx.currentTime;
    if (isRealtime(ctx)) {
      const now = performance.now();
      if (now - this.tsFetched >= OUTPUT_TS_REFRESH_MS || now < this.tsFetched) {
        this.tsFetched = now;
        const ts = typeof ctx.getOutputTimestamp === 'function' ? ctx.getOutputTimestamp() : null;
        const ok = ts !== null && ts.contextTime !== undefined && ts.performanceTime !== undefined && ts.performanceTime > 0;
        this.tsContext = ok ? (ts.contextTime ?? 0) : 0;
        this.tsPerf = ok ? (ts.performanceTime ?? -1) : -1;
      }
      if (this.tsPerf > 0) {
        t = this.tsContext + (now - this.tsPerf) / 1000;
      } else {
        t -= (ctx.baseLatency || 0) + (ctx.outputLatency || 0);
      }
    }
    t -= eng.mixer.latency;
    if (t < this.lastHeard && this.lastHeard - t < HEARD_JITTER) t = this.lastHeard;
    this.lastHeard = t;
    return t;
  }

  private applyContinuous(t: number, tau: number): void {
    const eng = this.engine;
    if (eng === null) return;
    const e = this.energy.value;
    // Outro: der Raum geht langsam zu (Nebenraum-Loop), die Instrumente behalten ihre Energie.
    const room = eng.music.roomEnergy(t);
    eng.mixer.setEnergy(room ?? e, t, room !== null ? 1.2 : tau);
    eng.music.setEnergy(e, t, tau);
    this.lastAppliedEnergy = e;
    this.lastApplyTime = t;
  }

  // ------------------------------------------------------------ Offline / Dev

  /** Energie und Layer sofort auf den Zustand dieses Drives (Messung im eingeschwungenen Zustand). */
  settle(drive: MusicDrive): void {
    this.drive = drive;
    this.energy.settle(drive);
    const eng = this.engine;
    if (eng === null) return;
    const t = eng.ctx.currentTime;
    eng.music.settleLayer(t);
    eng.music.setDrive(drive, t);
    eng.mixer.setMenu(drive.active, t);
    this.lastActive = drive.active;
    this.applyContinuous(t, 0.001);
    eng.sfx.updateContinuous(drive, t, 0.001);
  }

  /**
   * Plant deterministisch bis `until` (Kontextzeit). Mit `driveAt` wird die
   * Energie pro 16tel aus einer Zeitleiste fortgeschrieben — so lassen sich
   * Übergänge (Aufbau, Abbruch) offline rendern. Nur ohne Echtzeit-Timer sinnvoll.
   */
  scheduleOffline(until: number, driveAt?: (t: number) => MusicDrive): void {
    const eng = this.engine;
    if (eng === null) return;
    const seq = eng.seq;
    while (seq.nextStepTime < until) {
      const t = seq.nextStepTime;
      if (driveAt !== undefined) {
        const d = driveAt(t);
        this.drive = d;
        this.energy.step(d, seq.stepDur);
        eng.music.setDrive(d, t);
        if (d.active !== this.lastActive) {
          this.lastActive = d.active;
          this.applyMenu(d.active, t);
        }
        this.applyContinuous(t, PARAM_TAU);
        eng.sfx.updateContinuous(d, t, 0.07);
      }
      seq.advanceOne();
    }
  }

  /** Einzelne Spuren stummschalten (Dev-Seite, Mix-Messungen). */
  setMuted(part: MusicPart, muted: boolean): void {
    if (muted) this.mutedParts.add(part);
    else this.mutedParts.delete(part);
    this.engine?.music.setMuted(part, muted);
  }

  /**
   * Timer stoppen und Kontext schließen (nur wenn selbst erzeugt). Auch
   * während eines laufenden unlock() sicher: der Aufbau verwirft sich dann.
   * Danach kann die Instanz erneut per unlock() gestartet werden.
   */
  async dispose(): Promise<void> {
    this.generation++;
    const eng = this.engine;
    const ctx = this.ctx;
    this.engine = null;
    this.unlocking = null;
    this.ctx = null;
    eng?.seq.stopTimer();
    if (this.injected === null && ctx !== null && isRealtime(ctx) && ctx.state !== 'closed') await ctx.close();
  }
}
