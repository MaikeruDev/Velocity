import { POSE } from './poses';
import { arc, backOut, bell, smooth } from './anim';
import { PropTricks } from './propTricks';
import type { PropFrameInput, PropOut } from './propTricks';
import { VIEW_ALIGNED } from './rot';

/**
 * Butterfly-Messer (Balisong, stumpfer Trainer, rein kosmetisch — Plan 006). Die Faust hält
 * den "safe"-Griff; Klinge und zweiter Griff drehen an ihren Stiften.
 *
 * Zustand offen/zu hält bis Respawn. Tricks je Tempo:
 * - Stand: Aufklappen/Zuklappen (Basic Opening) im Wechsel,
 * - Lauf: dasselbe an Sprüngen,
 * - Flow: Rollover (Messer rollt über die Hand, Griffe fliegen) oder Auf/Zu,
 * - Overdrive: Aerial (Wurf mit Drehung, Fang wechselt offen/zu), Doppel-Aerial bei perfekten Hops.
 */

export const KNIFE_TRICKS = ['none', 'open', 'close', 'rollover', 'aerial', 'doubleAerial'] as const;
export type KnifeTrick = Exclude<(typeof KNIFE_TRICKS)[number], 'none'>;

export const KNIFE_TIER_TRICKS: readonly (readonly KnifeTrick[])[] = [[], ['open', 'close'], ['rollover', 'open', 'close'], ['aerial', 'doubleAerial', 'rollover']];

/** Drehstift des gehaltenen Griffs im Handgelenk-Raum (über der Daumenseite der Faust). */
export const KNIFE_HOLD_POS = [-5.2, 8.4, -3.2] as const;

const COOLDOWN = { open: 0.35, close: 0.35, rollover: 0.8, aerial: 0.8, doubleAerial: 0.9 } as const;
const FLIP_TIME = 0.5;
const ROLL_TIME = 0.85;
const AIR_WINDUP = 0.1;
const AIR_TIME = 0.62;
const AIR_TOTAL = 0.95;
const DAIR_TIME = 0.78;
const DAIR_TOTAL = 1.1;

const TAU = Math.PI * 2;

export class KnifeTricks extends PropTricks<KnifeTrick> {
  /** Klinge offen (hält bis Respawn). */
  isOpen = false;
  private pick = 0;

  protected resetRun(): void {
    this.isOpen = false;
    this.writeRest(this.out);
  }

  protected writeRest(o: PropOut): void {
    o.pose = POSE.knife;
    o.poseTau = 0.08;
    o.hx = 0;
    o.hy = 0;
    o.hz = 0;
    o.hpitch = 0;
    o.hyaw = 0;
    o.hroll = 0;
    o.pos[0] = KNIFE_HOLD_POS[0];
    o.pos[1] = KNIFE_HOLD_POS[1];
    o.pos[2] = KNIFE_HOLD_POS[2];
    o.rot[0] = VIEW_ALIGNED[0];
    o.rot[1] = VIEW_ALIGNED[1];
    o.rot[2] = VIEW_ALIGNED[2];
    // Griff steckt schräg in der Faust, Klinge zeigt nach links oben ins Bild.
    this.rotateView(o, 0, 1, 0, 0.5);
    this.rotateView(o, 0, 0, 1, 0.55);
    o.spin = 0;
    o.visible = 1;
    o.scale = 1;
    o.poof = -1;
    this.setBlade(o, this.isOpen ? 0 : Math.PI, 0);
  }

  /** Klinge β (0 offen, π zu) und Zusatzschwung des zweiten Griffs (rad, absolut). */
  private setBlade(o: PropOut, beta: number, swing: number): void {
    o.knifeBlade = beta;
    // Beide Griffe zusammen: absoluter Winkel des zweiten Griffs = 0 (+ Schwung).
    o.knifeBite = -beta + swing;
  }

  protected cooldownOf(id: KnifeTrick): number {
    return COOLDOWN[id];
  }

  protected onJump(tier: number, good: boolean): void {
    if (tier === 0) return;
    if (tier === 1) this.start(this.isOpen ? 'close' : 'open');
    else if (tier === 2) {
      const k = this.pick++ % 3;
      this.start(k === 0 ? 'rollover' : this.isOpen ? 'close' : 'open');
    } else this.start(good ? 'doubleAerial' : this.pick++ % 3 === 2 ? 'rollover' : 'aerial');
  }

  protected onMilestone(tier: number): void {
    if (tier >= 3) this.start('doubleAerial');
    else if (tier === 2) this.start('rollover');
  }

  protected onIdle(): number {
    this.start(this.isOpen ? 'close' : 'open');
    return 2.2 + 1.6 * this.rand();
  }

  protected override onFinish(): void {
    this.start('doubleAerial');
  }

  protected evaluate(id: KnifeTrick, t: number, _dt: number, _inp: PropFrameInput, _m: number, o: PropOut): boolean {
    if (id === 'open' || id === 'close') {
      const u = t / FLIP_TIME;
      const opening = id === 'open';
      if (u >= 1) {
        this.isOpen = opening;
        this.writeRest(o);
        return true;
      }
      // Basic Opening: Handgelenk schnippt, Klinge schwingt einmal herum, zweiter Griff
      // macht eine volle Runde und schlägt am Ende an (kleiner Ruck).
      const e = smooth(u);
      const beta = opening ? Math.PI * (1 - e) : Math.PI * e;
      this.setBlade(o, beta, TAU * e * (opening ? 1 : -1));
      o.hroll = 0.22 * bell(u) * (opening ? 1 : -1);
      o.hy = -0.012 * bell(u);
      if (this.mark(0, FLIP_TIME * 0.85, t)) {
        this.kick(o, 0.18, -0.5);
        this.spinKick(opening ? 2 : -2);
      }
      return false;
    }
    if (id === 'rollover') {
      const u = t / ROLL_TIME;
      if (u >= 1) return true;
      // Das Messer rollt einmal um die Hand (Bild-Tiefenachse), Griffe fliegen auf und zu.
      const e = backOut(u, 0.8);
      this.rotateView(o, 0, 0, 1, TAU * e);
      this.offsetView(o, 1.2 * Math.sin(TAU * u), 2 * bell(u), 1.5 * bell(u));
      const flail = Math.sin(Math.PI * u);
      const base = this.isOpen ? 0 : Math.PI;
      this.setBlade(o, base + (this.isOpen ? 1 : -1) * 1.6 * flail, 2.4 * flail);
      o.pose = u > 0.2 && u < 0.7 ? POSE.run : POSE.knife;
      o.poseTau = 0.05;
      o.hroll = -0.15 * bell(u);
      if (this.mark(0, ROLL_TIME * 0.8, t)) this.kick(o, 0.2, -0.4);
      return false;
    }
    // Aerial: Wurf mit Drehung, Klinge klappt in der Luft um, Fang im anderen Zustand.
    const air = id === 'doubleAerial' ? DAIR_TIME : AIR_TIME;
    const total = id === 'doubleAerial' ? DAIR_TOTAL : AIR_TOTAL;
    const turns = id === 'doubleAerial' ? 2 : 1;
    if (t < AIR_WINDUP) {
      if (this.mark(0, 0, t)) this.kick(o, 0.25, 0);
      this.offsetView(o, 0, -1.2, 0);
      this.rotateView(o, 0, 0, 1, 0.2 * smooth(t / AIR_WINDUP));
      return false;
    }
    if (this.mark(1, AIR_WINDUP, t)) this.kick(o, -0.7, 0);
    const s = (t - AIR_WINDUP) / air;
    if (s < 1) {
      this.offsetView(o, -2 * Math.sin(Math.PI * s), (5.5 + 2 * turns) * arc(s), 2 * Math.sin(Math.PI * s));
      this.rotateView(o, 0, 0, 1, 0.2 - (TAU * turns + 0.2) * s);
      const from = this.isOpen ? 0 : Math.PI;
      const to = this.isOpen ? Math.PI : 0;
      this.setBlade(o, from + (to - from) * smooth(s), TAU * turns * s);
      o.pose = s < 0.75 ? POSE.open : POSE.knife;
      o.poseTau = 0.05;
      return false;
    }
    if (this.mark(2, AIR_WINDUP + air, t)) {
      this.isOpen = !this.isOpen;
      this.kick(o, 0.4, -1.1);
      this.spinKick(-2.5);
    }
    this.writeRest(o);
    return t >= total;
  }
}
