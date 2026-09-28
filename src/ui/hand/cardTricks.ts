import { POSE } from './poses';
import { arc, backOut, bell, smooth } from './anim';
import { PropTricks } from './propTricks';
import type { PropFrameInput, PropOut } from './propTricks';
import { VIEW_ALIGNED } from './rot';

/**
 * Sammelkarte (Plan 006): zwischen Daumen und Zeigefinger. Tricks:
 * - spin: um die Hochachse drehen (Vorder-/Rückseite im Wechsel — beide Seiten texturiert),
 * - turn: komplett umdrehen (über die Querachse), bleibt gewendet bis zum nächsten turn,
 * - tossSpin: hochwerfen mit Wirbel und fangen,
 * - vanish: Zaubertrick — Hand wischt darüber, Karte löst sich (Dither) mit Poof auf, kurz
 *   leere Hand, dann erscheint sie mit Schwung (Überschwinger) wieder.
 * Tempo steuert Häufigkeit und Wildheit.
 */

export const CARD_TRICKS = ['none', 'spin', 'turn', 'tossSpin', 'vanish'] as const;
export type CardTrick = Exclude<(typeof CARD_TRICKS)[number], 'none'>;

export const CARD_TIER_TRICKS: readonly (readonly CardTrick[])[] = [[], ['spin', 'turn'], ['tossSpin', 'spin', 'turn'], ['vanish', 'tossSpin', 'tossSpin']];

/** Mitte der Karte im Griff (Handgelenk-Raum) — Daumen und Zeigefinger halten die untere Ecke. */
export const CARD_HOLD_POS = [-5.6, 11.9, -1.2] as const;

const COOLDOWN = { spin: 0.9, turn: 0.9, tossSpin: 0.8, vanish: 1.2 } as const;

const SPIN_TIME = 0.9;
const TURN_TIME = 0.7;
const TOSS_WINDUP = 0.08;
const TOSS_AIR = 0.62;
const TOSS_TOTAL = 0.9;
/** Zaubertrick-Zeitleiste (s). */
const V_SWIPE = 0.18;
const V_GONE = 0.42;
const V_BACK = 1.25;
const V_POP = 1.45;
const V_TOTAL = 1.9;

const TAU = Math.PI * 2;

export class CardTricks extends PropTricks<CardTrick> {
  /** Karte zeigt gerade die Rückseite (nach turn). */
  flipped = false;
  /** Tools/Tests: Karte war seit Trickstart unsichtbar bzw. ist wieder da. */
  vanished = false;
  private pick = 0;
  private idleCount = 0;
  private spins = 1;
  /** Laufende halbe Drehung des turn-Tricks (rad). */
  private turnExtra = 0;

  protected resetRun(): void {
    this.flipped = false;
    this.vanished = false;
    this.turnExtra = 0;
    this.writeRest(this.out);
  }

  protected writeRest(o: PropOut): void {
    o.pose = POSE.pinch;
    o.poseTau = 0.08;
    o.hx = 0;
    o.hy = 0;
    o.hz = 0;
    o.hpitch = 0;
    o.hyaw = 0;
    o.hroll = 0;
    o.pos[0] = CARD_HOLD_POS[0];
    o.pos[1] = CARD_HOLD_POS[1];
    o.pos[2] = CARD_HOLD_POS[2];
    o.rot[0] = VIEW_ALIGNED[0];
    o.rot[1] = VIEW_ALIGNED[1];
    o.rot[2] = VIEW_ALIGNED[2];
    const flip = (this.flipped ? Math.PI : 0) + this.turnExtra;
    if (flip !== 0) this.rotateView(o, 1, 0, 0, flip);
    // Leicht schräg und zur Mitte gedreht: man sieht die Vorderseite und die Dicke.
    this.rotateView(o, 0, 1, 0, 0.42);
    this.rotateView(o, 0, 0, 1, 0.3);
    o.spin = 0;
    o.visible = 1;
    o.scale = 1;
    o.poof = -1;
  }

  protected cooldownOf(id: CardTrick): number {
    return COOLDOWN[id];
  }

  protected onJump(tier: number, good: boolean): void {
    if (tier === 0) return;
    const list = CARD_TIER_TRICKS[tier];
    if (tier === 3 && good) this.startTrick(this.pick++ % 2 === 0 ? 'vanish' : 'tossSpin', 3);
    else this.startTrick(list[this.pick++ % list.length], tier);
  }

  protected onMilestone(tier: number): void {
    if (tier >= 3) this.startTrick('vanish', 3);
    else if (tier === 2) this.startTrick('tossSpin', 2);
  }

  protected onIdle(): number {
    const k = this.idleCount++ % 4;
    this.startTrick(k === 3 ? 'vanish' : k === 1 ? 'turn' : 'spin', 0);
    return 2.8 + 2 * this.rand();
  }

  protected override onFinish(): void {
    this.startTrick('vanish', 3);
  }

  private startTrick(id: CardTrick, tier: number): void {
    // Wildheit: Spin-Umdrehungen mit dem Tempo.
    this.spins = tier >= 3 ? 3 : tier === 2 ? 2 : 1;
    if (id === 'vanish') this.vanished = false;
    this.start(id);
  }

  /** Tools: Trick mit Wildheit einer Tempostufe starten. */
  debugPlayTier(id: CardTrick, tier: number, at = -1): void {
    this.debugPlay(id, at);
    this.spins = tier >= 3 ? 3 : tier === 2 ? 2 : 1;
  }

  protected evaluate(id: CardTrick, t: number, _dt: number, _inp: PropFrameInput, _m: number, o: PropOut): boolean {
    if (id === 'spin') {
      const time = SPIN_TIME * (0.8 + 0.2 * this.spins);
      const u = t / time;
      if (u >= 1) return true;
      // Leicht anheben (Finger lockern), drehen, mit kleinem Überschwinger zurück.
      o.spin = TAU * this.spins * backOut(u, 1.2);
      this.offsetView(o, 0, 1.4 * bell(u), 0.6 * bell(u));
      o.hroll = -0.06 * bell(u);
      return false;
    }
    if (id === 'turn') {
      const u = t / TURN_TIME;
      if (u >= 1) {
        this.flipped = !this.flipped;
        this.turnExtra = 0;
        return true;
      }
      // Halbe Drehung über die Querachse an derselben Stelle wie der Ruhe-Zustand (sonst
      // springt die Karte am Ende), dazu ein kleiner Hopser.
      this.turnExtra = Math.PI * smooth(u);
      this.writeRest(o);
      this.offsetView(o, 0, 3 * arc(u), 0);
      return false;
    }
    if (id === 'tossSpin') {
      if (t < TOSS_WINDUP) {
        if (this.mark(0, 0, t)) this.kick(o, 0.2, 0);
        this.offsetView(o, 0, -1, 0);
        return false;
      }
      if (this.mark(1, TOSS_WINDUP, t)) this.kick(o, -0.5, 0);
      const s = (t - TOSS_WINDUP) / TOSS_AIR;
      if (s < 1) {
        this.offsetView(o, 1.5 * Math.sin(Math.PI * s), (4.5 + 1.5 * this.spins) * arc(s), 1.5 * Math.sin(Math.PI * s));
        o.spin = TAU * this.spins * s;
        this.rotateView(o, 0, 0, 1, -TAU * s);
        o.pose = s < 0.7 ? POSE.open : POSE.pinch;
        o.poseTau = 0.05;
        return false;
      }
      if (this.mark(2, TOSS_WINDUP + TOSS_AIR, t)) {
        this.kick(o, 0.35, -1.0);
        this.spinKick(-1.2);
      }
      return t >= TOSS_TOTAL;
    }
    // vanish
    return this.vanish(t, o);
  }

  private vanish(t: number, o: PropOut): boolean {
    if (t >= V_TOTAL) return true;
    // Hand wischt: flache Hand, Handgelenk rollt über die Karte und zurück.
    const swipe1 = bell(t / (V_GONE + 0.1));
    const swipe2 = bell((t - V_BACK + 0.05) / (V_POP - V_BACK + 0.25));
    o.hroll = 0.5 * swipe1 - 0.45 * swipe2;
    o.hx = -0.04 * swipe1 + 0.03 * swipe2;
    o.hy = -0.02 * (swipe1 + swipe2);
    if (t < V_SWIPE) {
      o.pose = POSE.pinch;
      return false;
    }
    if (t < V_GONE) {
      // Auflösen im Dither (kein Blending), Poof in der Kartenmitte.
      const u = (t - V_SWIPE) / (V_GONE - V_SWIPE);
      o.visible = 1 - smooth(u);
      o.pose = POSE.flat;
      o.poseTau = 0.05;
      if (this.mark(0, V_SWIPE + 0.05, t)) this.kick(o, -0.2, 0.4);
      this.poofAt(o, (t - V_SWIPE) / 0.45);
      return false;
    }
    if (t < V_BACK) {
      // Leere Hand zeigen: offen, Finger wackeln kurz ("nichts drin!").
      this.vanished = true;
      o.visible = 0;
      o.pose = POSE.open;
      o.poseTau = 0.07;
      o.hroll += 0.08 * Math.sin((t - V_GONE) * 18) * bell((t - V_GONE) / (V_BACK - V_GONE));
      this.poofAt(o, (t - V_SWIPE) / 0.45);
      return false;
    }
    if (t < V_POP) {
      o.visible = 0;
      o.pose = POSE.flat;
      o.poseTau = 0.05;
      return false;
    }
    // Wiedererscheinen mit Schwung: Poof, Karte wächst mit Überschwinger und dreht sich ein.
    const u = (t - V_POP) / (V_TOTAL - V_POP);
    if (this.mark(1, V_POP, t)) {
      this.kick(o, 0.3, -0.8);
      this.vanished = false;
    }
    o.visible = 1;
    o.scale = Math.max(0.05, backOut(smooth(u * 1.6), 2.4));
    o.spin = -TAU * (1 - smooth(u * 1.3));
    o.pose = POSE.pinch;
    o.poseTau = 0.05;
    this.poofAt(o, (t - V_POP) / 0.4);
    return false;
  }

  private poofAt(o: PropOut, u: number): void {
    if (u < 0 || u >= 1) return;
    o.poof = u;
    o.poofPos[0] = o.pos[0];
    o.poofPos[1] = o.pos[1];
    o.poofPos[2] = o.pos[2];
  }
}
