/**
 * Stick-Kurve (Plan 011 §1.1): reine Funktionen, DOM-frei, ohne Allokation
 * (Rückgabe in übergebene Objekte). Werte belegt mit `npm run sim -- --section stick`.
 *
 * Vorzeichen bleiben in Stick-Koordinaten (Gamepad API: x rechts +, y unten +).
 * Abbildung auf Yaw/Pitch und Invertierung macht der Aufrufer (InputState).
 */

export interface Vec2Out {
  x: number;
  y: number;
}

export interface MoveOut {
  /** +1 = vorwärts (Stick hoch), −1 = rückwärts. */
  fwd: number;
  /** +1 = rechts, −1 = links (wie PlayerInput.side). */
  side: number;
}

export interface LookRateOut {
  /** rad/s, positiv = Stick rechts. */
  yaw: number;
  /** rad/s, positiv = Stick unten. */
  pitch: number;
}

export interface LookCurveParams {
  /** Höchst-Drehrate horizontal (°/s) bei voller Auslenkung, ohne Boost. */
  readonly maxYawRate: number;
  /** Höchst-Drehrate vertikal (°/s). */
  readonly maxPitchRate: number;
  /** Exponent der Antwortkurve: rate = max · s^exponent (1 = linear). */
  readonly exponent: number;
  /** Radiale Deadzone innen/außen (Betrag 0…1). */
  readonly inner: number;
  readonly outer: number;
  /** Dreh-Boost am Rand: +boost × Grundrate (0 = aus). */
  readonly boost: number;
  /** So lange muss der Stick am Rand stehen, bevor der Boost einsetzt (s). */
  readonly boostDelay: number;
  /** Rampe des Boosts nach dem Einsetzen (s) — kein Ratensprung. */
  readonly boostRamp: number;
}

/** Ab diesem Betrag (nach Deadzone) gilt der Stick als "am Rand" (Boost-Uhr läuft). */
export const STICK_EDGE = 0.95;

/**
 * Defaults aus Plan 011 S1a (Sim-Beleg: movement-tuning.md "Controller"). 420 °/s
 * + Boost +50 % (Spitze 630) erfüllt das Kriterium bis 3 % Rauschen; ohne Boost
 * bräuchte es 510. ^2.4 hält 30 % Auslenkung bei 23 °/s (feinzielbar ≤ 25).
 * Pitch ist nicht vermessen (Strafen braucht keinen), Wert nach Gefühl.
 */
export const DEFAULT_LOOK_CURVE: LookCurveParams = {
  maxYawRate: 420,
  maxPitchRate: 220,
  exponent: 2.4,
  inner: 0.12,
  outer: 0.95,
  boost: 0.5,
  boostDelay: 0.15,
  boostRamp: 0.1,
};

/**
 * Radiale Deadzone: Richtung bleibt, Betrag wird von [inner, outer] stetig auf
 * [0, 1] abgebildet (kein Sprung an `inner`, weil der Betrag dort bei 0 beginnt).
 */
export function radialDeadzone(x: number, y: number, inner: number, outer: number, out: Vec2Out): Vec2Out {
  const m = Math.hypot(x, y);
  if (!(m > inner) || !(outer > inner)) {
    out.x = 0;
    out.y = 0;
    return out;
  }
  const s = Math.min(1, (m - inner) / (outer - inner));
  out.x = (x / m) * s;
  out.y = (y / m) * s;
  return out;
}

/** Boost-Faktor (≥ 1) aus der Haltezeit am Rand. */
export function boostFactor(p: LookCurveParams, heldEdgeTime: number): number {
  if (!(p.boost > 0) || !(heldEdgeTime > p.boostDelay)) return 1;
  const ramp = p.boostRamp > 0 ? Math.min(1, (heldEdgeTime - p.boostDelay) / p.boostRamp) : 1;
  return 1 + p.boost * ramp;
}

const DEG = Math.PI / 180;

/**
 * Drehrate aus Roh-Stick (x, y). Kurve wirkt auf den Betrag (radial), damit
 * Diagonalen nicht schneller drehen als die Achsen. `heldEdgeTime` führt der
 * Aufrufer (Zeit mit Betrag ≥ STICK_EDGE, sonst 0).
 */
export function lookRate(x: number, y: number, p: LookCurveParams, heldEdgeTime: number, out: LookRateOut): LookRateOut {
  const m = Math.hypot(x, y);
  if (!(m > p.inner) || !(p.outer > p.inner)) {
    out.yaw = 0;
    out.pitch = 0;
    return out;
  }
  const s = Math.min(1, (m - p.inner) / (p.outer - p.inner));
  const k = (Math.pow(s, p.exponent) * boostFactor(p, heldEdgeTime)) / m;
  out.yaw = x * k * p.maxYawRate * DEG;
  out.pitch = y * k * p.maxPitchRate * DEG;
  return out;
}

/** Betrag nach Deadzone (0…1) — für die Boost-Uhr des Aufrufers. */
export function stickMagnitude(x: number, y: number, inner: number, outer: number): number {
  const m = Math.hypot(x, y);
  if (!(m > inner) || !(outer > inner)) return 0;
  return Math.min(1, (m - inner) / (outer - inner));
}

/**
 * Bewegungs-Stick → digital (8 Sektoren, Plan 011 §2.2.1). Diagonalen sind
 * `diagonalBand` Grad breit (zentriert auf 45°), der Rest gehört der nächsten
 * Achse — ein Stick 20° neben links bleibt reines A.
 */
export function digitizeMove(x: number, y: number, inner: number, diagonalBand: number, out: MoveOut): MoveOut {
  if (!(Math.hypot(x, y) > inner)) {
    out.fwd = 0;
    out.side = 0;
    return out;
  }
  // Winkel 0° = rechts, 90° = hoch (Gamepad-y zeigt nach unten).
  let a = Math.atan2(-y, x) / DEG;
  if (a < 0) a += 360;
  const rel = a % 90; // Winkel innerhalb des Quadranten
  const diag = Math.abs(rel - 45) <= diagonalBand / 2;
  if (diag) {
    const q = Math.floor(a / 90); // 0: rechts-hoch, 1: links-hoch, 2: links-runter, 3: rechts-runter
    out.side = q === 0 || q === 3 ? 1 : -1;
    out.fwd = q <= 1 ? 1 : -1;
    return out;
  }
  const c = Math.round(a / 90) % 4; // 0 rechts, 1 hoch, 2 links, 3 runter
  out.side = c === 0 ? 1 : c === 2 ? -1 : 0;
  out.fwd = c === 1 ? 1 : c === 3 ? -1 : 0;
  return out;
}
