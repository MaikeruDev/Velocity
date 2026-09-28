import { VM_STRING_POINTS } from '../../render/types';
import { arc, bell, clamp, fin, smooth } from './anim';
import { KNIFE_HOLD_POS } from './knifeTricks';
import { POSE } from './poses';
import { PropTricks } from './propTricks';
import type { PropFrameInput, PropOut } from './propTricks';
import { VIEW_ALIGNED, VIEW_AXES, axisAngle, fromEulerXYZ, mat3, mul, toEulerXYZ } from './rot';
import type { Mat3 } from './rot';
import { Rope, RopeDrive } from './rope';
import { socketOf, socketPoint, viewPoint, viewRot } from './view';
import type { V3 } from './view';

/**
 * Kendama (Plan 007, KI6): Ken in der Faust (Pose knife), Kugel (tama) an 9 Einheiten Schnur als
 * zweiter Körper. In Ruhe hängt die Kugel als freies Pendel (Verlet-Schnur, RopeDrive).
 *
 * Fänge sind Zeitleisten, keine Physik fürs Ergebnis: die Kugel fliegt von der Pendel-Lage auf einer
 * Bahn in den Becher, und ab der Fang-Marke steht ihre Mitte EXAKT auf dem Becherpunkt — gerechnet
 * mit derselben Sockel-Transformation wie der Renderer (view.socketPoint: pos + R·(s·Ry(spin)·p)),
 * also bei jeder Framerate ohne Rest. Fang = "Klack" (Hand y +0.35, Squash −0.8).
 *
 * Für einen Becher-Fang kippen Hand und Ken den Becher nach oben (~70°); danach kippen sie zurück und
 * die Kugel fällt frei zurück ins Pendel. Tricks: Stand bigCup / smallCup, jedes 3. Mal aroundJapan
 * (klein → groß → Spitze); Lauf bigCup; Flow smallCup / bigCup; Overdrive / guter Hop spike (Kugel dreht
 * das Loch nach unten, landet auf der Spitze), Meilenstein aroundJapan; Surf ≥ 500 = Zustand cupRide
 * (liegt im großen Becher, rollt mit der Rampe); Checkpoint bigCup; Ziel spike mit Ken hoch.
 */

export const KENDAMA_TRICKS = ['none', 'bigCup', 'smallCup', 'aroundJapan', 'spike', 'cupRide'] as const;
export type KendamaTrick = Exclude<(typeof KENDAMA_TRICKS)[number], 'none'>;
const KENDAMA_NAMES: readonly string[] = KENDAMA_TRICKS.filter((t) => t !== 'none');

/** Tricks je Tempo-Stufe bei Sprüngen (Tests prüfen genau diese Zuordnung). */
export const KENDAMA_TIER_TRICKS: readonly (readonly KendamaTrick[])[] = [[], ['bigCup'], ['smallCup', 'bigCup'], ['spike', 'bigCup']];

/** Schnur (Hand-Einheiten): hängend bleibt die Kugel so im Bild (11 war zu lang). */
export const KEN_STRING = 9;
export const TAMA_R = 1.9;
/** Punkte im Ken-Raum (items/kendama: großer Becher +x, kleiner −x, Spitze oben). Kugel-Mitte beim Fang. */
export const KEN_BIG_CUP: V3 = [3.75, 0.3, 0];
export const KEN_SMALL_CUP: V3 = [-4.35, 0.3, 0];
export const KEN_SPIKE: V3 = [0, 3.5, 0];
export const KEN_STRING_AT: V3 = [0, 0.3, 0.9];

/** Griff: Handgriff-Mitte (Ken y −1.8) im Faust-Tunnel der Messer-Pose, Spitze oben, leicht nach links. */
const KEN_TILT = 0.25;
export const KEN_HOLD_ROT: V3 = viewRot([[2, KEN_TILT]]);
export const KEN_HOLD_POS: V3 = viewPoint([KNIFE_HOLD_POS[0], KNIFE_HOLD_POS[1], KNIFE_HOLD_POS[2]], -Math.sin(KEN_TILT) * 0.2, Math.cos(KEN_TILT) * 0.2, 0.4);
/** Kippwinkel (Bild, gegen den Uhrzeigersinn positiv): großer Becher nach oben (+), kleiner (−); Anteil Hand. */
const CUP_TILT = 1.2;
const HAND_SHARE = 0.45;

/** Abklingzeiten (event-probe): Overdrive-Tricks länger, sonst läge L1 bei sync 1.0 über 45 % Trick-Anteil. */
const COOLDOWN: { readonly [K in KendamaTrick]: number } = { bigCup: 0.7, smallCup: 0.8, aroundJapan: 1.2, spike: 1.3, cupRide: 0.5 };
const TURN = 0.15;
const FLIGHT = 0.38;
/** Liegen im Becher (s) — kurz: der Takt (event-probe) lag mit 0.8 s bei 55–60 % Trick-Anteil. */
const HOLD = 0.2;
const BACK = 0.22;
const AJ_SMALL = TURN + FLIGHT;
const AJ_HOP1 = AJ_SMALL + 0.2;
const AJ_BIG = AJ_HOP1 + 0.45;
const AJ_HOP2 = AJ_BIG + 0.15;
const AJ_SPIKE = AJ_HOP2 + 0.45;
const AJ_T = AJ_SPIKE + 0.3 + BACK;
const SPIKE_LAUNCH = 0.12;
const SPIKE_CATCH = SPIKE_LAUNCH + 0.44;
const SPIKE_SHOW = 0.2;
const SPIKE_T = SPIKE_CATCH + SPIKE_SHOW + BACK;
const SURF_FROM = 500;
const SURF_MIN = 0.5;

const enum Ball {
  /** Freies Pendel. */
  Free = 0,
  /** Flug von `from` zum Ziel (Bahn), Anteil `fly`. */
  Fly = 1,
  /** Liegt im Ziel (exakt). */
  Caught = 2,
}

type V = Float64Array;

/** Winkel auf (−π, π]. */
function wrapPi(a: number): number {
  const t = Math.PI * 2;
  const r = a - t * Math.floor((a + Math.PI) / t);
  return r;
}

export class KendamaTricks extends PropTricks<KendamaTrick> {
  readonly rope = new Rope({ segments: VM_STRING_POINTS - 1, length: KEN_STRING, substep: 1 / 240, iterations: 4, endWeight: 0.15 });
  readonly drive = new RopeDrive();
  private pick = 0;
  private idleCount = 0;
  // Zeitleisten-Ergebnis → Aufbau in afterPose (braucht die Ken-Lage dieses Frames).
  private ball: Ball = Ball.Free;
  private target: V3 = KEN_BIG_CUP;
  /** Start der Bahn: Kugel-Mitte (Handgelenk-Raum), einmal beim Abwurf eingefangen. */
  private readonly from: V = new Float64Array(3);
  private fromTarget: V3 | null = null;
  private fly = 0;
  private hop = 3;
  /** Kugel-Drehung um die Bild-Tiefenachse (Loch nach unten beim Spitzen-Fang). */
  private ballTurn = 0.5;
  /** Zuletzt in subRot geschriebene Drehung (NaN = noch nie). */
  private shownTurn = Number.NaN;
  private launched = -1;
  /** Trick-Zeit, ab der die Kugel wieder frei ist (Loslassen nach dem Fang), −1 = noch nicht. */
  private releaseAt = -1;
  private surfOut = -1;
  // Scratch
  private readonly tmp: V = new Float64Array(3);
  private readonly tmp2: V = new Float64Array(3);
  private readonly tmp3: V = new Float64Array(3);
  private readonly rA: Mat3 = mat3();
  private readonly rB: Mat3 = mat3();

  constructor() {
    super();
    this.rope.drive = this.drive;
    this.hangAtRest();
  }

  /** Kugel hängt ruhig unter dem Ken in Ruhelage (Start, Respawn, Tools). */
  private hangAtRest(): void {
    this.writeRest(this.out);
    const o = this.out;
    socketPoint(o.pos, o.rot, o.spin, o.scale, KEN_STRING_AT[0], KEN_STRING_AT[1], KEN_STRING_AT[2], this.tmp);
    const A = VIEW_AXES;
    for (let k = 0; k < 3; k++) this.tmp2[k] = this.tmp[k] - A.up[k] * KEN_STRING;
    this.rope.freeEnd = true;
    this.rope.reset(this.tmp[0], this.tmp[1], this.tmp[2], this.tmp2[0], this.tmp2[1], this.tmp2[2]);
    o.sub[0] = this.tmp2[0];
    o.sub[1] = this.tmp2[1];
    o.sub[2] = this.tmp2[2];
    this.ballTurn = 0;
  }

  /**
   * Tools: ein FESTGEHALTENER Start (at ≥ 0, Kontaktblätter) beginnt mit ruhig hängender Kugel —
   * reproduzierbar, auch wenn die Dev-Seite den Trick jeden Frame neu setzt. Frei laufend (at < 0,
   * __vel.forceTrick, Tests) startet er aus dem laufenden Pendel wie im Spiel.
   */
  override debugPlayName(name: string, at: number): boolean {
    if (at >= 0 && name !== 'none' && this.isTrick(name)) this.hangAtRest();
    return super.debugPlayName(name, at);
  }

  override get trickNames(): readonly string[] {
    return KENDAMA_NAMES;
  }

  protected override isState(id: KendamaTrick): boolean {
    return id === 'cupRide';
  }

  protected resetRun(): void {
    this.drive.reset();
    this.hangAtRest();
  }

  protected override start(id: KendamaTrick): void {
    super.start(id);
    this.launched = -1;
    this.releaseAt = -1;
    this.surfOut = -1;
    this.fromTarget = null;
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
    o.pos[0] = KEN_HOLD_POS[0];
    o.pos[1] = KEN_HOLD_POS[1];
    o.pos[2] = KEN_HOLD_POS[2];
    o.rot[0] = KEN_HOLD_ROT[0];
    o.rot[1] = KEN_HOLD_ROT[1];
    o.rot[2] = KEN_HOLD_ROT[2];
    o.spin = 0;
    o.visible = 1;
    o.scale = 1;
    o.poof = -1;
    o.subVisible = 1;
    this.ball = Ball.Free;
  }

  protected cooldownOf(id: KendamaTrick): number {
    return COOLDOWN[id];
  }

  protected onJump(tier: number, good: boolean): void {
    if (tier === 0) return;
    const list = KENDAMA_TIER_TRICKS[tier];
    if (tier === 3 && good) this.start('spike');
    else this.start(list[this.pick++ % list.length]);
  }

  protected onMilestone(tier: number): void {
    // Meilensteine achten auf die Abklingzeit (event-probe: sonst L1 bei sync 1.0 über 45 % Trick-Anteil).
    if (this.now < this.cooldownUntil) return;
    if (tier >= 3) this.start('aroundJapan');
    else if (tier === 2) this.start('smallCup');
  }

  protected onIdle(): number {
    const k = this.idleCount++ % 3;
    this.start(k === 2 ? 'aroundJapan' : k === 1 ? 'smallCup' : 'bigCup');
    return 3 + 2 * this.rand();
  }

  protected override onFinish(): void {
    this.start('spike');
  }

  protected override onCheckpoint(_split: number | null): void {
    this.start('bigCup');
  }

  protected override onSurfStart(speed: number): void {
    if (speed >= SURF_FROM) this.start('cupRide');
  }

  protected override onFree(inp: PropFrameInput, speed: number): void {
    if (inp.surfing && speed >= SURF_FROM) this.start('cupRide');
  }

  /** Ken kippen: Anteil Hand (hroll), Rest im Griff (Drehung um die Bild-Tiefenachse). */
  private tilt(o: PropOut, a: number): void {
    o.hroll += a * HAND_SHARE;
    this.rotateView(o, 0, 0, 1, a * (1 - HAND_SHARE));
  }

  /** Abwurf: Kugel-Lage (Pendel) einfangen — einmal, ab `at`. */
  private launch(t: number, at: number, o: PropOut): void {
    if (this.launched < 0 && t >= at) {
      this.launched = at;
      this.from[0] = o.sub[0];
      this.from[1] = o.sub[1];
      this.from[2] = o.sub[2];
      this.fromTarget = null;
    }
  }

  /** Flug zum Ziel (Scheitel `hop` über der Geraden) oder, ab 1, exakt im Ziel. */
  private aim(target: V3, s: number, hop: number): void {
    this.target = target;
    this.hop = hop;
    if (s >= 1) {
      this.ball = Ball.Caught;
      return;
    }
    this.ball = Ball.Fly;
    this.fly = s;
  }

  /** Hop von einem Fangpunkt zum nächsten (Start = Fangpunkt im Ken-Raum, mitbewegt). */
  private hopFrom(from: V3, target: V3, s: number, hop: number): void {
    this.fromTarget = from;
    this.aim(target, s, hop);
  }

  /** Tests/Tools: Kugel liegt gerade exakt auf diesem Fangpunkt (KEN_BIG_CUP, KEN_SMALL_CUP, KEN_SPIKE). */
  caughtOn(target: V3): boolean {
    return this.ball === Ball.Caught && this.target === target;
  }

  private klack(o: PropOut): void {
    this.kick(o, 0.35, -0.8);
    this.spinKick(0.5);
  }

  protected evaluate(id: KendamaTrick, t: number, _dt: number, inp: PropFrameInput, _m: number, o: PropOut): boolean {
    if (id === 'bigCup' || id === 'smallCup') return this.cupCatch(id === 'bigCup', t, o);
    if (id === 'spike') return this.spike(t, o);
    if (id === 'aroundJapan') return this.aroundJapan(t, o);
    return this.cupRide(t, inp, o);
  }

  /** Becher-Fang: kippen, abwerfen, Klack, liegen lassen, zurückkippen — Kugel fällt frei ins Pendel. */
  private cupCatch(big: boolean, t: number, o: PropOut): boolean {
    const sign = big ? 1 : -1;
    const total = TURN + FLIGHT + HOLD + BACK;
    const back = smooth((t - TURN - FLIGHT - HOLD) / BACK);
    const e = smooth(t / TURN) * (1 - back);
    this.tilt(o, sign * CUP_TILT * e);
    if (this.mark(0, 0, t)) this.kick(o, 0.12, 0);
    if (t < TURN) {
      o.hy = 0.015 * bell(t / TURN);
      return false;
    }
    this.launch(t, TURN, o);
    if (this.mark(1, TURN, t)) this.kick(o, -0.3, 0);
    if (t < TURN + FLIGHT + HOLD) {
      this.aim(big ? KEN_BIG_CUP : KEN_SMALL_CUP, (t - TURN) / FLIGHT, 4.5);
      if (this.mark(2, TURN + FLIGHT, t)) this.klack(o);
      o.hy = -0.012 * bell(clamp((t - TURN - FLIGHT) / HOLD, 0, 1));
      return false;
    }
    // Zurückkippen: Kugel frei (fällt aus dem Becher, schwingt ins Pendel).
    this.releaseAt = TURN + FLIGHT + HOLD;
    return t >= total;
  }

  /** Spitze: Kugel dreht das Loch nach unten und landet auf der Spitze. */
  private spike(t: number, o: PropOut): boolean {
    if (t < SPIKE_LAUNCH) {
      if (this.mark(0, 0, t)) this.kick(o, 0.15, 0);
      o.hy = 0.02 * bell(t / SPIKE_LAUNCH);
      return false;
    }
    this.launch(t, SPIKE_LAUNCH, o);
    if (this.mark(1, SPIKE_LAUNCH, t)) this.kick(o, -0.45, 0);
    const s = (t - SPIKE_LAUNCH) / (SPIKE_CATCH - SPIKE_LAUNCH);
    const release = SPIKE_CATCH + SPIKE_SHOW;
    // Loch nach unten: halbe Drehung plus eine volle, am Fang genau auf die Ken-Achse. Ab dem Loslassen
    // klingt die Drehung frei ab (afterPose) — hier nicht mehr setzen, sonst hinge das Abklingen am Frame.
    if (t < release) this.ballTurn = Math.PI * 3 * smooth(Math.min(1, s)) + KEN_TILT;
    if (t < release) {
      this.aim(KEN_SPIKE, s, 5.5);
      if (this.mark(2, SPIKE_CATCH, t)) this.klack(o);
      // Ken hoch zeigen.
      o.hy = -0.03 * bell(clamp((t - SPIKE_CATCH) / 0.5, 0, 1));
      return false;
    }
    this.releaseAt = release;
    if (this.mark(3, release, t)) this.kick(o, -0.15, 0);
    return t >= SPIKE_T;
  }

  /** Around Japan: kleiner Becher → großer Becher → Spitze, dann frei. */
  private aroundJapan(t: number, o: PropOut): boolean {
    // Kippen: klein (−), dann groß (+), dann aufrecht für die Spitze.
    let a: number;
    if (t < AJ_HOP1) a = -CUP_TILT * smooth(t / TURN);
    else if (t < AJ_BIG) a = -CUP_TILT + 2 * CUP_TILT * smooth((t - AJ_HOP1) / (AJ_BIG - AJ_HOP1));
    else if (t < AJ_HOP2) a = CUP_TILT;
    else a = CUP_TILT * (1 - smooth((t - AJ_HOP2) / (AJ_SPIKE - AJ_HOP2)));
    this.tilt(o, a);
    if (t < TURN) {
      if (this.mark(0, 0, t)) this.kick(o, 0.12, 0);
      return false;
    }
    this.launch(t, TURN, o);
    if (this.mark(1, TURN, t)) this.kick(o, -0.3, 0);
    const release = AJ_SPIKE + 0.3;
    if (t < AJ_HOP1) {
      this.aim(KEN_SMALL_CUP, (t - TURN) / FLIGHT, 4);
      if (this.mark(2, AJ_SMALL, t)) this.klack(o);
    } else if (t < AJ_HOP2) {
      this.hopFrom(KEN_SMALL_CUP, KEN_BIG_CUP, (t - AJ_HOP1) / (AJ_BIG - AJ_HOP1), 4.5);
      if (this.mark(3, AJ_BIG, t)) this.klack(o);
    } else if (t < release) {
      this.ballTurn = (Math.PI * 3 + KEN_TILT) * smooth((t - AJ_HOP2) / (AJ_SPIKE - AJ_HOP2));
      this.hopFrom(KEN_BIG_CUP, KEN_SPIKE, (t - AJ_HOP2) / (AJ_SPIKE - AJ_HOP2), 4);
      if (this.mark(4, AJ_SPIKE, t)) this.klack(o);
    } else this.releaseAt = release;
    return t >= AJ_T;
  }

  /** Surf: Kugel in den großen Becher, liegt dort und rollt mit der Rampe; Surf-Ende → frei. */
  private cupRide(t: number, inp: PropFrameInput, o: PropOut): boolean {
    if (this.surfOut < 0 && !inp.surfing && t >= SURF_MIN) this.surfOut = t;
    const out = this.surfOut < 0 ? 0 : smooth((t - this.surfOut) / BACK);
    const e = smooth(t / TURN) * (1 - out);
    this.tilt(o, (CUP_TILT - 0.25 * this.surfLean) * e);
    this.offsetView(o, 0.4 * e, 1.0 * e, 0.8 * e);
    if (t < TURN) return false;
    this.launch(t, TURN, o);
    if (this.mark(0, TURN, t)) this.kick(o, -0.3, 0);
    if (this.surfOut < 0 || t < this.surfOut) {
      this.aim(KEN_BIG_CUP, (t - TURN) / FLIGHT, 4.5);
      if (this.mark(1, TURN + FLIGHT, t)) this.klack(o);
      return false;
    }
    this.releaseAt = this.surfOut;
    return t >= this.surfOut + BACK;
  }

  /**
   * Nach dem Überblenden: Kugel aus Ken-Lage (o.pos/o.rot, wie der Renderer) und Zeitleiste; Schnur
   * vom Ken zur Kugel (frei = Pendel, sonst geführt, Länge fest — locker durchhängend).
   */
  override afterPose(_joints: ArrayLike<number>, inp: PropFrameInput, dtRaw: number): void {
    const dt = Number.isFinite(dtRaw) ? clamp(dtRaw, 0, 0.1) : 0;
    const o = this.out;
    const rope = this.rope;
    const st = this.tmp;
    socketOf(o, KEN_STRING_AT, st);
    const s = o.sub;
    const free = this.ball === Ball.Free || this.motionFx <= 0;
    this.drive.setFrameFrom(inp, this.motionFx);
    // Wechsel frei ↔ geführt mitten im Frame (Abwurf, Loslassen): Schnur bis zur Marke im alten Modus.
    const sw = free === rope.freeEnd || this.motionFx <= 0 ? -1 : free ? this.releaseAt : this.launched;
    const back = sw >= 0 ? this.t - sw : -1;
    if (back >= 0 && back < dt) this.switchFrame(dt, back, free, st);
    else {
      if (!free) this.placeBall(s);
      rope.freeEnd = free;
      rope.updateV(dt, st, s);
    }
    if (free) {
      s[0] = rope.endX;
      s[1] = rope.endY;
      s[2] = rope.endZ;
      // Loch-Drehung klingt ab dem Loslassen ab (auf ±π gefaltet: keine drei Rückwärts-Drehungen).
      if (back >= 0 && back < dt) this.ballTurn = wrapPi(this.ballTurn);
      this.ballTurn *= Math.exp(-(back >= 0 && back < dt ? back : dt) / 0.25);
    }
    this.writeBallRot(o);
    o.stringCount = rope.n;
    o.string.set(rope.out);
  }

  /**
   * Frame mit Moduswechsel `back` s vor seinem Ende. Loslassen: bis dahin im Becher (Lage zwischen der
   * letzten und dieser Becher-Lage), dann frei. Abwurf: bis dahin Pendel, die Bahn beginnt EXAKT an der
   * Pendel-Lage zur Marke (vorher: an der vom letzten Frame-Ende).
   */
  private switchFrame(dt: number, back: number, free: boolean, st: V): void {
    const rope = this.rope;
    const s = this.out.sub;
    const k = 1 - back / dt;
    if (free) {
      const o = this.out;
      const tg = this.target;
      const e = this.tmp2;
      socketOf(o, tg, e);
      const m = this.tmp3;
      for (let i = 0; i < 3; i++) m[i] = s[i] + (e[i] - s[i]) * k;
      rope.updatePart(dt, k, st, m);
      rope.freeEnd = true;
      if (back > 0) rope.updateRest(dt, k, st, st);
      return;
    }
    rope.updatePart(dt, k, st, s);
    this.from[0] = rope.endX;
    this.from[1] = rope.endY;
    this.from[2] = rope.endZ;
    this.fromTarget = null;
    rope.freeEnd = false;
    this.placeBall(s);
    if (back > 0) rope.updateRest(dt, k, st, s);
  }

  /** Kugel-Mitte für Flug/Fang aus der aktuellen Ken-Lage. */
  private placeBall(s: Float32Array): void {
    const o = this.out;
    const tg = this.target;
    const end = this.tmp2;
    socketOf(o, tg, end);
    if (this.ball === Ball.Caught) {
      // Exakt im Becher/auf der Spitze (gleiche Transformation wie der Renderer).
      s[0] = end[0];
      s[1] = end[1];
      s[2] = end[2];
      return;
    }
    const f = this.fromTarget;
    const from = this.from;
    if (f) socketOf(o, f, from);
    const u = this.fly;
    const e = smooth(u);
    const A = VIEW_AXES;
    for (let k = 0; k < 3; k++) s[k] = from[k] + (end[k] - from[k]) * e + A.up[k] * this.hop * arc(u);
  }

  /** Kugel-Lage: aufrecht (Loch oben) im Bild, um die Tiefenachse gedreht (ballTurn). Nur bei Änderung. */
  private writeBallRot(o: PropOut): void {
    if (Math.abs(this.ballTurn) < 1e-4) this.ballTurn = 0;
    if (this.ballTurn === this.shownTurn) return;
    this.shownTurn = this.ballTurn;
    const A = VIEW_AXES;
    axisAngle(this.rA, A.cam[0], A.cam[1], A.cam[2], this.ballTurn);
    fromEulerXYZ(this.rB, VIEW_ALIGNED[0], VIEW_ALIGNED[1], VIEW_ALIGNED[2]);
    mul(this.rB, this.rA, this.rB);
    toEulerXYZ(this.rB, o.subRot);
  }
}
