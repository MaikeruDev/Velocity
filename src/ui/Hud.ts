import type { GameEvent } from '../engine/events';
import type { InputNotice } from '../engine/InputState';
import { MIN_TAKEOFF, VERDICT_TEXT } from '../engine/strafeJudge';
import { DEFAULT_OUTLINE, pixelFont } from './BitmapFont';
import type { TextStyle } from './BitmapFont';
import { formatDiff, formatTime } from './format';
import { AirDisplay, LESSON_PIP, MAX_PIPS, SpeedTrend, lessonCardLayout, makeLessonCardLayout, stageSteps, turnBarLength } from './hudLogic';
import type { TrendMovement } from './hudLogic';
import type { HudData, HudKeys, LessonHud } from './types';
import type { StageRank } from '../world/level/LevelFormat';
import { MEDAL_COLORS, MEDAL_NAMES, MEDAL_SHIMMER } from './medals';
import { safeLeft, safeRight } from './safeFrame';

/**
 * HUD im Low-Res-Pixelraster: eigener transparenter Canvas in exakt der
 * Auflösung des Render-Targets, den der Renderer 1:1 im selben Raster
 * einrechnet. Minimal nach Bhop-/KZ-Tradition: großer Speedometer unten mittig,
 * Timer oben, kurze Popups für Gain und Splits.
 *
 * Lebenszyklus: resize(w, h) bei Auflösungswechsel, setMovement(cfg) bei
 * Config-Wechsel → pro Frame onEvent(e) für alle Ereignisse, update(dt, data), draw().
 *
 * Lektionen (Plan 007, HudData.lesson): die Lektionskarte ersetzt die Timerzeile (≤ 4 Zeilen oben),
 * in Stufen, die Strafen bewerten (judge), steht jedes Urteil (lessonHop) am Gain-Popup ("+23 GUT",
 * "+0 MAUS!") — sonst Gain-Popups wie im normalen Level und keine SYNC-Zeile. Der Drehbalken der
 * Showkeys zeigt das Zielband, unten das Coach-Band (Tipps; ein Stufenwechsel verwirft den Tipp der alten
 * Stufe) bzw. während der Vorführung das Demo-Band.
 * Die Bildmitte bleibt frei (Landepunkt) — Rechtecke für Tools über rect().
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
  cyanDim: '#23a8b3',
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
/** W in der Luft mit A/D ab dieser Dauer (ms) rot blinken lassen (nur ohne Strafe-Assist, siehe wWarn). */
const W_AIR_WARN_MS = 150;
/** Lektion: Titelzeile zeigt nach einer Stufe so lange "GESCHAFFT!" (s). */
const STAGE_FLASH = 1.2;
/** Lektion bestanden: "LEKTION GESCHAFFT!" so lange (s). */
const LESSON_FLASH = 2.4;
/** Neuer Pip leuchtet so lange auf (s). */
const PIP_POP = 0.3;
/** Titel/Hinweise der Karte als feste Strings (Vergleich per Identität im Frame-Pfad). */
const TITLE_LESSON_DONE = 'LEKTION GESCHAFFT!';
const TITLE_STAGE_DONE = 'GESCHAFFT!';
const TITLE_ALL_DONE = 'ALLES GESCHAFFT!';
const HINT_RESULT = '[ENTER] ERGEBNIS';
/** Kurztext am Gain-Popup für einen Absprung, der zu langsam für ein Urteil ist (strafeJudge.MIN_TAKEOFF). */
const SLOW_TAKEOFF_TEXT = 'ANLAUF MIT W';
/** Dasselbe mit gehaltenem W: der Absprung kam vor dem Tempo (Smart-Hop nach 0.2 s Stand), W ist schon richtig. */
const SLOW_TAKEOFF_W_TEXT = 'WEITER ANLAUFEN';
/** Beschriftung des Maus-Drehbalkens in Lektionen mit Zielband (sonst sah man nur Striche über W). */
const TURN_LABEL = 'MAUS';
/**
 * Legende statt "MAUS", bis der erste gute Hop der Lektion sitzt: das Band war nur per Tipp nach 12 s Stillstand
 * erklärt — wer es nicht verstand, sah Striche. Wortlaut wie der T3-Tipp ("MAUS-TEMPO … IM GRÜNEN").
 */
const TURN_LEGEND = 'MAUS-TEMPO\nIM FLUG IM GRÜNEN HALTEN';
/** Demo-Band, sobald die Vorführung die Aufgabe erfüllt hat (Game kehrt ~1 s später zum Stufen-Spawn zurück). */
const DEMO_GOAL_TEXT = "SO GEHT'S! GLEICH BIST DU DRAN";
/** Rand einer vorgerenderten Kachel (× UI-Skala): Akzente, Kontur und Schatten ragen über das Band. */
const SPRITE_MARGIN = 8;

/**
 * Vorgerenderte HUD-Kachel: ein Element mit viel Text wird nur bei Änderung in einen eigenen Canvas
 * gezeichnet und sonst mit EINEM drawImage kopiert (ganzzahlig, pixelgleich zum direkten Zeichnen).
 * begin() verschiebt den Nullpunkt, sodass in HUD-Koordinaten gezeichnet wird.
 */
class HudSprite {
  private canvas: HTMLCanvasElement | null = null;
  private context: CanvasRenderingContext2D | null = null;
  private x = 0;
  private y = 0;
  private w = 0;
  private h = 0;

  /** Neu zeichnen: Ausschnitt (x, y, w, h) in HUD-Koordinaten leeren; Kontext zeichnet in HUD-Koordinaten. */
  begin(x: number, y: number, w: number, h: number): CanvasRenderingContext2D {
    let c = this.canvas;
    let ctx = this.context;
    if (c === null || ctx === null) {
      c = document.createElement('canvas');
      c.width = Math.max(64, w);
      c.height = Math.max(16, h);
      ctx = c.getContext('2d');
      if (!ctx) throw new Error('Hud: 2D-Kontext nicht verfügbar');
      this.canvas = c;
      this.context = ctx;
    } else if (c.width < w || c.height < h) {
      // Nur wachsen (setzt den Kontext zurück) — kommt höchstens ein paar Mal vor.
      c.width = Math.max(c.width, w);
      c.height = Math.max(c.height, h);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, w, h);
    ctx.setTransform(1, 0, 0, 1, -x, -y);
    this.x = x;
    this.y = y;
    this.w = w;
    this.h = h;
    return ctx;
  }

  end(): void {
    this.context?.setTransform(1, 0, 0, 1, 0, 0);
  }

  blit(dst: CanvasRenderingContext2D): void {
    if (this.canvas !== null && this.w > 0) dst.drawImage(this.canvas, 0, 0, this.w, this.h, this.x, this.y, this.w, this.h);
  }

  /** Mit Versatz (dx, dy) und Deckkraft kopieren (verblassende Popups: wie BitmapFont.blitLineFaded). */
  blitAt(dst: CanvasRenderingContext2D, dx: number, dy: number, alpha: number): void {
    if (this.canvas === null || this.w <= 0) return;
    if (alpha < 1) dst.globalAlpha = alpha;
    dst.drawImage(this.canvas, 0, 0, this.w, this.h, this.x + dx, this.y + dy, this.w, this.h);
    if (alpha < 1) dst.globalAlpha = 1;
  }
}

/** Was die Karten-Kachel zuletzt zeigte (neu zeichnen nur bei Abweichung) und wo sie liegt. */
interface CardCache {
  title: string;
  /** Stufenzähler ("2/4"); während des Geschafft-Blitzes der der erledigten Stufe. '' = keiner. */
  step: string;
  flash: boolean;
  blink: boolean;
  fresh: boolean;
  count: number;
  goal: number;
  style: LessonHud['style'];
  rank: LessonHud['rank'];
  /** Hinweis rechts vom Fortschritt ("[H] ZEIGEN" bzw. "[ENTER] ERGEBNIS"). */
  hint: string;
  /** Hinweis links vom Fortschritt: "[H] ZEIGEN", solange rechts das Ergebnis steht. */
  hintLeft: string;
  hintGold: boolean;
  /** Fortschritt wird gezeichnet (nach der letzten Stufe nur beim Geschafft-Blitz). */
  progress: boolean;
  scale: number;
  width: number;
  height: number;
  bx: number;
  by: number;
  bw: number;
  bh: number;
}

/** HUD-Rechtecke für Tools (__vel.hudLayout): Index in HudRect-Reihenfolge. */
export const HUD_RECTS = ['card', 'verdict', 'notice', 'demo', 'speed', 'photo'] as const;
export type HudRectName = (typeof HUD_RECTS)[number];

/** Movement-Werte, die das HUD liest: Speedometer-Farbe (TrendMovement) und ob W in der Luft schadet. */
export interface HudMovement extends TrendMovement {
  /** An: W zählt in der Luft nicht, solange A/D gehalten wird — dann blinkt W nicht rot (movement.md). */
  readonly strafeAssist: boolean;
}

/** Was die Lektionskarte zuletzt zeigte (Tools: __vel.hudLayout().card). Kein Frame-Pfad. */
export interface HudCardState {
  readonly title: string;
  readonly step: string;
  readonly count: number;
  readonly goal: number;
  readonly style: LessonHud['style'];
  readonly progress: boolean;
  readonly hint: string;
  readonly hintLeft: string;
}
const R_CARD = 0;
const R_VERDICT = 1;
const R_NOTICE = 2;
const R_DEMO = 3;
const R_SPEED = 4;
const R_PHOTO = 5;

/** Ziel-Foto (Plan 007 I3): Stempel "FOTO" so lange sichtbar, der Auslöser-Blitz am Rand so kurz (s). */
const PHOTO_LIFE = 1.4;
const PHOTO_FLASH = 0.12;

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
  /** Urteil einer Lektion dahinter ("GUT", "MAUS!"), '' = keins. */
  verdict: string;
  verdictColor: string;
  /** Laufende Nummer des Urteils (Hud.verdictSerial), 0 = reines Gain-Popup. */
  serial: number;
  /**
   * Text + Urteil einmal vorgerendert (beim ersten Zeichnen), danach je Frame ein drawImage mit Deckkraft.
   * Direkt verblassend gezeichnet ging jeder Text über denselben Scratch-Canvas — zwei Texte je Popup
   * ließen ihn im Frame zweimal beschreiben und kopieren (+0.1 ms). scale 0 = noch nicht gerendert.
   */
  scale: number;
  width: number;
  readonly sprite: HudSprite;
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
  /** Zielband am Drehbalken (Lektion): Fläche gedämpft grün, Enden heller. */
  band: 'rgba(93, 255, 154, 0.35)',
  bandEdge: 'rgba(93, 255, 154, 0.8)',
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
  private readonly gains: GainPopup[] = Array.from({ length: GAIN_SLOTS }, () => ({ born: 0, text: '', color: C.white, verdict: '', verdictColor: C.white, serial: 0, scale: 0, width: 0, sprite: new HudSprite() }));
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

  // Lektion (Plan 007). Game setzt demo/demoGoal/judge/lessonDone/demoAvailable pro Frame (nur Booleans).
  /** Vorführung läuft: Demo-Band statt Coach-Band. */
  demo = false;
  /** Vorführung hat die Aufgabe der Stufe erfüllt: Demo-Band "SO GEHT'S!" (grün, ohne Puls). */
  demoGoal = false;
  /**
   * Die Stufe bewertet Strafen (Game, je Stufe): Urteile am Gain-Popup und SYNC-Zeile. false = Gain-Popups
   * wie im normalen Level — "+0 W LOS" in Gold widersprach in T1/T2 der Anweisung "W + LEERTASTE HALTEN".
   */
  judge = false;
  /** Urteile angenommen (je gezeigtem 'lessonHop' +1) und höchste davon je gezeichnete Nummer (Tools: Verzug). */
  private verdictN = 0;
  private verdictDrawnN = 0;
  /** Stufenzähler je Rang (hudLogic.stageSteps, Game beim Laden); null = über alle Stufen zählen. */
  private stageStepText: readonly string[] | null = null;
  /** Index der zuletzt erledigten Stufe (lessonStage) — ihr Zähler steht beim Geschafft-Blitz. */
  private stageDoneIndex = -1;
  /** Nächster Absprung ist der erste nach Stufenstart/Respawn/Levelstart (aus dem Stand) — kein "ANLAUF"-Tadel. */
  private standHop = true;
  /**
   * Ziel und Art des Fortschritts der laufenden Stufe (zuletzt gezeichnet) und die der erledigten: beim
   * Geschafft-Blitz steht die VOLLE Reihe der erledigten Stufe ("5/5"). Die Session setzt den Zähler im
   * Tick der Erfüllung schon auf die neue Stufe — sonst sah man nie alle Pips gefüllt. doneGoal 0 = unbekannt.
   */
  private liveGoal = 0;
  private liveStyle: LessonHud['style'] = 'pips';
  private doneGoal = 0;
  private doneStyle: LessonHud['style'] = 'pips';
  /** Alle Pflichtstufen erledigt: Karte zeigt "[ENTER] ERGEBNIS". */
  lessonDone = false;
  /** Stufe hat eine Vorführung: Karte zeigt z. B. "[H] ZEIGEN" (setDemoKey). */
  demoAvailable = false;
  private demoHint = '[H] ZEIGEN';
  private demoBandText = 'VORFÜHRUNG · BELIEBIGE TASTE = SELBST';
  private lessonActive = false;
  private readonly cardLay = makeLessonCardLayout();
  // Karten-Cache: nur beim Stufenwechsel neu (Quelle = Objekt-Identität der Strings).
  private cardTitleSrc = '';
  private cardTextSrc = '';
  private cardIndex = -1;
  private cardTotal = -1;
  private cardStep = '';
  private cardLines = 0;
  private cardTextW = 0;
  private cardTitleW = 0;
  private stageDoneAt = -Infinity;
  private lessonDoneAt = -Infinity;
  private pipPopAt = -Infinity;
  private readonly cardSprite = new HudSprite();
  private readonly card: CardCache = {
    title: '',
    step: '',
    flash: false,
    blink: false,
    fresh: false,
    count: -1,
    goal: -1,
    style: 'pips',
    rank: 'required',
    hint: '',
    hintLeft: '',
    hintGold: false,
    progress: false,
    scale: 0,
    width: 0,
    height: 0,
    bx: 0,
    by: 0,
    bw: 0,
    bh: 0,
  };
  private readonly demoSprite = new HudSprite();
  /** phase 0/1 = Puls der laufenden Vorführung, 2 = Ziel erreicht ("SO GEHT'S!"). */
  private readonly demoBand = { phase: -1, text: '', scale: 0, width: 0, height: 0, bx: 0, by: 0, bw: 0, bh: 0 };
  /** Letzte gezeichnete Rechtecke (x, y, w, h je HUD_RECTS), w = 0 = nicht gezeichnet. */
  private readonly rects = new Int32Array(HUD_RECTS.length * 4);

  // Showkeys: Beschriftung aus der Belegung (setKeyLabels), gehaltene Spiegel-Farbe.
  private jumpLabel = 'SPACE';
  private crouchLabel = 'C';
  private strafeShown = 0;
  private strafeUntil = -Infinity;
  /** Blinkphase (8 Hz) — in update() berechnet, damit drawKeys nur Ganzzahlen anfasst. */
  private blinkOn = false;
  /**
   * W in der Luft mit A/D rot blinken lassen: nur ohne Strafe-Assist. Mit Assist zählt W dort nicht
   * (movement.md) — das Blinken widersprach dem Urteil "GUT" (der Judge urteilt 'wHeld' auch nur ohne Assist).
   */
  private wWarn = false;
  /** W-Taste bzw. Legende am Drehbalken im letzten draw() gezeichnet (Tools: hudLayout().wRed/.turnLegend). */
  private wRedDrawn = false;
  private turnLegendDrawn = false;
  /** Lektion mit Zielband: noch kein guter Hop — Legende am Drehbalken (TURN_LEGEND). Neu je Level/Lektion. */
  private turnLegend = true;
  /** Beschriftung des Drehbalkens vorgerendert (2 Zeilen Legende wären je Frame Glyphe für Glyphe). */
  private readonly turnSprite = new HudSprite();
  private readonly turnLabel = { text: '', color: '', x: -1, y: -1, scale: 0 };

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
  private readonly stVerdict: MutableStyle = { scale: 1, color: C.gold, outline: DEFAULT_OUTLINE, alpha: 1 };
  private readonly stCardTitle: MutableStyle = { outline: DEFAULT_OUTLINE, shadow: C.shadow, scale: 2, color: C.white, alpha: 1 };
  private readonly stCardSmall: MutableStyle = { scale: 1, color: C.dim, shadow: true };
  private readonly stCardRank: MutableStyle = { scale: 1, color: C.gold, outline: DEFAULT_OUTLINE };
  private readonly stCardText: MutableStyle = { scale: 1, color: C.white, outline: DEFAULT_OUTLINE, align: 'center' };
  private readonly stCardHint: MutableStyle = { scale: 1, color: C.dim, shadow: true };
  private readonly stDemo: MutableStyle = { scale: 1, color: C.cyan, outline: DEFAULT_OUTLINE, align: 'center', alpha: 1 };
  private readonly stPhoto: MutableStyle = { scale: 2, color: C.white, outline: DEFAULT_OUTLINE, tracking: 1, alpha: 1 };
  /** HUD-Uhr beim Auslösen des Ziel-Fotos, −∞ = keins (showPhoto). */
  private photoAt = -Infinity;
  // Showkeys: je Farbe ein eigenes Stil-Objekt (Memo-Treffer im BitmapFont, keine Allokation).
  private readonly stKeyDim: MutableStyle = { scale: 1, color: C.dim };
  private readonly stKeyDark: MutableStyle = { scale: 1, color: DEFAULT_OUTLINE };
  /**
   * "MAUS" am Drehbalken: frei über dem Boden, daher mit Schatten (die Tasten-Beschriftungen liegen in Kästen).
   * Grün, solange der Balken in der Luft im Band liegt — dieselbe Farbe wie der Balken selbst.
   */
  private readonly stTurnLabel: MutableStyle = { scale: 1, color: C.dim, shadow: true };
  private readonly stTurnLabelIn: MutableStyle = { scale: 1, color: C.gain, shadow: true };
  /** Legende in Weiß: gedimmt war sie auf dem hellen Boden von T3 schwer zu lesen. */
  private readonly stTurnLegend: MutableStyle = { scale: 1, color: C.white, shadow: true };

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
  setMovement(m: HudMovement): void {
    this.trend.setMovement(m);
    this.wWarn = !m.strafeAssist;
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

  /**
   * Coach-Band verwerfen (Stufenwechsel einer Lektion: der Tipp gehörte zur alten Stufe und widersprach der
   * neuen Karte). Info-Hinweise ("Ton an") bleiben. Auch im Tick-Pfad erlaubt (keine Allokation).
   */
  dropCoachNotice(): void {
    if (this.notice !== null && this.notice.kind === 'coach') this.notice = null;
  }

  /**
   * Stufe ohne Erfolg gewechselt (Überspringen, Lektion neu): Tipp UND Geschafft-Blitz der alten Stufe weg. Sonst stand
   * nach "R" kurz nach einer erledigten Stufe noch "1/3 GESCHAFFT!" mit voller Pip-Reihe über der neu begonnenen Lektion.
   */
  lessonJump(): void {
    this.dropCoachNotice();
    this.stageDoneAt = -Infinity;
    this.lessonDoneAt = -Infinity;
    this.stageDoneIndex = -1;
    this.doneGoal = 0;
  }

  /** Was die Lektionskarte zuletzt zeigte (Tools); null = keine Karte gezeichnet. Kein Frame-Pfad. */
  cardState(): HudCardState | null {
    const c = this.card;
    if (!this.lessonActive || c.scale === 0) return null;
    return { title: c.title, step: c.step, count: c.count, goal: c.goal, style: c.style, progress: c.progress, hint: c.hint, hintLeft: c.hintLeft };
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

  /** Beschriftung der Vorführungs-Taste (KeyBinds.demo, z. B. 'H'); null = keine belegt. */
  setDemoKey(label: string | null): void {
    this.demoHint = label !== null ? `[${label}] ZEIGEN` : '';
    this.demoBandText = label !== null ? `VORFÜHRUNG · [${label}] ODER JEDE TASTE = SELBST` : 'VORFÜHRUNG · JEDE TASTE = SELBST';
  }

  /**
   * Zuletzt gezeichnetes Rechteck eines HUD-Elements in HUD-Pixeln [x, y, w, h] (w = 0: nicht
   * gezeichnet) — für __vel.hudLayout (Prüfung "Bildmitte frei"). Kein Frame-Pfad.
   */
  rect(name: HudRectName): [number, number, number, number] {
    const o = HUD_RECTS.indexOf(name) * 4;
    const r = this.rects;
    return [r[o], r[o + 1], r[o + 2], r[o + 3]];
  }

  /**
   * Stufen der Lektion (Rang je Stufe) für den Zähler der Karte: Pflichtstufen "2/4", danach "BONUS 1/1",
   * "MEISTER 1/1" — über alle Stufen gezählt stand "LEKTION GESCHAFFT!" bei "4/6". null = normales Level.
   * Beim Laden, nicht im Frame-Pfad.
   */
  setLessonStages(ranks: readonly StageRank[] | null): void {
    this.stageStepText = ranks !== null ? stageSteps(ranks) : null;
    this.stageDoneIndex = -1;
    this.doneGoal = 0;
    // Karte neu aufbauen (Zähler-Text hängt an den Rängen).
    this.cardIndex = -1;
  }

  /** Anzahl angenommener Urteile (je gezeigtem 'lessonHop' +1) — Tools vergleichen mit verdictDrawn. */
  get verdictSerial(): number {
    return this.verdictN;
  }

  /** Höchste Urteilsnummer, die draw() schon sichtbar gezeichnet hat (0 = noch keins). */
  get verdictDrawn(): number {
    return this.verdictDrawnN;
  }

  /** W-Showkey im letzten Frame rot (Warnung "W in der Luft", nur ohne Strafe-Assist) — Tools. */
  get wKeyRed(): boolean {
    return this.wRedDrawn;
  }

  /** Legende am Drehbalken sichtbar (Lektion mit Zielband, noch kein guter Hop) — Tools. */
  get turnLegendShown(): boolean {
    return this.turnLegendDrawn;
  }

  /** Gerade sichtbares Urteil am Gain-Popup (Tools/Tests), sonst null. */
  get currentVerdict(): string | null {
    for (let k = this.gainCount - 1; k >= 0; k--) {
      const p = this.gains[(this.gainHead + k) % GAIN_SLOTS];
      if (p.verdict !== '') return p.verdict;
    }
    return null;
  }

  /**
   * Ziel-Foto ausgelöst (Plan 007 I3, Handy): Stempel "FOTO" rechts oben im Safe-Frame und ein kurzer
   * weißer Auslöser-Rahmen. Einmal je Ziel, außerhalb des Frame-Pfads gerufen.
   */
  showPhoto(): void {
    this.photoAt = this.t;
  }

  /** Alle Popups/Overlays verwerfen (z. B. beim Levelwechsel). */
  clear(): void {
    this.standHop = true;
    this.photoAt = -Infinity;
    this.turnLegend = true;
    this.gainCount = 0;
    this.split = null;
    this.finish = null;
    this.intro = null;
    this.notice = null;
    this.milestoneAt = -Infinity;
    this.cpFlashAt = -Infinity;
    this.strafeShown = 0;
    this.stageDoneAt = -Infinity;
    this.lessonDoneAt = -Infinity;
    this.stageDoneIndex = -1;
    this.liveGoal = 0;
    this.doneGoal = 0;
    this.pipPopAt = -Infinity;
    this.trend.reset();
    this.air.reset();
  }

  onEvent(e: GameEvent): void {
    switch (e.type) {
      case 'jump': {
        // Läuft im Tick-Pfad (EventBus) — Ring-Slot und gecachter Text statt neuer Objekte.
        if (this.lessonActive && this.judge) {
          // In Stufen mit Urteil trägt das Urteil (lessonHop) den Gewinn — sonst stünde "+23" doppelt da. Einen
          // Absprung unter MIN_TAKEOFF beurteilt der Judge nie: ohne Anlauf (Probe T3: Leertaste + A in der Luft,
          // 40 u/s) kam sonst bis zu 20 s gar keine Rückmeldung. Nicht in der Vorführung (die zeigt, wie es geht).
          // Der erste Hop nach Stufenstart/Respawn kommt aus dem Stand (W + Leertaste wie auf der Karte: Smart-Hop springt
          // nach 0.2 s bei ~40 u/s) — dort kein Tadel (E2E-Review v2final: "ANLAUF MIT W" bei gehaltenem W).
          if (e.speed < MIN_TAKEOFF && !this.demo && !this.standHop)
            this.pushGain('', C.white, this.data.keys.forward > 0 ? SLOW_TAKEOFF_W_TEXT : SLOW_TAKEOFF_TEXT, C.gold, 0);
          this.standHop = false;
          break;
        }
        if (e.chain < 2) break;
        const g = Math.round(e.gain);
        if (Math.abs(g) < GAIN_MIN_SHOWN) break;
        this.pushGain(gainText(g), gainColor(g), '', C.white, 0);
        break;
      }
      case 'lessonHop': {
        if (e.counted) this.pipPopAt = this.t;
        // Erster guter Hop der Lektion: das Band ist verstanden, "MAUS" reicht (kein Zustandswechsel im Frame-Pfad).
        if (e.verdict === 'good' && !this.demo) this.turnLegend = false;
        // Stufe ohne Strafe-Aufgabe: kein Urteil (den Gewinn zeigt das 'jump'-Popup wie im normalen Level).
        if (!this.judge) break;
        // Urteil erscheint im selben Frame wie die Landung (Event aus dem Tick, draw danach).
        const g = Math.round(e.gain);
        const good = e.verdict === 'good';
        this.pushGain(gainText(g), gainColor(g), VERDICT_TEXT[e.verdict].short, good ? C.gain : C.gold, ++this.verdictN);
        break;
      }
      case 'lessonStage':
        // Erfüllen zwei Stufen im selben Frame (T4: HALTEN und BONUS 500), feiert der Blitz die erste — ihre
        // Pips standen auf dem Bild, die zweite war nie zu sehen.
        if (this.stageDoneAt !== this.t) {
          this.stageDoneIndex = e.index;
          this.doneGoal = this.liveGoal;
          this.doneStyle = this.liveStyle;
        }
        this.stageDoneAt = this.t;
        if (e.lessonDone) this.lessonDoneAt = this.t;
        // Der Tipp der alten Stufe widerspräche der neuen Karte (Probe T3: "JETZT: A HALTEN" unter "D HALTEN").
        this.dropCoachNotice();
        this.standHop = true;
        break;
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
        this.photoAt = -Infinity;
        break;
      case 'respawn':
        this.standHop = true;
        this.finish = null;
        this.photoAt = -Infinity;
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

  /**
   * Popup in den Ring (ältestes fällt raus): text = Gewinn ("+23", '' = keiner), verdict = Urteil ('' = reines
   * Gain-Popup), serial = Urteilsnummer (0 = kein Urteil des Judge).
   */
  private pushGain(text: string, color: string, verdict: string, verdictColor: string, serial: number): void {
    const slot = this.gains[(this.gainHead + this.gainCount) % GAIN_SLOTS];
    if (this.gainCount < GAIN_SLOTS) this.gainCount++;
    else this.gainHead = (this.gainHead + 1) % GAIN_SLOTS;
    slot.born = this.t;
    slot.text = text;
    slot.color = color;
    slot.verdict = verdict;
    slot.verdictColor = verdictColor;
    slot.serial = serial;
    slot.scale = 0;
  }

  update(dt: number, data: HudData): void {
    this.data = data;
    this.lessonActive = data.lesson !== null && data.lesson !== undefined;
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
    this.rects.fill(0);
    this.wRedDrawn = false;
    this.turnLegendDrawn = false;
    if (!this.visible) return;
    const d = this.data;
    const s = this.uiScale();
    const lesson = d.lesson ?? null;

    // Lektion: die Karte steht dort, wo sonst der Timer steht (kein Timer, keine Bestzeit). In der
    // Pause nicht — das Pause-Menü nennt Lektion und Stufe selbst, die Karte läge unter seiner Überschrift.
    if (lesson !== null) {
      if (!d.paused) this.drawLesson(lesson, s);
    }
    // Beim Ziel-Banner steht die Zeit dort groß — die obere Timerzeile wäre eine Dopplung.
    else if (!this.finish || d.paused) this.drawTimer(d, s);
    // In der Pause (Menü offen) nur der Timer — alles andere würde unter dem Menü durchscheinen.
    if (d.paused) return;
    // Während der Level-Titelkarte liegt deren Band über dem Speedometer-Platz.
    const showSpeed = d.showSpeedometer && !this.finish && !this.intro;
    if (showSpeed) this.drawSpeedometer(d, s);
    // Urteile einer Lektion auch ohne Speedometer — sie sind dort die wichtigste Rückmeldung.
    else if (lesson !== null && !this.intro) this.drawGains(Math.floor(this.w / 2), this.speedTop(), 0, s, 1);
    if (d.showKeys) this.drawKeys(d.keys, s);
    if (this.split) this.drawSplit(this.split, s);
    if (this.intro) this.drawIntro(this.intro, d, s);
    if (this.finish) this.drawFinish(this.finish, s);
    else this.drawCrosshair();
    if (this.t - this.photoAt < PHOTO_LIFE) this.drawPhoto(s);
    if (this.demo) this.drawDemoBand(s);
    else if (this.notice) this.drawNotice(this.notice, s);
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
    this.setRect(R_SPEED, cx - (w >> 1), y, w, this.speedBlockBottom() - y);

    if (sinceMilestone < MILESTONE_LIFE) this.drawMilestoneLines(cx, y, w, big, sinceMilestone / MILESTONE_LIFE, fade);

    this.drawGains(cx, y, w, s, fade);

    // Zweite Zeile: Hop-Kette und Sync (in der Luft, entprellt), klein.
    const segs = this.segs;
    let n = 0;
    if (d.hopChain >= 2 && d.speed >= CHAIN_MIN_SPEED) setSeg(segs[n++], chainText(d.hopChain), C.cyan, false);
    if (this.air.surf) setSeg(segs[n++], 'SURF', C.magenta, false);
    // Lektion ohne Strafe-Aufgabe: kein "SYNC 0 %" in Rot für jemanden, der genau die Anweisung (W + Leertaste) befolgt.
    else if (this.air.air && (!this.lessonActive || this.judge)) {
      const sync = Math.round(Math.max(0, Math.min(1, d.strafeSync)) * 100);
      setSeg(segs[n++], 'SYNC', C.dim, false);
      setSeg(segs[n++], percentText(sync), sync >= 80 ? C.gain : sync >= 50 ? C.white : C.loss, true);
    }
    if (n > 0) this.drawSegments(segs, n, cx, y + 7 * big + 5 * s, s, fade);
  }

  /** Gain-Popups (+ Urteil) rechts neben der Zahl: steigen auf und verblassen. w = Breite der Zahl. */
  private drawGains(cx: number, y: number, w: number, s: number, fade: number): void {
    const px = cx + Math.ceil(w / 2) + 4 * s;
    let top = this.h;
    let right = px;
    for (let k = 0; k < this.gainCount; k++) {
      const p = this.gains[(this.gainHead + k) % GAIN_SLOTS];
      const age = (this.t - p.born) / GAIN_POPUP_LIFE;
      const rise = Math.round(age * 10 * s);
      const alpha = (age < 0.5 ? 1 : 1 - (age - 0.5) * 2) * fade;
      if (p.scale !== s) this.renderGain(p, s);
      if (alpha > 0) {
        p.sprite.blitAt(this.ctx, px, y - rise, alpha);
        if (p.serial > this.verdictDrawnN) this.verdictDrawnN = p.serial;
      }
      if (y - rise < top) top = y - rise;
      if (px + p.width > right) right = px + p.width;
    }
    if (this.gainCount > 0) this.setRect(R_VERDICT, px, top, right - px, y + 7 * s - top);
  }

  /** Gain-Popup (+ Urteil) voll deckend in seine Kachel; Nullpunkt = linke obere Ecke des Texts. Selten. */
  private renderGain(p: GainPopup, s: number): void {
    const m = SPRITE_MARGIN * s;
    const gw = p.text !== '' ? pixelFont.width(p.text, s) : 0;
    const gap = gw > 0 ? 3 * s : 0;
    const vw = p.verdict !== '' ? gap + pixelFont.width(p.verdict, s) : 0;
    const ctx = p.sprite.begin(-m, -m, gw + vw + 2 * m, 7 * s + 2 * m);
    const sg = this.stGain;
    sg.scale = s;
    sg.color = p.color;
    sg.alpha = 1;
    if (gw > 0) pixelFont.drawText(ctx, p.text, 0, 0, sg);
    if (vw > 0) {
      const sv = this.stVerdict;
      sv.scale = s;
      sv.color = p.verdictColor;
      sv.alpha = 1;
      pixelFont.drawText(ctx, p.verdict, gw + gap, 0, sv);
    }
    p.sprite.end();
    p.scale = s;
    p.width = gw + vw;
  }

  private setRect(i: number, x: number, y: number, w: number, h: number): void {
    const o = i * 4;
    const r = this.rects;
    r[o] = x | 0;
    r[o + 1] = y | 0;
    r[o + 2] = w | 0;
    r[o + 3] = h | 0;
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

  /**
   * Stempel "FOTO" (Plan 007 I3): kleiner Kasten rechts oben im 16:9-Safe-Frame — frei von Ziel-Band,
   * Hand (rechts unten) und Showkeys. Die ersten PHOTO_FLASH s ein weißer Auslöser-Rahmen um das Bild
   * (Rand, nie die Mitte). Der Stempel springt kurz größer auf und blendet am Ende aus — neu gerastert,
   * nicht skaliert (fallen.md #76).
   */
  private drawPhoto(s: number): void {
    const ctx = this.ctx;
    const age = this.t - this.photoAt;
    if (age < PHOTO_FLASH) {
      const a = 1 - age / PHOTO_FLASH;
      const t = 3 * s;
      ctx.globalAlpha = a;
      ctx.fillStyle = C.white;
      ctx.fillRect(0, 0, this.w, t);
      ctx.fillRect(0, this.h - t, this.w, t);
      ctx.fillRect(0, 0, t, this.h);
      ctx.fillRect(this.w - t, 0, t, this.h);
      ctx.globalAlpha = 1;
    }
    const scale = age < 0.08 ? 3 * s : 2 * s;
    const fade = age > PHOTO_LIFE - 0.3 ? Math.max(0, (PHOTO_LIFE - age) / 0.3) : 1;
    const st = this.stPhoto;
    st.scale = scale;
    st.tracking = s;
    st.alpha = fade;
    const tw = pixelFont.width('FOTO', scale) + 3 * s;
    const th = 7 * scale;
    const pad = 3 * s;
    const bw = tw + 2 * pad + 6 * s;
    const bh = th + 2 * pad;
    const right = Math.floor(safeRight(this.w, this.h)) - 6 * s;
    const x = right - bw;
    const y = 6 * s;
    ctx.globalAlpha = fade;
    ctx.fillStyle = C.band;
    ctx.fillRect(x, y, bw, bh);
    // Rahmen in Magenta (Stempel), Punkt in Rot wie die Aufnahme-Leuchte einer Kamera.
    ctx.fillStyle = C.magenta;
    ctx.fillRect(x, y, bw, s);
    ctx.fillRect(x, y + bh - s, bw, s);
    ctx.fillRect(x, y, s, bh);
    ctx.fillRect(x + bw - s, y, s, bh);
    ctx.fillStyle = C.loss;
    ctx.fillRect(x + pad, y + Math.floor((bh - 3 * s) / 2), 3 * s, 3 * s);
    ctx.globalAlpha = 1;
    this.text('FOTO', x + pad + 5 * s, y + pad, st);
    this.setRect(R_PHOTO, x, y, bw, bh);
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

  /**
   * Lektionskarte oben mittig (≤ 4 Zeilen): Stufe "2/4" (Pflicht) bzw. "BONUS 1/1" + Titel groß, Aufgabe
   * in 1–2 Zeilen, Fortschritt als Pips (≤ 12) oder Balken, rechts "[H] ZEIGEN" bzw. "[ENTER] ERGEBNIS"
   * (dann "[H] ZEIGEN" links). Nach einer Stufe steht kurz "GESCHAFFT!" mit dem Zähler und der vollen
   * Pip-Reihe der erledigten Stufe (der Text zeigt schon die neue Stufe).
   *
   * Vorgerendert (HudSprite): Glyphe für Glyphe kostete die Karte ~0.3 ms je Frame. Neu gezeichnet
   * wird nur, wenn sich ein angezeigter Wert ändert (Zähler, Blitz, Hinweis) — Vergleiche ohne String-Bau.
   */
  private drawLesson(L: LessonHud, s: number): void {
    const c = this.card;
    const steps = this.stageStepText !== null && this.stageStepText.length === L.stageTotal ? this.stageStepText : null;
    // Texte ändern sich nur beim Stufenwechsel — Zähler und Zeilenzahl nur dann neu (selten, darf bauen).
    let dirty = false;
    if (L.stageTitle !== this.cardTitleSrc || L.text !== this.cardTextSrc || L.stageIndex !== this.cardIndex || L.stageTotal !== this.cardTotal) {
      this.cardTitleSrc = L.stageTitle;
      this.cardTextSrc = L.text;
      this.cardIndex = L.stageIndex;
      this.cardTotal = L.stageTotal;
      // Nach der letzten Stufe steht der Index hinter dem Ende (TrainingSession) — dann kein Zähler.
      this.cardStep =
        L.stageIndex >= L.stageTotal ? '' : steps !== null ? steps[L.stageIndex] : `${L.stageIndex + 1}/${L.stageTotal}`;
      this.cardLines = L.text === '' ? 0 : L.text.split('\n').length;
      dirty = true;
    }
    const since = this.t - this.stageDoneAt;
    const done = this.t - this.lessonDoneAt < LESSON_FLASH;
    const flash = done || since < STAGE_FLASH;
    const allDone = L.stageIndex >= L.stageTotal;
    const title = done ? TITLE_LESSON_DONE : flash ? TITLE_STAGE_DONE : allDone ? TITLE_ALL_DONE : L.stageTitle;
    // Beim Blitz der Zähler der erledigten Stufe ("4/4 LEKTION GESCHAFFT!"), nicht der neuen.
    const di = this.stageDoneIndex;
    const step = flash && steps !== null && di >= 0 && di < steps.length ? steps[di] : this.cardStep;
    // Geschafft-Blitz: die ersten 0.3 s im 10-Hz-Takt blinken (liest sich als Ereignis).
    const blink = flash && since < 0.3 && Math.floor(since * 10) % 2 === 1;
    const fresh = this.t - this.pipPopAt < PIP_POP;
    // Während STAGE_FLASH die volle Reihe der erledigten Stufe, danach der Fortschritt der neuen.
    const full = since < STAGE_FLASH && this.doneGoal > 0;
    // Stand der laufenden Stufe merken — kommt im nächsten Tick 'lessonStage', war es dieser.
    this.liveGoal = L.goal;
    this.liveStyle = L.style;
    const count = full ? this.doneGoal : L.count;
    const goal = full ? this.doneGoal : L.goal;
    const style = full ? this.doneStyle : L.style;
    const progress = full || !allDone;
    // Rechts "[H] ZEIGEN" bzw. nach den Pflichtstufen "[ENTER] ERGEBNIS" — dann steht die Vorführung links
    // (sonst verschwand der Hinweis in Bonus-/Meisterstufen mit Vorführung).
    const demoHint = this.demoAvailable && !L.demo && !this.demo ? this.demoHint : '';
    const hint = this.lessonDone ? HINT_RESULT : demoHint;
    const hintLeft = this.lessonDone ? demoHint : '';
    if (
      dirty ||
      title !== c.title ||
      step !== c.step ||
      flash !== c.flash ||
      blink !== c.blink ||
      fresh !== c.fresh ||
      count !== c.count ||
      goal !== c.goal ||
      style !== c.style ||
      progress !== c.progress ||
      L.rank !== c.rank ||
      hint !== c.hint ||
      hintLeft !== c.hintLeft ||
      this.lessonDone !== c.hintGold ||
      s !== c.scale ||
      this.w !== c.width ||
      this.h !== c.height
    ) {
      c.title = title;
      c.step = step;
      c.flash = flash;
      c.blink = blink;
      c.fresh = fresh;
      c.count = count;
      c.goal = goal;
      c.style = style;
      c.progress = progress;
      c.rank = L.rank;
      c.hint = hint;
      c.hintLeft = hintLeft;
      c.hintGold = this.lessonDone;
      c.scale = s;
      c.width = this.w;
      c.height = this.h;
      this.renderCard(L, s, allDone);
    }
    this.cardSprite.blit(this.ctx);
    this.setRect(R_CARD, c.bx, c.by, c.bw, c.bh);
  }

  /** Karte in die Kachel zeichnen (selten: nur bei Änderung, siehe drawLesson). Koordinaten wie im HUD. */
  private renderCard(L: LessonHud, s: number, allDone: boolean): void {
    const c = this.card;
    const lay = lessonCardLayout(this.h, this.cardLines, this.cardLay);
    const cx = Math.floor(this.w / 2);
    const flash = c.flash;
    const title = c.title;
    const hint = c.hint;
    const hintLeft = c.hintLeft;
    // Rang vor dem Zähler ("BONUS 1/1"); beim Blitz und nach der letzten Stufe ohne Rang.
    const rank = flash || allDone ? '' : L.rank === 'bonus' ? 'BONUS' : L.rank === 'master' ? 'MEISTER' : '';
    const step = c.step;
    const stepW = step !== '' ? pixelFont.width(step, s) + 5 * s : 0;
    const rankW = rank !== '' ? pixelFont.width(rank, s) + 4 * s : 0;
    this.cardTitleW = pixelFont.width(title, 2 * s);
    const rowW = rankW + stepW + this.cardTitleW;
    this.cardTextW = this.cardLines > 0 ? pixelFont.width(L.text, s) : 0;
    // Zähler/Ziel/Art aus dem Cache: beim Geschafft-Blitz die der erledigten Stufe (drawLesson).
    const goal = c.goal > 0 ? c.goal : 1;
    const pips = c.style === 'pips' && goal <= MAX_PIPS;
    const progW = !c.progress ? 0 : pips ? goal * (LESSON_PIP + 3) * s - 3 * s : 64 * s;
    const hintW = hint !== '' ? pixelFont.width(hint, s) + 8 * s : 0;
    const hintLeftW = hintLeft !== '' ? pixelFont.width(hintLeft, s) + 8 * s : 0;
    // Fortschritt bleibt mittig: beide Seiten so breit wie der breitere Hinweis.
    const sideW = hintW > hintLeftW ? hintW : hintLeftW;
    let bw = rowW;
    if (this.cardTextW > bw) bw = this.cardTextW;
    if (progW + 2 * sideW > bw) bw = progW + 2 * sideW;
    bw += 16 * s;
    const bx = cx - (bw >> 1);
    const bh = lay.bottom - lay.top;
    c.bx = bx;
    c.by = lay.top;
    c.bw = bw;
    c.bh = bh;
    // Kachel mit Rand: Kontur, Schatten und Akzente der Schrift ragen über das Band hinaus.
    const m = SPRITE_MARGIN * s;
    const ctx = this.cardSprite.begin(bx - m, lay.top - m, bw + 2 * m, bh + 2 * m);

    // Band: dunkel, oben Cyan (Gold beim Geschafft-Blitz), unten Magenta — wie die Titelkarte.
    ctx.globalAlpha = 0.62;
    ctx.fillStyle = C.band;
    ctx.fillRect(bx, lay.top, bw, bh);
    ctx.globalAlpha = 1;
    ctx.fillStyle = flash ? C.gold : C.cyan;
    ctx.fillRect(bx, lay.top, bw, s);
    ctx.fillStyle = C.magenta;
    ctx.fillRect(bx, lay.top + bh - s, bw, s);

    // Titelzeile: Rang, "2/4" klein und gedimmt, Titel groß (Grundlinie wie der Timer).
    let x = cx - (rowW >> 1);
    if (rankW > 0) {
      const rs = this.stCardRank;
      rs.scale = s;
      rs.color = L.rank === 'master' ? C.magenta : C.gold;
      pixelFont.drawText(ctx, rank, x, lay.titleY + 7 * s, rs);
      x += rankW;
    }
    if (stepW > 0) {
      const small = this.stCardSmall;
      small.scale = s;
      pixelFont.drawText(ctx, step, x, lay.titleY + 7 * s, small);
      x += stepW;
    }
    const ts = this.stCardTitle;
    ts.scale = 2 * s;
    ts.color = flash ? C.gold : C.white;
    ts.alpha = c.blink ? 0.35 : 1;
    pixelFont.drawText(ctx, title, x, lay.titleY, ts);

    if (this.cardLines > 0) {
      const tx = this.stCardText;
      tx.scale = s;
      pixelFont.drawText(ctx, L.text, cx, lay.textY, tx);
    }

    // Fortschritt: Pips (Einzelziele) oder Balken (Tempo, Zeit, große Ziele).
    const count = c.count < 0 ? 0 : c.count > goal ? goal : c.count;
    const px0 = cx - (progW >> 1);
    const py = lay.progressY;
    const pip = LESSON_PIP * s;
    if (!c.progress) {
      // keine Aufgabe mehr — nur der Hinweis aufs Ergebnis
    } else if (pips) {
      for (let i = 0; i < goal; i++) {
        const px = px0 + i * (pip + 3 * s);
        if (i < count) {
          const fresh = c.fresh && i === count - 1;
          ctx.fillStyle = fresh ? C.white : C.gold;
          if (fresh) ctx.fillRect(px - s, py - s, pip + 2 * s, pip + 2 * s);
          else ctx.fillRect(px, py, pip, pip);
        } else {
          ctx.fillStyle = K.frame;
          ctx.fillRect(px, py, pip, s);
          ctx.fillRect(px, py + pip - s, pip, s);
          ctx.fillRect(px, py + s, s, pip - 2 * s);
          ctx.fillRect(px + pip - s, py + s, s, pip - 2 * s);
        }
      }
    } else {
      ctx.fillStyle = K.back;
      ctx.fillRect(px0, py, progW, pip);
      const fill = ((count * progW) / goal) | 0;
      ctx.fillStyle = count >= goal ? C.gain : C.gold;
      ctx.fillRect(px0, py + s, fill, pip - 2 * s);
      ctx.fillStyle = K.frame;
      ctx.fillRect(px0, py, progW, s);
      ctx.fillRect(px0, py + pip - s, progW, s);
    }
    if (hint !== '') {
      const hs = this.stCardHint;
      hs.scale = s;
      hs.color = c.hintGold ? C.gold : C.dim;
      pixelFont.drawText(ctx, hint, px0 + progW + 8 * s, py - s, hs);
    }
    if (hintLeft !== '') {
      const hs = this.stCardHint;
      hs.scale = s;
      hs.color = C.dim;
      pixelFont.drawText(ctx, hintLeft, px0 - hintLeftW, py - s, hs);
    }
    this.cardSprite.end();
  }

  /**
   * Vorführung: Band unten mittig, an der Stelle des Coach-Bands (vorgerendert, 2 Farbphasen). Hat die
   * Vorführung die Aufgabe erfüllt (demoGoal), steht dort grün "SO GEHT'S!" — dann geht es zurück zum Spieler.
   */
  private drawDemoBand(s: number): void {
    // "Aufnahme"-Puls: 1 Hz gedimmt — es ist nicht der Spieler, der steuert. Farbe statt Alpha:
    // halbtransparenter Text ginge über den teuren Einzel-Blit (BitmapFont.blitLineFaded).
    const goal = this.demoGoal;
    const phase = goal ? 2 : Math.floor(this.t * 2) % 2;
    const text = goal ? DEMO_GOAL_TEXT : this.demoBandText;
    const d = this.demoBand;
    if (phase !== d.phase || text !== d.text || s !== d.scale || this.w !== d.width || this.h !== d.height) {
      d.phase = phase;
      d.text = text;
      d.scale = s;
      d.width = this.w;
      d.height = this.h;
      const tw = pixelFont.width(text, s);
      const cx = Math.floor(this.w / 2);
      const y = this.h - 8 * s - 7 * s;
      const bw = tw + 14 * s;
      const bx = cx - (bw >> 1);
      const by = y - 4 * s;
      const bh = 7 * s + 8 * s;
      d.bx = bx;
      d.by = by;
      d.bw = bw;
      d.bh = bh;
      const m = SPRITE_MARGIN * s;
      const ctx = this.demoSprite.begin(bx - m, by - m, bw + 2 * m, bh + 2 * m);
      ctx.globalAlpha = 0.8;
      ctx.fillStyle = C.band;
      ctx.fillRect(bx, by, bw, bh);
      ctx.globalAlpha = 1;
      ctx.fillStyle = goal ? C.gain : C.cyan;
      ctx.fillRect(bx, by, bw, s);
      ctx.fillRect(bx, by + bh - s, bw, s);
      const st = this.stDemo;
      st.scale = s;
      st.color = goal ? C.gain : phase === 0 ? C.cyan : C.cyanDim;
      pixelFont.drawText(ctx, text, cx, y, st);
      this.demoSprite.end();
    }
    this.demoSprite.blit(this.ctx);
    this.setRect(R_DEMO, d.bx, d.by, d.bw, d.bh);
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
      this.setRect(R_NOTICE, bx, by, bw, bh);
      if (age < 0.3 && Math.floor(age * 10) % 2 === 1) return;
    }
    const tw = this.text(n.text, cx, y, st);
    if (n.kind !== 'coach') this.setRect(R_NOTICE, cx - (tw >> 1), y, tw, textH);
  }

  /**
   * Showkeys + Strafe-Spiegel unten links: W A S D, Sprung und Ducken leuchten,
   * solange gehalten; darüber ein 1-px-Balken für Drehrichtung und -rate der Maus (in Lektionen mit
   * Zielband 3 px hoch mit Beschriftung "MAUS", im Band grün, daneben Gold).
   * In der Luft wird A/D grün, wenn die Taste zur Drehrichtung passt und Tempo
   * brachte, rot bei Taste gegen die Maus; W blinkt rot, wenn es in der Luft mit
   * A/D gehalten wird und Strafe-Assist aus ist. Nur fillRect und feste Stile — keine Allokation.
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
    const wBlink = this.wWarn && air && k.forward > 0 && k.forwardInAirMs > W_AIR_WARN_MS && this.blinkOn;
    this.wRedDrawn = wBlink;
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
    let by = row0 - 4 * s;
    const len = turnBarLength(k.turnDeg, half);
    const band = k.turnBand ?? null;
    if (band === null) {
      ctx.fillStyle = K.tick;
      ctx.fillRect(mid, by - s, s, 3 * s);
      if (len > 0) {
        ctx.fillStyle = K.turn;
        if (k.turnDeg > 0) ctx.fillRect(mid - len, by, len, s);
        else ctx.fillRect(mid + s, by, len, s);
      }
      return;
    }
    // Lektion mit Zielband (°/s): Balken dreimal so hoch (1–2 Low-Res-Pixel gingen neben den Showkeys unter, das
    // Band war nirgends erklärt), rechts daneben "MAUS". Band als Fläche dahinter, Enden als Striche. In der Luft:
    // im Band grün, daneben Gold — am Boden neutral.
    const bh = 3 * s;
    by -= s;
    const lo = turnBarLength(band.lo, half);
    const hi = turnBarLength(band.hi, half);
    const abs = k.turnDeg < 0 ? -k.turnDeg : k.turnDeg;
    const inBand = abs >= band.lo && abs <= band.hi;
    ctx.fillStyle = K.band;
    ctx.fillRect(mid - hi, by, hi - lo, bh);
    ctx.fillRect(mid + s + lo, by, hi - lo, bh);
    ctx.fillStyle = K.tick;
    ctx.fillRect(mid, by - s, s, bh + 2 * s);
    ctx.fillStyle = K.bandEdge;
    ctx.fillRect(mid - hi, by - s, s, bh + 2 * s);
    ctx.fillRect(mid - lo, by - s, s, bh + 2 * s);
    ctx.fillRect(mid + s + lo, by - s, s, bh + 2 * s);
    ctx.fillRect(mid + s + hi, by - s, s, bh + 2 * s);
    if (len > 0) {
      ctx.fillStyle = !air ? K.turn : inBand ? K.gain : C.gold;
      if (k.turnDeg > 0) ctx.fillRect(mid - len, by, len, bh);
      else ctx.fillRect(mid + s, by, len, bh);
    }
    // Beschriftung rechts neben dem Band (über D frei, Showkeys-Spalte bleibt gleich): letzte Zeile mittig zum Balken,
    // die Legende wächst nach oben. Vorgerendert, neu nur bei Wechsel von Text, Farbe oder Lage.
    const legend = this.turnLegend;
    const text = legend ? TURN_LEGEND : TURN_LABEL;
    const st = air && inBand ? this.stTurnLabelIn : legend ? this.stTurnLegend : this.stTurnLabel;
    const lx = mid + half + 4 * s;
    const ly = by + ((bh - 7 * s) >> 1) - (legend ? 11 * s : 0);
    const c = this.turnLabel;
    if (text !== c.text || st.color !== c.color || lx !== c.x || ly !== c.y || s !== c.scale) {
      c.text = text;
      c.color = st.color ?? '';
      c.x = lx;
      c.y = ly;
      c.scale = s;
      st.scale = s;
      const lh = (legend ? 18 : 7) * s;
      const m = SPRITE_MARGIN * s;
      const tctx = this.turnSprite.begin(lx - m, ly - m, pixelFont.width(text, s) + 2 * m, lh + 2 * m);
      pixelFont.drawText(tctx, text, lx, ly, st);
      this.turnSprite.end();
    }
    this.turnSprite.blit(ctx);
    this.turnLegendDrawn = legend;
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

function gainColor(g: number): string {
  return g > 0 ? C.gain : g < 0 ? C.loss : C.white;
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
