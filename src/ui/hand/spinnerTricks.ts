import type { GameEvent } from '../../engine/events';
import { VM_PARAM } from '../../render/types';
import { arc, bell, clamp, fin, smooth } from './anim';
import { fingerTip } from './fk';
import { POSE, POSE_JOINTS } from './poses';
import { PropTricks } from './propTricks';
import type { PropFrameInput, PropOut } from './propTricks';
import { VIEW_ALIGNED } from './rot';
import { viewPoint, viewRot } from './view';
import type { V3 } from './view';

/**
 * Fidget-Spinner (Plan 007, K5): "Tacho in der Hand". Die Drehzahl folgt dem Tempo
 * (ω = 6 + 0.07 · Tempo rad/s, hoch τ 0.8 s, runter 3 s), jeder Sprung schnippt nach (+8, guter Hop
 * (jump.clean) +14, Meilenstein +20; Deckel 110 rad/s). Gehalten im Pinch zwischen Daumen und Zeigefinger.
 *
 * Tricks je Tempo (Takt gemessen mit tools/cosmetics/event-probe.ts):
 * - Stand: flick (Daumen schnippt), jedes 3. Mal swap (auf die Zeigefinger-Spitze und zurück),
 * - Lauf: flick, Flow: toss (flach drehend hoch, Fang im Pinch) / swap im Wechsel,
 * - Overdrive / Ziel: ufo (hoch wie ein UFO, Fang auf der Fingerspitze), guter Hop im Wechsel ufo / toss,
 * - Surf ≥ 500 u/s: Zustand balance — auf der Fingerspitze, die Achse präzediert (Kreis ∝ 1/ω) und
 *   neigt sich mit der Rampe, hüpft als Einlage kurz hoch; endet mit dem Surf ("nie abbrechen" bleibt wahr),
 * - Checkpoint: großer flick, die Nabe blinkt grün (vor der Bestzeit) oder rot (dahinter).
 *
 * Gegen Wagenrad-Aliasing (3-fache Symmetrie) zeigt der Renderer höchstens 0.9 rad Drehung pro
 * Frame; darüber blendet ein Unschärfe-Ring (Bayer-Screen-Door) ein. Das ist absichtlich pro Frame
 * (Aliasing entsteht pro Frame) — Winkel und Unschärfe sind deshalb NICHT framerate-unabhängig,
 * ω und alle Zeitleisten schon. motionFx 0: der Spinner steht.
 */

export const SPINNER_TRICKS = ['none', 'flick', 'swap', 'toss', 'ufo', 'balance'] as const;
export type SpinnerTrick = Exclude<(typeof SPINNER_TRICKS)[number], 'none'>;
const SPINNER_NAMES: readonly string[] = SPINNER_TRICKS.filter((t) => t !== 'none');

/** Tricks je Tempo-Stufe bei Sprüngen (Tests prüfen genau diese Zuordnung). */
export const SPINNER_TIER_TRICKS: readonly (readonly SpinnerTrick[])[] = [[], ['flick'], ['toss', 'swap'], ['ufo', 'toss']];

/** Drehzahl: Ziel ω = BASE + PER_SPEED · Tempo (rad/s). */
export const SPINNER_OMEGA_BASE = 6;
export const SPINNER_OMEGA_PER_SPEED = 0.07;
export const SPINNER_OMEGA_MAX = 110;
const TAU_UP = 0.8;
const TAU_DOWN = 3;
const KICK_JUMP = 8;
const KICK_PERFECT = 14;
const KICK_MILESTONE = 20;
const KICK_FLICK = 10;
const KICK_FLICK_BIG = 20;
/** Größter angezeigter Drehschritt pro Frame (rad) — darüber Unschärfe statt Wagenrad. */
export const SPINNER_STEP_CAP = 0.9;
const BLUR_FROM = 0.75;
const BLUR_MAX = 0.45;
/** Rotor ist 3-fach symmetrisch: Winkel nur modulo 2π/3 nötig (bleibt klein, keine Präzisionsverluste). */
const SYM = (Math.PI * 2) / 3;
const SURF_FROM = 500;

const COOLDOWN = { flick: 1.0, swap: 1.0, toss: 1.3, ufo: 1.2, balance: 0.5 } as const;
const FLICK_TIME = 0.4;
const SWAP_TIME = 1.0;
const TOSS_WINDUP = 0.08;
const TOSS_AIR = 0.55;
const TOSS_TOTAL = 0.8;
const UFO_WINDUP = 0.1;
const UFO_AIR = 0.75;
const UFO_BACK = 0.25;
const UFO_TOTAL = UFO_WINDUP + UFO_AIR + UFO_BACK;
const BAL_IN = 0.25;
const BAL_OUT = 0.3;
const BAL_MIN = 0.5;
/** Einlage im Surf-Zustand: Scheitel des Hüpfers von der Fingerspitze (Einheiten). */
const BEAT_HOP = 3.2;
const HUB_TIME = 0.9;

/** Mitte im Pinch (Handgelenk-Raum): an der Karten-Griffstelle, zu den Fingerkuppen gerückt. */
export const SPINNER_HOLD_POS: V3 = viewPoint([-5.6, 11.9, -1.2], 0.6, -0.8, 0.3);
/** Liegt fast flach zur Kamera, leicht gekippt (man sieht Lappen und Dicke). */
const HOLD_TILT_RIGHT = -0.35;
const HOLD_TILT_UP = 0.3;
export const SPINNER_HOLD_ROT: V3 = viewRot([
  [0, HOLD_TILT_RIGHT],
  [1, HOLD_TILT_UP],
]);
/** Auf der Zeigefinger-Spitze (Pose point, per FK): Nabe knapp über der Kuppe, Oberseite zu uns gekippt. */
const TIP_TILT_RIGHT = -0.95;
export const SPINNER_TIP_POS: V3 = ((): V3 => {
  const tip = fingerTip(POSE_JOINTS[POSE.point], 0, [0, 0, 0], 0.9);
  return viewPoint([tip[0], tip[1], tip[2]], 0, 0.7, 0);
})();

const P = VM_PARAM.spinner;
/** Größer als ein echter Spinner (7 cm): im Low-Res-Bild liest er sich sonst als kleines Kreuz. */
const SPINNER_SCALE = 1.25;

export class SpinnerTricks extends PropTricks<SpinnerTrick> {
  /** Drehzahl (rad/s). */
  omega = SPINNER_OMEGA_BASE;
  /** Angezeigter Rotor-Winkel (rad, modulo 2π/3) und Unschärfe 0..1 (Tools/Tests). */
  shownAngle = 0;
  blur = 0;
  private pick = 0;
  private goodCount = 0;
  private milestoneCount = 0;
  private idleCount = 0;
  private bigFlick = false;
  private hubSign = 0;
  private hubT = HUB_TIME;
  /** Balance: Ende des Surfs (Trick-Zeit), −1 = läuft noch. */
  private balOut = -1;
  private precess = 0;
  /** Trick-Zeit beim letzten Präzessions-Schritt (der erste Frame eines Tricks ist τ 0, #77). */
  private precessT = 0;
  /** ω am Frame-Anfang (Trapez für die Präzession). */
  private omegaStart = SPINNER_OMEGA_BASE;

  override get trickNames(): readonly string[] {
    return SPINNER_NAMES;
  }

  protected override isState(id: SpinnerTrick): boolean {
    return id === 'balance';
  }

  protected resetRun(): void {
    this.omega = SPINNER_OMEGA_BASE;
    this.hubT = HUB_TIME;
    this.hubSign = 0;
    this.balOut = -1;
    this.writeRest(this.out);
  }

  protected override start(id: SpinnerTrick): void {
    super.start(id);
    this.balOut = -1;
    this.bigFlick = false;
    this.precess = 0;
    this.precessT = 0;
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
    this.place(o, 0);
    o.spin = 0;
    o.visible = 1;
    o.scale = SPINNER_SCALE;
    o.poof = -1;
  }

  /** Ort und Lage zwischen Pinch (e = 0) und Fingerspitze (e = 1). */
  private place(o: PropOut, e: number): void {
    const h = SPINNER_HOLD_POS;
    const t = SPINNER_TIP_POS;
    o.pos[0] = h[0] + (t[0] - h[0]) * e;
    o.pos[1] = h[1] + (t[1] - h[1]) * e;
    o.pos[2] = h[2] + (t[2] - h[2]) * e;
    if (e <= 0) {
      o.rot[0] = SPINNER_HOLD_ROT[0];
      o.rot[1] = SPINNER_HOLD_ROT[1];
      o.rot[2] = SPINNER_HOLD_ROT[2];
      return;
    }
    o.rot[0] = VIEW_ALIGNED[0];
    o.rot[1] = VIEW_ALIGNED[1];
    o.rot[2] = VIEW_ALIGNED[2];
    this.rotateView(o, 1, 0, 0, HOLD_TILT_RIGHT + (TIP_TILT_RIGHT - HOLD_TILT_RIGHT) * e);
    this.rotateView(o, 0, 1, 0, HOLD_TILT_UP * (1 - e));
  }

  protected cooldownOf(id: SpinnerTrick): number {
    return COOLDOWN[id];
  }

  /** Schnipp-Impulse kommen bei JEDEM Sprung (auch mitten im Trick) — die Drehzahl ist der Tacho. */
  override onEvent(e: GameEvent): void {
    if (this.motionFx > 0) {
      if (e.type === 'jump') this.addOmega(e.clean && e.gain > 0 ? KICK_PERFECT : KICK_JUMP);
      else if (e.type === 'speedMilestone') this.addOmega(KICK_MILESTONE);
      else if (e.type === 'checkpoint') {
        // Nabe blinkt auch mitten im Trick: grün vor der Bestzeit, rot dahinter, ohne Referenz cyan.
        this.hubSign = e.split === null ? 0 : e.split <= 0 ? 1 : -1;
        this.hubT = 0;
      }
    }
    super.onEvent(e);
  }

  private addOmega(d: number): void {
    this.omega = Math.min(SPINNER_OMEGA_MAX, this.omega + d);
  }

  /**
   * Abwechslung (Review Phase 2: toss machte 45–62 % der Starts — jeder gute Hop im Flow war ein toss): Flow
   * immer im Wechsel toss/swap, Overdrive guter Hop im Wechsel ufo/toss, sonst die Liste reihum.
   */
  protected onJump(tier: number, good: boolean): void {
    if (tier === 0) return;
    const list = SPINNER_TIER_TRICKS[tier];
    if (tier === 3 && good) this.start(this.goodCount++ % 2 === 0 ? 'ufo' : 'toss');
    else this.start(list[this.pick++ % list.length]);
  }

  protected onMilestone(tier: number): void {
    if (tier >= 3) this.start('ufo');
    else if (tier === 2) this.start(this.milestoneCount++ % 2 === 0 ? 'toss' : 'swap');
  }

  protected onIdle(): number {
    this.start(this.idleCount++ % 3 === 2 ? 'swap' : 'flick');
    return 2.6 + 1.8 * this.rand();
  }

  protected override onFinish(): void {
    this.start('ufo');
  }

  protected override onCheckpoint(_split: number | null): void {
    this.start('flick');
    this.bigFlick = true;
  }

  protected override onSurfStart(speed: number): void {
    if (speed >= SURF_FROM) this.start('balance');
  }

  protected override onFree(inp: PropFrameInput, speed: number): void {
    if (inp.surfing && speed >= SURF_FROM) this.start('balance');
  }

  override update(dtRaw: number, inp: PropFrameInput): void {
    const dt = dtRaw - dtRaw === 0 ? clamp(dtRaw, 0, 0.1) : 0;
    const m = clamp(fin(this.motionFx), 0, 1);
    // Drehzahl VOR der Zeitleiste aufs Frame-Ende bringen: die Balance liest sie (Präzession), und
    // Schnipps der Marken kommen danach — am Frame-Ende wie alle Impulse (#77). Umgekehrt lief die
    // Präzession einen Frame hinter ω her (0.085 rad bei 30 Hz gegen 1440 Hz).
    this.omegaStart = this.omega;
    if (dt > 0 && m > 0) {
      const target = SPINNER_OMEGA_BASE + SPINNER_OMEGA_PER_SPEED * Math.max(0, fin(inp.speed));
      const tau = target > this.omega ? TAU_UP : TAU_DOWN;
      this.omega = Math.min(SPINNER_OMEGA_MAX, target + (this.omega - target) * Math.exp(-dt / tau));
    }
    super.update(dtRaw, inp);
    if (dt <= 0) return;
    const o = this.out;
    this.hubT += dt;
    if (m <= 0) {
      // Statisch: der Spinner steht (Winkel bleibt, keine Unschärfe).
      this.omega = 0;
      this.blur = 0;
    } else {
      const step = this.omega * dt;
      this.shownAngle = (this.shownAngle + Math.min(step, SPINNER_STEP_CAP)) % SYM;
      this.blur = clamp((step - BLUR_FROM) / (SPINNER_STEP_CAP * 2 - BLUR_FROM), 0, 1) * BLUR_MAX;
    }
    o.param[P.angle] = this.shownAngle;
    o.param[P.blur] = this.blur;
    const hubOn = this.hubT < HUB_TIME ? (Math.sin((this.hubT / HUB_TIME) * Math.PI * 5) > -0.4 ? 1 : 0.3) * (1 - smooth((this.hubT - HUB_TIME * 0.6) / (HUB_TIME * 0.4))) : 0;
    // Ohne Blinken exakt 0 (nicht −0: Float32Array speichert das Vorzeichen).
    o.param[P.hub] = hubOn > 0 && this.hubSign !== 0 ? this.hubSign * hubOn : 0;
    o.param[3] = 0;
  }

  protected evaluate(id: SpinnerTrick, t: number, dt: number, inp: PropFrameInput, _m: number, o: PropOut): boolean {
    if (id === 'flick') {
      const u = t / FLICK_TIME;
      if (u >= 1) return true;
      // Daumen schnippt einen Lappen: Ruck, kurz gekippt (Vorderseite blitzt), dreht sofort schneller.
      const big = this.bigFlick ? 1.6 : 1;
      if (this.mark(0, 0.06, t)) {
        this.addOmega(this.bigFlick ? KICK_FLICK_BIG : KICK_FLICK);
        this.kick(o, 0.12 * big, -0.3 * big);
      }
      this.offsetView(o, 0, 0.7 * big * bell(u), 0.3 * bell(u));
      this.rotateView(o, 1, 0, 0, -0.3 * big * bell(u));
      o.hroll = 0.1 * big * bell(u);
      return false;
    }
    if (id === 'swap') {
      const u = t / SWAP_TIME;
      if (u >= 1) return true;
      // Pinch → Fingerspitze (0.3 s), balancieren, zurück (ab 0.7 s).
      const e = u < 0.3 ? smooth(u / 0.3) : u < 0.7 ? 1 : 1 - smooth((u - 0.7) / 0.3);
      this.place(o, e);
      this.offsetView(o, 0, 1.2 * arc(u < 0.3 ? u / 0.3 : u > 0.7 ? (u - 0.7) / 0.3 : 0), 0);
      if (e > 0.99) this.rotateView(o, 0, 0, 1, 0.08 * Math.sin(t * 17));
      o.pose = u > 0.12 && u < 0.85 ? POSE.point : POSE.pinch;
      o.poseTau = 0.06;
      if (this.mark(0, SWAP_TIME * 0.3, t)) this.kick(o, 0.12, -0.25);
      if (this.mark(1, SWAP_TIME * 0.98, t)) this.kick(o, 0.1, -0.2);
      return false;
    }
    if (id === 'toss') {
      if (t < TOSS_WINDUP) {
        if (this.mark(0, 0, t)) this.kick(o, 0.2, 0);
        this.offsetView(o, 0, -0.9 * Math.sin(Math.PI * (t / TOSS_WINDUP)), 0);
        return false;
      }
      if (this.mark(1, TOSS_WINDUP, t)) {
        this.kick(o, -0.5, 0);
        this.addOmega(KICK_FLICK);
      }
      const s = (t - TOSS_WINDUP) / TOSS_AIR;
      if (s < 1) {
        // Flach drehend hoch (kippt zur Waagerechten), Fang wieder im Pinch.
        this.offsetView(o, 0.8 * Math.sin(Math.PI * s), 5.5 * arc(s), 1.0 * Math.sin(Math.PI * s));
        this.rotateView(o, 1, 0, 0, -1.1 * bell(s));
        o.pose = s < 0.75 ? POSE.open : POSE.pinch;
        o.poseTau = 0.05;
        return false;
      }
      if (this.mark(2, TOSS_WINDUP + TOSS_AIR, t)) {
        this.kick(o, 0.32, -0.8);
        this.spinKick(-1.0);
      }
      return t >= TOSS_TOTAL;
    }
    if (id === 'ufo') {
      if (t < UFO_WINDUP) {
        if (this.mark(0, 0, t)) this.kick(o, 0.25, 0);
        this.offsetView(o, 0, -1.1 * Math.sin(Math.PI * (t / UFO_WINDUP)), 0);
        return false;
      }
      if (this.mark(1, UFO_WINDUP, t)) {
        this.kick(o, -0.7, 0);
        this.addOmega(KICK_FLICK_BIG);
      }
      const s = (t - UFO_WINDUP) / UFO_AIR;
      if (s < 1) {
        // Steigt flach wie ein UFO (Scheitel 9), schwebt, landet auf der Zeigefinger-Spitze.
        const e = smooth(s);
        this.place(o, e);
        this.offsetView(o, 0.6 * Math.sin(Math.PI * s), 9 * arc(s), 0.8 * Math.sin(Math.PI * s));
        this.rotateView(o, 1, 0, 0, -0.5 * bell(s));
        this.rotateView(o, 0, 0, 1, 0.15 * Math.sin(s * Math.PI * 3));
        o.pose = s < 0.55 ? POSE.open : POSE.point;
        o.poseTau = 0.06;
        return false;
      }
      if (this.mark(2, UFO_WINDUP + UFO_AIR, t)) {
        this.kick(o, 0.35, -0.9);
        this.spinKick(-1.2);
      }
      // Kurz auf der Spitze, dann zurück in den Pinch.
      const b = (t - UFO_WINDUP - UFO_AIR) / UFO_BACK;
      this.place(o, 1 - smooth(b));
      o.pose = b < 0.6 ? POSE.point : POSE.pinch;
      o.poseTau = 0.06;
      return t >= UFO_TOTAL;
    }
    // balance: auf der Fingerspitze, solange gesurft wird.
    if (this.balOut < 0 && !inp.surfing && t >= BAL_MIN) this.balOut = t;
    const inE = smooth(t / BAL_IN);
    const outE = this.balOut < 0 ? 0 : smooth((t - this.balOut) / BAL_OUT);
    const e = inE * (1 - outE);
    this.place(o, e);
    o.pose = e > 0.15 ? POSE.point : POSE.pinch;
    o.poseTau = 0.07;
    // Präzession: Kreis ∝ 1/ω (langsamer Kreisel wackelt weiter), Neigung folgt der Rampe.
    // Winkel = Integral der Rate über die TRICK-Zeit (erster Frame 0), Trapez über den Frame.
    const w = Math.max(8, this.omega);
    this.precess += (1.5 + 0.01 * (Math.max(8, this.omegaStart) + w)) * Math.max(0, t - this.precessT);
    this.precessT = t;
    const amp = clamp(9 / w, 0.06, 0.35) * e;
    this.rotateView(o, 1, 0, 0, amp * Math.sin(this.precess));
    this.rotateView(o, 0, 0, 1, amp * Math.cos(this.precess) - 0.35 * this.surfLean * e);
    // Einlage (PropTricks.beatU): hüpft von der Fingerspitze wie ein kleines UFO und landet wieder.
    const u = this.beatU;
    if (u < 1) {
      this.offsetView(o, 0.3 * arc(u) * e, BEAT_HOP * arc(u) * e, 0.6 * arc(u) * e);
      this.rotateView(o, 1, 0, 0, -0.5 * bell(u) * e);
    }
    if (this.beatEnd()) this.kick(o, 0.1, -0.25);
    if (this.mark(0, BAL_IN, t)) this.kick(o, 0.1, -0.2);
    return this.balOut >= 0 && t >= this.balOut + BAL_OUT;
  }
}
