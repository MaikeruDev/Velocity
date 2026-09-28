import type { GameEvent } from '../engine/events';
import type { InputNotice } from '../engine/InputState';
import { DEFAULT_OUTLINE, pixelFont } from './BitmapFont';
import type { TextStyle } from './BitmapFont';
import { formatDiff, formatTime } from './format';
import { AirDisplay, SpeedTrend } from './hudLogic';
import type { TrendMovement } from './hudLogic';
import type { HudData, HudKeys } from './types';
import { MEDAL_COLORS, MEDAL_NAMES, MEDAL_SHIMMER } from './medals';
import { safeLeft } from './safeFrame';

/**
 * HUD im Low-Res-Pixelraster: eigener transparenter Canvas in exakt der
 * Auflösung des Render-Targets, den der Renderer 1:1 im selben Raster
 * einrechnet. Minimal nach Bhop-/KZ-Tradition: großer Speedometer unten mittig,
 * Timer oben, kurze Popups für Gain und Splits.
 *
 * Lebenszyklus: resize(w, h) bei Auflösungswechsel, setMovement(cfg) bei
 * Config-Wechsel → pro Frame onEvent(e) für alle Ereignisse, update(dt, data), draw().
 *
 * Frame-Pfad ohne Allokation (AGENTS.md §4, sonst GC-Ruckler bei 144 Hz):
 * Stil-Objekte werden wiederverwendet, Zahlen- und Zeitstrings gecacht,
 * Farben vorab gemischt, Gain-Popups liegen in einem festen Ring.
 */

const C = {
  white: '#f4f1ff',
  dim: '#a79fcc',
  gain: '#5dff9a',
  loss: '#ff4d6d',
  cyan: '#33f0ff',
  magenta: '#ff3fd0',
  gold: '#ffd84a',
  band: 'rgba(8, 4, 22, 0.68)',
  shadow: 'rgba(6, 3, 18, 0.85)',
} as const;

/** Stufen der Trend-Farbmischung — hält den Glyphen-Cache klein und passt zur begrenzten Palette. */
const COLOR_STEPS = 6;
/** Meilenstein: Cyan → Trendfarbe in wenigen Stufen (jede Stufe ist ein eigener Glyphen-Stil). */
const MILESTONE_STEPS = 3;

const GAIN_POPUP_LIFE = 0.9;
const GAIN_SLOTS = 4;
const SPLIT_LIFE = 2.8;
const MILESTONE_LIFE = 0.6;
const INTRO_LIFE = 2.2;
const NOTICE_LIFE = 4;
/** Hinweise im Moment (Coach) stehen länger — man liest sie mitten in der Bewegung. */
const COACH_LIFE = 5.5;
/** CP-Zeile blitzt nach einem Checkpoint so lange in Gold. */
const CP_FLASH = 1.1;
/** Speedometer-Oberkante (Anteil der Bildhöhe): über dem Fadenkreuz, weg vom Landepunkt (U2). */
const SPEED_TOP = 0.3;
/** Ketten-/Sync-Zeile gedämpft — die Zahl ist die Hauptsache. */
const SEG_ALPHA = 0.75;
/** Gain-Popups erst ab diesem Betrag (u/s): "+0 +0 +1" beim Novizen war nur Rauschen in der Bildmitte. */
const GAIN_MIN_SHOWN = 3;
/** Hop-Kette erst ab diesem Tempo zeigen — Mausrad-Hüpfen auf der Stelle ist keine Kette. */
const CHAIN_MIN_SPEED = 100;
/** Speedometer-Deckkraft, solange der Ghost dahinter fliegt (Prüfung 27.09.: Ghost lag unter den Ziffern). */
const GHOST_DIM_ALPHA = 0.3;
/** Ein-/Ausblendzeit des Ghost-Dimmens (s). */
const GHOST_DIM_TIME = 0.12;
/** Strafe-Spiegel: Farbe mindestens so lange halten (gegen Flackern zwischen Ticks). */
const STRAFE_HOLD = 0.08;
/** W in der Luft mit A/D ab dieser Dauer (ms) rot blinken lassen. */
const W_AIR_WARN_MS = 150;
/** Drehraten-Balken: volle Länge bei 360°/s. Länge = |°/s| · halbe Breite · 91 >> 15 (≈ /360, nur Ganzzahl-Rechnung). */
const TURN_FULL_DEG = 360;

/** Texte zu den Eingabe-Hinweisen des InputManagers. */
const NOTICE_TEXT: Readonly<Record<InputNotice, string>> = {
  ctrlCrouchNeedsFullscreen: 'Strg duckt nur im Vollbild\nStrg+W würde sonst den Tab schließen',
};

export type NoticeKind = 'info' | 'coach';

type MutableStyle = { -readonly [K in keyof TextStyle]: TextStyle[K] };

/** Gain-Popup im Ring (wiederverwendet, kein Objekt pro Hop). */
interface GainPopup {
  born: number;
  text: string;
  color: string;
}

interface SplitPopup {
  readonly born: number;
  /** Große Zeile: farbige Differenz zur Bestzeit — null ohne Referenz (dann nur die kleine Zeile). */
  readonly headline: string | null;
  readonly headColor: string;
  /** Kleine Zeile: CP-Stand und Zwischenzeit. */
  readonly detail: string;
}

interface FinishInfo {
  readonly born: number;
  readonly time: number;
  readonly best: boolean;
  readonly diff: number | null;
}

interface IntroInfo {
  readonly born: number;
  readonly name: string;
}

interface NoticeInfo {
  readonly born: number;
  readonly text: string;
  readonly lines: number;
  readonly kind: NoticeKind;
  readonly life: number;
}

/** Ein Stück der mehrfarbigen Zeile unter dem Speedometer (wiederverwendet, keine Allokation pro Frame). */
interface Seg {
  text: string;
  color: string;
  /** Nur ein schmaler Abstand zum Vorgänger. */
  tight: boolean;
}

const EMPTY_DATA: HudData = {
  speed: 0,
  hopChain: 0,
  strafeSync: 0,
  onGround: true,
  surfing: false,
  runTime: null,
  running: false,
  checkpoint: { index: 0, total: 0 },
  levelName: '',
  levelSubtitle: null,
  bestTime: null,
  showSpeedometer: true,
  showKeys: false,
  keys: { forward: 0, side: 0, jump: false, crouch: false, turnDeg: 0, inAir: false, strafe: 0, forwardInAirMs: 0 },
  paused: false,
};

/** Farben der Showkeys (feste Palette). */
const K = {
  frame: 'rgba(167, 159, 204, 0.55)',
  back: 'rgba(8, 4, 22, 0.45)',
  on: '#f4f1ff',
  gain: C.gain,
  loss: C.loss,
  turn: C.cyan,
  tick: 'rgba(167, 159, 204, 0.7)',
} as const;

export class Hud {
  readonly canvas: HTMLCanvasElement;
  /** false = draw() leert nur den Canvas (z. B. im Titelmenü). */
  visible = true;
  private readonly ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;

  private data: HudData = EMPTY_DATA;
  /** HUD-Uhr (s) — steht in der Pause, damit Popups nicht heimlich verfallen. */
  private t = 0;

  private readonly trend = new SpeedTrend();
  private readonly air = new AirDisplay();
  private readonly segs: Seg[] = [0, 1, 2].map(() => ({ text: '', color: C.white, tight: false }));

  /** Ring der Gain-Popups: gainHead = ältester, gainCount = belegt. */
  private readonly gains: GainPopup[] = Array.from({ length: GAIN_SLOTS }, () => ({ born: 0, text: '', color: C.white }));
  private gainHead = 0;
  private gainCount = 0;
  private split: SplitPopup | null = null;
  private finish: FinishInfo | null = null;
  private intro: IntroInfo | null = null;
  private notice: NoticeInfo | null = null;
  private milestoneAt = -Infinity;

  // Gecachte Zeilen: nur neu bauen, wenn sich der Inhalt ändert.
  private timerSec = -1;
  private timerMain = '00:00';
  private cpText = '';
  private pbText = '';
  private cpIndex = -1;
  private cpTotal = -1;
  private cpBest: number | null | undefined = undefined;
  private cpFlashAt = -Infinity;
  private ghostDiffShown: number | null | undefined = undefined;
  private ghostText = '';
  private ghostColor: string = C.white;
  /** Nächstes Medaillen-Ziel (Plan 005): Objekt-Identität aus HudData, Text nur bei Wechsel neu. */
  private medalShown: HudData['nextMedal'] | undefined = undefined;
  private medalText = '';
  private medalColor: string = C.white;
  private medalShimmer = false;
  /** Deckkraft des Speedometer-Blocks (1 = voll, GHOST_DIM_ALPHA = Ghost dahinter). */
  private speedAlpha = 1;

  // Showkeys: Beschriftung aus der Belegung (setKeyLabels), gehaltene Spiegel-Farbe.
  private jumpLabel = 'SPACE';
  private crouchLabel = 'C';
  private strafeShown = 0;
  private strafeUntil = -Infinity;
  /** Blinkphase (8 Hz) — in update() berechnet, damit drawKeys nur Ganzzahlen anfasst. */
  private blinkOn = false;

  // Wiederverwendete Stile (Felder werden pro Frame gesetzt, nie neue Objekte).
  private readonly stTimerMain: MutableStyle = { outline: DEFAULT_OUTLINE, shadow: C.shadow, scale: 2, color: C.white, alpha: 1 };
  private readonly stTimerCs: MutableStyle = { scale: 1, color: C.white, shadow: true, alpha: 1 };
  private readonly stTimerLine: MutableStyle = { scale: 1, color: C.dim, shadow: true };
  private readonly stTimerLineGold: MutableStyle = { scale: 1, color: C.gold, shadow: true };
  private readonly stGhostLine: MutableStyle = { scale: 1, color: C.white, shadow: true };
  private readonly stMedalLine: MutableStyle = { scale: 1, color: C.white, shadow: true };
  private readonly stSpeed: MutableStyle = { outline: DEFAULT_OUTLINE, shadow: C.shadow, scale: 2, color: C.white, shadowOffset: 2, align: 'center' };
  private readonly stGain: MutableStyle = { scale: 1, color: C.white, outline: DEFAULT_OUTLINE, alpha: 1 };
  private readonly stSeg: MutableStyle = { scale: 1, color: C.white, outline: DEFAULT_OUTLINE, alpha: SEG_ALPHA };
  private readonly stSplitHead: MutableStyle = { outline: DEFAULT_OUTLINE, shadow: C.shadow, scale: 2, color: C.white, align: 'center', alpha: 1 };
  private readonly stSplitDetail: MutableStyle = { scale: 1, color: C.cyan, outline: DEFAULT_OUTLINE, align: 'center', alpha: 1 };
  private readonly stIntro: MutableStyle = { outline: DEFAULT_OUTLINE, shadow: C.shadow, scale: 3, color: C.white, shadowOffset: 2, align: 'center', tracking: 1, alpha: 1 };
  private readonly stIntroSub: MutableStyle = { scale: 1, color: C.cyan, outline: DEFAULT_OUTLINE, align: 'center', alpha: 1 };
  private readonly stFinishLabel: MutableStyle = { scale: 1, color: C.cyan, outline: DEFAULT_OUTLINE, align: 'center', tracking: 2 };
  private readonly stFinishTime: MutableStyle = { outline: DEFAULT_OUTLINE, shadow: C.shadow, scale: 4, color: C.white, shadowOffset: 2, align: 'center' };
  private readonly stFinishDiff: MutableStyle = { scale: 1, color: C.white, outline: DEFAULT_OUTLINE, align: 'center' };
  private readonly stFinishBest: MutableStyle = { outline: DEFAULT_OUTLINE, shadow: C.shadow, scale: 2, color: C.magenta, shadowOffset: 1, align: 'center', tracking: 1 };
  private readonly stNotice: MutableStyle = { scale: 1, color: C.gold, outline: DEFAULT_OUTLINE, align: 'center', alpha: 1 };
  // Showkeys: je Farbe ein eigenes Stil-Objekt (Memo-Treffer im BitmapFont, keine Allokation).
  private readonly stKeyDim: MutableStyle = { scale: 1, color: C.dim };
  private readonly stKeyDark: MutableStyle = { scale: 1, color: DEFAULT_OUTLINE };

  constructor(canvas: HTMLCanvasElement = document.createElement('canvas')) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Hud: 2D-Kontext nicht verfügbar');
    this.ctx = ctx;
    this.resize(canvas.width || 480, canvas.height || 270);
  }

  get width(): number {
    return this.w;
  }

  get height(): number {
    return this.h;
  }

  /** Auf die Low-Res-Auflösung des Renderers setzen (RendererApi.lowResWidth/-Height). */
  resize(w: number, h: number): void {
    const nw = Math.max(1, Math.round(w));
    const nh = Math.max(1, Math.round(h));
    if (nw === this.w && nh === this.h) return;
    this.w = this.canvas.width = nw;
    this.h = this.canvas.height = nh;
    // Nach einer Größenänderung setzt der Browser den Kontextzustand zurück.
    this.ctx.imageSmoothingEnabled = false;
    this.prewarmSpeedometer();
  }

  /**
   * Alle Farben, die der Speedometer annehmen kann (Trendstufen × Meilenstein-Mischung),
   * jetzt backen statt beim ersten Auftreten mitten im Lauf. ~40 Stile × 10 Ziffern,
   * einmalig 20–40 ms — resize() läuft beim Levelladen/Auflösungswechsel, nicht im Flow.
   */
  private prewarmSpeedometer(): void {
    const big = this.speedScale();
    const st = this.stSpeed;
    st.scale = big;
    st.shadowOffset = big;
    for (const row of MILESTONE_COLORS) {
      for (const color of row) {
        st.color = color;
        pixelFont.prewarm('0123456789', st);
      }
    }
  }

  /**
   * Movement-Werte für die Speedometer-Farbe (Maßstab = größtmöglicher Luftgewinn).
   * Bei jedem Config-Wechsel aufrufen (Preset, Tuning-Panel); Default VELOCITY_DEFAULT.
   */
  setMovement(m: TrendMovement): void {
    this.trend.setMovement(m);
  }

  /** Level-Intro manuell zeigen (passiert sonst automatisch bei 'levelLoaded'). */
  showIntro(name: string): void {
    this.intro = { born: this.t, name: name.toUpperCase() };
  }

  /**
   * Kurzer Hinweis unten mittig (klein, zwei Zeilen per '\n' möglich). 'coach' =
   * Hinweis im Moment (Crouch/Surf/Strafe): länger sichtbar, mit dunklem Band.
   */
  showNotice(text: string, kind: NoticeKind = 'info'): void {
    this.notice = { born: this.t, text, lines: text.split('\n').length, kind, life: kind === 'coach' ? COACH_LIFE : NOTICE_LIFE };
  }

  /** Text des gerade sichtbaren Hinweises (Tools/Tests), sonst null. */
  get currentNotice(): string | null {
    return this.notice ? this.notice.text : null;
  }

  /** Beschriftung der Showkeys aus der Belegung (Kurznamen, z. B. 'SPACE', 'C', 'M4'). */
  setKeyLabels(jump: string, crouch: string): void {
    this.jumpLabel = jump;
    this.crouchLabel = crouch;
  }

  /** Hinweis aus InputManager.onNotice anzeigen. */
  onInputNotice(n: InputNotice): void {
    this.showNotice(NOTICE_TEXT[n]);
  }

  /** Alle Popups/Overlays verwerfen (z. B. beim Levelwechsel). */
  clear(): void {
    this.gainCount = 0;
    this.split = null;
    this.finish = null;
    this.intro = null;
    this.notice = null;
    this.milestoneAt = -Infinity;
    this.cpFlashAt = -Infinity;
    this.strafeShown = 0;
    this.trend.reset();
    this.air.reset();
  }

  onEvent(e: GameEvent): void {
    switch (e.type) {
      case 'jump': {
        // Läuft im Tick-Pfad (EventBus) — Ring-Slot und gecachter Text statt neuer Objekte.
        if (e.chain < 2) break;
        const g = Math.round(e.gain);
        if (Math.abs(g) < GAIN_MIN_SHOWN) break;
        const slot = this.gains[(this.gainHead + this.gainCount) % GAIN_SLOTS];
        if (this.gainCount < GAIN_SLOTS) this.gainCount++;
        else this.gainHead = (this.gainHead + 1) % GAIN_SLOTS;
        slot.born = this.t;
        slot.text = gainText(g);
        slot.color = g > 0 ? C.gain : g < 0 ? C.loss : C.white;
        break;
      }
      case 'checkpoint': {
        // Selten (einmal pro Checkpoint) — hier darf formatiert werden. Den Stand "CP x/n"
        // zeigt nur die Dauerzeile unter dem Timer (sie blitzt dafür kurz in Gold).
        const split = e.split;
        const detail = formatTime(e.time);
        this.cpFlashAt = this.t;
        if (split !== null && Number.isFinite(split)) {
          this.split = {
            born: this.t,
            headline: formatDiff(split),
            headColor: split < -0.005 ? C.gain : split > 0.005 ? C.loss : C.white,
            detail,
          };
        } else {
          // Ohne Referenz keine zweite große Uhr unter dem Timer — nur die kleine Zeile.
          this.split = { born: this.t, headline: null, headColor: C.white, detail };
        }
        break;
      }
      case 'finish':
        this.finish = {
          born: this.t,
          time: e.time,
          best: e.best,
          diff: e.previousBest !== null ? e.time - e.previousBest : null,
        };
        this.split = null;
        this.gainCount = 0;
        break;
      case 'runStart':
        this.finish = null;
        this.split = null;
        break;
      case 'respawn':
        this.finish = null;
        this.gainCount = 0;
        if (e.reason === 'restart') this.split = null;
        this.trend.reset();
        this.air.reset();
        break;
      case 'speedMilestone':
        this.milestoneAt = this.t;
        break;
      case 'levelLoaded':
        this.clear();
        this.intro = { born: this.t, name: e.name.toUpperCase() };
        break;
      default:
        break;
    }
  }

  update(dt: number, data: HudData): void {
    this.data = data;
    if (data.paused || !(dt > 0)) return;
    const step = Math.min(dt, 0.1);
    this.t += step;
    this.trend.update(step, data.speed);
    this.air.update(step, data.onGround, data.surfing);
    const dimTo = data.ghostOverHud === true ? GHOST_DIM_ALPHA : 1;
    const dimStep = (step / GHOST_DIM_TIME) * (1 - GHOST_DIM_ALPHA);
    this.speedAlpha = this.speedAlpha < dimTo ? Math.min(dimTo, this.speedAlpha + dimStep) : Math.max(dimTo, this.speedAlpha - dimStep);

    // Abgelaufene Popups entsorgen.
    while (this.gainCount > 0 && this.t - this.gains[this.gainHead].born > GAIN_POPUP_LIFE) {
      this.gainHead = (this.gainHead + 1) % GAIN_SLOTS;
      this.gainCount--;
    }
    if (this.split && this.t - this.split.born > SPLIT_LIFE) this.split = null;
    if (this.intro && this.t - this.intro.born > INTRO_LIFE) this.intro = null;
    if (this.notice && this.t - this.notice.born > this.notice.life) this.notice = null;

    // Strafe-Spiegel: eine Farbe mindestens STRAFE_HOLD halten, sonst flackert sie zwischen Ticks.
    this.blinkOn = Math.floor(this.t * 8) % 2 === 0;
    const st = data.keys.strafe;
    if (st !== 0) {
      this.strafeShown = st;
      this.strafeUntil = this.t + STRAFE_HOLD;
    } else if (this.t > this.strafeUntil || !data.keys.inAir) {
      this.strafeShown = 0;
    }
  }

  draw(): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    if (!this.visible) return;
    const d = this.data;
    const s = this.uiScale();

    // Beim Ziel-Banner steht die Zeit dort groß — die obere Timerzeile wäre eine Dopplung.
    if (!this.finish || d.paused) this.drawTimer(d, s);
    // In der Pause (Menü offen) nur der Timer — alles andere würde unter dem Menü durchscheinen.
    if (d.paused) return;
    // Während der Level-Titelkarte liegt deren Band über dem Speedometer-Platz.
    if (d.showSpeedometer && !this.finish && !this.intro) this.drawSpeedometer(d, s);
    if (d.showKeys) this.drawKeys(d.keys, s);
    if (this.split) this.drawSplit(this.split, s);
    if (this.intro) this.drawIntro(this.intro, d, s);
    if (this.finish) this.drawFinish(this.finish, s);
    else this.drawCrosshair();
    if (this.notice) this.drawNotice(this.notice, s);
  }

  // ------------------------------------------------------------ Einzelteile

  /** Grundskala für kleine Schrift: 1 bis ~400 Zeilen, darüber 2. */
  private uiScale(): number {
    return this.h >= 400 ? 2 : 1;
  }

  private text(str: string, x: number, y: number, style: TextStyle): number {
    return pixelFont.drawText(this.ctx, str, x, y, style);
  }

  private drawCrosshair(): void {
    const ctx = this.ctx;
    const cx = Math.floor(this.w / 2);
    const cy = Math.floor(this.h / 2);
    ctx.fillStyle = C.shadow;
    ctx.fillRect(cx + 1, cy + 1, 1, 1);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.fillRect(cx, cy, 1, 1);
  }

  /** Oberkante der Zeile unter dem Timer (CP/PB). */
  private timerLineY(s: number): number {
    return 5 * s + 7 * 2 * s + 4 * s;
  }

  private drawTimer(d: HudData, s: number): void {
    const cx = Math.floor(this.w / 2);
    const top = 5 * s;
    const big = 2 * s;
    const t = d.runTime;
    // mm:ss nur neu, wenn die Sekunde wechselt; .cc aus der Tabelle (Hundertstel abgeschnitten wie formatTime).
    let main = '00:00';
    let cs = DOT_CS[0];
    if (t !== null) {
      if (Number.isFinite(t) && t >= 0) {
        const totalCs = Math.floor(t * 100 + 1e-6);
        const sec = Math.floor(totalCs / 100);
        if (sec !== this.timerSec) {
          this.timerSec = sec;
          this.timerMain = formatTime(sec).slice(0, 5);
        }
        main = this.timerMain;
        cs = DOT_CS[totalCs % 100];
      } else {
        main = '--:--';
        cs = '.--';
      }
    }
    const finished = t !== null && !d.running;
    const color = t === null ? C.dim : finished ? C.cyan : C.white;
    const alpha = t === null ? 0.6 : 1;
    // mm:ss groß, .cc klein auf derselben Grundlinie — die Hundertstel flimmern, die sollen nicht dominieren.
    const wMain = pixelFont.width(main, big);
    const wCs = pixelFont.width(cs, s);
    const total = wMain + s + wCs;
    const x0 = cx - Math.floor(total / 2);
    const stMain = this.stTimerMain;
    stMain.scale = big;
    stMain.color = color;
    stMain.alpha = alpha;
    this.text(main, x0, top, stMain);
    const stCs = this.stTimerCs;
    stCs.scale = s;
    stCs.color = color;
    stCs.alpha = alpha;
    this.text(cs, x0 + wMain + s, top + 7 * big - 7 * s, stCs);

    // Zweite Zeile: CP-Stand und persönliche Bestzeit, klein und gedimmt (nur bei Änderung neu gebaut).
    const cpI = d.checkpoint.index;
    const cpT = d.checkpoint.total;
    if (cpI !== this.cpIndex || cpT !== this.cpTotal || d.bestTime !== this.cpBest) {
      this.cpIndex = cpI;
      this.cpTotal = cpT;
      this.cpBest = d.bestTime;
      this.cpText = cpT > 0 ? `CP ${cpI}/${cpT}` : '';
      this.pbText = d.bestTime !== null ? `PB ${formatTime(d.bestTime)}` : '';
    }
    const gd = d.ghostDiff ?? null;
    if (gd !== this.ghostDiffShown) {
      // Nur an Checkpoints/Ziel neu — selten, hier darf formatiert werden.
      this.ghostDiffShown = gd;
      this.ghostText = gd !== null && Number.isFinite(gd) ? `GHOST ${formatDiff(gd)}` : '';
      this.ghostColor = gd === null ? C.white : gd < -0.005 ? C.gain : gd > 0.005 ? C.loss : C.white;
    }
    const nm = d.nextMedal ?? null;
    if (nm !== this.medalShown) {
      // Nur beim Levelstart und im Ziel neu (Game setzt dann ein neues Objekt).
      this.medalShown = nm;
      this.medalText = nm !== null ? `${MEDAL_NAMES[nm.id]} ${nm.limit < 60 ? (Math.floor(nm.limit * 100 + 1e-6) / 100).toFixed(2) : formatTime(nm.limit)}` : '';
      this.medalColor = nm !== null ? MEDAL_COLORS[nm.id] : C.white;
      this.medalShimmer = nm !== null && nm.id === 'velocity';
    }
    const cpW = this.cpText ? pixelFont.width(this.cpText, s) : 0;
    const pbW = this.pbText ? pixelFont.width(this.pbText, s) : 0;
    const ghW = this.ghostText ? pixelFont.width(this.ghostText, s) : 0;
    // Ziel-Medaille nur, solange kein Ghost-Abstand in der Zeile steht (sonst zu voll).
    const mdW = this.medalText && ghW === 0 ? pixelFont.width(this.medalText, s) : 0;
    if (cpW + pbW + ghW + mdW === 0) return;
    const gap = cpW > 0 && pbW > 0 ? 9 * s : 0;
    const gap2 = ghW > 0 && cpW + pbW > 0 ? 9 * s : 0;
    const gap3 = mdW > 0 && cpW + pbW > 0 ? 9 * s : 0;
    let x = cx - Math.floor((cpW + gap + pbW + gap2 + ghW + gap3 + mdW) / 2);
    const y = this.timerLineY(s);
    const dim = this.stTimerLine;
    dim.scale = s;
    if (cpW > 0) {
      // Nach einem Checkpoint blitzt der Stand kurz in Gold — das Popup darunter zeigt nur noch die Zeit.
      const flash = this.t - this.cpFlashAt < CP_FLASH;
      const st = flash ? this.stTimerLineGold : dim;
      st.scale = s;
      this.text(this.cpText, x, y, st);
      x += cpW + gap;
    }
    if (pbW > 0) {
      this.text(this.pbText, x, y, dim);
      x += pbW + gap2;
    } else x += gap2 - gap;
    if (ghW > 0) {
      // Ghost-Abstand in Gewinn-/Verlustfarbe — die einzige farbige Angabe der Zeile.
      const st = this.stGhostLine;
      st.scale = s;
      st.color = this.ghostColor;
      this.text(this.ghostText, x, y, st);
    } else if (mdW > 0) {
      // Nächstes Ziel in der Medaillenfarbe; VELOCITY schimmert Cyan/Magenta (2 Hz, harte Stufen).
      const st = this.stMedalLine;
      st.scale = s;
      st.color = this.medalShimmer && Math.floor(this.t * 4) % 2 === 1 ? MEDAL_SHIMMER : this.medalColor;
      this.text(this.medalText, x + gap3, y, st);
    }
  }

  /** Speedometer nie kleiner als der Timer: 240/270 → 2, 360 → 3, ab 400 Zeilen (UI-Skala 2) → 4. */
  private speedScale(): number {
    const s = this.uiScale();
    if (s >= 2) return 2 * s;
    return this.h >= 330 ? 3 : 2;
  }

  /**
   * Oberkante der Speedometer-Ziffern: ÜBER dem Fadenkreuz. Bei 0.70 h lag der
   * Aufsetzpunkt der nächsten Landung in 25–30 % der Entscheidungs-Frames unter
   * den Ziffern (Landeflächen liegen beim Geradeausblick unter dem Horizont).
   */
  private speedTop(): number {
    return Math.round(this.h * SPEED_TOP);
  }

  /** Zeilen [oben, unten] des Speedometer-Blocks (Zahl + Ketten-/Sync-Zeile) — für Mess-Tools. */
  speedBlockRows(): [number, number] {
    return [this.speedTop(), this.speedBlockBottom()];
  }

  /** Oberkante des Speedometer-Blocks (HUD-Pixel) — ohne Tupel, für den Frame-Pfad. */
  speedBlockTop(): number {
    return this.speedTop();
  }

  /** Unterkante des Speedometer-Blocks (HUD-Pixel). */
  speedBlockBottom(): number {
    const s = this.uiScale();
    return this.speedTop() + 7 * this.speedScale() + 5 * s + 7 * s;
  }

  private drawSpeedometer(d: HudData, s: number): void {
    const cx = Math.floor(this.w / 2);
    const big = this.speedScale();
    const y = this.speedTop();
    const str = intText(Math.max(0, Math.round(d.speed)));

    const sinceMilestone = this.t - this.milestoneAt;
    const row = MILESTONE_COLORS[trendIndex(this.trend.colorT) + COLOR_STEPS];
    let color = row[MILESTONE_STEPS];
    if (sinceMilestone < MILESTONE_LIFE) {
      // Meilenstein: Zahl kurz in Neon-Cyan, danach zurück — dezent, kein Konfetti.
      const u = sinceMilestone / MILESTONE_LIFE;
      color = u < 0.5 ? C.cyan : row[quantize((u - 0.5) * 2, MILESTONE_STEPS)];
    }
    const st = this.stSpeed;
    st.scale = big;
    st.shadowOffset = big;
    st.color = color;
    const fade = this.speedAlpha;
    st.alpha = fade;
    const w = this.text(str, cx, y, st);

    if (sinceMilestone < MILESTONE_LIFE) this.drawMilestoneLines(cx, y, w, big, sinceMilestone / MILESTONE_LIFE, fade);

    // Gain-Popups rechts neben der Zahl: steigen auf und verblassen.
    const px = cx + Math.ceil(w / 2) + 4 * s;
    const sg = this.stGain;
    sg.scale = s;
    for (let k = 0; k < this.gainCount; k++) {
      const p = this.gains[(this.gainHead + k) % GAIN_SLOTS];
      const age = (this.t - p.born) / GAIN_POPUP_LIFE;
      const rise = Math.round(age * 10 * s);
      sg.color = p.color;
      sg.alpha = (age < 0.5 ? 1 : 1 - (age - 0.5) * 2) * fade;
      this.text(p.text, px, y - rise, sg);
    }

    // Zweite Zeile: Hop-Kette und Sync (in der Luft, entprellt), klein.
    const segs = this.segs;
    let n = 0;
    if (d.hopChain >= 2 && d.speed >= CHAIN_MIN_SPEED) setSeg(segs[n++], chainText(d.hopChain), C.cyan, false);
    if (this.air.surf) setSeg(segs[n++], 'SURF', C.magenta, false);
    else if (this.air.air) {
      const sync = Math.round(Math.max(0, Math.min(1, d.strafeSync)) * 100);
      setSeg(segs[n++], 'SYNC', C.dim, false);
      setSeg(segs[n++], percentText(sync), sync >= 80 ? C.gain : sync >= 50 ? C.white : C.loss, true);
    }
    if (n > 0) this.drawSegments(segs, n, cx, y + 7 * big + 5 * s, s, fade);
  }

  private drawMilestoneLines(cx: number, y: number, w: number, big: number, age: number, fade: number): void {
    const ctx = this.ctx;
    const len = Math.round(6 + age * 26);
    const gap = Math.ceil(w / 2) + 4;
    const ly = y + Math.floor((7 * big) / 2);
    ctx.globalAlpha = (1 - age) * fade;
    ctx.fillStyle = C.cyan;
    ctx.fillRect(cx - gap - len, ly, len, 1);
    ctx.fillRect(cx + gap, ly, len, 1);
    ctx.globalAlpha = 1;
  }

  /** Mehrfarbige Zeile, zentriert. */
  private drawSegments(segs: readonly Seg[], n: number, cx: number, y: number, s: number, fade: number): void {
    const wide = 6 * s;
    const narrow = 3 * s;
    let total = 0;
    for (let i = 0; i < n; i++) {
      total += pixelFont.width(segs[i].text, s);
      if (i > 0) total += segs[i].tight ? narrow : wide;
    }
    let x = cx - Math.floor(total / 2);
    const st = this.stSeg;
    st.scale = s;
    st.alpha = SEG_ALPHA * fade;
    for (let i = 0; i < n; i++) {
      const sg = segs[i];
      if (i > 0) x += sg.tight ? narrow : wide;
      st.color = sg.color;
      x += this.text(sg.text, x, y, st);
    }
  }

  private drawSplit(p: SplitPopup, s: number): void {
    const age = this.t - p.born;
    const alpha = age < 0.1 ? age / 0.1 : age > SPLIT_LIFE - 0.5 ? (SPLIT_LIFE - age) / 0.5 : 1;
    const cx = Math.floor(this.w / 2);
    const y = this.timerLineY(s) + 12 * s;
    // Kurzes "Einrasten": die ersten 80 ms eine Zeile höher — liest sich als Ereignis, nicht als Dauertext.
    const bump = age < 0.08 ? -s : 0;
    const detail = this.stSplitDetail;
    detail.scale = s;
    detail.alpha = alpha;
    // Mit Ghost steht derselbe Abstand schon farbig in der Zeile darüber ("GHOST +0.19") —
    // die große Zahl wäre eine Dopplung genau im Moment des Checkpoints (Prüfung 27.09.).
    if (p.headline === null || this.ghostText !== '') {
      this.text(p.detail, cx, y + bump, detail);
      return;
    }
    const head = this.stSplitHead;
    head.scale = 2 * s;
    head.color = p.headColor;
    head.alpha = alpha;
    this.text(p.headline, cx, y + bump, head);
    this.text(p.detail, cx, y + 14 * s + 4 * s, detail);
  }

  private band(cy: number, height: number, widthFrac: number, alpha: number): void {
    const ctx = this.ctx;
    const cx = Math.floor(this.w / 2);
    const bw = Math.round(this.w * widthFrac);
    const x = cx - Math.floor(bw / 2);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = C.band;
    ctx.fillRect(x, cy, bw, height);
    ctx.fillStyle = C.cyan;
    ctx.fillRect(x, cy, bw, 1);
    ctx.fillStyle = C.magenta;
    ctx.fillRect(x, cy + height - 1, bw, 1);
    ctx.globalAlpha = 1;
  }

  private drawIntro(intro: IntroInfo, d: HudData, s: number): void {
    const age = this.t - intro.born;
    const cx = Math.floor(this.w / 2);
    const big = 3 * s;
    const cy = Math.round(this.h * 0.3);
    const fadeOut = age > INTRO_LIFE - 0.45 ? Math.max(0, (INTRO_LIFE - age) / 0.45) : 1;
    // Band wischt von der Mitte nach außen auf (PS2-Titelkarte).
    const open = Math.min(1, age / 0.22);
    const sub = d.levelSubtitle;
    const bandH = 7 * big + (sub ? 22 : 12) * s;
    this.band(cy - 6 * s, bandH, easeOut(open), fadeOut);
    if (open < 1) return;
    const textAlpha = Math.min(1, (age - 0.22) / 0.15) * fadeOut;
    const st = this.stIntro;
    st.scale = big;
    st.shadowOffset = 2 * s;
    st.tracking = s;
    st.alpha = textAlpha;
    this.text(intro.name, cx, cy, st);
    if (sub) {
      const ss = this.stIntroSub;
      ss.scale = s;
      ss.alpha = textAlpha;
      this.text(sub, cx, cy + 7 * big + 5 * s, ss);
    }
  }

  private drawFinish(f: FinishInfo, s: number): void {
    const age = this.t - f.born;
    const cx = Math.floor(this.w / 2);
    const big = 4 * s;
    const y = Math.round(this.h * 0.36);
    const open = Math.min(1, age / 0.2);
    const blockH = 12 * s + 7 * big + (f.diff !== null ? 13 : 4) * s + (f.best ? 24 : 0) * s;
    this.band(y - 18 * s, blockH + 12 * s, easeOut(open), 1);
    if (open < 1) return;
    const label = this.stFinishLabel;
    label.scale = s;
    label.tracking = 2 * s;
    this.text('ZIEL', cx, y - 12 * s, label);
    const time = this.stFinishTime;
    time.scale = big;
    time.shadowOffset = 2 * s;
    this.text(formatTime(f.time), cx, y, time);
    let y2 = y + 7 * big + 6 * s;
    if (f.diff !== null) {
      const diff = this.stFinishDiff;
      diff.scale = s;
      diff.color = f.diff < 0 ? C.gain : f.diff > 0 ? C.loss : C.white;
      this.text(formatDiff(f.diff), cx, y2, diff);
      y2 += 12 * s;
    }
    if (f.best) {
      // Blinkt mit 3 Hz zwischen Magenta und Gold — unübersehbar, aber im Pixel-Stil.
      const on = Math.floor(age * 6) % 2 === 0;
      const best = this.stFinishBest;
      best.scale = 2 * s;
      best.shadowOffset = s;
      best.tracking = s;
      best.color = on ? C.magenta : C.gold;
      this.text('NEUE BESTZEIT', cx, y2 + 2 * s, best);
    }
  }

  /** Hinweis unten mittig, über dem unteren Rand; blendet am Ende aus. */
  private drawNotice(n: NoticeInfo, s: number): void {
    const age = this.t - n.born;
    const st = this.stNotice;
    st.scale = s;
    const alpha = age > n.life - 0.5 ? Math.max(0, (n.life - age) / 0.5) : 1;
    st.alpha = alpha;
    const textH = (n.lines * 7 + (n.lines - 1) * 4) * s;
    const y = this.h - 8 * s - textH;
    const cx = Math.floor(this.w / 2);
    if (n.kind === 'coach') {
      // Band hinter dem Text: lesbar über hellem Boden; kurzes Aufblinken beim Erscheinen.
      const ctx = this.ctx;
      const bw = pixelFont.width(n.text, s) + 14 * s;
      const bx = cx - Math.floor(bw / 2);
      const by = y - 4 * s;
      const bh = textH + 8 * s;
      ctx.globalAlpha = alpha * 0.8;
      ctx.fillStyle = C.band;
      ctx.fillRect(bx, by, bw, bh);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = C.gold;
      ctx.fillRect(bx, by, bw, s);
      ctx.fillRect(bx, by + bh - s, bw, s);
      ctx.globalAlpha = 1;
      if (age < 0.3 && Math.floor(age * 10) % 2 === 1) return;
    }
    this.text(n.text, cx, y, st);
  }

  /**
   * Showkeys + Strafe-Spiegel unten links: W A S D, Sprung und Ducken leuchten,
   * solange gehalten; darüber ein 1-px-Balken für Drehrichtung und -rate der Maus.
   * In der Luft wird A/D grün, wenn die Taste zur Drehrichtung passt und Tempo
   * brachte, rot bei Taste gegen die Maus; W blinkt rot, wenn es in der Luft mit
   * A/D gehalten wird. Nur fillRect und feste Stile — keine Allokation.
   */
  private drawKeys(k: HudKeys, s: number): void {
    const u = 11 * s;
    const g = 2 * s;
    // Links im Safe-Frame (max. 16:9): auf Ultrawide nicht ganz außen im Augenwinkel.
    const x0 = safeLeft(this.w, this.h) + 6 * s;
    const rowSpace = this.h - 6 * s - u;
    const row1 = rowSpace - g - u;
    const row0 = row1 - g - u;
    const colA = x0;
    const colS = x0 + u + g;
    const colD = x0 + 2 * (u + g);
    const spaceW = 3 * u + 2 * g;

    const air = k.inAir;
    const strafe = air ? this.strafeShown : 0;
    const wBlink = air && k.forward > 0 && k.forwardInAirMs > W_AIR_WARN_MS && this.blinkOn;
    this.keyBox(colS, row0, u, s, 'W', k.forward > 0, wBlink ? K.loss : K.on);
    this.keyBox(colA, row1, u, s, 'A', k.side < 0, k.side < 0 ? sideColor(strafe) : K.on);
    this.keyBox(colS, row1, u, s, 'S', k.forward < 0, K.on);
    this.keyBox(colD, row1, u, s, 'D', k.side > 0, k.side > 0 ? sideColor(strafe) : K.on);
    this.keyBox(x0, rowSpace, spaceW, s, this.jumpLabel, k.jump, K.on);
    const cw = Math.max(u, pixelFont.width(this.crouchLabel, s) + 6 * s);
    this.keyBox(x0 + spaceW + g, rowSpace, cw, s, this.crouchLabel, k.crouch, K.on);

    // Drehraten-Balken über W: nach links = Maus nach links.
    const ctx = this.ctx;
    // Nur Ganzzahl-Rechnung (>> statt /): kein Gleitkomma-Zwischenwert, der in kaltem Code geboxt würde.
    const half = spaceW >> 1;
    const mid = x0 + half;
    const by = row0 - 4 * s;
    ctx.fillStyle = K.tick;
    ctx.fillRect(mid, by - s, s, 3 * s);
    const turn = Math.min(TURN_FULL_DEG, Math.abs(k.turnDeg));
    const len = (turn * half * 91) >> 15;
    if (len > 0) {
      ctx.fillStyle = K.turn;
      if (k.turnDeg > 0) ctx.fillRect(mid - len, by, len, s);
      else ctx.fillRect(mid + s, by, len, s);
    }
  }

  private keyBox(x: number, y: number, w: number, s: number, label: string, on: boolean, fill: string): void {
    const ctx = this.ctx;
    const h = 11 * s;
    if (on) {
      ctx.fillStyle = fill;
      ctx.fillRect(x, y, w, h);
    } else {
      ctx.fillStyle = K.back;
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = K.frame;
      ctx.fillRect(x, y, w, s);
      ctx.fillRect(x, y + h - s, w, s);
      ctx.fillRect(x, y + s, s, h - 2 * s);
      ctx.fillRect(x + w - s, y + s, s, h - 2 * s);
    }
    const st = on ? this.stKeyDark : this.stKeyDim;
    st.scale = s;
    const tw = pixelFont.width(label, s);
    this.text(label, x + ((w - tw) >> 1), y + 2 * s, st);
  }
}

function sideColor(strafe: number): string {
  return strafe > 0 ? K.gain : strafe < 0 ? K.loss : K.on;
}

function setSeg(sg: Seg, text: string, color: string, tight: boolean): void {
  sg.text = text;
  sg.color = color;
  sg.tight = tight;
}

function easeOut(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

/** t ∈ [0, 1] auf 0..steps runden. */
function quantize(t: number, steps: number): number {
  return Math.round(Math.max(0, Math.min(1, t)) * steps);
}

/** Trendmischung t ∈ [−1, 1] → Stufe −COLOR_STEPS..COLOR_STEPS (symmetrisch gerundet wie mixHex). */
function trendIndex(t: number): number {
  return t > 0 ? quantize(t, COLOR_STEPS) : -quantize(-t, COLOR_STEPS);
}

/** Zwei #rrggbb-Farben mischen, t auf `steps` Stufen quantisiert (begrenzte Palette, kleiner Glyphen-Cache). */
function mixHex(a: string, b: string, t: number, steps: number): string {
  const q = quantize(t, steps) / steps;
  if (q <= 0) return a;
  if (q >= 1) return b;
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const r = Math.round(((pa >> 16) & 255) * (1 - q) + ((pb >> 16) & 255) * q);
  const g = Math.round(((pa >> 8) & 255) * (1 - q) + ((pb >> 8) & 255) * q);
  const bl = Math.round((pa & 255) * (1 - q) + (pb & 255) * q);
  return `#${((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1)}`;
}

/**
 * Speedometer-Farben vorab: Zeile = Trendstufe (−COLOR_STEPS..COLOR_STEPS),
 * Spalte k = Meilenstein-Mischung Cyan → Trendfarbe (k = MILESTONE_STEPS: reine Trendfarbe).
 */
const MILESTONE_COLORS: readonly (readonly string[])[] = Array.from({ length: 2 * COLOR_STEPS + 1 }, (_, i) => {
  const step = i - COLOR_STEPS;
  const base = step > 0 ? mixHex(C.white, C.gain, step / COLOR_STEPS, COLOR_STEPS) : step < 0 ? mixHex(C.white, C.loss, -step / COLOR_STEPS, COLOR_STEPS) : C.white;
  return Array.from({ length: MILESTONE_STEPS + 1 }, (_, k) => mixHex(C.cyan, base, k / MILESTONE_STEPS, MILESTONE_STEPS));
});

/** ".00" … ".99" — Hundertstel des Timers ohne String-Bau pro Frame. */
const DOT_CS: readonly string[] = Array.from({ length: 100 }, (_, i) => (i < 10 ? `.0${i}` : `.${i}`));

/** Lazy gefüllte String-Caches: jeder Wert wird genau einmal gebaut. */
const INT_TEXT: string[] = [];
const GAIN_TEXT: string[] = [];
const CHAIN_TEXT: string[] = [];
const PERCENT_TEXT: string[] = [];
const CACHE_LIMIT = 10000;

function intText(n: number): string {
  if (n < 0 || n >= CACHE_LIMIT) return String(n);
  return (INT_TEXT[n] ??= String(n));
}

function gainText(g: number): string {
  if (g <= -CACHE_LIMIT || g >= CACHE_LIMIT) return g > 0 ? `+${g}` : `−${-g}`;
  const i = g + CACHE_LIMIT;
  return (GAIN_TEXT[i] ??= g > 0 ? `+${g}` : g < 0 ? `−${-g}` : '+0');
}

function chainText(n: number): string {
  if (n < 0 || n >= CACHE_LIMIT) return `×${n}`;
  return (CHAIN_TEXT[n] ??= `×${n}`);
}

function percentText(n: number): string {
  if (n < 0 || n > 100) return `${n}%`;
  return (PERCENT_TEXT[n] ??= `${n}%`);
}
