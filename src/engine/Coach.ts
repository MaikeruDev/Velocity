import type { MovementConfig } from '../player/MovementConfig';
import type { PlayerInput, PlayerSnapshot } from '../player/types';
import type { RouteNode } from '../world/level/LevelFormat';
import type { GameEvent } from './events';
import { StrafeJudge, VERDICT_TEXT } from './strafeJudge';
import { VERDICTS } from './trainingTypes';
import type { Verdict } from './trainingTypes';

/**
 * Hinweise im Moment (Plan 003, U1; Strafe-Teil seit Plan 007 über den StrafeJudge): erkennt die
 * drei Stellen, an denen Neulinge ohne Erklärung scheitern, und meldet einen Hinweis — jeder nur,
 * bis die Handlung einmal gelingt (pro Sitzung, also pro Coach-Instanz).
 *
 * - crouch: zwei Stirnwand-Bonks nahe einer Crouch-Kante (Route-Knoten mit `crouch`) ohne Ducken
 *   → "in der Luft ducken". Gelernt: Landung oben.
 * - surf: auf der Rampe W gehalten ohne A/D (> 0.3 s) oder Tod nach Surf-Kontakt → "W los, A/D in
 *   die Rampe". Gelernt: Checkpoint/Ziel nach Surf-Kontakt.
 * - strafe: der StrafeJudge bewertet jeden Luftabschnitt; dreimal dasselbe Fehlurteil seit dem
 *   letzten guten Hop → Hinweis mit dem Text genau dieses Fehlers (Maus steht → "Maus mitziehen").
 *   Nur unter 600 u/s Absprungtempo: darüber sind Fehlurteile verrauschter Hände meist Zielfehler,
 *   keine Technik (Plan 007 §4.3: 30–50 % weak/tooFast bei 600–1000 u/s). 'wOnly'/'noSide' zählen
 *   hier nicht — das ist kein Strafe-Versuch, sondern W + Leertaste (mit Luftlenkung gewollt).
 *   Gelernt: ein guter Hop.
 * - noStrafe: bewusste Abweichung vom Entwurf (dort 'wOnly' als Fehler-Hinweis "W LOSLASSEN"): W + Leertaste
 *   ist mit Luftlenkung legitim, bringt aber kein Tempo. Wer NO_STRAFE_HOPS Hops ohne Strafe-Versuch unter
 *   NO_STRAFE_MAX_SPEED macht und noch nie gut gestrafet hat, bekommt EINMAL je Sitzung einen Anstoß mit
 *   Verweis aufs Training — sonst erfuhr ein W-Hüpfer in L1 nie, dass es Strafen gibt.
 *
 * In Lektionen (lesson = true) ist der Coach stumm: die Lektion lehrt selbst (Karte, Urteile, eigene
 * Tipps über TrainingSession.tip).
 *
 * DOM-frei und allokationsfrei im Tick (läuft in Game.onTick nach movement.tick und nach den Events
 * dieses Ticks).
 */

export type HintId = 'crouch' | 'surf' | 'strafe' | 'noStrafe';

export const HINT_IDS: readonly HintId[] = ['crouch', 'surf', 'strafe', 'noStrafe'];

/** Horizontaler Umkreis um die Crouch-Kante (Knoten → nächster Knoten), in dem Bonks zählen. */
const CROUCH_RADIUS = 400;
/**
 * Zwei Bonks in diesem Fenster → Hinweis. Plan: 3 s; wer nach einem Bonk zum
 * Anlauf zurückläuft, braucht 2.5–4 s bis zum zweiten — 5 s fangen auch den.
 */
const BONK_WINDOW = 5;
/** "An der Wand hängen": horizontal langsamer als das in einem Luft-Tick. */
const STOP_SPEED = 50;
/** Vorher mindestens so schnell (sonst zählt nur gehaltenes W gegen die Wand). */
const BONK_FROM_SPEED = 100;
/** Toleranz für "oben angekommen" (Füße relativ zur Kante), u. */
const LEDGE_TOL = 8;
const SURF_W_HOLD = 0.3;
/** Judge-Hinweise nur unter diesem Absprungtempo (u/s). */
export const JUDGE_MAX_SPEED = 600;
/** So oft dasselbe Fehlurteil seit dem letzten guten Hop → Hinweis. */
export const JUDGE_SAME = 3;
/** Derselbe Hinweis frühestens wieder nach … s (die Anzeige steht ~5 s). */
const COOLDOWN = 6;
/** Anstoß "Schneller?": so viele Hops ohne Strafe-Versuch ('wOnly'/'noSide') seit dem letzten guten Hop … */
export const NO_STRAFE_HOPS = 6;
/** … mit Absprung unter diesem Tempo (u/s) — darüber ist man schon schnell genug unterwegs. */
export const NO_STRAFE_MAX_SPEED = 400;
/** Text des Anstoßes (≤ 2 Zeilen à ≤ 40 Zeichen). */
const NO_STRAFE_TEXT = 'SCHNELLER? IN DER LUFT A ODER D HALTEN\nUND DIE MAUS MITZIEHEN · TRAINING T3';

/** Fehlurteile, die kein Strafe-Versuch sind (nur W / gar nichts) — zählen weder für noch gegen. */
function isStrafeAttempt(v: Verdict): boolean {
  return v !== 'wOnly' && v !== 'noSide';
}

/** Allgemeiner Strafe-Hinweis (ohne Urteil, z. B. 'good' oder unbekannt). */
const STRAFE_GENERIC = 'MAUS UND A/D IN DIESELBE RICHTUNG\nA + MAUS LINKS · D + MAUS RECHTS';

/**
 * Text des Hinweises fürs Coach-Band (≤ 2 Zeilen). Strafe: der Coach-Text des StrafeJudge zum
 * Fehlurteil (eine Quelle für Lektion und Coach). crouchKey = Kurzname der Duck-Taste.
 */
export function hintText(id: HintId, verdict: Verdict | null, crouchKey: string): string {
  if (id === 'crouch') return `IN DER LUFT DUCKEN [${crouchKey}]\nZIEHT DIE FÜSSE 18 u HÖHER`;
  if (id === 'surf') return 'W LOS · A/D IN DIE RAMPE · MAUS ENTLANG';
  if (id === 'noStrafe') return NO_STRAFE_TEXT;
  const long = verdict !== null ? VERDICT_TEXT[verdict].long : '';
  return long !== '' ? long : STRAFE_GENERIC;
}

export class Coach {
  /** Einstellung showHints. Aus = nichts erkennen, nichts melden. */
  enabled = true;
  /** Lektion läuft: keine eigenen Hinweise (Karte, Urteile und die Tipps der Lektion lehren). */
  lesson = false;
  /** Wird bei jedem Hinweis gerufen; verdict = Fehlurteil beim Strafe-Hinweis, sonst null. */
  onHint: (id: HintId, verdict: Verdict | null) => void = () => undefined;

  private time = 0;
  private readonly learnedMap: Record<HintId, boolean> = { crouch: false, surf: false, strafe: false, noStrafe: false };
  private readonly shownMap: Record<HintId, number> = { crouch: 0, surf: 0, strafe: 0, noStrafe: 0 };
  private readonly lastShown: Record<HintId, number> = { crouch: -Infinity, surf: -Infinity, strafe: -Infinity, noStrafe: -Infinity };
  private readonly judge: StrafeJudge;
  /** Fehlurteile je Art seit dem letzten guten Hop (Index = VERDICTS). */
  private readonly verdictCounts = new Int32Array(VERDICTS.length);
  /** Hops ohne Strafe-Versuch unter NO_STRAFE_MAX_SPEED seit dem letzten guten Hop (Sitzung, nicht je Lauf). */
  private noStrafeHops = 0;
  private lastVerdict: Verdict | null = null;

  // Crouch-Kanten: je 6 Werte (Knoten A xyz, Knoten B xyz), B = Oberkante.
  private segs = new Float64Array(0);
  private segCount = 0;

  // Laufender Luftabschnitt
  private inAir = false;
  private airStartY = 0;
  private airNear = -1;
  private airDucked = false;
  private airStopped = false;
  private lastBonk = -Infinity;

  // Surf
  private surfContact = false;
  private surfWHold = 0;
  private surfShownThisContact = false;

  /**
   * cfg ist Pflicht: der Judge urteilt 'wHeld' nur ohne Strafe-Assist. Ein Default (Assist an) ließ Game mit
   * gespeichertem "Assist aus" falsch diagnostizieren, bis sich die Config zum ersten Mal änderte.
   */
  constructor(cfg: Pick<MovementConfig, 'strafeAssist'>) {
    this.judge = new StrafeJudge(cfg);
  }

  /** Wie oft jeder Hinweis gezeigt wurde (Tests, Debug-Handle). */
  get shown(): Readonly<Record<HintId, number>> {
    return this.shownMap;
  }

  /** Letztes gemeldetes Fehlurteil des Strafe-Hinweises (Tests/Debug), null = keins. */
  get hintVerdict(): Verdict | null {
    return this.lastVerdict;
  }

  isLearned(id: HintId): boolean {
    return this.learnedMap[id];
  }

  /** Strafe-Assist folgt der Einstellung ('wHeld' hängt daran). */
  setConfig(cfg: Pick<MovementConfig, 'strafeAssist'>): void {
    this.judge.setConfig(cfg);
  }

  /** Route des neuen Levels: Crouch-Kanten merken, Zustand des Laufs verwerfen. */
  setLevel(route: readonly RouteNode[] | undefined): void {
    const list: number[] = [];
    if (route) {
      for (let i = 0; i + 1 < route.length; i++) {
        if (!route[i].crouch) continue;
        const a = route[i].pos;
        const b = route[i + 1].pos;
        list.push(a[0], a[1], a[2], b[0], b[1], b[2]);
      }
    }
    this.segs = Float64Array.from(list);
    this.segCount = list.length / 6;
    this.resetRun();
  }

  onEvent(e: GameEvent): void {
    switch (e.type) {
      case 'respawn':
        // Tod nach Surf-Kontakt: sofort erklären (Respawn-Schleife an der Rampe).
        if ((e.reason === 'fall' || e.reason === 'kill') && this.surfContact) this.show('surf', true, null);
        this.resetRun();
        break;
      case 'checkpoint':
      case 'finish':
        if (this.surfContact) this.learn('surf');
        break;
      case 'levelLoaded':
        this.resetRun();
        break;
      default:
        break;
    }
  }

  /** Nach jedem Physik-Tick: prev = Zustand davor, cur = danach, cmd = Eingabe dieses Ticks. */
  tick(dt: number, prev: PlayerSnapshot, cur: PlayerSnapshot, cmd: PlayerInput): void {
    this.time += dt;
    if (!this.enabled || this.lesson) return;
    if (this.judge.tick(dt, prev, cur, cmd)) {
      const r = this.judge.last;
      this.judged(r.verdict, r.takeoffSpeed);
    }
    const air = !cur.onGround;
    if (air && !this.inAir) {
      this.inAir = true;
      this.airStartY = prev.pos.y;
      this.airNear = -1;
      this.airDucked = false;
      this.airStopped = false;
    }
    if (air) {
      if (cur.ducked) this.airDucked = true;
      if (this.segCount > 0) {
        const near = this.nearCrouch(cur.pos.x, cur.pos.y, cur.pos.z);
        if (near >= 0) this.airNear = near;
      }
      if (cur.speed < STOP_SPEED && (prev.speed >= BONK_FROM_SPEED || cmd.forward > 0)) this.airStopped = true;
    } else if (this.inAir) {
      this.inAir = false;
      if (this.airNear >= 0) this.crouchLanding(cur.pos.y);
    }

    if (cur.surfing) {
      this.surfContact = true;
      if (cmd.forward > 0 && cmd.side === 0) {
        this.surfWHold += dt;
        if (this.surfWHold > SURF_W_HOLD && !this.surfShownThisContact) {
          this.surfShownThisContact = true;
          this.show('surf', false, null);
        }
      } else this.surfWHold = 0;
    } else {
      this.surfWHold = 0;
    }
  }

  /**
   * Ein Urteil des StrafeJudge (tick ruft das selbst; öffentlich für Tests). Guter Hop = gelernt;
   * dreimal dasselbe Fehlurteil unter 600 u/s → Hinweis mit dem Text dieses Fehlers. Kein Strafe-Versuch
   * (nur W / gar nichts) zählt nur für den einmaligen Anstoß 'noStrafe'.
   */
  judged(verdict: Verdict, takeoffSpeed: number): void {
    if (!this.enabled || this.lesson) return;
    const counts = this.verdictCounts;
    if (verdict === 'good') {
      this.learn('strafe');
      this.learn('noStrafe');
      counts.fill(0);
      this.noStrafeHops = 0;
      return;
    }
    if (!isStrafeAttempt(verdict)) {
      if (takeoffSpeed >= NO_STRAFE_MAX_SPEED || this.shownMap.noStrafe > 0) return;
      if (++this.noStrafeHops >= NO_STRAFE_HOPS) this.show('noStrafe', false, null);
      return;
    }
    if (takeoffSpeed >= JUDGE_MAX_SPEED) return;
    const i = VERDICTS.indexOf(verdict);
    if (++counts[i] < JUDGE_SAME) return;
    counts.fill(0);
    this.show('strafe', false, verdict);
  }

  // ---------------------------------------------------------------- intern

  private crouchLanding(y: number): void {
    const upper = this.segs[this.airNear * 6 + 4];
    if (y >= upper - LEDGE_TOL) {
      // Oben gelandet, von unten gekommen: Crouch-Jump sitzt.
      if (this.airStartY < upper - LEDGE_TOL) this.learn('crouch');
      return;
    }
    if (!this.airStopped || this.airDucked) return;
    if (this.time - this.lastBonk <= BONK_WINDOW) {
      this.lastBonk = -Infinity;
      this.show('crouch', false, null);
    } else {
      this.lastBonk = this.time;
    }
  }

  /** Index der Crouch-Kante in Reichweite (horizontaler Abstand zur Strecke A→B, passende Höhe), sonst −1. */
  private nearCrouch(x: number, y: number, z: number): number {
    const s = this.segs;
    for (let i = 0; i < this.segCount; i++) {
      const o = i * 6;
      const ax = s[o];
      const ay = s[o + 1];
      const az = s[o + 2];
      const bx = s[o + 3];
      const by = s[o + 4];
      const bz = s[o + 5];
      if (y < Math.min(ay, by) - 96 || y > Math.max(ay, by) + 160) continue;
      const dx = bx - ax;
      const dz = bz - az;
      const len2 = dx * dx + dz * dz;
      let t = len2 > 0 ? ((x - ax) * dx + (z - az) * dz) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = ax + dx * t - x;
      const pz = az + dz * t - z;
      if (px * px + pz * pz <= CROUCH_RADIUS * CROUCH_RADIUS) return i;
    }
    return -1;
  }

  private show(id: HintId, force: boolean, verdict: Verdict | null): void {
    if (!this.enabled || this.lesson || this.learnedMap[id]) return;
    if (!force && this.time - this.lastShown[id] < COOLDOWN) return;
    this.lastShown[id] = this.time;
    this.shownMap[id]++;
    if (verdict !== null) this.lastVerdict = verdict;
    this.onHint(id, verdict);
  }

  private learn(id: HintId): void {
    this.learnedMap[id] = true;
  }

  private resetRun(): void {
    this.inAir = false;
    this.airNear = -1;
    this.airStopped = false;
    this.airDucked = false;
    this.lastBonk = -Infinity;
    this.surfContact = false;
    this.surfWHold = 0;
    this.surfShownThisContact = false;
    this.judge.reset();
    this.verdictCounts.fill(0);
  }
}

