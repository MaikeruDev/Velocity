import type { GameEvent } from '../../engine/events';
import { VM_JOINT, VM_PARAM, VM_PHONE_MODE } from '../../render/types';
import { clamp, fin, smooth } from './anim';
import { GripTricks, KeySeq, TossRig, fingerKey, poseDelta, settleIn } from './canTricks';
import type { TossTrackSet } from './canTricks';
import { Track, cubicInOut, quadIn, quadOut, sineInOut } from './curves';
import type { Key } from './curves';
import { POSE } from './poses';
import type { PropFrameInput, PropOut } from './propTricks';
import { viewRot } from './view';
import type { V3 } from './view';

/**
 * Handy (Plan 007 KI7, Animation Plan 008 Schritt 2), generisch: Hochformat in der Hand, Daumen auf dem Display.
 * Anzeige (Kanäle VM_PARAM.phone): Feed, Tacho ab 500 u/s von selbst, Split nach einem Checkpoint, Kamera beim Surfen,
 * beim Filmen und im Ziel, danach Foto.
 *
 * Der Daumen bewegt sich wirklich (Schlüssel-Posen per IK auf die Display-Ebene, jointAdd auf der Pose `phone`):
 * - scroll: drei Wischer — Daumen setzt oben auf, zieht nach unten (der Feed läuft mit dem Daumen mit und gleitet nach
 *   dem Loslassen kurz nach), hebt ab und setzt oben neu an,
 * - tap: Daumen hebt ab, tippt (das Handy gibt kurz nach), Anzeige wechselt Feed ↔ Tacho,
 * - flipCatch / spinToss: echte Würfe (PropFlight) mit Überschlag bzw. Drehung um die Längsachse, Fang mit Nachgeben,
 * - record (neu, Tempo): Hand hebt das Handy, dreht es quer (Hand und Handgelenk drehen, nicht das Handy im Griff),
 *   Daumen tippt Aufnahme, REC läuft, Daumen stoppt, zurück,
 * - Surf ≥ 500: Zustand gimbal — quer, bleibt waagerecht, während die Hand kippt,
 * - Checkpoint: buzz (Vibration 40 Hz), Display zeigt den Split 2.5 s,
 * - Ziel: photo — Hand hebt das Handy geschmeidig nach rechts oben und dreht es quer (Ease-in/out mit Überschwinger),
 *   Sucher, Daumen drückt den AUSLÖSER nach SHUTTER_AT s: Display blitzt, `shutterCount` zählt hoch →
 *   ViewHand.takeShutter() → Game macht das Selfie (RendererApi.selfie). Bei motionFx 0 bleibt das Handy stehen,
 *   Anzeige und Auslöser laufen trotzdem (das Selfie ist eine Freischaltung). Kommt das Ergebnis früher: shootNow().
 */

export const PHONE_TRICKS = ['none', 'scroll', 'tap', 'flipCatch', 'spinToss', 'buzz', 'photo', 'gimbal', 'record'] as const;
export type PhoneTrick = Exclude<(typeof PHONE_TRICKS)[number], 'none'>;
const PHONE_NAMES: readonly string[] = PHONE_TRICKS.filter((t) => t !== 'none');

/**
 * Tricks je Tempo-Stufe bei Sprüngen (Tests prüfen genau diese Zuordnung). Lauf tap / scroll: mit tap allein machte
 * er bei der 1.5°-Hand 54 % der Starts (Review Phase 2). Overdrive: Würfe und kurz filmen.
 */
export const PHONE_TIER_TRICKS: readonly (readonly PhoneTrick[])[] = [[], ['tap', 'scroll'], ['flipCatch', 'tap'], ['spinToss', 'record', 'flipCatch']];

/**
 * Plan 008 (Griff-Audit): echte Größe ~72 × 150 mm — das Modell (46 × 86) war kleiner als die Handfläche breit, die
 * Hand hielt es nur mit den Kuppen. 1.45× → 67 × 125 mm (das Display bleibt 24 × 48 Texel, nur größer).
 */
export const PHONE_SCALE = 1.45;
/** Kippung der Ruhelage um die Blickachse — quer = π/2 insgesamt. */
const HOLD_CAM = 0.3;
export const PHONE_HOLD_POS: V3 = [-1.881, 6.15, -5.861];
export const PHONE_HOLD_ROT: V3 = viewRot([
  [1, 0.45],
  [2, HOLD_CAM],
]);
/** Auslöser im Ziel-Foto (Trick-Zeit, s) — vor dem Ergebnis-Bildschirm (Game FINISH_MENU_DELAY 1.1 s); bewusst nicht auf einem gemeinsamen Frame-Raster. */
export const SHUTTER_AT = 0.76;

const COOLDOWN: { readonly [K in PhoneTrick]: number } = { scroll: 0.6, tap: 1.0, flipCatch: 0.9, spinToss: 1.3, buzz: 0.4, photo: 0.5, gimbal: 0.5, record: 1.2 };
const SCROLL_T = 1.5;
const TAP_T = 0.6;
const BUZZ_T = 0.5;
const PHOTO_T = 2.2;
const REC_T = 1.6;
const SPLIT_SHOW = 2.5;
const FLASH_T = 0.15;
const SPEEDO_ON = 500;
const SPEEDO_OFF = 440;
const SURF_FROM = 500;
/** Einlage im Gimbal: Schwenk zur Seite und zurück (rad). */
const BEAT_PAN = 0.55;
const SURF_MIN = 0.5;
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

const P = VM_PARAM.phone;
const M = VM_PHONE_MODE;
const JA = VM_JOINT;

// ---------------------------------------------------------------- Daumen-Schlüssel (IK auf die Display-Ebene)

/** Daumen [Abspreizen, Opposition, Grund, End] relativ zur Pose phone. Display-Koordinaten im Handy-Raum. */
const K_REST = fingerKey(4, [0, 0, 0, 0]);
/** auf dem Display oben (−1.0, 2.2) / unten (−1.0, −1.6) */
const K_TOP = fingerKey(4, [-0.188, -0.354, -0.618, 0.81]);
const K_BOTTOM = fingerKey(4, [-0.734, 0.122, -0.341, 0.907]);
/** über dem Display, oben (abgehoben) */
const K_LIFT = fingerKey(4, [0.682, -0.322, 0.036, 0.679]);
/** Mitte: schwebend / gedrückt */
const K_HOVER = fingerKey(4, [0.714, 0.118, -0.645, 1.515]);
const K_PRESS = fingerKey(4, [-0.37, -0.073, -0.737, 1.419]);
const KEYS: readonly Float32Array[] = [K_REST, K_TOP, K_BOTTOM, K_LIFT, K_HOVER, K_PRESS];
const REST = 0;
const TOP = 1;
const BOTTOM = 2;
const LIFT = 3;
const HOVER = 4;
const PRESS = 5;

/** Wischer k: Beginn (über dem Display oben), Aufsetzen, Ziehen, Loslassen. */
const SWIPE_AT = [0.1, 0.52, 0.94] as const;
const SW_DOWN = 0.07;
const SW_DRAG = 0.2;
const SW_UP = 0.12;
/** Feed je Wischer (Texturlängen): mit dem Daumen gezogen, danach Nachgleiten. */
const SW_FEED = 0.19;
const SW_COAST = 0.06;
const SW_COAST_T = 0.18;

const SCROLL_SEQ = ((): KeySeq => {
  const e: [number, number, typeof sineInOut?][] = [[0, REST, sineInOut]];
  for (const s of SWIPE_AT) {
    e.push([s, LIFT, quadIn]);
    e.push([s + SW_DOWN, TOP, sineInOut]);
    e.push([s + SW_DOWN + SW_DRAG, BOTTOM, quadOut]);
    e.push([s + SW_DOWN + SW_DRAG + SW_UP, LIFT, sineInOut]);
  }
  e.push([SCROLL_T, REST]);
  return new KeySeq(e);
})();

const TAP_SEQ = new KeySeq([
  [0, REST, sineInOut],
  [0.13, HOVER, quadIn],
  [0.21, PRESS, sineInOut],
  [0.27, PRESS, quadOut],
  [0.36, HOVER, sineInOut],
  [TAP_T, REST],
]);
const TAP_PRESS = 0.21;

/** Ziel-Foto: Hand hebt und dreht (0..1), Daumen drückt den Auslöser. */
const PHOTO_UP = new Track([
  [0, 0, cubicInOut],
  [0.52, 1.04, sineInOut],
  [0.66, 1, sineInOut],
  [1.66, 1, cubicInOut],
  [2.12, -0.02, sineInOut],
  [PHOTO_T, 0],
]);
const PHOTO_SEQ = new KeySeq([
  [0, REST],
  [0.42, REST, sineInOut],
  [SHUTTER_AT - 0.12, HOVER, quadIn],
  [SHUTTER_AT, PRESS, sineInOut],
  [SHUTTER_AT + 0.07, PRESS, quadOut],
  [SHUTTER_AT + 0.2, HOVER, sineInOut],
  [1.4, REST],
]);

/** Filmen: Hand hebt und dreht quer, Daumen startet und stoppt die Aufnahme; dazwischen schwenkt die Hand mit. */
const REC_UP = new Track([
  [0, 0, cubicInOut],
  [0.38, 1.03, sineInOut],
  [0.5, 1, sineInOut],
  [1.2, 1, cubicInOut],
  [1.55, -0.02, sineInOut],
  [REC_T, 0],
]);
const REC_ON = 0.42;
const REC_OFF = 1.12;
const REC_SEQ = new KeySeq([
  [0, REST],
  [0.22, REST, sineInOut],
  [REC_ON - 0.1, HOVER, quadIn],
  [REC_ON, PRESS, sineInOut],
  [REC_ON + 0.12, HOVER, sineInOut],
  [REC_OFF - 0.1, HOVER, quadIn],
  [REC_OFF, PRESS, sineInOut],
  [REC_OFF + 0.14, REST],
]);

/**
 * Quer drehen MIT der Hand (vorher drehte das Handy im Griff — die Finger steckten darin): eine Drehung um die
 * Blickachse um π/2 − HOLD_CAM, exakt zerlegt in die Handgelenk-Gelenke (Euler ZXY [−Beugen, Drehen, Seitneigen],
 * three.Euler.setFromRotationMatrix) — vor allem Unterarm-Drehen, wie man ein Handy quer dreht. Der Unterarm selbst
 * rollt nicht (das schwenkte ihn waagerecht ins Bild).
 */
const TURN_ROLL = 0.9;
const TURN_PITCH = 0;
const TURN_FLEX = 0;
const TURN_TWIST = -0.5;
const TURN_DEV = 0;

/** Finger öffnen sich zum Wurf (Daumen eigens: THUMB_AWAY). */
const OPEN_D = ((): Float32Array => {
  const d = poseDelta(POSE.phone, POSE.open);
  for (let i = JA.thumbAbd; i <= JA.thumbIp; i++) d[i] = 0;
  for (let i = JA.finger + 8; i < JA.finger + 16; i++) d[i] = 0;
  return d;
})();
/**
 * Ring/kleiner Finger umgreifen die Kante: sie öffnen erst, wenn das Handy weg ist, und schließen erst, wenn es wieder
 * liegt — gleichzeitig mit den anderen schwangen ihre Kuppen durch das Gehäuse (−0.6).
 */
const RING_D = ((): Float32Array => {
  const d = poseDelta(POSE.phone, POSE.open);
  for (let i = JA.thumbAbd; i < JA.finger + 8; i++) d[i] = 0;
  return d;
})();
const THUMB_AWAY = fingerKey(4, [1.3, -0.4, -0.3, 0]);

interface PTossSpec {
  readonly rel: number;
  readonly air: number;
  readonly apex: number;
  readonly turns: number;
  readonly spins: number;
  readonly total: number;
  readonly kick: number;
  readonly away: number;
}
const FLIP: PTossSpec = { rel: 0.12, air: 0.46, apex: 7, turns: 1, spins: 0, total: 0.82, kick: 0.3, away: 0.7 };
const SPIN: PTossSpec = { rel: 0.14, air: 0.56, apex: 9, turns: 0, spins: 2, total: 1.0, kick: 0.38, away: 1.0 };

function pTracks(s: PTossSpec): TossTrackSet {
  const r = s.rel;
  const c = s.rel + s.air;
  const big = s.apex / 8;
  const hy: Key[] = [
    [0, 0, sineInOut],
    [r - 0.07, 0.014 + 0.008 * big, quadIn],
    [r, -0.02 - 0.008 * big, quadOut],
    [r + 0.14, -0.003, sineInOut],
    [c - 0.08, -0.01, sineInOut],
    [c, -0.006, sineInOut],
    [c + 0.25, 0],
  ];
  const hx: Key[] = [
    [0, 0, sineInOut],
    [r, 0.025 * big, sineInOut],
    [c, 0.06 * big, sineInOut],
    [c + 0.1, 0.06 * big, cubicInOut],
    [s.total - 0.02, 0],
  ];
  const flex: Key[] = [
    [0, 0, sineInOut],
    [r - 0.07, 0.26, quadIn],
    [r, -0.24, quadOut],
    [r + 0.15, -0.04, sineInOut],
    [c, -0.03, sineInOut],
    [c + 0.28, 0],
  ];
  const open: Key[] = [
    [0, 0, sineInOut],
    [r - 0.05, 0, quadIn],
    [r + 0.025, 0.8, quadOut],
    [r + 0.09, 1, sineInOut],
    [c - 0.1, 0.85, sineInOut],
    [c - 0.02, 0.6, quadIn],
    [c + 0.04, 0, quadOut],
    [c + 0.2, 0],
  ];
  const thumb: Key[] = [
    [0, 0, sineInOut],
    [r - 0.06, 0, quadIn],
    [r + 0.02, 1, sineInOut],
    [c + 0.02, 1, sineInOut],
    [c + 0.16, 0],
  ];
  const ring: Key[] = [
    [0, 0],
    [r + 0.04, 0, sineInOut],
    [r + 0.12, 0.9, sineInOut],
    [c, 0.9, quadIn],
    [c + 0.1, 0],
  ];
  return { hy: new Track(hy), hx: new Track(hx), flex: new Track(flex), open: new Track(open), thumb: new Track(thumb), ring: new Track(ring) };
}
function pRig(s: PTossSpec): TossRig {
  const k = s.kick / 0.3;
  return new TossRig(s.rel, s.air, s.total, s.apex, s.turns, s.away, pTracks(s), { hy: 0.45 * k, flex: 2.4 * k, fingers: 1.2, carry: 0.05, omega: TAU * 3.4, zeta: 0.42 });
}
const FLIP_RIG = pRig(FLIP);
const SPIN_RIG = pRig(SPIN);

/** 0..1 mit quadratischen Rampen der Längen a (Anfang) und b (Ende), dazwischen linear (C1) — Drall baut sich auf/ab. */
function ramp2(u: number, a: number, b: number): number {
  const x = u < 0 ? 0 : u > 1 ? 1 : u;
  const k = 1 / (1 - a / 2 - b / 2);
  if (x < a) return (k * x * x) / (2 * a);
  if (x > 1 - b) return 1 - (k * (1 - x) * (1 - x)) / (2 * b);
  return k * (x - a / 2);
}

export class PhoneTricks extends GripTricks<PhoneTrick> {
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
  /** Ziel-Foto ohne Bewegung (motionFx 0): Alter wie eine Trick-Zeit (erster Frame 0), −1 = keins. */
  private stillAge = -1;
  private stillFresh = false;
  private stillShot = false;
  /** Auslöser schon vorgezogen (shootNow), bevor das Ziel-Foto starten konnte: es löst dann nicht noch einmal aus. */
  private shotEarly = false;
  /** Gimbal-Anteil dieses Frames (afterPose gleicht damit die Hand-Neigung aus). */
  private gimbal = 0;
  /** Kamera-Anzeige (Filmen) in diesem Frame. */
  private filming = false;
  private speed = 0;

  constructor() {
    super();
    this.flight.setHold(PHONE_HOLD_POS, PHONE_HOLD_ROT);
  }

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
    this.stillAge = -1;
    this.shotEarly = false;
    this.writeRest(this.out);
  }

  protected override start(id: PhoneTrick): void {
    super.start(id);
    this.surfOut = -1;
    this.shot = id === 'photo' && this.shotEarly;
    this.shotEarly = false;
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
    o.scale = PHONE_SCALE;
    o.poof = -1;
    this.gimbal = 0;
    this.filming = false;
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
    // Tempo-Meilenstein im Overdrive: kurz filmen ("das muss ich aufnehmen").
    if (tier >= 3) this.start('record');
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

  /**
   * Ergebnis erscheint vor dem Auslöser (Enter/Esc im Ziel-Ausrollen, Tod nach dem Ziel): anstehendes
   * Ziel-Foto jetzt auslösen. true = ausgelöst (ViewHand.takeShutterNow).
   */
  shootNow(): boolean {
    // Ziel kam mitten in einem Trick, das Foto startet erst am Ende des nächsten Frames (PropTricks).
    if (this.finishPending && !this.shotEarly) {
      this.shotEarly = true;
      this.fire(0);
      return true;
    }
    if (this.trick === 'photo' && !this.shot) {
      this.shot = true;
      this.fire(0);
      return true;
    }
    if (this.stillAge >= 0 && !this.stillShot) {
      this.stillShot = true;
      this.fire(0);
      return true;
    }
    return false;
  }

  /** Auslöser: Zähler für ViewHand.takeShutter, Blitz mit Alter `age` (s seit dem Auslösen). */
  private fire(age: number): void {
    this.shutterCount++;
    this.flashAge = age;
  }

  /** Split zeigen auch mitten im Trick; Vibration nur ohne laufenden Trick. */
  override onEvent(e: GameEvent): void {
    if (e.type === 'checkpoint' && this.motionFx > 0 && e.split !== null) {
      this.split = e.split;
      this.splitUntil = this.now + SPLIT_SHOW;
    }
    if (e.type === 'finish' && this.motionFx <= 0) {
      this.stillAge = 0;
      this.stillFresh = true;
      this.stillShot = false;
    }
    super.onEvent(e);
  }

  protected override onCheckpoint(_split: number | null): void {
    this.start('buzz');
  }

  /** Training (KI9): Stufe und Lektion fertig = vibrieren (ohne Split) — in der Lektion gibt es kein Selfie. */
  protected override onLesson(): void {
    this.start('buzz');
  }

  protected override onSurfStart(speed: number): void {
    if (speed >= SURF_FROM) this.start('gimbal');
  }

  protected override onFree(inp: PropFrameInput, speed: number): void {
    if (inp.surfing && speed >= SURF_FROM) this.start('gimbal');
  }

  override update(dtRaw: number, inp: PropFrameInput): void {
    const dt = dtRaw - dtRaw === 0 ? clamp(dtRaw, 0, 0.1) : 0;
    this.speed = Math.max(0, fin(inp.speed));
    if (dt > 0 && this.motionFx > 0) {
      // Feed scrollt mit dem Tempo (Texturlängen/s), Tacho schaltet mit Hysterese.
      this.feedScroll = (this.feedScroll + (0.04 + this.speed / 2500) * dt) % 1;
      if (this.speed >= SPEEDO_ON) this.autoSpeedo = true;
      else if (this.speed < SPEEDO_OFF) this.autoSpeedo = false;
    }
    if (dt > 0) this.flashAge += dt;
    super.update(dtRaw, inp);
    if (dt > 0) {
      if (this.stillAge >= 0) this.stepStill(dt);
      this.writeDisplay();
    }
  }

  /** Ziel-Foto bei motionFx 0: Kamera-Anzeige, Auslöser nach SHUTTER_AT, Foto bis PHOTO_T. */
  private stepStill(dt: number): void {
    if (this.stillFresh) this.stillFresh = false;
    else this.stillAge += dt;
    if (!this.stillShot && this.stillAge >= SHUTTER_AT) {
      this.stillShot = true;
      this.fire(this.stillAge - SHUTTER_AT);
    }
    if (this.stillAge >= PHOTO_T) this.stillAge = -1;
  }

  private writeDisplay(): void {
    const p = this.out.param;
    const trick = this.trick;
    const still = this.stillAge >= 0;
    if ((trick === 'photo' && this.shot) || (still && this.stillShot)) {
      p[P.mode] = M.photo;
      p[P.value] = 0;
    } else if (trick === 'photo' || trick === 'gimbal' || still || this.filming) {
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

  protected evaluate(id: PhoneTrick, t: number, _dt: number, inp: PropFrameInput, m: number, o: PropOut): boolean {
    let done: boolean;
    if (id === 'scroll') done = this.scroll(t, o);
    else if (id === 'tap') done = this.tap(t, o);
    else if (id === 'flipCatch') done = this.toss(t, FLIP, FLIP_RIG, m, o);
    else if (id === 'spinToss') done = this.toss(t, SPIN, SPIN_RIG, m, o);
    else if (id === 'buzz') done = this.buzz(t, o);
    else if (id === 'photo') done = this.photo(t, o);
    else if (id === 'record') done = this.record(t, o);
    else done = this.gimbalState(t, inp, o);
    this.fadeFingers(o, t, m);
    return done;
  }

  /** Drei Daumen-Wischer: der Feed läuft mit dem Daumen (je Wischer ¼ Textur) und gleitet nach dem Loslassen nach. */
  private scroll(t: number, o: PropOut): boolean {
    const u = t / SCROLL_T;
    if (u >= 1) {
      // Ende exakt: Stand bei SCROLL_T, danach der freie Vorlauf (sonst hinge der Feed am Frame-Ende).
      this.feedScroll = (this.swipeBase + 0.75 + 0.02 * SCROLL_T + (0.04 + this.speed / 2500) * (t - SCROLL_T)) % 1;
      return true;
    }
    this.addSeq(o, KEYS, SCROLL_SEQ, t);
    let steps = 0;
    for (let k = 0; k < SWIPE_AT.length; k++) {
      const d0 = SWIPE_AT[k] + SW_DOWN;
      // Mit dem Daumen gezogen (gleiche Kurve wie die Daumen-Bewegung), dann Nachgleiten (quadOut).
      steps += SW_FEED * quadOut(clamp((t - d0) / SW_DRAG, 0, 1)) + SW_COAST * quadOut(clamp((t - d0 - SW_DRAG) / SW_COAST_T, 0, 1));
    }
    if (this.swipeBase < 0) this.swipeBase = this.feedScroll;
    this.feedScroll = (this.swipeBase + steps + 0.02 * t) % 1;
    // Hand hält das Handy etwas höher und näher (man schaut drauf), jeder Wischer drückt es minimal.
    const b = Math.sin(Math.PI * u);
    this.offsetHand(o, 0, -0.008 * b * b, 0.6 * b * b);
    o.jointAdd[JA.wristFlex] += -0.08 * b * b;
    return false;
  }

  /** Tippen: Daumen hebt ab, drückt (Handy gibt kurz nach), Anzeige wechselt Feed ↔ Tacho. */
  private tap(t: number, o: PropOut): boolean {
    const u = t / TAP_T;
    if (u >= 1) return true;
    this.addSeq(o, KEYS, TAP_SEQ, t);
    if (this.mark(0, TAP_PRESS, t)) this.kick(o, 0.06, -0.12);
    if (t >= 0.25 && !this.shot) {
      // Zustandswechsel über die Zeit (gilt auch festgehalten in Tools), einmal je tap.
      this.shot = true;
      this.manualSpeedo = !this.manualSpeedo;
    }
    const b = Math.sin(Math.PI * u);
    this.offsetHand(o, 0, -0.008 * b * b, 0.6 * b * b);
    // Der Druck kippt das Handy kurz vom Daumen weg (Handgelenk federt).
    o.jointAdd[JA.wristFlex] += settleIn(1.6, t - TAP_PRESS, 0.3, TAU * 5, 0.45);
    return false;
  }

  private offsetHand(o: PropOut, hx: number, hy: number, hz: number): void {
    o.hx += hx;
    o.hy += hy;
    o.hz += hz;
  }

  /** Würfe: flipCatch = Überschlag (Handflächen-Normale), spinToss = flach, zwei Drehungen um die Längsachse. */
  private toss(t: number, s: PTossSpec, rig: TossRig, m: number, o: PropOut): boolean {
    this.ftT = t;
    this.ftM = m;
    this.flyToss(o, rig, OPEN_D, null, THUMB_AWAY, RING_D);
    if (t >= rig.rel && t < rig.cat) o.spin = TAU * s.spins * ramp2((t - rig.rel) / s.air, 0.25, 0.25);
    if (this.mark(2, rig.cat, t)) this.kick(o, s.kick, -s.kick * 2.6);
    return t >= s.total;
  }

  /** Vibration (40 Hz, abklingend) — das Display zeigt dazu den Split. */
  private buzz(t: number, o: PropOut): boolean {
    const u = t / BUZZ_T;
    if (u >= 1) return true;
    const a = 0.15 * (1 - u) * Math.sin(TAU * 40 * t);
    const b = Math.sin(Math.PI * u);
    // Die Hand hebt das brummende Handy kurz an (vorher rückte es im Griff — in den Daumen), das Handy zittert minimal.
    this.offsetHand(o, 0, -0.012 * b * b, 0.5 * b * b);
    this.offsetView(o, 0.6 * a, 0, 0);
    this.rotateView(o, 0, 0, 1, 0.04 * Math.sin(TAU * 40 * t + 1) * (1 - u));
    // Die Finger fangen das Brummen ab: kurzes Nachfassen.
    o.jointAdd[JA.wristDev] += 0.03 * Math.sin(TAU * 40 * t + 2) * (1 - u);
    return false;
  }

  /** Hand hebt das Handy (e) und dreht es quer (siehe TURN_*). */
  private raiseLandscape(o: PropOut, e: number, hx: number, hy: number, hz: number): void {
    o.hx += hx * e;
    o.hy += hy * e;
    o.hz += hz * e;
    o.hroll += TURN_ROLL * e;
    o.hpitch += TURN_PITCH * e;
    o.jointAdd[JA.wristFlex] += TURN_FLEX * e;
    o.jointAdd[JA.wristTwist] += TURN_TWIST * e;
    o.jointAdd[JA.wristDev] += TURN_DEV * e;
  }

  /** Ziel-Foto: geschmeidig nach rechts oben, quer, Sucher; Daumen drückt den Auslöser (Blitz, Ruck); zurück. */
  private photo(t: number, o: PropOut): boolean {
    const u = t / PHOTO_T;
    if (u >= 1) return true;
    const e = PHOTO_UP.value(t);
    this.raiseLandscape(o, e, -0.06, -0.44, 3);
    this.addSeq(o, KEYS, PHOTO_SEQ, t);
    if (t >= SHUTTER_AT && !this.shot) {
      this.shot = true;
      this.fire(t - SHUTTER_AT);
    }
    if (this.mark(0, SHUTTER_AT, t)) this.kick(o, 0.08, -0.2);
    // Auslöser-Druck: das Handy nickt kurz weg und federt zurück.
    o.jointAdd[JA.wristFlex] += settleIn(1.8, t - SHUTTER_AT, 0.4, TAU * 4.5, 0.4);
    return false;
  }

  /** Filmen (Tempo): hoch, quer, Aufnahme starten, mitschwenken, stoppen, zurück. */
  private record(t: number, o: PropOut): boolean {
    if (t >= REC_T) return true;
    const e = REC_UP.value(t);
    this.raiseLandscape(o, e, -0.03, -0.36, 2.5);
    this.addSeq(o, KEYS, REC_SEQ, t);
    // Mitschwenken (filmt die Strecke): kleine Gierbewegung der Hand zwischen Start und Stopp.
    const pan = Math.sin(Math.PI * clamp((t - REC_ON) / (REC_OFF - REC_ON), 0, 1));
    o.hyaw += 0.12 * pan * e;
    o.jointAdd[JA.wristFlex] += settleIn(1.2, t - REC_ON, 0.3, TAU * 5, 0.45) + settleIn(1.2, t - REC_OFF, 0.3, TAU * 5, 0.45);
    if (this.mark(0, REC_ON, t)) this.kick(o, 0.05, -0.1);
    if (this.mark(1, REC_OFF, t)) this.kick(o, 0.05, -0.1);
    this.filming = t >= REC_ON - 0.15 && t < REC_OFF + 0.1;
    return false;
  }

  /**
   * Surf: quer und waagerecht (Gimbal) — filmt die Fahrt; endet mit dem Surf. Einlage (PropTricks.beatU): die
   * Kamera schwenkt einmal zur Seite und zurück (filmt die Rampe), die Hand hebt sie dabei etwas an.
   */
  private gimbalState(t: number, inp: PropFrameInput, o: PropOut): boolean {
    if (this.surfOut < 0 && !inp.surfing && t >= SURF_MIN) this.surfOut = t;
    const inE = smooth(t / 0.3);
    const out = this.surfOut < 0 ? 0 : smooth((t - this.surfOut) / 0.3);
    const e = inE * (1 - out);
    this.gimbal = e;
    // Plan 008: quer und hoch per Hand und Handgelenk (vorher drehte das Handy im Griff durch Handfläche und Daumen).
    this.raiseLandscape(o, e, 0.012, -0.2, 1.5);
    o.hyaw -= 0.3 * e;
    const u = this.beatU;
    if (u < 1) {
      const b = Math.sin(Math.PI * u);
      // Schwenk mit der ganzen Hand (filmt die Rampe), sie hebt dabei etwas an.
      o.hyaw += BEAT_PAN * 0.6 * Math.sin(Math.PI * 2 * u) * e;
      o.hy -= 0.03 * b * b * e;
      o.hz += 0.6 * b * b * e;
    }
    return this.surfOut >= 0 && t >= this.surfOut + 0.3;
  }

  /** Gimbal: die Hand-Neigung DIESES Frames ausgleichen (Frame-Rollen = −Neigung). */
  override afterPose(_joints: ArrayLike<number>, inp: PropFrameInput, _dt: number): void {
    if (this.gimbal <= 0) return;
    const tilt = fin(inp.handTilt ?? 0);
    if (tilt !== 0) this.rotateView(this.out, 0, 0, 1, tilt * DEG * this.gimbal);
  }
}
