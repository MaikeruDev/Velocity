/**
 * Fester Physik-Takt mit Render-Interpolation ("Fix Your Timestep").
 *
 * Pro Frame: onFrameStart (Blick sampeln, auch in Frames ohne Tick), dann die
 * Zahl der fälligen Ticks n bestimmen und ticken. onTick bekommt (i, n, u):
 * u ist der Zeitpunkt des Tick-Endes im Intervall [voriger Frame, dieser Frame]
 * — damit verteilt InputState den Maus-Yaw nach Zeit, nicht nach Index
 * (Subtick-Yaw, fallen.md #45). Danach bekommt onFrame den Interpolationsanteil
 * alpha ∈ [0, 1) zwischen dem vorletzten und dem letzten Tick.
 */

export interface FixedLoopOptions {
  /** Ticks pro Sekunde (MovementConfig.tickRate). */
  readonly tickRate: number;
  /**
   * dt in Sekunden, i = 0..n-1, n = Ticks dieses Frames (vorab bekannt).
   * frameFraction ∈ [0, 1]: wann dieses Tick-Ende zwischen vorigem (0) und diesem Frame (1) liegt.
   */
  readonly onTick: (dt: number, tickIndex: number, ticksThisFrame: number, frameFraction: number) => void;
  /** Vor den Ticks JEDES Frames, auch ohne Tick (Blick-Sample für die Subtick-Interpolation). */
  readonly onFrameStart?: () => void;
  /** alpha = Anteil des angebrochenen Ticks (für Interpolation), frameDt = echte (gekappte) Framezeit. */
  readonly onFrame: (alpha: number, frameDt: number, nowSeconds: number) => void;
  /** Längster Frame, der noch simuliert wird (s). Länger → Spiel läuft kurz langsamer statt zu springen. Default 0.1. */
  readonly maxFrameTime?: number;
  /** Harte Tick-Obergrenze pro Frame (Spiral-of-Death-Schutz). Default: ceil(maxFrameTime · tickRate) + 1. */
  readonly maxTicksPerFrame?: number;
  /** Zeitquelle in ms. Default performance.now — injizierbar für Tests. */
  readonly now?: () => number;
  /** Frame-Scheduler. Default requestAnimationFrame — injizierbar für Tests. */
  readonly requestFrame?: (cb: (timeMs: number) => void) => number;
  readonly cancelFrame?: (handle: number) => void;
}

/** Winzige Toleranz, damit k·dt nach Float-Summation nicht als k−1 Ticks zählt. */
const TICK_EPSILON = 1e-9;

export class FixedLoop {
  private readonly onTick: FixedLoopOptions['onTick'];
  private readonly onFrame: FixedLoopOptions['onFrame'];
  private readonly onFrameStart: (() => void) | null;
  private readonly maxFrameTime: number;
  private readonly fixedMaxTicks: number | null;
  private readonly now: () => number;
  private readonly requestFrame: (cb: (timeMs: number) => void) => number;
  private readonly cancelFrame: (handle: number) => void;

  private tickRateHz: number;
  private dtSeconds: number;
  private maxTicks: number;
  private accumulator = 0;
  private lastTimeMs: number | null = null;
  private handle: number | null = null;
  private isRunning = false;
  private totalTicks = 0;
  private droppedSeconds = 0;
  private readonly onVisibility = (): void => {
    // Nach Tab-Wechsel nicht nachholen: Zeit, in der niemand zugesehen hat, existiert nicht.
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') this.resetTiming();
  };

  constructor(opts: FixedLoopOptions) {
    this.onTick = opts.onTick;
    this.onFrame = opts.onFrame;
    this.onFrameStart = opts.onFrameStart ?? null;
    this.maxFrameTime = opts.maxFrameTime ?? 0.1;
    this.fixedMaxTicks = opts.maxTicksPerFrame ?? null;
    this.now = opts.now ?? (() => performance.now());
    this.requestFrame = opts.requestFrame ?? ((cb) => requestAnimationFrame(cb));
    this.cancelFrame = opts.cancelFrame ?? ((h) => cancelAnimationFrame(h));
    this.tickRateHz = 0;
    this.dtSeconds = 0;
    this.maxTicks = 1;
    this.setTickRate(opts.tickRate);
  }

  get running(): boolean {
    return this.isRunning;
  }

  get tickRate(): number {
    return this.tickRateHz;
  }

  /** Tick-Dauer in Sekunden. */
  get dt(): number {
    return this.dtSeconds;
  }

  /** Anzahl aller bisher ausgeführten Ticks (inkl. stepTicks). */
  get tickCount(): number {
    return this.totalTicks;
  }

  /** Simulationszeit, die durch Kappung verworfen wurde (s) — Diagnose für Ruckler. */
  get droppedTime(): number {
    return this.droppedSeconds;
  }

  setTickRate(hz: number): void {
    if (!Number.isFinite(hz) || hz <= 0) throw new Error(`FixedLoop: ungültige Tickrate ${hz}`);
    this.tickRateHz = hz;
    this.dtSeconds = 1 / hz;
    this.maxTicks = Math.max(1, this.fixedMaxTicks ?? Math.ceil(this.maxFrameTime * hz) + 1);
    // Angebrochener Tick bleibt erhalten, darf aber nicht mehrere neue Ticks auslösen.
    this.accumulator = Math.min(this.accumulator, this.dtSeconds);
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.resetTiming();
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisibility);
    this.handle = this.requestFrame(this.frame);
  }

  stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this.handle !== null) this.cancelFrame(this.handle);
    this.handle = null;
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility);
  }

  /** Vergisst die bisherige Frame-Zeit: der nächste Frame simuliert 0 s statt der Lücke. */
  resetTiming(): void {
    this.lastTimeMs = null;
    this.accumulator = 0;
  }

  /**
   * Deterministisch n Ticks ausführen, ohne rAF und ohne Uhr (Tests, Playwright,
   * `window.__vel`). Danach genau ein onFrame mit alpha = 1 (Zustand = letzter Tick).
   * Der Akkumulator des Echtzeit-Loops bleibt unberührt.
   */
  stepTicks(n: number): void {
    const count = Math.max(0, Math.floor(n));
    const dt = this.dtSeconds;
    this.onFrameStart?.();
    for (let i = 0; i < count; i++) {
      // Kein Rest im Spiel: die Ticks füllen den "Frame" exakt, u = Index-Anteil.
      this.onTick(dt, i, count, (i + 1) / count);
      this.totalTicks++;
    }
    this.onFrame(1, count * dt, this.now() / 1000);
  }

  /**
   * Einen Frame mit gegebener Framezeit simulieren (s). Wird vom rAF-Callback
   * benutzt und ist für Tests öffentlich.
   */
  advance(frameDt: number, nowSeconds: number = this.now() / 1000): void {
    let frame = Number.isFinite(frameDt) && frameDt > 0 ? frameDt : 0;
    if (frame > this.maxFrameTime) {
      this.droppedSeconds += frame - this.maxFrameTime;
      frame = this.maxFrameTime;
    }
    const dt = this.dtSeconds;
    this.onFrameStart?.();
    this.accumulator += frame;

    // Tickzahl zuerst festlegen — onTick braucht n für die Subtick-Verteilung.
    let n = Math.floor((this.accumulator + TICK_EPSILON) / dt);
    if (n > this.maxTicks) {
      // Spiral of Death: lieber Zeit verwerfen als immer mehr Ticks pro Frame stapeln.
      this.droppedSeconds += (n - this.maxTicks) * dt;
      this.accumulator -= (n - this.maxTicks) * dt;
      n = this.maxTicks;
    }
    // Rest nach den Ticks = wie weit die Simulation hinter diesem Frame liegt. Vom Frame-Ende
    // rückwärts gerechnet stimmt u auch, wenn oben Ticks verworfen wurden.
    const rest = Math.max(0, this.accumulator - n * dt);
    for (let i = 0; i < n; i++) {
      const u = frame > 0 ? clamp01(1 - (rest + (n - 1 - i) * dt) / frame) : (i + 1) / n;
      this.onTick(dt, i, n, u);
      this.totalTicks++;
    }
    this.accumulator = rest;
    const alpha = Math.min(this.accumulator / dt, 1 - 1e-6);
    this.onFrame(alpha, frame, nowSeconds);
  }

  private readonly frame = (timeMs: number): void => {
    if (!this.isRunning) return;
    // Nächsten Frame zuerst anfordern: eine Exception in onTick soll das Spiel nicht einfrieren.
    this.handle = this.requestFrame(this.frame);
    const now = Number.isFinite(timeMs) && timeMs > 0 ? timeMs : this.now();
    if (this.lastTimeMs === null) {
      this.lastTimeMs = now;
      this.advance(0, now / 1000);
      return;
    }
    const frameDt = (now - this.lastTimeMs) / 1000;
    this.lastTimeMs = now;
    this.advance(frameDt, now / 1000);
  };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
