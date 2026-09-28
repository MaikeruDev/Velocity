/**
 * 16tel-Raster mit Lookahead-Planung ("A Tale of Two Clocks"): ein grober
 * JS-Timer (~25 ms) plant alle Schritte, die in den nächsten ~120 ms fällig
 * werden, sample-genau gegen `ctx.currentTime`. Offline wird einmal bis zum
 * Ende geplant — dieselbe Funktion, deterministisch.
 *
 * Schrittzeiten werden immer als origin + n·stepDur berechnet, nie
 * aufsummiert: kein Drift über lange Sessions.
 */

export type StepHandler = (step: number, time: number) => void;

/** Diagnose der Echtzeit-Planung (sollte im Normalbetrieb bei 0 bleiben). */
export interface SequencerStats {
  /** Schritte, die leicht verspätet (≤ 30 ms) sofort gespielt wurden. */
  readonly late: number;
  /** Schritte, die verworfen wurden, weil sie zu weit in der Vergangenheit lagen. */
  readonly dropped: number;
  /** Neu-Verankerungen nach Lücken > 1 s (Hintergrund-Tab). */
  readonly resyncs: number;
}

/** Ab dieser Lücke (Hintergrund-Tab, blockierter Main-Thread) wird neu verankert statt nachgeholt. */
const RESYNC_GAP = 1.0;
/** Etwas verspätete Schritte werden sofort gespielt; ältere fallen weg (keine Notenlawine). */
const LATE_TOLERANCE = 0.03;

const TIMER_MS = 25;
const LOOKAHEAD = 0.12;
/**
 * Nach einem Ruckler (Timer-Lücke > GAP_MS) und in den ersten Sekunden nach
 * dem Start (Pointer-Lock, Level-Aufbau, Shader-Kompilierung) weiter
 * vorausplanen: Ruckler kommen in Serien, und 120 ms überbrücken keinen
 * davon. Kosten: Layer-Wechsel greifen bis ~0.23 s später — sie sind ohnehin
 * auf Beats quantisiert; Filter/Pegel folgen der Energie weiter sofort.
 */
const LOOKAHEAD_BOOST = 0.35;
const GAP_MS = 60;
const BOOST_MS = 5000;
const START_BOOST_MS = 4000;
/** Verdeckte Tabs bekommen gedrosselte Timer — dann weiter vorausplanen, damit nichts abreißt. */
const LOOKAHEAD_HIDDEN = 1.2;

export class Sequencer {
  readonly bpm: number;
  readonly beatDur: number;
  readonly stepDur: number;
  private origin = 0;
  private next = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private late = 0;
  private dropped = 0;
  private resyncs = 0;
  private currentLookahead = LOOKAHEAD;

  constructor(
    private readonly ctx: BaseAudioContext,
    bpm: number,
    private readonly onStep: StepHandler,
  ) {
    this.bpm = bpm;
    this.beatDur = 60 / bpm;
    this.stepDur = this.beatDur / 4;
  }

  /** Zeitpunkt von Schritt 0 (verschiebt sich nur beim Neu-Verankern). */
  get originTime(): number {
    return this.origin;
  }

  get stats(): SequencerStats {
    return { late: this.late, dropped: this.dropped, resyncs: this.resyncs };
  }

  get nextStep(): number {
    return this.next;
  }

  get nextStepTime(): number {
    return this.timeOf(this.next);
  }

  timeOf(step: number): number {
    return this.origin + step * this.stepDur;
  }

  start(origin: number): void {
    this.origin = origin;
    this.next = 0;
  }

  /**
   * Plant alle Schritte mit Zeit < `untilTime`. `now` = aktuelle Kontextzeit
   * (offline: −∞, dann ist nie etwas zu spät).
   */
  advance(untilTime: number, now = Number.NEGATIVE_INFINITY): void {
    let t = this.timeOf(this.next);
    if (now - t > RESYNC_GAP) {
      // Musik läuft an derselben musikalischen Stelle weiter, statt hunderte Schritte nachzuspielen.
      this.origin = now + 0.03 - this.next * this.stepDur;
      t = this.timeOf(this.next);
      this.resyncs++;
    }
    while (t < untilTime) {
      if (t >= now - LATE_TOLERANCE) {
        if (t < now) this.late++;
        this.onStep(this.next, Math.max(t, now));
      } else {
        this.dropped++;
      }
      this.next++;
      t = this.timeOf(this.next);
    }
  }

  /** Genau einen Schritt planen (Offline-Zeitleisten). */
  advanceOne(): void {
    this.onStep(this.next, this.timeOf(this.next));
    this.next++;
  }

  /** Aktueller Vorlauf der Echtzeit-Planung in s (Diagnose). */
  get lookahead(): number {
    return this.currentLookahead;
  }

  startTimer(): void {
    if (this.timer !== null) return;
    let lastWall = performance.now();
    let boostUntil = lastWall + START_BOOST_MS;
    const tick = (): void => {
      const now = this.ctx.currentTime;
      const wall = performance.now();
      if (wall - lastWall > GAP_MS) boostUntil = wall + BOOST_MS;
      lastWall = wall;
      const hidden = typeof document !== 'undefined' && document.hidden;
      this.currentLookahead = hidden ? LOOKAHEAD_HIDDEN : wall < boostUntil ? LOOKAHEAD_BOOST : LOOKAHEAD;
      this.advance(now + this.currentLookahead, now);
    };
    tick();
    this.timer = setInterval(tick, TIMER_MS);
  }

  stopTimer(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
