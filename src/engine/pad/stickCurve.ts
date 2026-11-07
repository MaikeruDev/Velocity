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
  /**
   * Achsen-Deadzone des Pitch (Review A2): Vertikalanteil |y|/|Stick| darunter zählt nicht, darüber stetig auf
   * 0…1 nachskaliert. Ein voller Seitenausschlag ein paar Grad neben der Waagerechten kippte sonst den Blick
   * (12° → 37° Pitch in 0.6 s). Rein geometrisch, kein Zeitfilter (movement.md §3).
   */
  readonly pitchSnap: number;
}

/** Ab diesem Betrag (nach Deadzone) gilt der Stick als "am Rand": die Boost-Uhr läuft. */
export const STICK_EDGE = 0.95;
/**
 * Hysterese der Boost-Uhr (Review A3): zwischen STICK_EDGE_OFF und STICK_EDGE steht sie (der erreichte Boost bleibt),
 * erst darunter fällt sie auf 0. Ohne das setzte jedes Zittern unter 0.95 sie zurück (0.93 ± 0.03 → 395 statt 555 °/s).
 */
export const STICK_EDGE_OFF = 0.85;

/**
 * Defaults aus Plan 011 S1a (Sim-Beleg: movement-tuning.md "Controller"). 420 °/s
 * + Boost +50 % (Spitze 630) erfüllt das Kriterium bis 3 % Rauschen; ohne Boost
 * bräuchte es 510. ^2.4 hält 30 % Auslenkung bei 23 °/s (feinzielbar ≤ 25).
 * Pitch: 220 °/s ohne Boost (45° in 0.2 s, ganzer Bereich ±89° in 0.81 s, 30 % Auslenkung 12 °/s),
 * Achsen-Deadzone 0.2 (asin 0.2 = 11.5° neben der Waagerechten kippt nichts) — tests/pad.test.ts.
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
  pitchSnap: 0.2,
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

/**
 * Boost-Uhr weiterstellen (Review A3): läuft nur am Rand (Betrag ≥ STICK_EDGE), steht im Band
 * [STICK_EDGE_OFF, STICK_EDGE), fällt darunter auf 0. Zustand führt der Aufrufer (PadInput, Sim-Hand).
 */
export function edgeClock(clock: number, magnitude: number, dt: number): number {
  if (magnitude >= STICK_EDGE) return clock + dt;
  return magnitude >= STICK_EDGE_OFF ? clock : 0;
}

const DEG = Math.PI / 180;

/**
 * Drehrate aus Roh-Stick (x, y). Kurve wirkt auf den Betrag (radial), damit
 * Diagonalen nicht schneller drehen als die Achsen. `heldEdgeTime` = Boost-Uhr
 * des Aufrufers (edgeClock); der Boost wirkt NUR auf Yaw (Review A2) — Strafen
 * braucht die Spitze, Pitch nicht. Pitch mit Achsen-Deadzone (pitchSnap).
 */
export function lookRate(x: number, y: number, p: LookCurveParams, heldEdgeTime: number, out: LookRateOut): LookRateOut {
  const m = Math.hypot(x, y);
  if (!(m > p.inner) || !(p.outer > p.inner)) {
    out.yaw = 0;
    out.pitch = 0;
    return out;
  }
  const s = Math.min(1, (m - p.inner) / (p.outer - p.inner));
  const c = Math.pow(s, p.exponent);
  out.yaw = ((x * c) / m) * boostFactor(p, heldEdgeTime) * p.maxYawRate * DEG;
  // Vertikalanteil |sin θ| erst über pitchSnap, stetig von 0 (an der Schwelle) bis 1 (senkrecht).
  const snap = p.pitchSnap > 0 && p.pitchSnap < 1 ? p.pitchSnap : 0;
  const ay = Math.abs(y) / m;
  const share = ay > snap ? (ay - snap) / (1 - snap) : 0;
  out.pitch = share > 0 ? (y < 0 ? -share : share) * c * p.maxPitchRate * DEG : 0;
  return out;
}

/** Betrag nach Deadzone (0…1) — für die Boost-Uhr des Aufrufers. */
export function stickMagnitude(x: number, y: number, inner: number, outer: number): number {
  const m = Math.hypot(x, y);
  if (!(m > inner) || !(outer > inner)) return 0;
  return Math.min(1, (m - inner) / (outer - inner));
}

/**
 * Hysterese der 8 Richtungen (Review A3): eine gehaltene Richtung bleibt bis MOVE_ANGLE_HOLD Grad über ihre
 * Sektorgrenze hinaus, und erst unter der Deadzone minus MOVE_MAG_HOLD (höchstens ein Drittel von ihr) ist der
 * Stick los. Sonst flatterte die Richtung an der Bandkante (30° ± 1°: fwd 277 Wechsel in 600 Polls) — am Boden
 * springt die wishdir dabei um 45° (Prestrafe W+A ↔ A).
 */
export const MOVE_ANGLE_HOLD = 3.5;
export const MOVE_MAG_HOLD = 0.1;

/**
 * Bewegungs-Stick → digital (8 Sektoren, Plan 011 §2.2.1). Diagonalen sind
 * `diagonalBand` Grad breit (zentriert auf 45°), der Rest gehört der nächsten
 * Achse — ein Stick 20° neben links bleibt reines A.
 * `prev` = Ergebnis des vorigen Polls (darf `out` sein) → Hysterese; ohne prev zustandslos.
 */
export function digitizeMove(x: number, y: number, inner: number, diagonalBand: number, out: MoveOut, prev: MoveOut | null = null): MoveOut {
  // Vor dem Schreiben lesen: prev und out sind beim Aufrufer oft dasselbe Objekt.
  const pf = prev !== null ? prev.fwd : 0;
  const ps = prev !== null ? prev.side : 0;
  const held = pf !== 0 || ps !== 0;
  const release = held ? inner - Math.min(MOVE_MAG_HOLD, inner / 3) : inner;
  if (!(Math.hypot(x, y) > release)) {
    out.fwd = 0;
    out.side = 0;
    return out;
  }
  // Winkel 0° = rechts, 90° = hoch (Gamepad-y zeigt nach unten).
  let a = Math.atan2(-y, x) / DEG;
  if (a < 0) a += 360;
  if (held) {
    // Gehaltene Richtung: Sektormitte (Vielfache von 45°) und halbe Sektorbreite + Hysterese.
    let center = Math.atan2(pf, ps) / DEG;
    if (center < 0) center += 360;
    const half = (pf !== 0 && ps !== 0 ? diagonalBand : 90 - diagonalBand) / 2 + MOVE_ANGLE_HOLD;
    let d = Math.abs(a - center);
    if (d > 180) d = 360 - d;
    if (d <= half) {
      out.fwd = pf;
      out.side = ps;
      return out;
    }
  }
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
