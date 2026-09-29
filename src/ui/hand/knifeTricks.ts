import { POSE, POSE_JOINTS } from './poses';
import { arc, backOut, bell, clamp, fin, smooth } from './anim';
import { fingerTip } from './fk';
import { PropTricks } from './propTricks';
import type { PropFrameInput, PropOut } from './propTricks';
import { VIEW_ALIGNED } from './rot';
import { relRot, viewPoint, viewRot } from './view';
import type { V3 } from './view';

/**
 * Butterfly-Messer (Balisong, stumpfer Trainer, rein kosmetisch — Plan 006). Die Faust hält
 * den "safe"-Griff; Klinge und zweiter Griff drehen an ihren Stiften.
 *
 * Zustand offen/zu hält bis Respawn. Tricks je Tempo:
 * - Stand: Aufklappen/Zuklappen (Basic Opening) im Wechsel,
 * - Lauf: dasselbe an Sprüngen,
 * - Flow: Rollover (Messer rollt über die Hand, Griffe fliegen) oder Auf/Zu,
 * - Overdrive: Aerial (Wurf mit Drehung, Fang wechselt offen/zu), Doppel-Aerial bei perfekten Hops.
 * - Plan 007 KI8, Surf ≥ 500 u/s: Zustand surfHeli ("Helikopter") — offen auf der Zeigefinger-Spitze,
 *   dreht flach wie ein Rotor um den Finger (Drehebene zur Kamera gekippt). Surf-Ende: läuft auf eine
 *   volle Umdrehung aus und legt sich zurück in die Faust (bleibt offen).
 */

export const KNIFE_TRICKS = ['none', 'open', 'close', 'rollover', 'aerial', 'doubleAerial', 'surfHeli'] as const;
export type KnifeTrick = Exclude<(typeof KNIFE_TRICKS)[number], 'none'>;

const KNIFE_NAMES: readonly string[] = KNIFE_TRICKS.filter((t) => t !== 'none');

export const KNIFE_TIER_TRICKS: readonly (readonly KnifeTrick[])[] = [[], ['open', 'close'], ['rollover', 'open', 'close'], ['aerial', 'doubleAerial', 'rollover']];

/** Drehstift des gehaltenen Griffs im Handgelenk-Raum (über der Daumenseite der Faust). */
export const KNIFE_HOLD_POS = [-5.2, 8.4, -3.2] as const;

const COOLDOWN = { open: 0.35, close: 0.35, rollover: 0.8, aerial: 0.8, doubleAerial: 0.9, surfHeli: 0.5 } as const;

/** Helikopter (KI8): Drehpunkt (Stift) über der Zeigefinger-Kuppe, Rotor flach, zur Kamera gekippt. */
const SURF_FROM = 500;
const SURF_MIN = 0.5;
const HELI_UP = 0.35;
const HELI_STOP_MIN = 0.3;
const HELI_OUT = 0.3;
/** Drehzahl (rad/s): Grundwert + Anteil des Tempos beim Einstieg (einmal gelesen → Zeitleiste bleibt geschlossen). */
const HELI_W0 = 14;
const HELI_W_PER_SPEED = 0.012;
const HELI_W_MAX = 28;
const HELI_TILT = 0.55;
const HELI_POS: V3 = ((): V3 => {
  const t: [number, number, number] = [0, 0, 0];
  fingerTip(POSE_JOINTS[POSE.point], 0, t, 0.3);
  return viewPoint(t, 0, 0.8, 0);
})();
/** Griffe nach links/rechts, Klinge flach (Schneide nach unten weg): Stab entlang Bild-rechts. */
const HELI_BASE: V3 = viewRot([
  [2, -Math.PI / 2],
  [0, Math.PI / 2],
]);
const REST_ROT: V3 = viewRot([
  [1, 0.5],
  [2, 0.55],
]);
const HELI_REL = relRot(REST_ROT, HELI_BASE);
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
  private surfOut = -1;
  private wasOpen = false;
  private heliW = HELI_W0;
  /** Auslauf ab surfOut: Winkel dort, Dauer bis zur vollen Umdrehung (einmal berechnet). */
  private stopFrom = 0;
  private stopTime = 0;

  override get trickNames(): readonly string[] {
    return KNIFE_NAMES;
  }

  protected override isState(id: KnifeTrick): boolean {
    return id === 'surfHeli';
  }

  protected override start(id: KnifeTrick): void {
    super.start(id);
    this.surfOut = -1;
    this.wasOpen = this.isOpen;
    this.heliW = clamp(HELI_W0 + HELI_W_PER_SPEED * this.lastSpeed, HELI_W0, HELI_W_MAX);
  }

  protected override onSurfStart(speed: number): void {
    if (speed >= SURF_FROM) this.start('surfHeli');
  }

  protected override onFree(inp: PropFrameInput, speed: number): void {
    if (inp.surfing && speed >= SURF_FROM) this.start('surfHeli');
  }

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

  /** Training (KI9): Stufe = auf- bzw. zuschnappen (Jubel), Lektion fertig = wie das Ziel. */
  protected override onLesson(done: boolean): void {
    if (done) this.onFinish();
    else this.start(this.isOpen ? 'close' : 'open');
  }

  protected evaluate(id: KnifeTrick, t: number, _dt: number, inp: PropFrameInput, _m: number, o: PropOut): boolean {
    if (id === 'surfHeli') return this.heli(t, inp, o);
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

  /** Drehwinkel des Rotors bis Trick-Zeit t: linearer Hochlauf über HELI_UP, dann konstant (geschlossen). */
  private heliAngle(t: number): number {
    const w = this.heliW;
    return t < HELI_UP ? (w * t * t) / (2 * HELI_UP) : w * (t - HELI_UP / 2);
  }

  /**
   * Helikopter (KI8): aus der Faust auf die Fingerspitze (Lage per Achse-Winkel), aufklappen falls zu,
   * flach um die Bild-Hochachse drehen. Surf-Ende: gleichmäßig abbremsen bis auf eine volle Umdrehung
   * (Rotor = Ausgangslage), dann zurück in die Faust. Alles geschlossene Funktionen der Trick-Zeit.
   */
  private heli(t: number, inp: PropFrameInput, o: PropOut): boolean {
    if (this.surfOut < 0 && !inp.surfing && t >= SURF_MIN) {
      this.surfOut = t;
      const w = this.heliW;
      const a = this.heliAngle(t);
      const k = Math.ceil((a + (w * HELI_STOP_MIN) / 2) / (Math.PI * 2));
      this.stopFrom = a;
      this.stopTime = (2 * (Math.PI * 2 * k - a)) / w;
    }
    let angle: number;
    let e = smooth(t / HELI_UP);
    if (this.surfOut < 0) angle = this.heliAngle(t);
    else {
      const s = clamp((t - this.surfOut) / this.stopTime, 0, 1);
      angle = this.stopFrom + this.heliW * this.stopTime * (s - (s * s) / 2);
      e *= 1 - smooth((t - this.surfOut - this.stopTime) / HELI_OUT);
    }
    this.rotateLocal(o, HELI_REL[0], HELI_REL[1], HELI_REL[2], HELI_REL[3] * e);
    this.rotateView(o, 0, 1, 0, angle % (Math.PI * 2));
    this.rotateView(o, 1, 0, 0, HELI_TILT * e);
    for (let k = 0; k < 3; k++) o.pos[k] += (HELI_POS[k] - o.pos[k]) * e;
    // Einlage (PropTricks.beatU): der Rotor springt von der Fingerspitze hoch, kippt kurz und landet wieder.
    const u = this.beatU;
    if (u < 1) {
      this.offsetView(o, 0.3 * arc(u) * e, 2.6 * arc(u) * e, 0.6 * arc(u) * e);
      this.rotateView(o, 0, 0, 1, 0.35 * bell(u) * e);
    }
    if (this.beatEnd()) this.kick(o, 0.12, -0.3);
    // Aufklappen in den ersten HELI_UP s (war es zu), danach offen.
    const beta = this.wasOpen ? 0 : Math.PI * (1 - smooth(t / HELI_UP));
    this.setBlade(o, beta, 0);
    if (t >= HELI_UP) this.isOpen = true;
    o.pose = e > 0.3 ? POSE.point : POSE.knife;
    o.poseTau = 0.06;
    if (this.mark(0, HELI_UP, t)) this.kick(o, 0.1, -0.25);
    const end = this.surfOut >= 0 ? this.surfOut + this.stopTime + HELI_OUT : Infinity;
    if (t >= end) {
      this.writeRest(o);
      return true;
    }
    return false;
  }
}
