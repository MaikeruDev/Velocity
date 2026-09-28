import { VELOCITY_DEFAULT, airSpeedCapAt } from '../player/MovementConfig';
import type { StageRank } from '../world/level/LevelFormat';

/**
 * DOM-freie Zustandslogik des HUD (Speedometer-Farbe, entprellter Luftzustand).
 * Liegt getrennt vom Canvas-Code, damit Vitest sie mit echten Movement-Traces prüfen kann.
 */

/**
 * Die Movement-Werte, die den größtmöglichen Luftgewinn bestimmen. Die
 * Überblend-Felder sind optional (fehlen = konstanter Cap); eine volle
 * MovementConfig passt direkt.
 */
export interface TrendMovement {
  readonly tickRate: number;
  readonly airSpeedCap: number;
  readonly airSpeedCapLow?: number;
  readonly airSpeedCapFadeFrom?: number;
  readonly airSpeedCapFadeTo?: number;
}

/**
 * Schwellen relativ zum größtmöglichen Luftgewinn beim aktuellen Tempo.
 * Absolute Schwellen (u/s²) taugen nicht: pro Tick sind höchstens
 * sqrt(v² + cap²) − v drin (wishdir ⟂ v), also ~tickRate·cap²/(2v) u/s² —
 * bei 1000 u/s nur 18 u/s². Ein fester Wert wäre bei Tempo unerreichbar oder
 * bei niedrigem Tempo Rauschen. Rauschen gibt es sonst kaum: ohne Eingabe ist
 * die Beschleunigung in der Luft exakt 0, am Boden bei Laufgeschwindigkeit auch.
 * Kalibriert mit StrafeBot (sync 1/0.85/0.7) bei 60 und 144 fps, 128 und 64 Tick.
 */
const TREND_ENTER = 0.2;
const TREND_LEAVE = 0.08;
/** Zeitkonstante der Beschleunigungs-Glättung, s (glättet Frames ohne Tick bei > 128 fps). */
const ACCEL_TAU = 0.15;
/** Wie schnell die angezeigte Farbe zum Trend wandert (Anteil pro s). */
const COLOR_RATE = 6;

export type Trend = -1 | 0 | 1;

function finiteOr(v: number | undefined, fallback: number): number {
  return v !== undefined && Number.isFinite(v) ? v : fallback;
}

/** Gewinn/Verlust-Anzeige des Speedometers: geglättete Beschleunigung mit Hysterese. */
export class SpeedTrend {
  private tickRate = VELOCITY_DEFAULT.tickRate;
  /** Cap-Parameter wie MovementConfig — airSpeedCapAt rechnet daraus den Cap beim aktuellen Tempo. */
  private readonly cap = {
    airSpeedCap: VELOCITY_DEFAULT.airSpeedCap,
    airSpeedCapLow: VELOCITY_DEFAULT.airSpeedCapLow,
    airSpeedCapFadeFrom: VELOCITY_DEFAULT.airSpeedCapFadeFrom,
    airSpeedCapFadeTo: VELOCITY_DEFAULT.airSpeedCapFadeTo,
  };
  private last: number | null = null;
  private accel = 0;
  private r = 0;
  private state: Trend = 0;
  private color = 0;

  constructor(m?: TrendMovement) {
    if (m) this.setMovement(m);
  }

  /** −1 Verlust, 0 stabil, +1 Gewinn (Zielzustand mit Hysterese). */
  get trend(): Trend {
    return this.state;
  }

  /** Angezeigte Farbmischung −1..1, wandert weich zu `trend`. */
  get colorT(): number {
    return this.color;
  }

  /** Geglättete Beschleunigung relativ zum maximalen Luftgewinn bei aktuellem Tempo (1 = perfekter Strafe). */
  get ratio(): number {
    return this.r;
  }

  setMovement(m: TrendMovement): void {
    if (Number.isFinite(m.tickRate) && m.tickRate > 0) this.tickRate = m.tickRate;
    if (Number.isFinite(m.airSpeedCap) && m.airSpeedCap >= 0) this.cap.airSpeedCap = m.airSpeedCap;
    // Fehlende Überblend-Werte = konstanter Cap (0 schaltet aus).
    this.cap.airSpeedCapLow = finiteOr(m.airSpeedCapLow, 0);
    this.cap.airSpeedCapFadeFrom = finiteOr(m.airSpeedCapFadeFrom, 0);
    this.cap.airSpeedCapFadeTo = finiteOr(m.airSpeedCapFadeTo, 0);
  }

  reset(): void {
    this.last = null;
    this.accel = 0;
    this.r = 0;
    this.state = 0;
    this.color = 0;
  }

  update(dt: number, speed: number): void {
    if (!(dt > 0) || !Number.isFinite(speed)) return;
    if (this.last === null) this.last = speed;
    const a = (speed - this.last) / dt;
    this.last = speed;
    this.accel += (a - this.accel) * (1 - Math.exp(-dt / ACCEL_TAU));
    const v = Math.max(0, speed);
    // Untergrenze 1 u/s²: airSpeedCap 0 (Tuning-Panel) darf nicht durch 0 teilen.
    const cap = airSpeedCapAt(this.cap, v);
    const ref = Math.max(1, this.tickRate * (Math.sqrt(v * v + cap * cap) - v));
    const r = this.accel / ref;
    this.r = r;
    if (this.state === 0) this.state = r > TREND_ENTER ? 1 : r < -TREND_ENTER ? -1 : 0;
    else if (this.state > 0 && r < TREND_LEAVE) this.state = r < -TREND_ENTER ? -1 : 0;
    else if (this.state < 0 && r > -TREND_LEAVE) this.state = r > TREND_ENTER ? 1 : 0;
    this.color += (this.state - this.color) * (1 - Math.exp(-dt * COLOR_RATE));
  }
}

/**
 * So lange muss man am Stück am Boden sein, bis das HUD "am Boden" zeigt. Beim
 * Bhop meldet jede Landung genau einen Boden-Tick — ohne Entprellung spränge die
 * Zeile unter dem Speedometer im Hop-Rhythmus.
 */
const GROUND_HIDE = 0.2;
/** SURF bleibt nach dem Abheben kurz stehen (Kanten-Hüpfer auf der Rampe). */
const SURF_HOLD = 0.15;

/** Entprellter Luft-/Surf-Zustand für die Anzeige (nicht für Logik). */
export class AirDisplay {
  private groundFor = Infinity;
  private sinceSurf = Infinity;

  /** SYNC zeigen (in der Luft oder erst ganz kurz gelandet). */
  get air(): boolean {
    return this.groundFor < GROUND_HIDE;
  }

  /** SURF zeigen. */
  get surf(): boolean {
    return this.sinceSurf < SURF_HOLD;
  }

  reset(): void {
    this.groundFor = Infinity;
    this.sinceSurf = Infinity;
  }

  update(dt: number, onGround: boolean, surfing: boolean): void {
    const step = dt > 0 ? dt : 0;
    this.groundFor = onGround ? this.groundFor + step : 0;
    this.sinceSurf = surfing ? 0 : this.sinceSurf + step;
  }
}

// ==================================================================== Lektionskarte (Plan 007)

/**
 * Bildschirmmitte, die das Lektions-HUD frei lassen muss (Anteile der Bildhöhe): der Landepunkt der
 * nächsten Plattform liegt beim Geradeausblick dort. Karte oben, Urteil am Gain-Popup (über dem
 * Fadenkreuz), Coach- und Demo-Band unten.
 */
export const CENTER_BAND_TOP = 0.35;
export const CENTER_BAND_BOTTOM = 0.65;

/** Grundskala der kleinen HUD-Schrift (wie Hud.uiScale): 1 bis ~400 Zeilen, darüber 2. */
export function hudScale(h: number): number {
  return h >= 400 ? 2 : 1;
}

/** Zeilen der Lektionskarte in HUD-Pixeln (oben mittig, an der Stelle des Timers). */
export interface LessonCardLayout {
  /** Oberkante des Hintergrund-Bands. */
  top: number;
  /** Titelzeile (Stufe, doppelte Größe). */
  titleY: number;
  /** Erste Textzeile und Abstand zur nächsten. */
  textY: number;
  lineStep: number;
  /** Fortschrittszeile (Pips/Balken). */
  progressY: number;
  /** Unterkante des Bands. */
  bottom: number;
}

export function makeLessonCardLayout(): LessonCardLayout {
  return { top: 0, titleY: 0, textY: 0, lineStep: 0, progressY: 0, bottom: 0 };
}

/** Höhe der Pips/des Balkens in Schrift-Pixeln. */
export const LESSON_PIP = 5;

/**
 * Layout der Karte: Titel (2×) + höchstens zwei Textzeilen + Fortschritt = ≤ 4 Zeilen. Bei 240 Zeilen
 * endet sie bei 0.23 h, bei 448 bei 0.25 h — immer über dem Speedometer (0.3 h) und der Bildmitte.
 */
export function lessonCardLayout(h: number, textLines: number, out: LessonCardLayout): LessonCardLayout {
  const s = hudScale(h);
  const lines = Math.max(0, Math.min(2, textLines));
  out.top = 3 * s;
  out.titleY = 5 * s;
  out.lineStep = 11 * s;
  out.textY = out.titleY + 14 * s + 5 * s;
  out.progressY = out.textY + lines * out.lineStep + s;
  out.bottom = out.progressY + LESSON_PIP * s + 4 * s;
  return out;
}

/** Pips statt Balken bis zu so vielen Einheiten (darüber wird es ein Balken). */
export const MAX_PIPS = 12;

/**
 * Länge des Drehraten-Balkens (Showkeys) für |°/s| in Pixeln: volle halbe Breite bei 360 °/s.
 * Nur Ganzzahl-Rechnung (≈ /360 per · 91 >> 15) — kein Gleitkomma-Zwischenwert, der in kaltem
 * Code geboxt würde (fallen.md #59).
 */
export function turnBarLength(deg: number, half: number): number {
  const d = deg < 0 ? -deg : deg;
  const turn = d > 360 ? 360 : d | 0;
  return (turn * half * 91) >> 15;
}

/**
 * Stufenzähler je Rang (Karte, Pause): Pflichtstufen zählen unter sich ("2/4"), Bonus und Meister je für sich
 * ("1/1" hinter "BONUS"). Über alle Stufen gezählt sah "LEKTION GESCHAFFT!" bei "4/6" nach "noch nicht fertig"
 * aus, und ein Neuling las "1/6", obwohl 4 Stufen Pflicht sind. Nicht im Frame-Pfad (Levelstart/Pause).
 */
export function stageSteps(ranks: readonly StageRank[]): string[] {
  return ranks.map((r, i) => {
    let n = 0;
    let k = 0;
    for (let j = 0; j < ranks.length; j++) {
      if (ranks[j] !== r) continue;
      n++;
      if (j <= i) k++;
    }
    return `${k}/${n}`;
  });
}

/** Stufe `index` für die Pause: "Stufe 2/4", "Bonus 1/1", "Meister 1/1"; ohne Ränge nur "Stufe". */
export function stageLabel(ranks: readonly StageRank[], index: number): string {
  const r = ranks[index];
  if (r === undefined) return 'Stufe';
  const word = r === 'bonus' ? 'Bonus' : r === 'master' ? 'Meister' : 'Stufe';
  return `${word} ${stageSteps(ranks)[index]}`;
}
