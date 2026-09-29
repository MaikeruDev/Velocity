import type { MovementConfig } from '../player/MovementConfig';
import type { PlayerInput, PlayerSnapshot } from '../player/types';
import type { TurnBand, Verdict } from './trainingTypes';

/**
 * StrafeJudge (Plan 007, TC1): bewertet jeden Luftabschnitt (Absprung → Landung, ohne Surf-Kontakt)
 * und sagt, WARUM ein Hop nichts brachte. DOM-frei, Tick ohne Allokation (Bericht wird wiederverwendet).
 *
 * Gemessen wird pro Abschnitt: Gewinn (Tempo im letzten Luft-Tick − Absprungtempo; die Landung selbst
 * zählt nicht — die Hang-Landung schenkt auf Gefällen Tempo ohne Technik), A/D-Anteil der Luftzeit, W-Ticks
 * ohne A/D, W zusätzlich zu A/D, erste A/D-Zeit und die NETTO-Drehung der Maus mit dem Vorzeichen der
 * Taste (Σ −side·dYaw: > 0 = Maus in Tastenrichtung). Netto statt Σ|dYaw|: Zitter der Hand ist keine
 * Drehrate (v2-Entwurf judgehigh.ts).
 *
 * Wand-Kontakt in der Luft (Bande, Insel, Kante): in freier Luft ist die horizontale Verschiebung eines Ticks
 * exakt vel_h·dt, und mit A/D ändert sich v_h nur entlang der wishdir (Luft-Accelerate; gemessen 270 000
 * Luft-Ticks, Fehler < 1e-12). Ein Clip bricht das — frontal (Verschiebung kürzer) wie im Schleifen an der
 * Bande (Anteil in die Wand weggeclippt, der Rest der wishdir bremst: 312 → 0 u/s in 0.5 s ohne einen
 * einzigen Positionsfehler). Ein Abschnitt mit Kontakt verliert Tempo, das mit der Technik nichts zu tun hat
 * (T4-Anfänger: 44 von 44 'weak' mit Verlust) — er wird nur gemeldet, wenn er trotzdem 'good' ist.
 *
 * ALLE Schwellen stehen hier. Die Tempo-Tabellen kommen aus `npx tsx tools/levels/training/turnwindow.ts`
 * (echte PlayerMovement, VELOCITY_DEFAULT: Cap 40, Lande-Gnade, Luftlenkung) — nach jedem Movement-
 * Tuning neu laufen lassen; das Skript meldet Abweichungen.
 */

/** Referenz-Drehrate (°/s) für "guter Hop": die langsamste Rate, die noch als Technik zählt. */
export const REF_RATE = 20;
/** Guter Hop = Gewinn ≥ GOOD_SHARE × Gewinn der Referenz-Rate (ohne Verzug) beim Absprungtempo. */
export const GOOD_SHARE = 0.8;

/**
 * Mindestgewinn (u/s) eines guten Hops je Absprungtempo — 0.8 × Gewinn bei 20 °/s (turnwindow.ts,
 * finale Physik 28.09.). Unter 350 u/s wirkt Cap 40, darüber sinkt er bis 700 auf 24: deshalb fällt
 * die Schwelle mit dem Tempo. Fehlerbilder liegen weit darunter (bei 320: gegen die Maus +2.5,
 * ohne Maus +2.5, nur W 0).
 */
export const GOOD_GAIN_TABLE: readonly (readonly [number, number])[] = [
  [200, 11.1],
  [250, 10.5],
  [320, 10],
  [400, 8.8],
  [450, 8.1],
  [600, 6.1],
  [800, 4.9],
  [1000, 4.8],
  [1400, 4.6],
];

/**
 * "Zu schnell": obere Grenze des 50-%-Fensters (Rate, ab der Überdrehen den halben Bestgewinn
 * kostet) je Absprungtempo, °/s (turnwindow.ts). 200 u/s: Rand des Messrasters (1800).
 */
export const FAST_TABLE: readonly (readonly [number, number])[] = [
  [200, 1800],
  [250, 1640],
  [320, 1340],
  [400, 1050],
  [450, 900],
  [600, 570],
  [800, 360],
  [1000, 290],
  [1400, 210],
];

/** Kürzere Luftabschnitte (Stufen, Kanten, Stolpern) werden nicht bewertet (s). */
export const MIN_AIR = 0.35;
/**
 * Wand-Kontakt: horizontale Verschiebung eines Luft-Ticks weicht um mehr als so viele u von vel_h·dt ab.
 * Freie Luft liegt unter 1e-6 u (T3/T4/T5-Anfänger, 195 000 Luft-Ticks); Kontakte ab ~1e-3 u.
 */
export const CONTACT_EPS = 0.01;
/** Wand-Kontakt: Änderung von v_h (u/s) quer zur wishdir oder gegen sie (freie Luft: < 1e-12). */
export const CONTACT_DV = 0.01;
/** Absprung unter diesem Tempo nicht bewerten: aus dem Stand schenkt der Luft-Cap Gewinn ohne Technik. */
export const MIN_TAKEOFF = 200;
/** Unter diesem A/D-Anteil der Luftzeit gilt "keine Seitentaste". */
export const SIDE_MIN_SHARE = 0.25;
/** goodHops: Mindest-A/D-Anteil, damit ein guter Hop für die Aufgabe zählt (TaskDef.minSideShare). */
export const COUNT_SIDE_SHARE = 0.5;
/** Ohne A/D: W in mehr als diesem Anteil der Luftzeit → 'wOnly' statt 'noSide'. */
export const W_ONLY_SHARE = 0.5;
/**
 * Netto-Drehrate (°/s) während A/D unter diesem Wert: "Maus steht". 6 statt 12: dazwischen liegt das Fehlerbild
 * "zu langsam" (10 °/s: +5 u/s bei 320, Schwelle 10) — bei 12 blieb ihm nur das Band 12–16 °/s, der Rest war 'good'.
 */
export const NO_MOUSE_RATE = 6;
/**
 * Überdreht: so viel Tempo (u/s) ging in Ticks mit A/D verloren — der Blick lief der Flugrichtung voraus, die
 * wishdir zeigte nach hinten. Gute Hops der Hände haben ~0 (StrafeBots bis 40, netto trotzdem Gewinn), die
 * übrigen 'weak' der Hände alle ≥ 8 (geübter Anfänger 65–450 bei 600+ u/s): das ist "zu schnell", nicht "knapp".
 */
export const OVERTURN_LOSS = 2;
/** Netto-Drehrate (°/s) unter diesem Wert: zu zaghaft gezogen. */
export const SLOW_RATE = 35;
/** Erste A/D-Taste später als so viele s nach dem Absprung: 'late' (−6 u/s je 0.1 s bei 120 °/s). */
export const LATE_SIDE = 0.3;
/** Strafe-Assist aus und W in mindestens diesem Anteil der A/D-Ticks gehalten: 'wHeld'. */
export const W_HELD_SHARE = 0.3;
/**
 * Zielband am Drehbalken: untere Grenze (°/s) und Anteil der Zu-schnell-Grenze als obere, gekappt.
 * Unten 60 statt 40: bei 320 u/s bringt 40 °/s +20 u/s je Hop, 60 °/s +32 — das Band zeigt, wohin es geht; der
 * Judge nennt langsamere Hops weiter 'good', solange sie die Schwelle schaffen. Oben 540 statt 360: mit 360 zog,
 * wer bei 320–450 u/s schneller und BESSER zog (500 °/s: +150 u/s je Hop), den Balken in Gold ("daneben"), während
 * der Judge "GUT" sagte. 540 °/s holt bei 320 u/s 98 % des besten Hops (turnwindow.ts: +155 von +159 bei 650 °/s),
 * ab 400 u/s liegt das Optimum im Band (530 °/s); darüber zieht 0.8 × Zu-schnell-Grenze das Band herunter
 * (600 u/s: 456, 800: 288). Der Balken selbst endet bei 360 °/s (hudLogic.turnBarLength): voll + grün = gut.
 */
export const BAND_LO = 60;
export const BAND_HI_SHARE = 0.8;
export const BAND_HI_MAX = 540;
/**
 * Zielband der Prestrafe (Boden, W + A + Maus) in °/s: gemessen (flach, finale Physik, 20 Seeds, prestrafeRate)
 * tragen 160 und 220 °/s 20/20 über 350 u/s, 120 °/s 6/20, 45–90 °/s 0/20; ab ~360 °/s überdreht.
 */
export const PRESTRAFE_BAND_LO = 150;
export const PRESTRAFE_BAND_HI = 300;

/** Double-Startwert für Gleitkomma-Felder im Tick-Pfad (wird vor jedem Lesen überschrieben). */
const D0 = 0.5;

function lerpTable(t: readonly (readonly [number, number])[], x: number): number {
  if (x <= t[0][0]) return t[0][1];
  for (let i = 1; i < t.length; i++) {
    if (x <= t[i][0]) {
      const f = (x - t[i - 1][0]) / (t[i][0] - t[i - 1][0]);
      return t[i - 1][1] + f * (t[i][1] - t[i - 1][1]);
    }
  }
  return t[t.length - 1][1];
}

/** Mindestgewinn (u/s) eines guten Hops beim Absprungtempo `speed`. */
export function goodGainAt(speed: number): number {
  return lerpTable(GOOD_GAIN_TABLE, speed);
}

/** Drehrate (°/s), ab der der Hop beim Absprungtempo `speed` überdreht ist. */
export function tooFastRate(speed: number): number {
  return lerpTable(FAST_TABLE, speed);
}

/** Zielband der Drehrate (°/s) beim Tempo `speed`: BAND_LO … min(BAND_HI_MAX, 0.8 × Zu-schnell-Grenze). */
export function turnBandAt(speed: number, out: { lo: number; hi: number }): TurnBand {
  out.lo = BAND_LO;
  out.hi = Math.max(BAND_LO + 20, Math.min(BAND_HI_MAX, BAND_HI_SHARE * tooFastRate(speed)));
  return out;
}

/** Urteil über einen Luftabschnitt. Das Objekt `StrafeJudge.last` wird wiederverwendet. */
export interface HopReport {
  verdict: Verdict;
  /** Tempo im letzten Luft-Tick − Absprungtempo (u/s): der Gewinn des Strafes, ohne Landung. */
  gain: number;
  takeoffSpeed: number;
  landSpeed: number;
  /** Luftzeit (s). */
  air: number;
  /** Anteil der Luft-Ticks mit A/D. */
  sideShare: number;
  /** Netto-Drehrate der Maus während A/D in Tastenrichtung (°/s, Betrag). */
  turnRate: number;
  /** Überwiegende Taste: −1 = A (Linkskurve), +1 = D (Rechtskurve), 0 = keine. */
  side: -1 | 0 | 1;
  /** Zeit bis zur ersten A/D-Taste (s), −1 = nie. */
  firstSide: number;
  /** Wand-Kontakt in der Luft (dann nur 'good' gemeldet, sonst kein Urteil). */
  wall: boolean;
  /** Summe der Tempo-Einbrüche (u/s) in Ticks mit A/D: der Blick lief der Flugrichtung voraus. */
  loss: number;
}

const TWO_PI = 2 * Math.PI;

/**
 * Pro Physik-Tick nach PlayerMovement.tick mit Zustand davor/danach und der Eingabe des Ticks.
 * `tick` gibt true zurück, wenn in diesem Tick ein bewerteter Abschnitt endete (Urteil in `last`).
 */
export class StrafeJudge {
  // Gleitkomma-Felder mit Double-Startwert (D0): V8 legt sie als Double an und schreibt in place — mit Smi-Start
  // (0) boxte jedes Urteil seine Zahlen neu (fallen.md #59, Inbox cosmetics "Smi-Startwerte").
  readonly last: HopReport = { verdict: 'good', gain: D0, takeoffSpeed: D0, landSpeed: D0, air: D0, sideShare: D0, turnRate: D0, side: 0, firstSide: D0, wall: false, loss: D0 };
  private assist: boolean;
  private inAir = false;
  private surfed = false;
  private wall = false;
  private ticks = 0;
  private sideTicks = 0;
  private wTicks = 0;
  private wWithSide = 0;
  /** Summe der Tempo-Einbrüche in Ticks mit A/D (Blick der Flugrichtung voraus → wishdir zeigt nach hinten). */
  private loss = D0;
  private turnSum = D0;
  private sideSum = 0;
  private firstSide = D0;
  private startSpeed = D0;
  private prevYaw = D0;
  /** Tick-Länge des laufenden Aufrufs (für contact(); Kommazahlen als Argument nicht geinlineter Aufrufe boxen, #107). */
  private dt = D0;

  constructor(cfg: Pick<MovementConfig, 'strafeAssist'>) {
    this.assist = cfg.strafeAssist;
  }

  /** Strafe-Assist folgt der Spieler-Einstellung (nur 'wHeld' hängt daran). */
  setConfig(cfg: Pick<MovementConfig, 'strafeAssist'>): void {
    this.assist = cfg.strafeAssist;
  }

  /** Laufenden Abschnitt verwerfen (Respawn, Teleport, Vorführung). */
  reset(): void {
    this.inAir = false;
  }

  tick(dt: number, prev: PlayerSnapshot, cur: PlayerSnapshot, cmd: PlayerInput): boolean {
    this.dt = dt;
    const air = !cur.onGround;
    if (air && !this.inAir) {
      this.inAir = true;
      this.surfed = false;
      this.wall = false;
      this.ticks = 0;
      this.sideTicks = 0;
      this.wTicks = 0;
      this.wWithSide = 0;
      this.loss = 0;
      this.turnSum = 0;
      this.sideSum = 0;
      this.firstSide = -1;
      this.startSpeed = prev.speed;
      this.prevYaw = cmd.yaw;
    }
    if (air) {
      this.ticks++;
      if (cur.surfing) this.surfed = true;
      // Abschnitte mit Surf-Kontakt bekommen nie ein Urteil: nichts weiter messen. Die Wand-Probe allozierte an der
      // Flanke je Tick (T7 allein: 4.6 B/Tick in contact()), obwohl ihr Ergebnis verworfen wird.
      if (this.surfed) return false;
      // Schon im Absprung-Tick (T4: Bande im Sprung-Tick, 400 → 296 u/s, sonst 'weak').
      if (!this.wall && this.contact(prev, cur, cmd, this.ticks === 1)) this.wall = true;
      // Gewickelt: InputState verschiebt den Blick nach 32 Netto-Umdrehungen um ein Vielfaches von 2π.
      let dYaw = cmd.yaw - this.prevYaw;
      dYaw -= Math.round(dYaw / TWO_PI) * TWO_PI;
      this.prevYaw = cmd.yaw;
      if (cmd.side !== 0) {
        this.sideTicks++;
        if (this.firstSide < 0) this.firstSide = this.ticks * dt;
        // Linksdrehung (yaw steigt) passt zu A (side −1): Beitrag −side·dYaw > 0.
        this.turnSum -= cmd.side * dYaw;
        this.sideSum += cmd.side;
        if (prev.speed > cur.speed) this.loss += prev.speed - cur.speed;
        if (cmd.forward > 0) this.wWithSide++;
      } else if (cmd.forward > 0) this.wTicks++;
      return false;
    }
    if (!this.inAir) return false;
    this.inAir = false;
    if (this.surfed || this.ticks * dt < MIN_AIR || this.startSpeed < MIN_TAKEOFF) return false;
    // Gewinn bis zum letzten Luft-Tick: die Landung selbst gehört nicht zum Strafe. Auf einem
    // Gefälle gibt die Hang-Landung (A4) Tempo ohne Technik — A/D ohne Maus am T3-Rand: 5/20
    // "bestanden", 10 % der Urteile 'good'. Auf flachem Boden ändert die Landung |v_h| nicht.
    this.judge(dt, prev.speed, cur.speed);
    // Wand gestreift und kein Gewinn: die Ursache ist die Wand, nicht die Technik → kein Urteil.
    return !this.wall || this.last.verdict === 'good';
  }

  /**
   * Hat in diesem Luft-Tick eine Wand geclippt? (Nur Physik-Invarianten, keine Welt nötig.) `first` = erster
   * Luft-Tick: die Verschiebung gilt auch für einen Boden-Move (von der Kante gelaufen), v_h nicht (Reibung).
   */
  private contact(prev: PlayerSnapshot, cur: PlayerSnapshot, cmd: PlayerInput, first: boolean): boolean {
    const dt = this.dt;
    const ex = cur.pos.x - prev.pos.x - cur.vel.x * dt;
    const ez = cur.pos.z - prev.pos.z - cur.vel.z * dt;
    if (ex * ex + ez * ez > CONTACT_EPS * CONTACT_EPS) return true;
    if (first) return false;
    const dvx = cur.vel.x - prev.vel.x;
    const dvz = cur.vel.z - prev.vel.z;
    if (cmd.side === 0) {
      if (cmd.forward === 0) return dvx * dvx + dvz * dvz > CONTACT_DV * CONTACT_DV;
      if (cmd.forward < 0) return false;
      // Nur W: die Luftlenkung dreht v_h (Betrag bleibt), der Schub geht entlang des Blicks. Zeigt der Blick
      // nach vorn (≤ 90° zur Flugrichtung), wird |v_h| nie kleiner — schrumpft es, hat eine Wand geclippt. Das
      // fängt das Schleifen an der Bande, bei dem die Verschiebung schon an der Wand beginnt (kein Positionsfehler).
      // Math.sqrt statt Math.hypot: hypot (Rest-Parameter) allozierte im Tick-Pfad (Heap-Sampling 57 B/Tick).
      const px = prev.vel.x;
      const pz = prev.vel.z;
      if (-px * Math.sin(cmd.yaw) - pz * Math.cos(cmd.yaw) <= 0) return false;
      const v0 = Math.sqrt(px * px + pz * pz);
      const cx = cur.vel.x;
      const cz = cur.vel.z;
      return Math.sqrt(cx * cx + cz * cz) < v0 - CONTACT_DV;
    }
    // wishdir wie PlayerMovement.computeWish: forward = (−sin, −cos), right = (cos, −sin); Assist: W zählt nicht.
    const fwd = this.assist ? 0 : cmd.forward;
    const sy = Math.sin(cmd.yaw);
    const cy = Math.cos(cmd.yaw);
    const wx = -sy * fwd + cy * cmd.side;
    const wz = -cy * fwd - sy * cmd.side;
    const len2 = wx * wx + wz * wz;
    if (len2 < 1e-12) return false;
    const len = Math.sqrt(len2);
    const cross = (dvx * wz - dvz * wx) / len;
    const along = (dvx * wx + dvz * wz) / len;
    return cross > CONTACT_DV || cross < -CONTACT_DV || along < -CONTACT_DV;
  }

  private judge(dt: number, airEndSpeed: number, landSpeed: number): void {
    const r = this.last;
    const n = this.ticks;
    r.gain = airEndSpeed - this.startSpeed;
    r.takeoffSpeed = this.startSpeed;
    r.landSpeed = landSpeed;
    r.air = n * dt;
    r.sideShare = this.sideTicks / n;
    r.turnRate = this.sideTicks > 0 ? (Math.abs(this.turnSum) / (this.sideTicks * dt)) * (180 / Math.PI) : 0;
    r.side = this.sideSum < 0 ? -1 : this.sideSum > 0 ? 1 : 0;
    r.firstSide = this.firstSide;
    r.wall = this.wall;
    r.loss = this.loss;
    r.verdict = this.classify(r, n);
  }

  /**
   * Reihenfolge = Priorität: erst die Technik (A/D überhaupt, Maus mit der Taste), dann der Gewinn, dann Maus,
   * Tempo, Timing. Ohne A/D oder mit der Maus gegen die Taste gibt es auch mit Gewinn kein 'good': mit schneller
   * Maus streicht der Blick bzw. die Wunschrichtung zufällig durchs Gewinnfenster (320 u/s: nur W 360 °/s +66 u/s,
   * gegen 540 °/s +100). Vorher hieß derselbe W-Hop mal "W LOS", mal "GUT", und nur W + schnelle Maus bestand
   * T4/T5 (Review rv-tc3) — die Lektion lehrt A/D + Maus.
   */
  private classify(r: HopReport, n: number): Verdict {
    const good = r.gain >= goodGainAt(r.takeoffSpeed);
    if (r.sideShare < SIDE_MIN_SHARE) {
      // A/D kam, aber erst spät und mit passender Maus: das ist der Fehler, nicht "keine Taste" (Zu-spät-Hand
      // 0.45–0.5 s: sonst 7 % 'wOnly'). Reicht der Gewinn trotzdem, ist der Hop gut (Nachsicht wie bisher).
      if (this.sideTicks > 0 && r.firstSide > LATE_SIDE && r.turnRate >= NO_MOUSE_RATE && this.turnSum > 0) return good ? 'good' : 'late';
      return this.wTicks > n * W_ONLY_SHARE ? 'wOnly' : 'noSide';
    }
    if (r.turnRate >= NO_MOUSE_RATE && this.turnSum < 0) return 'against';
    if (good) return 'good';
    if (r.turnRate < NO_MOUSE_RATE) return 'noMouse';
    if (!this.assist && this.wWithSide >= this.sideTicks * W_HELD_SHARE) return 'wHeld';
    if (r.turnRate > tooFastRate(r.takeoffSpeed) || r.loss >= OVERTURN_LOSS) return 'tooFast';
    if (r.firstSide > LATE_SIDE) return 'late';
    if (r.turnRate < SLOW_RATE) return 'tooSlow';
    return 'weak';
  }
}

/** Kurztext (neben dem Gain-Popup) und Coach-Text (2 Zeilen à ≤ 40 Zeichen) je Urteil. Nur HUD-Glyphen. */
export const VERDICT_TEXT: Readonly<Record<Verdict, { readonly short: string; readonly long: string }>> = {
  good: { short: 'GUT', long: '' },
  wOnly: { short: 'W LOS', long: 'IN DER LUFT W LOSLASSEN\nSTATTDESSEN A ODER D HALTEN' },
  noSide: { short: 'A/D!', long: 'IN DER LUFT A ODER D HALTEN\nUND DIE MAUS MITZIEHEN' },
  noMouse: { short: 'MAUS!', long: 'DIE MAUS MITZIEHEN\nA + MAUS LINKS, D + MAUS RECHTS' },
  against: { short: 'FALSCHE SEITE', long: 'TASTE UND MAUS IN DIESELBE RICHTUNG\nA = MAUS LINKS, D = MAUS RECHTS' },
  wHeld: { short: 'W LOS', long: 'STRAFE-ASSIST IST AUS:\nIN DER LUFT W LOSLASSEN' },
  tooFast: { short: 'RUHIGER', long: 'LANGSAMER ZIEHEN\nJE SCHNELLER DU BIST, DESTO SANFTER' },
  late: { short: 'FRÜHER', long: 'GLEICH NACH DEM ABSPRUNG DRÜCKEN\nNICHT ERST OBEN IM SPRUNG' },
  tooSlow: { short: 'WEITER', long: 'DIE MAUS WEITER ZIEHEN\nEINE VIERTELDREHUNG PRO SPRUNG' },
  weak: { short: 'KNAPP', long: 'FAST: FLÜSSIGER ZIEHEN\nTASTE BIS ZUR LANDUNG HALTEN' },
};
