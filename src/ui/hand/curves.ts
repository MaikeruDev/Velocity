/**
 * Kurven und Keyframes der View-Hand (Plan 008). DOM-/three-frei, nach dem Aufbau keine Allokation.
 *
 * - Easing-Bibliothek: Funktionen 0..1 → 0..1 (Überschwinger erlaubt), alle mit e(0) = 0, e(1) = 1.
 * - `Track`: Keyframes (Zeit, Wert, Easing je Segment) — stetig per Konstruktion: jedes Segment läuft
 *   von seinem Key zum nächsten. Mit `smooth: true` stetig in Wert UND Steigung (kubische Hermite mit
 *   Catmull-Rom-Tangenten, monoton begrenzt) — kein Knick an Phasengrenzen (Messer-Aerial sprang dort).
 * - `Clip`: mehrere Tracks über eine gemeinsame Zeit, ausgewertet in ein Float64Array (Kanäle).
 * Zeiten in Sekunden der Trick-Zeit: dieselbe Zeit ergibt bei jeder Framerate denselben Wert.
 */

// ------------------------------------------------------------------ Easing

export type Ease = (u: number) => number;

const c01 = (u: number): number => (u < 0 ? 0 : u > 1 ? 1 : u);

export const linear: Ease = (u) => c01(u);
export const quadIn: Ease = (u) => {
  const x = c01(u);
  return x * x;
};
export const quadOut: Ease = (u) => {
  const x = 1 - c01(u);
  return 1 - x * x;
};
export const cubicIn: Ease = (u) => {
  const x = c01(u);
  return x * x * x;
};
export const cubicOut: Ease = (u) => {
  const x = 1 - c01(u);
  return 1 - x * x * x;
};
export const cubicInOut: Ease = (u) => {
  const x = c01(u);
  return x < 0.5 ? 4 * x * x * x : 1 - 4 * (1 - x) * (1 - x) * (1 - x);
};
export const quintOut: Ease = (u) => {
  const x = 1 - c01(u);
  return 1 - x * x * x * x * x;
};
export const sineInOut: Ease = (u) => 0.5 - 0.5 * Math.cos(Math.PI * c01(u));
/** Smoothstep (C1, wie anim.smooth). */
export const smoothstep: Ease = (u) => {
  const x = c01(u);
  return x * x * (3 - 2 * x);
};
/** Smootherstep (C2: auch die Beschleunigung startet/endet bei 0 — Physik-Antrieb ohne Ruck). */
export const smootherstep: Ease = (u) => {
  const x = c01(u);
  return x * x * x * (x * (x * 6 - 15) + 10);
};

/** Ausholen (Anticipation): erst gegen die Richtung (Tiefe ~s/10), dann zum Ziel. */
export function backIn(s = 1.70158): Ease {
  return (u) => {
    const x = c01(u);
    return x * x * ((s + 1) * x - s);
  };
}
/** Überschwinger am Ende (Overshoot ~s/10). */
export function backOut(s = 1.70158): Ease {
  return (u) => {
    const x = c01(u) - 1;
    return 1 + x * x * ((s + 1) * x + s);
  };
}
export function backInOut(s = 1.70158): Ease {
  const k = s * 1.525;
  return (u) => {
    const x = c01(u) * 2;
    if (x < 1) return 0.5 * (x * x * ((k + 1) * x - k));
    const y = x - 2;
    return 0.5 * (y * y * ((k + 1) * y + k) + 2);
  };
}

/**
 * Gedämpft-elastisches Einschwingen: 1 − e^(−ζωu)·(cos ωd·u + …) normiert auf genau 1 bei u = 1.
 * `cycles` Schwingungen über die Dauer, `damping` 0..1 (1 = kaum Nachschwingen). Fang/Anschlag.
 */
export function elasticOut(cycles = 2, damping = 0.45): Ease {
  const wd = Math.PI * 2 * cycles;
  const zw = damping * 9;
  const end = Math.exp(-zw);
  return (u) => {
    const x = c01(u);
    const e = Math.exp(-zw * x);
    const v = 1 - e * (Math.cos(wd * x) + (zw / wd) * Math.sin(wd * x));
    // Rest bei u = 1 linear wegnehmen → e(1) = 1 exakt, kein Sprung am Segmentende.
    const r = 1 - (1 - end * (Math.cos(wd) + (zw / wd) * Math.sin(wd)));
    return v + r * x;
  };
}

/**
 * Kubische Bézier wie CSS cubic-bezier(x1, y1, x2, y2): x(t) per Newton (6 Schritte) + Bisektion als
 * Rückfall, keine Allokation pro Auswertung. x1, x2 ∈ [0, 1] (monoton in der Zeit).
 */
export function bezier(x1: number, y1: number, x2: number, y2: number): Ease {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sx = (t: number): number => ((ax * t + bx) * t + cx) * t;
  const dx = (t: number): number => (3 * ax * t + 2 * bx) * t + cx;
  return (u) => {
    const x = c01(u);
    let t = x;
    for (let i = 0; i < 6; i++) {
      const e = sx(t) - x;
      const d = dx(t);
      if (Math.abs(e) < 1e-7) break;
      if (Math.abs(d) < 1e-6) break;
      t -= e / d;
    }
    if (!(t >= 0 && t <= 1) || Math.abs(sx(t) - x) > 1e-5) {
      let lo = 0;
      let hi = 1;
      t = x;
      for (let i = 0; i < 30; i++) {
        if (sx(t) < x) lo = t;
        else hi = t;
        t = (lo + hi) / 2;
      }
    }
    return ((ay * t + by) * t + cy) * t;
  };
}

/** Glocke 0 → 1 → 0 (sin², C1) — Ausschlag hin und zurück. */
export const bellCurve: Ease = (u) => {
  const s = Math.sin(Math.PI * c01(u));
  return s * s;
};

// ------------------------------------------------------------------ Keyframes

/** Kennzahlen der in Track.evalInto inline ausgewerteten Easings (Formeln dort müssen exakt gleich bleiben). */
const TRACK_IO = new Float64Array(2);
const EASE_KIND = new Map<Ease, number>([
  [linear, 1],
  [quadIn, 2],
  [quadOut, 3],
  [cubicIn, 4],
  [cubicOut, 5],
  [cubicInOut, 6],
  [quintOut, 7],
  [sineInOut, 8],
  [smoothstep, 9],
  [smootherstep, 10],
  [bellCurve, 11],
]);

/** Ein Key: Zeit (s), Wert, Easing des Segments AB diesem Key (zum nächsten); ohne = smooth/linear. */
export type Key = readonly [time: number, value: number, ease?: Ease];

export interface TrackOptions {
  /** C1-stetig über alle Keys (Hermite, Catmull-Rom-Tangenten), Easing der Keys wird dann ignoriert. */
  readonly smooth?: boolean;
}

/**
 * Keyframe-Spur. Vor dem ersten Key gilt dessen Wert, nach dem letzten dessen Wert (keine Extrapolation).
 * Aufbau zur Ladezeit, value(t) ohne Allokation.
 */
export class Track {
  readonly t: Float64Array;
  readonly v: Float64Array;
  /** Tangenten (Wert/s) je Key, nur smooth. */
  private readonly m: Float64Array;
  private readonly ease: (Ease | null)[];
  /** Easing je Segment als Kennzahl (EASE_KIND; 0 = keins, -1 = Aufruf von ease[i]). */
  private readonly kind: Int32Array;
  private readonly smoothed: boolean;

  constructor(keys: readonly Key[], o: TrackOptions = {}) {
    if (keys.length === 0) throw new Error('Track ohne Keys');
    this.t = Float64Array.from(keys.map((k) => k[0]));
    this.v = Float64Array.from(keys.map((k) => k[1]));
    for (let i = 1; i < keys.length; i++) if (!(this.t[i] > this.t[i - 1])) throw new Error(`Track: Zeiten müssen steigen (${this.t[i - 1]} → ${this.t[i]})`);
    this.ease = keys.map((k) => k[2] ?? null);
    this.kind = Int32Array.from(keys.map((k) => (k[2] ? (EASE_KIND.get(k[2]) ?? -1) : 0)));
    this.smoothed = o.smooth ?? false;
    const n = keys.length;
    this.m = new Float64Array(n);
    if (this.smoothed) {
      // Catmull-Rom (ungleichmäßige Zeiten), Enden flach (Ruhe vor/nach dem Trick), monoton begrenzt (Fritsch-Carlson):
      // kein Überschwingen zwischen zwei gleichen Keys (Haltephasen bleiben ruhig).
      for (let i = 1; i < n - 1; i++) {
        const d0 = (this.v[i] - this.v[i - 1]) / (this.t[i] - this.t[i - 1]);
        const d1 = (this.v[i + 1] - this.v[i]) / (this.t[i + 1] - this.t[i]);
        this.m[i] = d0 * d1 <= 0 ? 0 : (this.v[i + 1] - this.v[i - 1]) / (this.t[i + 1] - this.t[i - 1]);
        const lim = 3 * Math.min(Math.abs(d0), Math.abs(d1));
        if (Math.abs(this.m[i]) > lim) this.m[i] = Math.sign(this.m[i]) * lim;
      }
    }
  }

  get start(): number {
    return this.t[0];
  }

  get end(): number {
    return this.t[this.t.length - 1];
  }

  value(time: number): number {
    const b = TRACK_IO;
    b[0] = time;
    this.evalInto(b, 0, b, 1);
    return b[1];
  }

  /**
   * out[k] = value(buf[ti]). Ohne Kommazahl-Argumente und -Rückgabe, Easing inline über eine Kennzahl (dieselben
   * Formeln wie die Easing-Konstanten → bitgleich): `e(u)` war megamorph (sineInOut/quadIn/… je Segment) und nicht
   * inlinebar, jede Rückgabe eine HeapNumber; ebenso value(t) selbst, wenn der Aufrufer zu groß war (fallen.md).
   */
  evalInto(buf: Float64Array, ti: number, out: Float64Array, k: number): void {
    const time = buf[ti];
    const T = this.t;
    const n = T.length;
    if (!(time > T[0])) {
      out[k] = this.v[0];
      return;
    }
    if (time >= T[n - 1]) {
      out[k] = this.v[n - 1];
      return;
    }
    let i = 0;
    while (i < n - 2 && time >= T[i + 1]) i++;
    const h = T[i + 1] - T[i];
    const u = (time - T[i]) / h;
    const a = this.v[i];
    const b = this.v[i + 1];
    if (this.smoothed) {
      const u2 = u * u;
      const u3 = u2 * u;
      out[k] = (2 * u3 - 3 * u2 + 1) * a + (u3 - 2 * u2 + u) * h * this.m[i] + (-2 * u3 + 3 * u2) * b + (u3 - u2) * h * this.m[i + 1];
      return;
    }
    const x = u < 0 ? 0 : u > 1 ? 1 : u;
    let w: number;
    switch (this.kind[i]) {
      case 0:
        w = u;
        break;
      case 1:
        w = x;
        break;
      case 2:
        w = x * x;
        break;
      case 3: {
        const y = 1 - x;
        w = 1 - y * y;
        break;
      }
      case 4:
        w = x * x * x;
        break;
      case 5: {
        const y = 1 - x;
        w = 1 - y * y * y;
        break;
      }
      case 6:
        w = x < 0.5 ? 4 * x * x * x : 1 - 4 * (1 - x) * (1 - x) * (1 - x);
        break;
      case 7: {
        const y = 1 - x;
        w = 1 - y * y * y * y * y;
        break;
      }
      case 8:
        w = 0.5 - 0.5 * Math.cos(Math.PI * x);
        break;
      case 9:
        w = x * x * (3 - 2 * x);
        break;
      case 10:
        w = x * x * x * (x * (x * 6 - 15) + 10);
        break;
      case 11: {
        const s = Math.sin(Math.PI * x);
        w = s * s;
        break;
      }
      default:
        w = (this.ease[i] as Ease)(u);
    }
    out[k] = a + (b - a) * w;
  }

  /** Ableitung (Wert/s) per zentraler Differenz — für Antrieb von Physik (Handgelenk-Winkelgeschwindigkeit). */
  slope(time: number, h = 1e-4): number {
    return (this.value(time + h) - this.value(time - h)) / (2 * h);
  }
}

/** Mehrere Spuren über dieselbe Zeit — Werte landen in `out` (Kanal i = Spur i). */
export class Clip {
  readonly tracks: readonly Track[];
  readonly out: Float64Array;
  readonly duration: number;

  constructor(tracks: readonly Track[]) {
    this.tracks = tracks;
    this.out = new Float64Array(tracks.length);
    let d = 0;
    for (const tr of tracks) d = Math.max(d, tr.end);
    this.duration = d;
  }

  eval(time: number): Float64Array {
    const tr = this.tracks;
    for (let i = 0; i < tr.length; i++) this.out[i] = tr[i].value(time);
    return this.out;
  }
}

/** Phasen-Helfer: Anteil 0..1 von t in [a, b] (geklemmt). */
export function phase(t: number, a: number, b: number): number {
  return b > a ? c01((t - a) / (b - a)) : t >= b ? 1 : 0;
}
