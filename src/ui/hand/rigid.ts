import { VIEW_AXES } from './rot';

/**
 * Starrkörper-Flug für Würfe (Plan 008): geschlossene Lösung statt Integration — p(t) = p0 + v0·t + ½·g·t²,
 * Drehung mit konstanter Rate. `plan()` legt v0 und die Rate so fest, dass der Gegenstand zur Fangzeit T
 * genau am Fangpunkt mit dem gewünschten Winkel ankommt (n volle Drehungen + Rest). Damit sind Würfe
 * physikalisch (echte Parabel, Schwerkraft "unten im Bild") UND exakt steuerbar, und jede Framerate zeigt
 * dieselbe Bahn. Nach dem Fang: `settle()` — gedämpftes Nachfedern aus der Aufprall-Geschwindigkeit
 * (Squash/Settle), plus der Ruck, der an die Hand geht.
 * Einheiten: Handgelenk-Raum (~cm), s. Schwerkraft zeigt "unten im Bild" (VIEW_AXES.up), Betrag wählbar:
 * echte 981 cm/s² wirken bei Trick-Dauern von 0.5 s zu hoch — Cartoon-Würfe nehmen 600–900.
 */
export class Toss {
  readonly p0 = new Float64Array(3);
  readonly v0 = new Float64Array(3);
  readonly g = new Float64Array(3);
  /** Fangzeit (s ab Abwurf), Startwinkel und Drehrate (rad/s). */
  T = 0.5;
  a0 = 0.5;
  w = 0.5;

  constructor(gravity = 800) {
    this.setGravity(gravity);
    this.T = 0.5;
    this.a0 = 0;
    this.w = 0;
  }

  /** Schwerkraft in Bildrichtung "unten" mit Betrag g (Einheiten/s²). */
  setGravity(g: number): void {
    const up = VIEW_AXES.up;
    this.g[0] = -up[0] * g;
    this.g[1] = -up[1] * g;
    this.g[2] = -up[2] * g;
  }

  /**
   * Abwurf bei `from` (xyz), Fang bei `to` nach T s; Winkel von a0 nach a1 (die Differenz enthält die
   * vollen Drehungen, z. B. a1 = a0 + 2π·n). Ladezeit oder Trick-Start (keine Allokation).
   */
  plan(from: ArrayLike<number>, to: ArrayLike<number>, T: number, a0: number, a1: number): void {
    this.T = T;
    for (let k = 0; k < 3; k++) {
      this.p0[k] = from[k];
      this.v0[k] = (to[k] - from[k] - 0.5 * this.g[k] * T * T) / T;
    }
    this.a0 = a0;
    this.w = (a1 - a0) / T;
  }

  /** Scheitelhöhe über dem Abwurf (Bildrichtung oben) — zum Prüfen der Bild-Hülle. */
  apexUp(): number {
    const up = VIEW_AXES.up;
    const vu = this.v0[0] * up[0] + this.v0[1] * up[1] + this.v0[2] * up[2];
    const gu = -(this.g[0] * up[0] + this.g[1] * up[1] + this.g[2] * up[2]);
    return gu > 0 && vu > 0 ? (vu * vu) / (2 * gu) : 0;
  }

  /** Lage zur Flugzeit t (geklemmt auf [0, T]) → out xyz; Rückgabe: Winkel. */
  at(t: number, out: Float64Array | Float32Array): number {
    const x = t < 0 ? 0 : t > this.T ? this.T : t;
    for (let k = 0; k < 3; k++) out[k] = this.p0[k] + this.v0[k] * x + 0.5 * this.g[k] * x * x;
    return this.a0 + this.w * x;
  }

  /** Geschwindigkeit zur Flugzeit t → out xyz (für Aufprall/Ruck beim Fang). */
  velocity(t: number, out: Float64Array | Float32Array): void {
    const x = t < 0 ? 0 : t > this.T ? this.T : t;
    for (let k = 0; k < 3; k++) out[k] = this.v0[k] + this.g[k] * x;
  }
}

/**
 * Nachfedern nach einem Fang: gedämpfte Schwingung aus der Aufprall-Geschwindigkeit v (Einheiten/s bzw.
 * rad/s), Zeit seit dem Fang s. Rückgabe: Versatz (Einheiten bzw. rad), 0 bei s ≤ 0 und für s → ∞.
 * Geschlossene Form → framerate-unabhängig. ω ~ 2π·5 (fester Griff) … 2π·3 (weicher), ζ 0.35–0.6.
 */
export function settle(v: number, s: number, omega = Math.PI * 2 * 4, zeta = 0.45): number {
  if (!(s > 0)) return 0;
  const wd = omega * Math.sqrt(1 - zeta * zeta);
  return (v / wd) * Math.exp(-zeta * omega * s) * Math.sin(wd * s);
}

/** Squash beim Fang: kurzes Stauchen (1 − amount·…) über `dur` s, C1 an beiden Enden. */
export function squash(s: number, amount = 0.12, dur = 0.16): number {
  if (!(s > 0) || s >= dur) return 1;
  const u = s / dur;
  const b = Math.sin(Math.PI * u);
  return 1 - amount * b * b * (1 - 0.35 * u);
}
