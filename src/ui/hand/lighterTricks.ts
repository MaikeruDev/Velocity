import type { GameEvent } from '../../engine/events';
import { VM_PARAM } from '../../render/types';
import { arc, backOut, bell, clamp, fin, smooth } from './anim';
import { CAN_HOLD_POS, CAN_HOLD_ROT } from './canTricks';
import { POSE } from './poses';
import { PropTricks } from './propTricks';
import type { PropFrameInput, PropOut } from './propTricks';

/**
 * Sturmfeuerzeug (Plan 007, KI2): der Fahrtwind pustet die Flamme aus. Gegriffen wie die Dose
 * (Achse quer, Deckel zum Daumen), entlang der Achse zum Daumen geschoben — so ragt es über den
 * Daumen statt in der Faust zu verschwinden.
 *
 * Flamme (läuft unabhängig von den Tricks, framerate-unabhängig über Alter statt Summen):
 * - Windneigung = clamp(Tempo/900)·(1 + 0.3·surfSide), mit dem Tempo kürzer,
 * - ≥ 950 u/s für 0.4 s → ausgeblasen (grauer Rauch),
 * - im nächsten ruhigen Moment (< 300 u/s am Boden) zündet sie wieder: das Rad dreht nach 0.65 s,
 *   die Flamme steht nach 0.8 s,
 * - Deckel zu löscht sie.
 * Tricks: Stand flickOpen → strike, später twirl / snapClose; Lauf lidFlick (auf/zu); Flow twirl /
 * lidFlick; Overdrive/guter Hop tossOpen (Deckel öffnet in der Luft, Flamme beim Fang, sofern nicht
 * zu schnell); Surf ≥ 500 = Zustand surfFlame (Deckel auf, Flamme weht seitlich); Checkpoint strike / twirl
 * mit Aufflackern; Ziel finale (auf, Aufflackern, zu).
 */

export const LIGHTER_TRICKS = ['none', 'flickOpen', 'strike', 'snapClose', 'lidFlick', 'twirl', 'tossOpen', 'finale', 'surfFlame'] as const;
export type LighterTrick = Exclude<(typeof LIGHTER_TRICKS)[number], 'none'>;
const LIGHTER_NAMES: readonly string[] = LIGHTER_TRICKS.filter((t) => t !== 'none');

/**
 * Tricks je Tempo-Stufe bei Sprüngen (Tests prüfen genau diese Zuordnung). Lauf lidFlick / strike (Rad, Funken,
 * Aufflackern): mit lidFlick allein machte er bei der 1.5°-Hand 56 % der Starts (Review Phase 2).
 */
export const LIGHTER_TIER_TRICKS: readonly (readonly LighterTrick[])[] = [[], ['lidFlick', 'strike'], ['twirl', 'lidFlick'], ['tossOpen', 'twirl']];

/** Griff: wie die Dose, 5.2 Einheiten entlang der Dosenachse zum Daumen; 1.3× groß. */
export const LIGHTER_HOLD_POS: readonly [number, number, number] = [CAN_HOLD_POS[0] - 5.2, CAN_HOLD_POS[1] + 0.3, CAN_HOLD_POS[2] + 0.6];
export const LIGHTER_SCALE = 1.3;

/** Flammen-Regeln (Tests prüfen genau diese). */
export const BLOW_SPEED = 950;
export const BLOW_TIME = 0.4;
export const CALM_SPEED = 300;
export const RELIGHT_TIME = 0.8;
/** Zündung im strike: Funken, dann Flamme (Trick-Zeit). */
const SPARK_AT = 0.1;
const IGNITE_AT = 0.15;
/** Das Rad dreht so früh, dass die Flamme nach RELIGHT_TIME Ruhe steht. */
const RELIGHT_START = RELIGHT_TIME - IGNITE_AT;
const WIND_FULL = 900;
const GROW = 0.12;
const FLARE_TIME = 0.3;
const FLARE = 0.6;
/** Rauch-Dauer: endet nicht auf einem gemeinsamen Frame-Raster (0.4 + 0.587 s), sonst kippt der Frame-Vergleich. */
const SMOKE_TIME = 0.587;
const SPARK_TIME = 0.35;
const SURF_FROM = 500;
const SURF_MIN = 0.5;

/**
 * Abklingzeiten (event-probe). tossOpen 1.3 → 1.6: seit das Ziel-Finale immer kommt (Review Phase 2, vorher fiel
 * es mitten im Trick weg), lag L1 sync 1.0 bei 33.4 Tricks/min (Band 20–32); danach 27.8.
 */
const COOLDOWN: { readonly [K in LighterTrick]: number } = { flickOpen: 0.3, strike: 0.5, snapClose: 0.5, lidFlick: 1.1, twirl: 1.1, tossOpen: 1.6, finale: 0.5, surfFlame: 0.5 };
const FLICK_T = 0.35;
const CLOSE_T = 0.3;
const LIDFLICK_T = 0.5;
const TWIRL_T = 0.7;
const TOSS_WIND = 0.1;
const TOSS_AIR = 0.6;
const TOSS_T = 0.9;
/** Rad-Dreh im strike (s): 0.32 → 0.44, seit er auch im Lauf kommt — kurz gerieben lag L2 sync 1.0 bei 24 % (Band ≥ 25). */
const STRIKE_T = 0.44;
const STRIKE_OPEN = 0.12;
const FINALE_T = 2.0;
const TAU = Math.PI * 2;

const P = VM_PARAM.lighter;

export class LighterTricks extends PropTricks<LighterTrick> {
  /** Deckel offen / Flamme brennt (Zustand bis Respawn). */
  lidOpen = false;
  lit = false;
  private pick = 0;
  private idleCount = 0;
  private cpCount = 0;
  /** Zeit ≥ BLOW_SPEED mit Flamme, Ruhe am Boden (s). */
  private windT = 0;
  private calmT = 0;
  /** Alter von Flamme, Aufflackern, Rauch, Funken (s; groß = vorbei). */
  private flameAge = 0;
  private flareAge = 9;
  private smokeAge = 9;
  private sparkAge = 9;
  /** In DIESEM Frame gesetzt (Alter schon exakt ab der Marke): nicht noch einmal dt addieren. */
  private stamped = 0;
  private lidFrom = 0;
  private wheel = 0;
  private surfSide = 0;
  private surfOut = -1;
  private tossLight = false;
  /** Zustandswechsel dieses Tricks schon passiert (über die Zeit, nicht über Marken — gilt auch festgehalten in Tools). */
  private didSpark = false;
  private didIgnite = false;
  /** surfFlame: beim Start war die Flamme aus → zünden (strike bis zu seinem Ende). */
  private stateStrike = false;

  override get trickNames(): readonly string[] {
    return LIGHTER_NAMES;
  }

  protected override isState(id: LighterTrick): boolean {
    return id === 'surfFlame';
  }

  protected resetRun(): void {
    this.lidOpen = false;
    this.lit = false;
    this.windT = 0;
    this.calmT = 0;
    this.flameAge = 0;
    this.flareAge = 9;
    this.smokeAge = 9;
    this.sparkAge = 9;
    this.stamped = 0;
    this.writeRest(this.out);
  }

  protected override start(id: LighterTrick): void {
    super.start(id);
    this.lidFrom = this.lidOpen ? 1 : 0;
    this.surfOut = -1;
    this.didSpark = false;
    this.didIgnite = false;
    this.stateStrike = !this.lit;
  }

  protected writeRest(o: PropOut): void {
    o.pose = POSE.grip;
    o.poseTau = 0.08;
    o.hx = 0;
    o.hy = 0;
    o.hz = 0;
    o.hpitch = 0;
    o.hyaw = 0;
    o.hroll = 0;
    o.pos[0] = LIGHTER_HOLD_POS[0];
    o.pos[1] = LIGHTER_HOLD_POS[1];
    o.pos[2] = LIGHTER_HOLD_POS[2];
    o.rot[0] = CAN_HOLD_ROT[0];
    o.rot[1] = CAN_HOLD_ROT[1];
    o.rot[2] = CAN_HOLD_ROT[2];
    o.spin = 0;
    o.visible = 1;
    o.scale = LIGHTER_SCALE;
    o.param[P.lid] = this.lidOpen ? 1 : 0;
    o.param[P.wheel] = this.wheel;
  }

  protected cooldownOf(id: LighterTrick): number {
    return COOLDOWN[id];
  }

  protected onJump(tier: number, good: boolean): void {
    if (tier === 0) return;
    const list = LIGHTER_TIER_TRICKS[tier];
    if (tier === 3 && good) this.start('tossOpen');
    else this.start(list[this.pick++ % list.length]);
  }

  protected onMilestone(tier: number): void {
    // Meilensteine achten auf die Abklingzeit (event-probe: L1 sync 1.0 sonst 35 Tricks/min, Grenze 32).
    if (this.now < this.cooldownUntil) return;
    if (tier >= 3) this.start('tossOpen');
    else if (tier === 2) this.start('twirl');
  }

  protected onIdle(): number {
    if (!this.lidOpen) this.start('flickOpen');
    else if (this.lit) this.start(this.idleCount++ % 2 === 0 ? 'twirl' : 'snapClose');
    else this.start('strike');
    return 3 + 2 * this.rand();
  }

  protected override onFinish(): void {
    this.start('finale');
  }

  /**
   * Checkpoint: Aufflackern kommt ohnehin (onEvent); dazu strike und twirl im Wechsel — nur strike machte auf L2
   * seit dem Lauf-strike die Hälfte aller Starts. Ist sie aus, zündet der strike sie wieder.
   */
  protected override onCheckpoint(_split: number | null): void {
    this.start(this.lit && this.cpCount++ % 2 === 1 ? 'twirl' : 'strike');
  }

  protected override onSurfStart(speed: number): void {
    if (speed >= SURF_FROM) this.start('surfFlame');
  }

  protected override onFree(inp: PropFrameInput, speed: number): void {
    if (inp.surfing && speed >= SURF_FROM) this.start('surfFlame');
    // Wieder zünden: offen, aus, ruhig am Boden — das Rad dreht so, dass die Flamme nach RELIGHT_TIME steht.
    // Start rückdatiert auf den Moment, in dem die Ruhe RELIGHT_START erreichte (sonst bis 1 Frame spät).
    else if (this.lidOpen && !this.lit && this.calmT >= RELIGHT_START) {
      this.start('strike');
      this.t = this.calmT - RELIGHT_START;
    }
  }

  override onEvent(e: GameEvent): void {
    // Checkpoint lässt die Flamme auch mitten im Trick aufflackern.
    if (e.type === 'checkpoint' && this.lit && this.motionFx > 0) this.flareAge = 0;
    super.onEvent(e);
  }

  override update(dtRaw: number, inp: PropFrameInput): void {
    const dt = dtRaw - dtRaw === 0 ? clamp(dtRaw, 0, 0.1) : 0;
    const speed = Math.max(0, fin(inp.speed));
    // Ruhe vor den Tricks zählen (onFree liest sie): ruhig = am Boden, kein Surf, < 300 u/s.
    if (dt > 0) this.calmT = inp.onGround && !inp.surfing && speed < CALM_SPEED ? this.calmT + dt : 0;
    this.surfSide = clamp(fin(inp.surfSide ?? 0), -1, 1);
    this.stamped = 0;
    super.update(dtRaw, inp);
    if (dt <= 0) return;
    this.stepFlame(dt, speed);
    this.writeFlame(speed);
  }

  /** Alter und Ausblasen (nach der Zeitleiste; Marken dieses Frames setzen ihr Alter exakt). */
  private stepFlame(dt: number, speed: number): void {
    const f = this.stamped;
    if ((f & 1) === 0) this.flameAge += dt;
    if ((f & 2) === 0) this.flareAge += dt;
    if ((f & 4) === 0) this.sparkAge += dt;
    this.smokeAge += dt;
    if (this.lit && speed >= BLOW_SPEED && this.motionFx > 0) {
      this.windT += dt;
      if (this.windT >= BLOW_TIME) {
        // Ausgeblasen — Rauch ab dem genauen Zeitpunkt.
        this.lit = false;
        this.smokeAge = this.windT - BLOW_TIME;
        this.windT = 0;
      }
    } else this.windT = 0;
  }

  private writeFlame(speed: number): void {
    const o = this.out;
    const m = this.motionFx > 0;
    const wind = clamp(speed / WIND_FULL, 0, 1) * (1 + 0.3 * this.surfSide);
    o.param[P.wind] = m ? clamp(wind, -1, 1) : 0;
    let flame = 0;
    const lid = o.param[P.lid];
    if (this.lit && lid > 0.45) {
      const flare = this.flareAge < FLARE_TIME ? 1 + FLARE * (1 - this.flareAge / FLARE_TIME) : 1;
      // Der Deckel verdeckt die Flamme stetig (0.45 … 0.65 offen), statt sie an einer Schwelle abzuschalten: der
      // Deckel-Klack der Surf-Einlage schließt und öffnet ihn, eine harte Schwelle hinge an der Framerate.
      flame = smooth(this.flameAge / GROW) * (1 - 0.45 * clamp(speed / BLOW_SPEED, 0, 1)) * flare * smooth((lid - 0.45) / 0.2);
    } else if (!this.lit && this.smokeAge < SMOKE_TIME) flame = -1;
    o.param[P.flame] = flame;
    o.param[P.wheel] = this.wheel;
    if (this.sparkAge < SPARK_TIME) o.poof = this.sparkAge / SPARK_TIME;
    else if (flame < 0) o.poof = this.smokeAge / SMOKE_TIME;
    else o.poof = -1;
  }

  /** Zünden zur Trick-Zeit `at` (Marke): Flamme und Aufflackern ab genau dort. */
  private ignite(t: number, at: number): void {
    this.lit = true;
    this.lidOpen = true;
    this.flameAge = t - at;
    this.flareAge = t - at;
    this.windT = 0;
    this.stamped |= 3;
  }

  private sparkAt(t: number, at: number): void {
    this.sparkAge = t - at;
    this.stamped |= 4;
  }

  protected evaluate(id: LighterTrick, t: number, _dt: number, inp: PropFrameInput, _m: number, o: PropOut): boolean {
    if (id === 'flickOpen') return this.flickOpen(t, o);
    if (id === 'snapClose') return this.snapClose(t, o);
    if (id === 'strike') return this.strike(t, 0, o);
    if (id === 'lidFlick') return this.lidFlick(t, o);
    if (id === 'twirl') return this.twirl(t, o);
    if (id === 'tossOpen') return this.tossOpen(t, inp, o);
    if (id === 'finale') return this.finale(t, o);
    return this.surfFlame(t, inp, o);
  }

  /** Deckel schnappt mit Überschwinger auf (Daumen schnippt). */
  private flickOpen(t: number, o: PropOut): boolean {
    const u = t / FLICK_T;
    if (u >= 1) {
      this.lidOpen = true;
      o.param[P.lid] = 1;
      return true;
    }
    o.param[P.lid] = this.lidFrom + (1 - this.lidFrom) * backOut(u, 2.2);
    o.pose = u < 0.45 ? POSE.crack : POSE.grip;
    o.poseTau = 0.04;
    o.hroll = 0.08 * bell(u);
    if (this.mark(0, 0.1, t)) this.kick(o, 0.1, -0.25);
    return false;
  }

  /** Zu mit Klack (löscht die Flamme). */
  private snapClose(t: number, o: PropOut): boolean {
    const u = t / CLOSE_T;
    const e = smooth(u / 0.7);
    o.param[P.lid] = this.lidFrom * (1 - e);
    o.hroll = -0.1 * bell(u);
    if (this.mark(0, CLOSE_T * 0.7, t)) {
      this.kick(o, 0.14, -0.4);
      this.spinKick(0.6);
    }
    if (t >= CLOSE_T * 0.7) {
      this.lidOpen = false;
      this.lit = false;
    }
    if (u >= 1) {
      o.param[P.lid] = 0;
      return true;
    }
    return false;
  }

  /** Reibrad: (wenn zu, erst auf) Daumen rollt das Rad, Funken, Flamme. `lead` = Vorlauf in der Zeitleiste. */
  private strike(t: number, lead: number, o: PropOut): boolean {
    const open = this.lidFrom > 0.5 ? 0 : STRIKE_OPEN;
    const s = t - lead - open;
    if (s < 0) {
      o.param[P.lid] = this.lidFrom + (1 - this.lidFrom) * backOut((t - lead) / STRIKE_OPEN, 2);
      o.pose = POSE.crack;
      o.poseTau = 0.04;
      return false;
    }
    o.param[P.lid] = 1;
    this.lidOpen = true;
    const u = s / STRIKE_T;
    o.pose = u < 0.7 ? POSE.crack : POSE.grip;
    o.poseTau = 0.04;
    this.wheel = (Math.PI * 1.5 * smooth(u)) % TAU;
    o.param[P.wheel] = this.wheel;
    o.hroll = 0.05 * bell(u);
    const base = lead + open;
    if (this.mark(0, base + SPARK_AT, t)) this.kick(o, 0.08, -0.15);
    if (!this.didSpark && t >= base + SPARK_AT) {
      this.didSpark = true;
      this.sparkAt(t, base + SPARK_AT);
    }
    if (!this.didIgnite && t >= base + IGNITE_AT) {
      this.didIgnite = true;
      this.ignite(t, base + IGNITE_AT);
    }
    return u >= 1;
  }

  /** Auf/zu in einer Handbewegung (Zustand wechselt; zu löscht). */
  private lidFlick(t: number, o: PropOut): boolean {
    const u = t / LIDFLICK_T;
    const opening = this.lidFrom < 0.5;
    o.hroll = (opening ? 0.22 : -0.22) * bell(u);
    o.hy = -0.012 * bell(u);
    const e = smooth(u / 0.6);
    o.param[P.lid] = opening ? backOut(u / 0.6, 2) : 1 - e;
    if (this.mark(0, LIDFLICK_T * 0.6, t)) {
      this.kick(o, 0.12, -0.35);
      this.spinKick(opening ? 1.2 : -1.2);
    }
    if (t >= LIDFLICK_T * 0.6) {
      this.lidOpen = opening;
      if (!opening) this.lit = false;
    }
    if (u >= 1) {
      o.param[P.lid] = opening ? 1 : 0;
      return true;
    }
    return false;
  }

  /** Einmal um die eigene Mitte gedreht, locker in der offenen Hand; der Deckel klappert. */
  private twirl(t: number, o: PropOut): boolean {
    const u = t / TWIRL_T;
    if (u >= 1) return true;
    this.offsetView(o, 0.3 * bell(u), 1.6 * bell(u), 1.2 * bell(u));
    this.rotateView(o, 0, 0, 1, -TAU * smooth(u));
    o.pose = u > 0.15 && u < 0.8 ? POSE.open : POSE.grip;
    o.poseTau = 0.05;
    if (this.lidOpen) o.param[P.lid] = 1 - 0.18 * Math.abs(Math.sin(u * Math.PI * 5)) * bell(u);
    if (this.mark(0, TWIRL_T * 0.85, t)) this.kick(o, 0.15, -0.4);
    return false;
  }

  /** Hochwurf mit 2 Drehungen, Deckel öffnet in der Luft, Flamme beim Fang (nicht bei ≥ 950 u/s). */
  private tossOpen(t: number, inp: PropFrameInput, o: PropOut): boolean {
    if (t < TOSS_WIND) {
      if (this.mark(0, 0, t)) this.kick(o, 0.22, 0);
      this.offsetView(o, 0, -1.1 * Math.sin(Math.PI * (t / TOSS_WIND)), 0);
      this.tossLight = !this.lit;
      return false;
    }
    if (this.mark(1, TOSS_WIND, t)) this.kick(o, -0.65, 0);
    const s = (t - TOSS_WIND) / TOSS_AIR;
    if (s < 1) {
      this.offsetView(o, -0.8 * Math.sin(Math.PI * s), 7 * arc(s), 1.2 * Math.sin(Math.PI * s));
      this.rotateView(o, 0, 0, 1, -2 * TAU * s);
      o.param[P.lid] = this.lidFrom + (1 - this.lidFrom) * smooth((s - 0.35) / 0.3);
      o.pose = s < 0.75 ? POSE.open : POSE.grip;
      o.poseTau = 0.05;
      return false;
    }
    o.param[P.lid] = 1;
    this.lidOpen = true;
    if (this.mark(2, TOSS_WIND + TOSS_AIR, t)) {
      this.kick(o, 0.38, -1.0);
      this.spinKick(-1.4);
    }
    if (!this.didIgnite) {
      this.didIgnite = true;
      if (this.tossLight && fin(inp.speed) < BLOW_SPEED) this.ignite(t, TOSS_WIND + TOSS_AIR);
      else if (this.lit) this.flareAge = t - TOSS_WIND - TOSS_AIR;
    }
    return t >= TOSS_T;
  }

  /** Ziel: auf, zünden, aufflackern, halten, zu. */
  private finale(t: number, o: PropOut): boolean {
    if (t < FINALE_T - CLOSE_T - 0.2) {
      if (!this.lit || t < 0.6) this.strike(t, 0, o);
      else {
        o.param[P.lid] = 1;
        o.hy = -0.02 * bell(clamp((t - 0.4) / 1.0, 0, 1));
      }
      return false;
    }
    const s = t - (FINALE_T - CLOSE_T - 0.2);
    if (s < 0.2) {
      o.param[P.lid] = 1;
      return false;
    }
    this.lidFrom = 1;
    this.snapClose(s - 0.2, o);
    return t >= FINALE_T;
  }

  /**
   * Surf: Deckel auf (falls zu), hochhalten, zünden (wenn aus), Flamme weht seitlich; endet mit dem Surf. Einlage
   * (PropTricks.beatU): Deckel schnappt zu und wieder auf (Daumen), die Hand wippt; brennt sie, flackert sie beim
   * Aufschnappen auf — auch ausgeblasen (≥ 950 u/s, L3) sieht man den Klack.
   */
  private surfFlame(t: number, inp: PropFrameInput, o: PropOut): boolean {
    if (this.surfOut < 0 && !inp.surfing && t >= SURF_MIN) this.surfOut = t;
    const inE = smooth(t / 0.25);
    const outE = this.surfOut < 0 ? 0 : smooth((t - this.surfOut) / 0.3);
    const e = inE * (1 - outE);
    // Erst zünden (setzt Pose/Neigung), dann die Surf-Lage darauf — so bleibt der Übergang stetig.
    if (this.stateStrike && this.strike(t, 0, o)) this.stateStrike = false;
    if (!this.stateStrike) o.param[P.lid] = 1;
    this.offsetView(o, 0.6 * e, 1.4 * e, 1.6 * e);
    this.rotateView(o, 0, 0, 1, -0.25 * this.surfLean * e);
    o.hroll += 0.1 * this.surfLean * e;
    const u = this.beatU;
    if (u < 1 && !this.stateStrike) {
      // Mit dem Zustand ausgeblendet (e): endet der Surf mitten im Klack, geht der Deckel stetig wieder auf.
      o.param[P.lid] = 1 - 0.95 * bell(u) * e;
      o.hroll -= 0.2 * bell(u) * e;
      o.pose = u > 0.15 && u < 0.85 ? POSE.crack : POSE.grip;
      o.poseTau = 0.04;
    }
    // Wieder auf: Klack, und die Flamme flackert ab genau dort (Alter exakt, framerate-unabhängig).
    if (this.beatEnd()) {
      this.kick(o, 0.1, -0.3);
      if (this.lit) {
        this.flareAge = this.lateness;
        this.stamped |= 2;
      }
    }
    this.lidOpen = true;
    return this.surfOut >= 0 && t >= this.surfOut + 0.3;
  }
}
