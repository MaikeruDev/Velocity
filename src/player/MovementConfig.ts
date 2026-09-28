/**
 * Alle Stellschrauben des Movements an einem Ort, typsicher und unveränderlich.
 *
 * Einheiten sind Source-Units (u ≈ 1 Zoll) und Sekunden. Die Namen in
 * Klammern sind die entsprechenden CS/Source-Cvars — wer aus CS kommt, soll
 * die Zahlen wiedererkennen.
 */

export interface HullConfig {
  /** Halbe Breite der Box (x und z). Source: 16. */
  readonly halfWidth: number;
  readonly standHeight: number; // 72
  readonly duckHeight: number; // 54
  readonly standEye: number; // 64
  readonly duckEye: number; // 46
}

export interface MovementConfig {
  /** Physik-Ticks pro Sekunde (fixed timestep). */
  readonly tickRate: number;
  /** (sv_gravity) u/s² */
  readonly gravity: number;
  /** Vertikaler Absprung in u/s. 301.993 → 57 u Sprunghöhe. */
  readonly jumpImpulse: number;
  /** Laufgeschwindigkeit am Boden, u/s (Messer in CS: 250). */
  readonly runSpeed: number;
  /** Sprint (Shift) am Boden, u/s. */
  readonly sprintSpeed: number;
  /** Faktor auf die Wunschgeschwindigkeit beim Ducken am Boden. Source: 0.34. */
  readonly duckSpeedScale: number;
  /** (sv_accelerate) Bodenbeschleunigung. */
  readonly accelerate: number;
  /** (sv_airaccelerate) Luftbeschleunigung. */
  readonly airAccelerate: number;
  /** Kappung der Wunschgeschwindigkeit in der Luft (Source: 30 u/s). Der eigentliche Skill-Hebel. */
  readonly airSpeedCap: number;
  /**
   * Tempoabhängiger Luft-Cap: bis `airSpeedCapFadeFrom` (horizontal, u/s) gilt
   * dieser Cap, bis `airSpeedCapFadeTo` linear zurück auf `airSpeedCap`.
   * Die ersten Strafes zahlen sich sofort aus, die Decke bleibt fast gleich.
   * 0 = aus (konstant `airSpeedCap`, wie Source). Siehe `airSpeedCapAt`.
   */
  readonly airSpeedCapLow: number;
  readonly airSpeedCapFadeFrom: number;
  readonly airSpeedCapFadeTo: number;
  /**
   * Strafe-Assist: in der Luft zählt W/S nicht, solange A/D gedrückt ist
   * (gehaltenes W dreht die wishdir zur Flugrichtung und frisst den Gewinn).
   */
  readonly strafeAssist: boolean;
  /** (sv_friction) */
  readonly friction: number;
  /** (sv_stopspeed) unterhalb davon bremst Friction wie bei dieser Geschwindigkeit. */
  readonly stopSpeed: number;
  /** (sv_maxvelocity) harte Kappung pro Achse. */
  readonly maxVelocity: number;
  /** Maximale Stufenhöhe, die man hochläuft. Source: 18. */
  readonly stepSize: number;
  /** Aufwärtsgeschwindigkeit, ab der man nie als "am Boden" gilt (Source: 140). */
  readonly nonJumpVelocity: number;
  /** Nach dem Verlassen einer Kante (ohne Sprung) darf noch so lange gesprungen werden. */
  readonly coyoteTime: number;
  /** Sprung-Druck so lange vor der Landung wird gepuffert und beim Aufsetzen ausgeführt. */
  readonly jumpBufferTime: number;
  /** Gedrückt gehaltenes Springen hüpft automatisch weiter (Bhop-Server-Stil). */
  readonly autoHop: boolean;
  /**
   * Smart-Auto-Hop: eine nur gehaltene Taste (kein frischer Druck, kein Puffer)
   * springt am Boden mit gedrückter Bewegungstaste erst ab diesem Anteil des
   * Boden-Wunschtempos — oder nach `autoHopGroundTime` am Boden. 0 = sofort
   * (Source-Autobhop).
   */
  readonly autoHopSpeedShare: number;
  /** Smart-Auto-Hop: nach so langer Bodenzeit (s) springt die gehaltene Taste immer (Wand, Stufe). */
  readonly autoHopGroundTime: number;
  /**
   * Smart-Auto-Hop, Strafer (A/D gedrückt) nach echtem Luftabschnitt (≥ `autoHopLandAirTime` s):
   * im ersten Bodentick reicht schon dieser Anteil des Boden-Wunschtempos. Der strenge Anteil oben
   * gilt nur für den Antritt aus dem Stand und nach einem Anprall — sonst hing jede leicht
   * zu langsame Strafe-Landung bis 0.2 s am Boden (Prüfung 27.09.).
   */
  readonly autoHopLandShare: number;
  /** Mindest-Luftzeit (s) der Landung für `autoHopLandShare` (Sprung/Fall, nicht Kanten-Holpern). */
  readonly autoHopLandAirTime: number;
  /** Dauer der Kamera-Absenkung beim Ducken am Boden, s. */
  readonly duckTime: number;

  // ---- Arcade-Pass (Plan 007, rules/movement.md, movement-tuning.md "Arcade-Pass"). Jede
  // Abweichung von Source hat einen Schalter: 0/false = aus (CS2_CLASSIC, bitgleich zu Source-Port).
  // Ausnahme ohne Schalter: der Knick-Projektion-Fix in tryPlayerMove (Bugfix, A1).

  /**
   * Lande-Gnade (s): so lange nach einer Landung aus ≥ 0.1 s Luft keine Friction (auch keine
   * Rutsch-Reibung). Boden-Schub hebt |v_h| in der Zeit nicht über max(Tempo davor, wishspeed);
   * Hop-Kette und Sync reißen erst danach; ein Sprung darin ist `jump.clean`. 0 = aus.
   */
  readonly landGraceTime: number;
  /**
   * Hang-Landung (0..1): bergab gewinnt man in jeder Tick-Phase, bergauf verliert man nichts, die
   * Rampslide-Entscheidung ist phasenfest. Der erlassene Bergauf-Verlust wird gestundet und vom nächsten
   * Bergab-Gewinn abgezogen (sonst pumpen Wellen). 0 = Source (Clip-Verlust hängt an der Tick-Phase).
   */
  readonly slopeLandGain: number;
  /**
   * Rampbug-Fix: trifft ein Surf-Move eine Gegen-Ebene (cos < −0.5, |v_h| > 100), wird der Weg
   * 0.25/1/2 u entlang der letzten Surf-Normale angehoben nachgetraced. false = Source.
   */
  readonly surfSeamFix: boolean;
  /**
   * Kanten-Assist: frontaler (≤ 45°) Lip-Step in der Luft bis zu dieser Höhe (u), danach Landung auf der
   * Kante (vel.y = 0; nicht, solange der Rest-Aufstieg die Kante klar selbst schafft). Hebt die Reichweite
   * ohne Ducken auf 57 + ledgeStep, aus der Auto-Hop-Landung + 1.5 → Crouch-Kanten ≥ 66 u. 0 = aus.
   */
  readonly ledgeStep: number;
  /**
   * Kanten-Assist: Tempo vor einem frontalen Bonk kommt innerhalb so vieler Sekunden Luftzeit zurück,
   * sobald die Hull höher frei ist (Steigen/Ducken) — nie seitlich, nie mehr als vorher. 0 = aus.
   */
  readonly ledgeMemory: number;
  /**
   * Rutschen: Eintritt geduckt am Boden ab diesem Horizontal-Tempo (u/s; Hull duckt sofort). Keine
   * Bodenbeschleunigung, eigene Reibung, Lenken mit der Maus, Hangabtrieb, keine Schritte. Ende unter
   * slideExitSpeed oder aufgestanden (unter einer Decke rutscht man weiter). 0 = kein Rutschen.
   */
  readonly slideMinSpeed: number;
  /** Rutschen endet unter diesem Tempo (u/s). */
  readonly slideExitSpeed: number;
  /** Rutsch-Reibung (1/s, wirkt wie sv_friction) … */
  readonly slideFriction: number;
  /** … plus konstante Verzögerung (u/s²). */
  readonly slideDecel: number;
  /** Schub beim Rutsch-Eintritt (u/s), nur aus dem Lauf … */
  readonly slideBoost: number;
  /** … und nur bis zu diesem Tempo (u/s). */
  readonly slideBoostCap: number;
  /** Schub nur nach so viel Bodenzeit (s) — Landen + Ducken ist kein Schub-Farmen. */
  readonly slideBoostMinGround: number;
  /** Abklingzeit des Schubs (s). */
  readonly slideBoostCooldown: number;
  /** Lenken beim Rutschen (rad/s zur Blickrichtung, nur bis 90° neben der Fahrt; Betrag bleibt). */
  readonly slideSteerRate: number;
  /** Hangabtrieb beim Rutschen (0..1 × Gravitation entlang der Fläche). */
  readonly slideSlopeGravity: number;
  /** Augenhöhe fällt beim Rutsch-Eintritt in dieser Zeit (s) statt duckTime. */
  readonly slideEyeTime: number;
  /**
   * Luftlenkung nur mit W (rad/s): v_h dreht zur Blickrichtung, der Betrag bleibt. Bis
   * `airControlFadeFrom` gilt dieser Wert, bis `airControlFadeTo` linear auf `airControlHigh`.
   * 0 = aus (CS2 und Einstellung "Luftlenkung mit W" aus, siehe movementConfigFor).
   */
  readonly airControl: number;
  readonly airControlHigh: number;
  readonly airControlFadeFrom: number;
  readonly airControlFadeTo: number;
  /** Luftlenkung ruht so lange (s) nach Kontakt mit einer steilen Fläche (Surf-Flanke). */
  readonly airControlSurfGrace: number;

  readonly hull: HullConfig;
}

export const SOURCE_HULL: HullConfig = {
  halfWidth: 16,
  standHeight: 72,
  duckHeight: 54,
  standEye: 64,
  duckEye: 46,
};

/** Werte wie auf einem CS2-Server mit Standard-Cvars (ohne Stamina-Strafe). Referenz, nicht Default. */
export const CS2_CLASSIC: MovementConfig = {
  tickRate: 64,
  gravity: 800,
  jumpImpulse: 301.993377,
  runSpeed: 250,
  sprintSpeed: 250,
  duckSpeedScale: 0.34,
  accelerate: 5.5,
  airAccelerate: 12,
  airSpeedCap: 30,
  // Source: konstanter Cap. Überblendwerte nur als Startpunkt fürs Tuning-Panel.
  airSpeedCapLow: 0,
  airSpeedCapFadeFrom: 350,
  airSpeedCapFadeTo: 700,
  strafeAssist: false,
  friction: 5.2,
  stopSpeed: 80,
  maxVelocity: 3500,
  stepSize: 18,
  nonJumpVelocity: 140,
  coyoteTime: 0,
  jumpBufferTime: 0,
  autoHop: false,
  // Autobhop-Server springen sofort (falls der Spieler Auto-Hop einschaltet).
  autoHopSpeedShare: 0,
  autoHopGroundTime: 0.2,
  autoHopLandShare: 0,
  autoHopLandAirTime: 0.25,
  duckTime: 0.2,
  // Arcade-Pass (Plan 007) aus: die Hauptschalter stehen auf 0/false. Die Nebenwerte (Rutsch-,
  // Lenk-Parameter) sind nur Startpunkt fürs Tuning-Panel und wirken ohne Hauptschalter nicht.
  landGraceTime: 0,
  slopeLandGain: 0,
  surfSeamFix: false,
  ledgeStep: 0,
  ledgeMemory: 0,
  slideMinSpeed: 0,
  slideExitSpeed: 160,
  slideFriction: 0.3,
  slideDecel: 80,
  slideBoost: 50,
  slideBoostCap: 380,
  slideBoostMinGround: 0.25,
  slideBoostCooldown: 2,
  slideSteerRate: 1.4,
  slideSlopeGravity: 1,
  slideEyeTime: 0.06,
  airControl: 0,
  airControlHigh: 0.8,
  airControlFadeFrom: 350,
  airControlFadeTo: 700,
  airControlSurfGrace: 0.5,
  hull: SOURCE_HULL,
};

/**
 * Das Spiel-Default. Startwerte — getunt per Simulation (tools/sim.ts) und
 * dokumentiert in .docs/research/movement-tuning.md.
 */
export const VELOCITY_DEFAULT: MovementConfig = {
  ...CS2_CLASSIC,
  tickRate: 128,
  sprintSpeed: 320,
  // 0 → 250 in 0.2 s statt 0.55 s (CS): Parcours braucht Antritt. Bleibt > friction → Boden-Max = runSpeed.
  accelerate: 8,
  airAccelerate: 40,
  // Kalibriert auf CS2-Parität: gleiche Hand (2–3° Zielfehler) → gleicher Speed wie CS2 mit 64 Tick,
  // aber mit 128-Tick-Präzision. Perfekter Bot Hop 5/10/20 ≈ 584/787/1084 u/s. Siehe movement-tuning.md.
  airSpeedCap: 24,
  // Tempoabhängig: 40 bis 350 u/s, linear auf 24 bei 700 — erste Strafes zahlen sich sofort aus
  // (Plan 007 A5: 4°-Hand bis 500 u/s 4.0 → 1.8 s), Decke +≤8 % gegenüber Cap 24, über 700 u/s
  // CS2-Parität wie oben. movement-tuning.md "Tempoabhängiger Cap" und "Arcade-Pass".
  airSpeedCapLow: 40,
  airSpeedCapFadeFrom: 350,
  airSpeedCapFadeTo: 700,
  // W zählt in der Luft nicht, solange A/D gedrückt ist (Schalter im Menü). movement-tuning.md.
  strafeAssist: true,
  coyoteTime: 0.1,
  jumpBufferTime: 0.12,
  autoHop: true,
  // Smart-Auto-Hop: gehaltene Taste springt erst mit Anlauf (kein 24-u/s-Mondhüpfen). 0.97 statt 0.95:
  // garantiert Hop-Tempo ≥ 242/310 in jeder Phase (0.95 → 238–244). movement-tuning.md.
  autoHopSpeedShare: 0.97,
  autoHopGroundTime: 0.2,
  // Strafe-Landung (A/D) aus der Luft: 0.75 × Wunschtempo (240 mit Sprint) reicht für den Sofort-Hop.
  // Kriechen (24–32 u/s) und Anprall (0) bleiben weit darunter. movement-tuning.md.
  autoHopLandShare: 0.75,
  autoHopLandAirTime: 0.25,
  duckTime: 0.15,
  // Arcade-Pass (Plan 007, Werte aus den v2-Entwürfen; Abnahme-Zahlen: npm run sim -- --section arcade,
  // movement-tuning.md "Arcade-Pass").
  // 8 Ticks: Tipp-Hand ±20 ms H20 742 → 1166 u/s; > 12 Ticks wäre "Eis" auf Stopp-Landungen.
  landGraceTime: 0.0625,
  slopeLandGain: 1,
  surfSeamFix: true,
  // Crouch-Kanten brauchen damit ≥ 57 + 1.5 (Auto-Hop-Landehöhe) + 5 + 2 Reserve ≈ 66 u (Level-Regel).
  ledgeStep: 5,
  ledgeMemory: 0.2,
  slideMinSpeed: 280,
  // Luftlenkung an; die Einstellung "Luftlenkung mit W" (Default an) kann sie abschalten.
  airControl: 1.6,
};

export const MOVEMENT_PRESETS = {
  velocity: VELOCITY_DEFAULT,
  cs2: CS2_CLASSIC,
} as const satisfies Record<string, MovementConfig>;

export type MovementPresetId = keyof typeof MOVEMENT_PRESETS;

/** Nur die numerischen Schlüssel — für Tuning-Panel und Sim-Sweeps. */
export type NumericMovementKey = {
  [K in keyof MovementConfig]: MovementConfig[K] extends number ? K : never;
}[keyof MovementConfig];

/**
 * Luft-Cap beim Horizontal-Tempo `speed` (tempoabhängiger Cap, siehe
 * `airSpeedCapLow`). Einzige Stelle der Formel — PlayerMovement, Bots und HUD
 * rufen alle diese Funktion.
 */
export function airSpeedCapAt(
  cfg: Pick<MovementConfig, 'airSpeedCap' | 'airSpeedCapLow' | 'airSpeedCapFadeFrom' | 'airSpeedCapFadeTo'>,
  speed: number,
): number {
  const low = cfg.airSpeedCapLow;
  if (!(low > 0)) return cfg.airSpeedCap;
  const from = cfg.airSpeedCapFadeFrom;
  const to = cfg.airSpeedCapFadeTo;
  if (speed <= from) return low;
  if (speed >= to || to <= from) return cfg.airSpeedCap;
  return low + ((cfg.airSpeedCap - low) * (speed - from)) / (to - from);
}

/** Neue Config mit geänderten Werten (die Configs selbst bleiben unveränderlich). */
export function withMovement(base: MovementConfig, patch: Partial<MovementConfig>): MovementConfig {
  return { ...base, ...patch, hull: { ...base.hull, ...(patch.hull ?? {}) } };
}
