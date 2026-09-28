/**
 * PROTOTYP (Kosmetik v2, nicht im Spiel): Jo-Jo als Unterklasse des bestehenden PropTricks-
 * Frameworks (src/ui/hand/propTricks.ts) — prüft, wie viel davon trägt.
 *
 * Was das Framework unverändert liefert: Event-Verteilung (jump/milestone/land/finish/respawn),
 * Tempo-Stufen, Abklingzeiten, "nie abbrechen", Marken/Impulse, Wackelfeder, motionFx, fresh-Flag.
 * Was fehlt (hier lokal ergänzt, im Entwurf als Vertrag): zweiter Körper (Jo-Jo selbst, `sub`),
 * Schnur (Rope), Checkpoint-Haken, Surf als Zustand ("schläft, solange du surfst").
 *
 * Koordinaten: Handgelenk-Raum wie PropOut. Der Schnur-Anker (Schlaufe am Mittelfinger) und die
 * Handflächen-Mitte kommen per FK von außen (Entwurf: aus VM_RIG + Pose, ui/hand/fk.ts).
 */
import type { GameEvent } from '../../../../src/engine/events';
import { POSE } from '../../../../src/ui/hand/poses';
import { arc, bell, smooth } from '../../../../src/ui/hand/anim';
import { PropTricks } from '../../../../src/ui/hand/propTricks';
import type { PropFrameInput, PropOut } from '../../../../src/ui/hand/propTricks';
import { VIEW_AXES } from '../../../../src/ui/hand/rot';
import { Rope } from './rope';

export const YOYO_TRICKS = ['none', 'sleeper', 'pass', 'snap', 'breakaway', 'around', 'aroundDouble', 'cradle'] as const;
export type YoyoTrick = Exclude<(typeof YOYO_TRICKS)[number], 'none'>;

export const YOYO_TIER_TRICKS: readonly (readonly YoyoTrick[])[] = [[], ['pass', 'snap'], ['breakaway', 'pass', 'snap'], ['around', 'breakaway', 'around']];

const COOLDOWN: { readonly [K in YoyoTrick]: number } = { sleeper: 1.0, pass: 0.6, snap: 0.5, breakaway: 0.8, around: 0.7, aroundDouble: 0.8, cradle: 1.0 };

/** Schnurlänge voll abgewickelt (Hand-Einheiten ≈ cm, Cartoon-kurz). */
export const YOYO_STRING = 9.5;
const THROW = 0.25;
const SLEEP = 1.2;
const RETURN = 0.25;
const LOOP = 1 / 1.8;
const TAU = Math.PI * 2;
const G = 980;
/** Scheinkraft-Faktor und Deckel (rope-bench.ts: × 1.5, 0.6 g — lebendig, aber nie schlaff). */
const CARTOON = 1.5;
const CAP_G = 0.6;

type Vec3 = [number, number, number];

export class YoyoTricks extends PropTricks<YoyoTrick> {
  /** Jo-Jo-Mitte im Handgelenk-Raum (zweiter Körper). */
  readonly sub = new Float32Array(3);
  /** Drehung des Jo-Jos um die eigene Achse (rad) — Schlafen = schnell. */
  subSpin = 0;
  readonly rope = new Rope({ segments: 8, length: YOYO_STRING, substep: 1 / 240, iterations: 4, endWeight: 0.15 });
  /** Schnur sichtbar (in der Hand aufgewickelt = aus). */
  stringOn = false;
  /** Surf-Schlafen läuft (freies Pendel bis Surf-Ende). */
  surfSleep = false;
  /** Probe: wie oft ein Trick an einem Checkpoint begann. */
  checkpointTricks = 0;

  private readonly anchor: Vec3;
  private readonly palm: Vec3;
  private spinRate = 0;
  private pick = 0;
  private loops = 1;
  private returnAt = -1;
  private ax = 0;
  private ay = 0;
  private tiltRad = 0;
  private readonly from = new Float32Array(3);

  constructor(anchor: Vec3, palm: Vec3) {
    super();
    this.anchor = anchor;
    this.palm = palm;
    this.writeRest(this.out);
    this.rope.reset(anchor[0], anchor[1], anchor[2], palm[0], palm[1], palm[2]);
  }

  /** Bewegung der Hand für die Schnur: Anker-Beschleunigung (Bildachsen, Einheiten/s²), Neigung (Grad). */
  setHandMotion(axView: number, ayView: number, tiltDeg: number): void {
    this.ax = Number.isFinite(axView) ? axView : 0;
    this.ay = Number.isFinite(ayView) ? ayView : 0;
    this.tiltRad = Number.isFinite(tiltDeg) ? (tiltDeg * Math.PI) / 180 : 0;
  }

  protected override start(id: YoyoTrick): void {
    super.start(id);
    this.returnAt = -1;
  }

  protected resetRun(): void {
    this.surfSleep = false;
    this.stringOn = false;
    this.spinRate = 0;
    this.writeRest(this.out);
  }

  protected writeRest(o: PropOut): void {
    o.pose = POSE.run;
    o.poseTau = 0.08;
    o.hx = 0;
    o.hy = 0;
    o.hz = 0;
    o.hpitch = 0;
    o.hyaw = 0;
    o.hroll = 0;
    o.spin = 0;
    o.visible = 1;
    o.scale = 1;
    o.poof = -1;
    const p = this.palm;
    if (p) {
      this.sub[0] = p[0];
      this.sub[1] = p[1];
      this.sub[2] = p[2];
      o.pos[0] = p[0];
      o.pos[1] = p[1];
      o.pos[2] = p[2];
    }
  }

  protected cooldownOf(id: YoyoTrick): number {
    return COOLDOWN[id];
  }

  protected onJump(tier: number, good: boolean): void {
    if (tier === 0) return;
    if (tier === 3) {
      this.loops = 1;
      this.start(good ? 'aroundDouble' : YOYO_TIER_TRICKS[3][this.pick++ % 3]);
    } else this.start(YOYO_TIER_TRICKS[tier][this.pick++ % YOYO_TIER_TRICKS[tier].length]);
  }

  protected onMilestone(tier: number): void {
    if (tier >= 3) this.start('aroundDouble');
    else if (tier === 2) this.start('breakaway');
  }

  protected onIdle(): number {
    this.start(this.pick++ % 3 === 2 ? 'cradle' : 'sleeper');
    return 3 + 2 * this.rand();
  }

  protected override onFinish(): void {
    this.start('cradle');
  }

  /** Neuer Haken (Entwurf: PropTricks.onCheckpoint): Breakaway zur Seite. */
  override onEvent(e: GameEvent): void {
    if (e.type === 'checkpoint' && !this.busy && this.motionFx > 0) {
      this.checkpointTricks++;
      this.start('breakaway');
    }
    super.onEvent(e);
  }

  protected override onFree(inp: PropFrameInput, speed: number): void {
    // Surf ab 500 u/s: Sleeper bis zum Surf-Ende (freies Pendel reagiert auf Neigung und Ruck).
    if (inp.surfing && speed >= 500) {
      this.surfSleep = true;
      this.start('sleeper');
    }
  }

  override update(dt: number, inp: PropFrameInput): void {
    super.update(dt, inp);
    const d = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.1) : 0;
    this.subSpin = (this.subSpin + this.spinRate * d) % TAU;
    const A = VIEW_AXES;
    const gs = Math.sin(this.tiltRad);
    const gc = Math.cos(this.tiltRad);
    for (let k = 0; k < 3; k++) this.rope.gravity[k] = G * (-A.up[k] * gc - A.right[k] * gs);
    let axv = CARTOON * this.ax;
    let ayv = CARTOON * this.ay;
    const l = Math.hypot(axv, ayv);
    if (l > CAP_G * G) {
      axv *= (CAP_G * G) / l;
      ayv *= (CAP_G * G) / l;
    }
    for (let k = 0; k < 3; k++) this.rope.accel[k] = A.right[k] * axv + A.up[k] * ayv;
    const a = this.anchor;
    if (!this.rope.freeEnd) {
      // Geführt: Schnur so lang wie der Abstand (+3 %) — gespannt wie beim echten Wurf.
      const dist = Math.hypot(this.sub[0] - a[0], this.sub[1] - a[1], this.sub[2] - a[2]);
      this.rope.setLength(Math.min(YOYO_STRING, Math.max(0.6, dist * 1.03)));
    }
    this.rope.update(d, a[0], a[1], a[2], this.sub[0], this.sub[1], this.sub[2]);
    if (this.rope.freeEnd) {
      this.sub[0] = this.rope.endX;
      this.sub[1] = this.rope.endY;
      this.sub[2] = this.rope.endZ;
    }
  }

  /** Jo-Jo = Anker + Bildrichtungen (rechts, oben, zur Kamera). */
  private place(right: number, up: number, cam: number): void {
    const A = VIEW_AXES;
    const a = this.anchor;
    for (let k = 0; k < 3; k++) this.sub[k] = a[k] + A.right[k] * right + A.up[k] * up + A.cam[k] * cam;
  }

  private lerpTo(to: readonly number[], u: number): void {
    for (let k = 0; k < 3; k++) this.sub[k] = this.from[k] + (to[k] - this.from[k]) * u;
  }

  private beginReturn(t: number, o: PropOut): void {
    this.returnAt = t;
    // writeRest hat sub schon auf die Handfläche gesetzt: frei hängend zählt die Pendelposition.
    if (this.rope.freeEnd) {
      this.from[0] = this.rope.endX;
      this.from[1] = this.rope.endY;
      this.from[2] = this.rope.endZ;
    } else this.from.set(this.sub);
    this.rope.freeEnd = false;
    this.surfSleep = false;
    this.kick(o, -0.35, 0.3);
  }

  /** Rückweg in die Hand; true = angekommen (mit Fang-Impuls). */
  private returning(t: number, o: PropOut): boolean {
    const u = Math.min(1, (t - this.returnAt) / RETURN);
    this.lerpTo(this.palm, smooth(u));
    this.stringOn = u < 1;
    this.spinRate *= 0.9;
    if (u >= 1 && this.mark(7, t, t)) {
      this.kick(o, 0.35, -0.8);
      this.spinKick(-1.2);
    }
    return u >= 1 && t >= this.returnAt + RETURN + 0.06;
  }

  protected evaluate(id: YoyoTrick, t: number, _dt: number, inp: PropFrameInput, _m: number, o: PropOut): boolean {
    this.stringOn = true;
    if (id === 'sleeper' || id === 'snap') {
      const sleep = id === 'snap' ? 0.05 : SLEEP;
      if (t < THROW) {
        const u = t / THROW;
        if (this.mark(0, 0, t)) this.kick(o, -0.3, 0);
        this.place(0.8 * u * u, -YOYO_STRING * 0.96 * u * u, 0.6 * u * u);
        this.spinRate = 60 * u;
        return false;
      }
      if (this.returnAt < 0) {
        const sleeping = this.surfSleep ? inp.surfing : t < THROW + sleep;
        if (sleeping) {
          if (!this.rope.freeEnd) {
            this.rope.freeEnd = true;
            this.rope.setLength(YOYO_STRING);
          }
          this.spinRate = 60;
          o.pose = POSE.relaxed;
          return false;
        }
        this.beginReturn(t, o);
      }
      return this.returning(t, o);
    }
    if (id === 'pass') {
      const T = 0.7;
      if (this.returnAt < 0) {
        const u = t / T;
        const e = arc(Math.min(1, u / 0.85));
        this.place(-6 * e, 2.5 * e, -5 * e);
        this.spinRate = 50;
        o.pose = POSE.relaxed;
        if (this.mark(0, 0.02, t)) this.kick(o, -0.25, 0);
        if (u >= 0.85) this.beginReturn(t, o);
        return false;
      }
      return this.returning(t, o);
    }
    if (id === 'breakaway') {
      const T = 0.8;
      if (this.returnAt < 0) {
        const u = t / T;
        // Seitwurf: Bogen rechts-unten → unter der Hand durch → nach vorn-links hoch.
        const ang = -0.55 * Math.PI + 1.25 * Math.PI * smooth(u);
        const r = YOYO_STRING * 0.9 * Math.min(1, u * 5);
        this.place(-Math.sin(ang) * r, -Math.cos(ang) * r, -2 * bell(u));
        this.spinRate = 55;
        o.hroll = -0.2 * bell(u);
        if (this.mark(0, 0, t)) this.kick(o, -0.3, 0);
        if (u >= 1) this.beginReturn(t, o);
        return false;
      }
      return this.returning(t, o);
    }
    if (id === 'around' || id === 'aroundDouble') {
      const loops = id === 'aroundDouble' ? 2 : this.loops;
      const W = 0.15;
      const L = loops * LOOP;
      if (t < W) {
        const u = t / W;
        this.place(0.5 * u, -YOYO_STRING * 0.9 * smooth(u), 0);
        if (this.mark(0, 0, t)) this.kick(o, -0.3, 0);
        return false;
      }
      if (this.returnAt < 0) {
        // Kreis in der Bildebene um den Anker: von unten nach vorn-links hoch, oben rüber.
        const ph = Math.min(1, (t - W) / L) * loops * TAU;
        const r = YOYO_STRING * 0.9;
        this.place(-Math.sin(ph) * r * 0.85, -Math.cos(ph) * r, -1.5 * Math.sin(ph));
        this.spinRate = 70;
        o.hroll = 0.12 * Math.sin(ph);
        if (t >= W + L) this.beginReturn(t, o);
        return false;
      }
      return this.returning(t, o);
    }
    // cradle ("Rock the Baby" — Prototyp: Pendel-Schwung vor der Hand; Entwurf: Schnur-Dreieck
    // über Daumen- und Zeigefingerspitze, zwei Innenpunkte der Kette dort festgepinnt).
    const T = 1.8;
    if (this.returnAt < 0) {
      const u = t / T;
      const swingA = 0.5 * Math.sin(TAU * 1.6 * t) * bell(u);
      const r = 5.5 * bell(Math.min(1, u * 1.3));
      this.place(Math.sin(swingA) * r, -Math.cos(swingA) * r + 1.5 * bell(u), 1.5 * bell(u));
      this.spinRate = 45;
      o.pose = POSE.open;
      o.hy = -0.03 * bell(u);
      if (u >= 1) this.beginReturn(t, o);
      return false;
    }
    return this.returning(t, o);
  }
}
