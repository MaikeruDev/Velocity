import type { Ease } from './curves';

/**
 * Sekundärbewegung (Plan 008): Nachlaufen, Überlappen, Nachschwingen, Ausholen. DOM-/three-frei, keine
 * Allokation pro Frame, framerate-unabhängig.
 *
 * `Follower` ist ein Feder-Dämpfer 2. Ordnung (ζ beliebig: < 1 schwingt nach, = 1 kritisch, > 1 träge), der
 * einem Ziel folgt. Exakt gelöst für ein Ziel, das sich innerhalb des Frames LINEAR ändert (Rampe von
 * Frame-Anfang zu Frame-Ende): bei bewegtem Ziel weicht er zwischen 30 und 240 Hz nur um die Abtastung des
 * Ziels ab, nicht um den Integrator (anim.Spring hält das Ziel über den Frame konstant → Fehler O(dt)).
 *
 * Muster:
 * - Follow-through/Overlap: Finger laufen dem Handgelenk nach → `overlap(driver)` = Follower(driver) − driver.
 * - Prop-Nachschwingen nach dem Fang: `impulse(v, age)` auf einen Follower mit Ziel 0, Ausgabe als Winkel.
 * - Ausholen: `anticipate(depth, split)` als Easing einer Track-Phase.
 */
export class Follower {
  /** Lage und Geschwindigkeit (Double-Startwerte, fallen.md #107.4). */
  x = 0.5;
  v = 0.5;
  /** Ziel am Ende des letzten Schritts (Anfang der nächsten Rampe). */
  private g = 0.5;
  private omega: number;
  private zeta: number;

  constructor(x0: number, omega: number, zeta: number) {
    this.x = x0;
    this.v = 0;
    this.g = x0;
    this.omega = omega;
    this.zeta = zeta;
  }

  /** Eigenfrequenz (rad/s) und Dämpfungsgrad ändern (Zustand bleibt). */
  tune(omega: number, zeta: number): void {
    this.omega = omega;
    this.zeta = zeta;
  }

  /** Auf x setzen, Ruhe. */
  reset(x: number): void {
    this.x = x;
    this.v = 0;
    this.g = x;
  }

  /** Schritt über dt; das Ziel läuft linear vom letzten Ziel bis `target`. */
  step(target: number, dt: number): number {
    if (!(dt > 0)) {
      this.g = target;
      return this.x;
    }
    const w = this.omega;
    const z = this.zeta;
    const s = (target - this.g) / dt;
    const lag = (2 * z * s) / w;
    // Abweichung von der Partikulärlösung x_p(t) = g(t) − 2ζs/ω, homogen exakt weiterführen.
    const y0 = this.x - (this.g - lag);
    const v0 = this.v - s;
    const hv = this.hv;
    hv[2] = y0;
    hv[3] = v0;
    hv[4] = w;
    hv[5] = z;
    hv[6] = dt;
    homogeneous(hv);
    this.x = this.hv[0] + target - lag;
    this.v = this.hv[1] + s;
    this.g = target;
    return this.x;
  }

  /** Geschwindigkeits-Impuls, der `age` s zurückliegt (Marke mitten im Frame, exakt nachgeholt). */
  impulse(dv: number, age = 0): void {
    if (!(age > 0)) {
      this.v += dv;
      return;
    }
    const hv = this.hv;
    hv[2] = 0;
    hv[3] = dv;
    hv[4] = this.omega;
    hv[5] = this.zeta;
    hv[6] = age;
    homogeneous(hv);
    this.x += this.hv[0];
    this.v += this.hv[1];
  }

  /** Nachlauf des Followers gegenüber seinem Ziel (Overlap/Drag). */
  get lagOf(): number {
    return this.x - this.g;
  }

  /** homogeneous(): Ergebnis [0..1], Eingaben [2..6]. */
  private readonly hv = new Float64Array(7);
}

/**
 * Homogene Lösung y'' + 2ζωy' + ω²y = 0 nach Zeit h → io[0..1] = [y, y'], Eingaben io[2..6] = [y0, v0, ω, ζ, h].
 * Über den Puffer statt als Argumente: die Funktion ist zu groß zum Inlinen, fünf Kommazahl-Argumente wurden je
 * Aufruf HeapNumbers (Feuerzeug-Flammen-Nachlauf ~80 B/Frame, fallen.md #107.3).
 */
export function homogeneous(io: Float64Array): void {
  const y0 = io[2];
  const v0 = io[3];
  const w = io[4];
  const z = io[5];
  const h = io[6];
  const out = io;
  if (z < 0.9999) {
    const wd = w * Math.sqrt(1 - z * z);
    const e = Math.exp(-z * w * h);
    const c = Math.cos(wd * h);
    const s = Math.sin(wd * h);
    out[0] = e * (y0 * c + ((v0 + z * w * y0) / wd) * s);
    out[1] = e * (v0 * c - ((w * w * y0 + z * w * v0) / wd) * s);
  } else if (z <= 1.0001) {
    const e = Math.exp(-w * h);
    const b = v0 + w * y0;
    out[0] = e * (y0 + b * h);
    out[1] = e * (v0 - w * b * h);
  } else {
    const q = Math.sqrt(z * z - 1);
    const r1 = -w * (z - q);
    const r2 = -w * (z + q);
    const c1 = (v0 - r2 * y0) / (r1 - r2);
    const c2 = y0 - c1;
    const e1 = Math.exp(r1 * h);
    const e2 = Math.exp(r2 * h);
    out[0] = c1 * e1 + c2 * e2;
    out[1] = c1 * r1 * e1 + c2 * r2 * e2;
  }
}

/**
 * Überlappen (Follow-through): Glied hängt einem Treiber nach. Pro Frame `step(driver, dt)` → Versatz
 * (Follower − Treiber) × gain, also 0 in Ruhe und beim Anhalten ein Nachschwingen. Typisch: Fingerbeugung
 * = Pose + overlap(Handgelenk-Winkel) mit gain −0.3…−0.6, ω 18–28, ζ 0.5–0.7.
 */
export class Overlap {
  private readonly f: Follower;
  readonly gain: number;
  value = 0.5;

  constructor(omega: number, zeta: number, gain: number, start = 0) {
    this.f = new Follower(start, omega, zeta);
    this.gain = gain;
    this.value = 0;
  }

  reset(driver: number): void {
    this.f.reset(driver);
    this.value = 0;
  }

  step(driver: number, dt: number): number {
    this.f.step(driver, dt);
    this.value = (this.f.x - driver) * this.gain;
    return this.value;
  }
}

/**
 * Ausholen als Easing: erst bis −depth gegen die Richtung (bis `split`), dann C1-stetig zum Ziel 1.
 * Start und Ausholpunkt mit Steigung 0 (kein Ruck).
 */
export function anticipate(depth = 0.15, split = 0.3): Ease {
  return (u) => {
    const x = u < 0 ? 0 : u > 1 ? 1 : u;
    if (x < split) {
      const s = Math.sin((Math.PI * x) / (2 * split));
      return -depth * s * s;
    }
    const k = (x - split) / (1 - split);
    const e = k * k * k * (k * (k * 6 - 15) + 10);
    return -depth + (1 + depth) * e;
  };
}
