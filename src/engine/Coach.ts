import type { PlayerInput, PlayerSnapshot } from '../player/types';
import type { RouteNode } from '../world/level/LevelFormat';
import type { GameEvent } from './events';

/**
 * Hinweise im Moment (Plan 003, U1): erkennt die drei Stellen, an denen Neulinge
 * ohne Erklärung scheitern, und meldet einen Hinweis — jeder nur, bis die
 * Handlung einmal gelingt (pro Sitzung, also pro Coach-Instanz).
 *
 * - crouch: zwei Stirnwand-Bonks nahe einer Crouch-Kante (Route-Knoten mit
 *   `crouch`) ohne Ducken → "in der Luft ducken". Gelernt: Landung oben.
 * - surf: auf der Rampe W gehalten ohne A/D (> 0.3 s) oder Tod nach Surf-Kontakt
 *   → "W los, A/D in die Rampe". Gelernt: Checkpoint/Ziel nach Surf-Kontakt.
 * - strafe: drei Sprünge in Folge mit A/D, aber Sync < 0.3 und ohne Gewinn in der
 *   Luft → "Maus und A/D in dieselbe Richtung". Gelernt: ein Sprung mit Sync ≥ 0.6 und Gewinn.
 *
 * Der Strafe-Teil misst jeden Luftabschnitt selbst (Tempo Absprung → Landung,
 * Anteil der A/D-Ticks mit Gewinn) statt der 'jump'-Events: wer gegen die Maus
 * strafet, verliert Tempo, landet unter dem Smart-Auto-Hop-Tempo und die Kette
 * reißt — die Events tragen dann chain 1 und sync 0, der Fehler bliebe unsichtbar.
 *
 * DOM-frei und allokationsfrei im Tick (läuft in Game.onTick nach movement.tick
 * und nach den Events dieses Ticks).
 */

export type HintId = 'crouch' | 'surf' | 'strafe';

export const HINT_IDS: readonly HintId[] = ['crouch', 'surf', 'strafe'];

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
/** Nur echte Sprünge bewerten (kein Stufen-Hüpfer), s Luftzeit. */
const STRAFE_MIN_AIR = 0.35;
/** Anteil der Luft-Ticks mit A/D, ab dem ein Sprung als Strafe-Versuch gilt. */
const STRAFE_SIDE_SHARE = 0.25;
const STRAFE_BAD_SYNC = 0.3;
/**
 * "Kein Gewinn" statt nur "Verlust" (Plan: gain < 0): Die Zickzack-Hand mit
 * Taste gegen die Maus (60 °/s) verliert 37–109 u/s pro Sprung, wer A/D ohne
 * Mausbewegung wechselt, bekommt aber exakt +0.0 — auch das ist der Fehler
 * (gemessen mit PlayerMovement, tests/coach.test.ts).
 */
const STRAFE_BAD_GAIN = 3;
const STRAFE_BAD_HOPS = 3;
const STRAFE_GOOD_SYNC = 0.6;
const STRAFE_GOOD_GAIN = 8;
/** Gewinn-Tick: Tempo nach dem Tick höher als davor (Rauschen darunter zählt nicht). */
const GAIN_EPS = 1e-3;
/** Derselbe Hinweis frühestens wieder nach … s (die Anzeige steht ~5 s). */
const COOLDOWN = 6;

export class Coach {
  /** Einstellung showHints. Aus = nichts erkennen, nichts melden. */
  enabled = true;
  /** Wird bei jedem Hinweis gerufen (Game zeigt den Text im HUD). */
  onHint: (id: HintId) => void = () => undefined;

  private time = 0;
  private readonly learnedMap: Record<HintId, boolean> = { crouch: false, surf: false, strafe: false };
  private readonly shownMap: Record<HintId, number> = { crouch: 0, surf: 0, strafe: 0 };
  private readonly lastShown: Record<HintId, number> = { crouch: -Infinity, surf: -Infinity, strafe: -Infinity };

  // Crouch-Kanten: je 6 Werte (Knoten A xyz, Knoten B xyz), B = Oberkante.
  private segs = new Float64Array(0);
  private segCount = 0;

  // Laufender Luftabschnitt
  private inAir = false;
  private airStartY = 0;
  private airStartSpeed = 0;
  private airEndSpeed = 0;
  private airNear = -1;
  private airDucked = false;
  private airStopped = false;
  private airSurfed = false;
  private airTicks = 0;
  private airSideTicks = 0;
  private airGainTicks = 0;
  private lastBonk = -Infinity;

  // Surf
  private surfContact = false;
  private surfWHold = 0;
  private surfShownThisContact = false;

  // Strafe
  private badHops = 0;

  /** Wie oft jeder Hinweis gezeigt wurde (Tests, Debug-Handle). */
  get shown(): Readonly<Record<HintId, number>> {
    return this.shownMap;
  }

  isLearned(id: HintId): boolean {
    return this.learnedMap[id];
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
        if ((e.reason === 'fall' || e.reason === 'kill') && this.surfContact) this.show('surf', true);
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
    if (!this.enabled) return;
    const air = !cur.onGround;
    if (air && !this.inAir) {
      this.inAir = true;
      this.airStartY = prev.pos.y;
      this.airStartSpeed = cur.speed;
      this.airNear = -1;
      this.airDucked = false;
      this.airStopped = false;
      this.airSurfed = false;
      this.airTicks = 0;
      this.airSideTicks = 0;
      this.airGainTicks = 0;
    }
    if (air) {
      this.airTicks++;
      this.airEndSpeed = cur.speed;
      if (cur.surfing) this.airSurfed = true;
      if (cmd.side !== 0) {
        this.airSideTicks++;
        if (cur.speed > prev.speed + GAIN_EPS) this.airGainTicks++;
      }
      if (cur.ducked) this.airDucked = true;
      if (this.segCount > 0) {
        const near = this.nearCrouch(cur.pos.x, cur.pos.y, cur.pos.z);
        if (near >= 0) this.airNear = near;
      }
      if (cur.speed < STOP_SPEED && (prev.speed >= BONK_FROM_SPEED || cmd.forward > 0)) this.airStopped = true;
    } else if (this.inAir) {
      this.inAir = false;
      if (this.airNear >= 0) this.crouchLanding(cur.pos.y);
      this.strafeLanding(dt);
    }

    if (cur.surfing) {
      this.surfContact = true;
      if (cmd.forward > 0 && cmd.side === 0) {
        this.surfWHold += dt;
        if (this.surfWHold > SURF_W_HOLD && !this.surfShownThisContact) {
          this.surfShownThisContact = true;
          this.show('surf', false);
        }
      } else this.surfWHold = 0;
    } else {
      this.surfWHold = 0;
    }
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
      this.show('crouch', false);
    } else {
      this.lastBonk = this.time;
    }
  }

  /** Einen beendeten Luftabschnitt als Strafe-Versuch bewerten. */
  private strafeLanding(dt: number): void {
    if (this.airSurfed || this.airTicks * dt < STRAFE_MIN_AIR) return;
    if (this.airSideTicks < this.airTicks * STRAFE_SIDE_SHARE) {
      // Kein Strafe-Versuch (nur W/nichts): zählt weder für noch gegen.
      this.badHops = 0;
      return;
    }
    const sync = this.airGainTicks / this.airSideTicks;
    const gain = this.airEndSpeed - this.airStartSpeed;
    if (sync >= STRAFE_GOOD_SYNC && gain >= STRAFE_GOOD_GAIN) {
      this.learn('strafe');
      this.badHops = 0;
    } else if (sync < STRAFE_BAD_SYNC && gain < STRAFE_BAD_GAIN) {
      if (++this.badHops >= STRAFE_BAD_HOPS) {
        this.badHops = 0;
        this.show('strafe', false);
      }
    } else {
      this.badHops = 0;
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

  private show(id: HintId, force: boolean): void {
    if (!this.enabled || this.learnedMap[id]) return;
    if (!force && this.time - this.lastShown[id] < COOLDOWN) return;
    this.lastShown[id] = this.time;
    this.shownMap[id]++;
    this.onHint(id);
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
    this.badHops = 0;
  }
}
