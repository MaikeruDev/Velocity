import type { GameEvent } from '../../engine/events';
import { VM_PARAM, VM_PHONE_MODE } from '../../render/types';
import { arc, bell, clamp, fin, smooth } from './anim';
import { CAN_HOLD_POS } from './canTricks';
import { POSE } from './poses';
import { PropTricks } from './propTricks';
import type { PropFrameInput, PropOut } from './propTricks';
import { viewPoint, viewRot } from './view';
import type { V3 } from './view';

/**
 * Handy (Plan 007, KI7), generisch: Hochformat in der Hand, Daumen über dem Display. Anzeige (Kanäle
 * VM_PARAM.phone): Feed (scrollt mit dem Tempo), Tacho ab 500 u/s von selbst, Split nach einem
 * Checkpoint (grün vorn, rot zurück), Kamera beim Surfen (quer, Gimbal) und im Ziel, danach Foto.
 *
 * - Stand: scroll (drei Daumen-Wischer), tap (Feed ↔ Tacho), jedes 3. Mal flipCatch,
 * - Lauf: tap, Flow: flipCatch, Overdrive / guter Hop: spinToss (flach, 2 Drehungen, Scheitel 8),
 * - Surf ≥ 500: Zustand gimbal — quer, bleibt waagerecht, während die Hand kippt (Rollen = −Neigung),
 * - Checkpoint: buzz (Vibration 40 Hz), Display zeigt den Split 2.5 s,
 * - Ziel: photo — Handy nach rechts oben (erlaubt, der Timer steht), quer, Sucher, AUSLÖSER nach
 *   SHUTTER_AT s: Display blitzt, `shutterCount` zählt hoch → ViewHand.takeShutter() → Game macht das
 *   Selfie (RendererApi.selfie, Phase 3). Vor dem Ergebnis (Game: 1.1 s), damit man den Blitz sieht.
 */

export const PHONE_TRICKS = ['none', 'scroll', 'tap', 'flipCatch', 'spinToss', 'buzz', 'photo', 'gimbal'] as const;
export type PhoneTrick = Exclude<(typeof PHONE_TRICKS)[number], 'none'>;
const PHONE_NAMES: readonly string[] = PHONE_TRICKS.filter((t) => t !== 'none');

/** Tricks je Tempo-Stufe bei Sprüngen (Tests prüfen genau diese Zuordnung). */
export const PHONE_TIER_TRICKS: readonly (readonly PhoneTrick[])[] = [[], ['tap'], ['flipCatch', 'tap'], ['spinToss', 'flipCatch']];

/** Kippung der Ruhelage um die Blickachse — quer = π/2 insgesamt. */
const HOLD_CAM = 0.3;
export const PHONE_HOLD_POS: V3 = viewPoint(CAN_HOLD_POS, -2.2, 1.6, 2.2);
export const PHONE_HOLD_ROT: V3 = viewRot([
  [1, 0.45],
  [2, HOLD_CAM],
]);
/** Auslöser im Ziel-Foto (Trick-Zeit, s) — vor dem Ergebnis-Bildschirm (Game FINISH_MENU_DELAY 1.1 s); bewusst nicht auf einem gemeinsamen Frame-Raster. */
export const SHUTTER_AT = 0.76;

const COOLDOWN: { readonly [K in PhoneTrick]: number } = { scroll: 0.6, tap: 1.0, flipCatch: 0.9, spinToss: 1.3, buzz: 0.4, photo: 0.5, gimbal: 0.5 };
const SCROLL_T = 1.5;
const TAP_T = 0.6;
const FLIP_WIND = 0.08;
const FLIP_AIR = 0.5;
const FLIP_T = 0.8;
const SPIN_WIND = 0.1;
const SPIN_AIR = 0.65;
const SPIN_T = 1.0;
const BUZZ_T = 0.5;
const PHOTO_T = 2.2;
const SPLIT_SHOW = 2.5;
const FLASH_T = 0.15;
const SPEEDO_ON = 500;
const SPEEDO_OFF = 440;
const SURF_FROM = 500;
const SURF_MIN = 0.5;
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

const P = VM_PARAM.phone;
const M = VM_PHONE_MODE;

export class PhoneTricks extends PropTricks<PhoneTrick> {
  /** Auslöser im Ziel (zählt hoch) — ViewHand.takeShutter() liest ihn. */
  shutterCount = 0;
  /** Nutzer-Wahl per tap: Tacho auch unter 500 u/s (bzw. Feed darüber). */
  private manualSpeedo = false;
  private autoSpeedo = false;
  private pick = 0;
  private idleCount = 0;
  private feedScroll = 0;
  private swipeBase = 0;
  private split = 0;
  private splitUntil = -1;
  private flashAge = 9;
  private shot = false;
  private surfOut = -1;
  /** Gimbal-Anteil dieses Frames (afterPose gleicht damit die Hand-Neigung aus). */
  private gimbal = 0;
  private speed = 0;

  override get trickNames(): readonly string[] {
    return PHONE_NAMES;
  }

  protected override isState(id: PhoneTrick): boolean {
    return id === 'gimbal';
  }

  protected resetRun(): void {
    this.manualSpeedo = false;
    this.autoSpeedo = false;
    this.splitUntil = -1;
    this.flashAge = 9;
    this.writeRest(this.out);
  }

  protected override start(id: PhoneTrick): void {
    super.start(id);
    this.surfOut = -1;
    this.shot = false;
    this.swipeBase = -1;
  }

  protected writeRest(o: PropOut): void {
    o.pose = POSE.phone;
    o.poseTau = 0.08;
    o.hx = 0;
    o.hy = 0;
    o.hz = 0;
    o.hpitch = 0;
    o.hyaw = 0;
    o.hroll = 0;
    o.pos[0] = PHONE_HOLD_POS[0];
    o.pos[1] = PHONE_HOLD_POS[1];
    o.pos[2] = PHONE_HOLD_POS[2];
    o.rot[0] = PHONE_HOLD_ROT[0];
    o.rot[1] = PHONE_HOLD_ROT[1];
    o.rot[2] = PHONE_HOLD_ROT[2];
    o.spin = 0;
    o.visible = 1;
    o.scale = 1;
    o.poof = -1;
    this.gimbal = 0;
  }

  protected cooldownOf(id: PhoneTrick): number {
    return COOLDOWN[id];
  }

  protected onJump(tier: number, good: boolean): void {
    if (tier === 0) return;
    const list = PHONE_TIER_TRICKS[tier];
    if (tier === 3 && good) this.start('spinToss');
    else this.start(list[this.pick++ % list.length]);
  }

  protected onMilestone(tier: number): void {
    // Meilensteine achten auf die Abklingzeit (event-probe: L1 sync 1.0 sonst 33 Tricks/min, Grenze 32).
    if (this.now < this.cooldownUntil) return;
    if (tier >= 3) this.start('spinToss');
    else if (tier === 2) this.start('flipCatch');
  }

  protected onIdle(): number {
    const k = this.idleCount++ % 3;
    this.start(k === 2 ? 'flipCatch' : k === 1 ? 'tap' : 'scroll');
    return 2.6 + 1.8 * this.rand();
  }

  protected override onFinish(): void {
    this.start('photo');
  }

  /** Split zeigen auch mitten im Trick; Vibration nur ohne laufenden Trick. */
  override onEvent(e: GameEvent): void {
    if (e.type === 'checkpoint' && this.motionFx > 0 && e.split !== null) {
      this.split = e.split;
      this.splitUntil = this.now + SPLIT_SHOW;
    }
    super.onEvent(e);
  }

  protected override onCheckpoint(_split: number | null): void {
    this.start('buzz');
  }

  protected override onSurfStart(speed: number): void {
    if (speed >= SURF_FROM) this.start('gimbal');
  }

  protected override onFree(inp: PropFrameInput, speed: number): void {
    if (inp.surfing && speed >= SURF_FROM) this.start('gimbal');
  }

  override update(dtRaw: number, inp: PropFrameInput): void {
    const dt = Number.isFinite(dtRaw) ? clamp(dtRaw, 0, 0.1) : 0;
    this.speed = Math.max(0, fin(inp.speed));
    if (dt > 0 && this.motionFx > 0) {
      // Feed scrollt mit dem Tempo (Texturlängen/s), Tacho schaltet mit Hysterese.
      this.feedScroll = (this.feedScroll + (0.04 + this.speed / 2500) * dt) % 1;
      if (this.speed >= SPEEDO_ON) this.autoSpeedo = true;
      else if (this.speed < SPEEDO_OFF) this.autoSpeedo = false;
    }
    if (dt > 0) this.flashAge += dt;
    super.update(dtRaw, inp);
    if (dt > 0) this.writeDisplay();
  }

  private writeDisplay(): void {
    const p = this.out.param;
    const trick = this.trick;
    if (trick === 'photo' && this.shot) {
      p[P.mode] = M.photo;
      p[P.value] = 0;
    } else if (trick === 'photo' || trick === 'gimbal') {
      p[P.mode] = M.camera;
      p[P.value] = 0;
    } else if (this.now < this.splitUntil) {
      p[P.mode] = M.split;
      p[P.value] = this.split;
    } else if (this.autoSpeedo !== this.manualSpeedo) {
      p[P.mode] = M.speedo;
      p[P.value] = this.speed;
    } else {
      p[P.mode] = M.feed;
      p[P.value] = 0;
    }
    p[P.scroll] = this.feedScroll;
    p[P.flash] = this.flashAge < FLASH_T ? 1 - this.flashAge / FLASH_T : 0;
  }

  protected evaluate(id: PhoneTrick, t: number, _dt: number, inp: PropFrameInput, _m: number, o: PropOut): boolean {
    if (id === 'scroll') return this.scroll(t, o);
    if (id === 'tap') return this.tap(t, o);
    if (id === 'flipCatch') return this.flipCatch(t, o);
    if (id === 'spinToss') return this.spinToss(t, o);
    if (id === 'buzz') return this.buzz(t, o);
    if (id === 'photo') return this.photo(t, o);
    return this.gimbalState(t, inp, o);
  }

  /** Drei Daumen-Wischer: jeder schiebt den Feed um eine Karte (¼ Textur). */
  private scroll(t: number, o: PropOut): boolean {
    const u = t / SCROLL_T;
    if (u >= 1) {
      // Ende exakt: Stand bei SCROLL_T, danach der freie Vorlauf (sonst hinge der Feed am Frame-Ende).
      this.feedScroll = (this.swipeBase + 0.75 + 0.02 * SCROLL_T + (0.04 + this.speed / 2500) * (t - SCROLL_T)) % 1;
      return true;
    }
    let steps = 0;
    for (let k = 0; k < 3; k++) {
      const s = (t - 0.2 - k * 0.45) / 0.3;
      steps += smooth(s);
      if (s > 0 && s < 1) o.pose = POSE.phoneTap;
    }
    o.poseTau = 0.05;
    if (this.swipeBase < 0) this.swipeBase = this.feedScroll;
    this.feedScroll = (this.swipeBase + 0.25 * steps + 0.02 * t) % 1;
    this.offsetView(o, 0, 0.3 * bell(u), 0.4 * bell(u));
    return false;
  }

  /** Tippen: Daumen drückt, Anzeige wechselt Feed ↔ Tacho. */
  private tap(t: number, o: PropOut): boolean {
    const u = t / TAP_T;
    if (u >= 1) return true;
    if (t > 0.12 && t < 0.34) o.pose = POSE.phoneTap;
    o.poseTau = 0.04;
    if (this.mark(0, 0.25, t)) this.kick(o, 0.06, -0.12);
    if (t >= 0.25 && !this.shot) {
      // Zustandswechsel über die Zeit (gilt auch festgehalten in Tools), einmal je tap.
      this.shot = true;
      this.manualSpeedo = !this.manualSpeedo;
    }
    this.offsetView(o, 0, 0.4 * bell(u), 0.6 * bell(u));
    this.rotateView(o, 1, 0, 0, 0.12 * bell(u));
    return false;
  }

  /** Hochwurf, einmal der Länge nach überschlagen, Fang. */
  private flipCatch(t: number, o: PropOut): boolean {
    if (t < FLIP_WIND) {
      if (this.mark(0, 0, t)) this.kick(o, 0.18, 0);
      this.offsetView(o, 0, -0.8 * Math.sin(Math.PI * (t / FLIP_WIND)), 0);
      return false;
    }
    if (this.mark(1, FLIP_WIND, t)) this.kick(o, -0.5, 0);
    const s = (t - FLIP_WIND) / FLIP_AIR;
    if (s < 1) {
      this.offsetView(o, 0.5 * Math.sin(Math.PI * s), 5 * arc(s), 1.2 * Math.sin(Math.PI * s));
      this.rotateView(o, 1, 0, 0, -TAU * s);
      o.pose = s < 0.75 ? POSE.open : POSE.phone;
      o.poseTau = 0.05;
      return false;
    }
    if (this.mark(2, FLIP_WIND + FLIP_AIR, t)) {
      this.kick(o, 0.3, -0.8);
      this.spinKick(-1.0);
    }
    return t >= FLIP_T;
  }

  /** Flach drehend hoch (2 Drehungen um die Bild-Hochachse), Scheitel 8. */
  private spinToss(t: number, o: PropOut): boolean {
    if (t < SPIN_WIND) {
      if (this.mark(0, 0, t)) this.kick(o, 0.22, 0);
      this.offsetView(o, 0, -1.0 * Math.sin(Math.PI * (t / SPIN_WIND)), 0);
      return false;
    }
    if (this.mark(1, SPIN_WIND, t)) this.kick(o, -0.7, 0);
    const s = (t - SPIN_WIND) / SPIN_AIR;
    if (s < 1) {
      this.offsetView(o, -0.6 * Math.sin(Math.PI * s), 8 * arc(s), 1.5 * Math.sin(Math.PI * s));
      this.rotateView(o, 1, 0, 0, -1.1 * bell(s));
      this.rotateView(o, 0, 1, 0, 2 * TAU * s);
      o.pose = s < 0.75 ? POSE.open : POSE.phone;
      o.poseTau = 0.05;
      return false;
    }
    if (this.mark(2, SPIN_WIND + SPIN_AIR, t)) {
      this.kick(o, 0.38, -1.0);
      this.spinKick(-1.3);
    }
    return t >= SPIN_T;
  }

  /** Vibration (40 Hz, abklingend) — das Display zeigt dazu den Split. */
  private buzz(t: number, o: PropOut): boolean {
    const u = t / BUZZ_T;
    if (u >= 1) return true;
    const a = 0.15 * (1 - u) * Math.sin(TAU * 40 * t);
    this.offsetView(o, a, 0.5 * bell(u), 0.5 * bell(u));
    this.rotateView(o, 0, 0, 1, 0.04 * Math.sin(TAU * 40 * t + 1) * (1 - u));
    return false;
  }

  /** Ziel-Foto: nach rechts oben, quer, Sucher; Auslöser mit Blitz; zurück. */
  private photo(t: number, o: PropOut): boolean {
    const u = t / PHOTO_T;
    if (u >= 1) return true;
    const e = smooth(t / 0.5) * (1 - smooth((t - 1.7) / 0.5));
    o.hx = -0.04 * e;
    o.hy = -0.1 * e;
    this.offsetView(o, 1.5 * e, 3.5 * e, 3.5 * e);
    this.rotateView(o, 0, 0, 1, (Math.PI / 2 - HOLD_CAM) * e);
    this.rotateView(o, 0, 1, 0, -0.45 * e);
    if (t >= SHUTTER_AT && !this.shot) {
      this.shot = true;
      this.shutterCount++;
      this.flashAge = t - SHUTTER_AT;
    }
    if (this.mark(0, SHUTTER_AT, t)) this.kick(o, 0.08, -0.2);
    if (t > SHUTTER_AT - 0.1 && t < SHUTTER_AT + 0.12) o.pose = POSE.phoneTap;
    return false;
  }

  /** Surf: quer und waagerecht (Gimbal) — filmt die Fahrt; endet mit dem Surf. */
  private gimbalState(t: number, inp: PropFrameInput, o: PropOut): boolean {
    if (this.surfOut < 0 && !inp.surfing && t >= SURF_MIN) this.surfOut = t;
    const inE = smooth(t / 0.3);
    const out = this.surfOut < 0 ? 0 : smooth((t - this.surfOut) / 0.3);
    const e = inE * (1 - out);
    this.gimbal = e;
    this.offsetView(o, 0.5 * e, 1.5 * e, 1.5 * e);
    this.rotateView(o, 0, 0, 1, (Math.PI / 2 - HOLD_CAM) * e);
    this.rotateView(o, 0, 1, 0, -0.45 * e);
    return this.surfOut >= 0 && t >= this.surfOut + 0.3;
  }

  /** Gimbal: die Hand-Neigung DIESES Frames ausgleichen (Frame-Rollen = −Neigung). */
  override afterPose(_joints: ArrayLike<number>, inp: PropFrameInput, _dt: number): void {
    if (this.gimbal <= 0) return;
    const tilt = fin(inp.handTilt ?? 0);
    if (tilt !== 0) this.rotateView(this.out, 0, 0, 1, tilt * DEG * this.gimbal);
  }
}
