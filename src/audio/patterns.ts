import type { AcidNote } from './instruments/Acid';
import { pick, type Rng } from './dsp';

/**
 * Alles Musikalische, was per Seed entsteht: Acid-Linie mit Variationen,
 * Bass-Turnarounds, Stab-Figuren, Percussion-Euklide, Fill-Typen.
 * Tonart durchgehend A-Moll (Pentatonik: A C D E G).
 */

export const PENTATONIC: readonly number[] = [0, 3, 5, 7, 10];

/** A-Moll-Pentatonik ab `root` über `octaves` Oktaven, plus Schluss-Grundton. */
export function pentatonicScale(root: number, octaves: number): number[] {
  const out: number[] = [];
  for (let o = 0; o < octaves; o++) for (const s of PENTATONIC) out.push(root + 12 * o + s);
  out.push(root + 12 * octaves);
  return out;
}

/** Euklidischer Rhythmus: k Schläge möglichst gleichmäßig auf n Schritte, rotiert. */
export function euclid(k: number, n: number, rotation: number): boolean[] {
  const out: boolean[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + rotation) % n;
    out.push((j * k) % n < k);
  }
  return out;
}

// ---------------------------------------------------------------- Acid

interface AcidStepDef {
  on: boolean;
  /** Index in die 2-Oktaven-Skala (0 = A2 … 10 = A4). */
  degree: number;
  accent: boolean;
  slide: boolean;
}

const ACID_ROOT = 45; // A2
const ACID_SCALE = pentatonicScale(ACID_ROOT, 2);
/** Gewichte je Skalenstufe: Grundton und Oktave tragen, der Rest färbt. */
const DEGREE_WEIGHTS = [0.3, 0.1, 0.08, 0.1, 0.08, 0.14, 0.06, 0.04, 0.05, 0.03, 0.02];

function weightedDegree(rng: Rng): number {
  let r = rng();
  for (let i = 0; i < DEGREE_WEIGHTS.length; i++) {
    r -= DEGREE_WEIGHTS[i];
    if (r <= 0) return i;
  }
  return 0;
}

/**
 * 16-Schritt-Acid-Linie. Hypnotisch = dieselbe Figur, leicht verschoben:
 * alle 2–4 Takte eine Variation (Töne, Akzente, Rhythmus, Oktave, Rotation),
 * nach einigen Variationen zurück zur Grundfigur.
 */
export class AcidLine {
  private base: AcidStepDef[] = [];
  private current: AcidStepDef[] = [];
  private phraseLen = 4;
  private barInPhrase = 0;
  private variations = 0;
  /** 0 = Säge, 1 = Rechteck — wechselt gelegentlich mit der Phrase. */
  squareMix = 0;

  constructor(private rng: Rng) {
    this.regenerate();
  }

  reseed(rng: Rng): void {
    this.rng = rng;
    this.regenerate();
  }

  private regenerate(): void {
    const r = this.rng;
    const steps: AcidStepDef[] = [];
    for (let i = 0; i < 16; i++) {
      const pOn = i % 4 === 0 ? 0.9 : i % 2 === 0 ? 0.72 : 0.6;
      steps.push({
        on: i === 0 || r() < pOn,
        degree: i === 0 ? 0 : weightedDegree(r),
        accent: r() < (i % 2 === 1 ? 0.34 : 0.22),
        slide: false,
      });
    }
    for (let i = 0; i < 16; i++) {
      const next = steps[(i + 1) % 16];
      steps[i].slide = steps[i].on && next.on && r() < 0.2;
    }
    this.base = steps;
    this.current = steps.map((s) => ({ ...s }));
    this.phraseLen = r() < 0.5 ? 2 : 4;
    this.barInPhrase = 0;
    this.variations = 0;
    this.squareMix = r() < 0.3 ? 1 : 0;
  }

  /** Zu jedem Taktbeginn. */
  onBar(): void {
    this.barInPhrase++;
    if (this.barInPhrase < this.phraseLen) return;
    this.barInPhrase = 0;
    this.phraseLen = this.rng() < 0.5 ? 2 : 4;
    this.vary();
  }

  private vary(): void {
    const r = this.rng;
    this.variations++;
    if (this.variations > 3 && r() < 0.6) {
      this.current = this.base.map((s) => ({ ...s }));
      this.variations = 0;
      return;
    }
    const cur = this.current;
    const op = r();
    if (op < 0.3) {
      for (let k = 0; k < 2; k++) {
        const i = 1 + Math.floor(r() * 15);
        cur[i].degree = weightedDegree(r);
        cur[i].on = true;
      }
    } else if (op < 0.5) {
      for (let k = 0; k < 3; k++) {
        const i = Math.floor(r() * 16);
        cur[i].accent = !cur[i].accent;
      }
    } else if (op < 0.68) {
      for (let k = 0; k < 2; k++) {
        const i = 1 + Math.floor(r() * 15);
        cur[i].on = !cur[i].on;
      }
    } else if (op < 0.82) {
      // Zweite Hälfte eine Oktave hoch — klassische 303-Spannung.
      for (let i = 8; i < 16; i++) if (cur[i].degree <= 5) cur[i].degree += 5;
    } else if (op < 0.93) {
      const rot = r() < 0.5 ? 2 : 3;
      this.current = cur.map((_, i) => ({ ...cur[(i + rot) % 16] }));
    } else {
      this.squareMix = this.squareMix > 0.5 ? 0 : 1;
    }
    for (let i = 0; i < 16; i++) {
      const s = this.current[i];
      s.slide = s.slide && s.on && this.current[(i + 1) % 16].on;
    }
  }

  note(step16: number): AcidNote | null {
    const s = this.current[step16 % 16];
    if (!s.on) return null;
    return { midi: ACID_SCALE[s.degree], accent: s.accent, slide: s.slide };
  }
}

// ---------------------------------------------------------------- Bass

const BASS_ROOT = 33; // A1 = 55 Hz

/** Turnaround-Figuren für den letzten Beat jedes 4. Takts (3 Offbeat-16tel). */
const BASS_TURNS: readonly (readonly number[])[] = [
  [33, 36, 38],
  [31, 31, 33],
  [40, 38, 36],
  [45, 43, 40],
  [33, 45, 43],
  [36, 36, 38],
];

export class BassLine {
  private turnA: readonly number[];
  private turnB: readonly number[];
  /** Oktavsprung auf dem letzten 16tel jedes Beats (ab Layer 3). */
  readonly bounce: boolean;

  constructor(rng: Rng) {
    this.turnA = pick(rng, BASS_TURNS);
    this.turnB = pick(rng, BASS_TURNS);
    this.bounce = rng() < 0.5;
  }

  /** MIDI-Note für 16tel `s16` in Takt `bar`, oder null (Kick-Platz). */
  note(bar: number, s16: number, layer: number): number | null {
    const sub = s16 % 4;
    if (sub === 0) return null;
    const beat = s16 >> 2;
    if (beat === 3 && bar % 4 === 3) {
      const turn = bar % 8 === 7 ? this.turnB : this.turnA;
      return turn[sub - 1];
    }
    if (layer >= 3 && this.bounce && sub === 3 && beat % 2 === 1) return BASS_ROOT + 12;
    return BASS_ROOT;
  }
}

// ---------------------------------------------------------------- Stabs

/** Synkopierte Positionen innerhalb einer 2-Takt-Periode (32 16tel). */
const STAB_FIGURES: readonly (readonly number[])[] = [
  [3],
  [6],
  [3, 22],
  [10],
  [6, 27],
  [14, 30],
  [11],
  [2, 19],
];

export function pickStabFigure(rng: Rng): readonly number[] {
  return pick(rng, STAB_FIGURES);
}

// ---------------------------------------------------------------- Percussion

export interface PercPattern {
  readonly conga: readonly boolean[];
  readonly congaNotes: readonly number[];
  readonly rim: readonly boolean[];
}

export function makePercPattern(rng: Rng): PercPattern {
  const conga = euclid(pick(rng, [3, 5, 5, 7]), 16, Math.floor(rng() * 16));
  const rim = euclid(pick(rng, [2, 3, 3, 4]), 16, Math.floor(rng() * 16));
  // Nicht auf die Kick-Viertel — dort ist der Platz schon belegt.
  for (let i = 0; i < 16; i += 4) {
    conga[i] = false;
    rim[i] = false;
  }
  for (let i = 0; i < 16; i++) if (rim[i] && conga[i]) rim[i] = false;
  const congaNotes: number[] = [];
  // A3–E4: tief genug für Körper, aber über dem Kick/Bass-Fundament.
  for (let i = 0; i < 16; i++) congaNotes.push(pick(rng, [57, 57, 64, 60, 62]));
  return { conga, congaNotes, rim };
}

// ---------------------------------------------------------------- Fills & Pad

export type FillType = 'clapRoll' | 'tomRun' | 'kickDrop';

export function pickFill(rng: Rng): FillType {
  return pick(rng, ['clapRoll', 'tomRun', 'kickDrop', 'clapRoll'] as const);
}

/** Minimale Drone-Schleife: Grundton + Quinte bleiben, nur die Farbe wandert (4 Takte je Akkord). */
export const PAD_CHORDS: readonly (readonly number[])[] = [
  [45, 52, 60],
  [45, 52, 59],
  [45, 52, 60],
  [45, 52, 62],
];
