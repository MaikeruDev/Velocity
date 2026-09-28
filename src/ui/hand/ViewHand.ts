import type { GameEvent } from '../../engine/events';
import type { GloveId, HeldItemId } from '../../engine/settingsTypes';
import { VM_JOINT_COUNT, createViewModelFrame } from '../../render/types';
import type { ViewModelFrame } from '../../render/types';
import { SAFE_ASPECT } from '../safeFrame';
import { clamp, fin } from './anim';
import { CanTricks } from './canTricks';
import type { CanTrick } from './canTricks';
import { CardTricks } from './cardTricks';
import type { CardTrick } from './cardTricks';
import { HandMotion } from './handMotion';
import type { HandFrameInput } from './handMotion';
import { KnifeTricks } from './knifeTricks';
import type { KnifeTrick } from './knifeTricks';
import { HAND_POSES, POSE, POSE_JOINTS } from './poses';
import type { PropControl } from './propTricks';

/**
 * View-Hand (Plan 006): steuert die 3D-Hand — Bewegung (HandMotion), Posen als Gelenkwinkel
 * mit weichem Überblenden, Gegenstand mit Tricks — und schreibt pro Frame einen
 * ViewModelFrame, den der Renderer nach der Welt zeichnet. DOM- und three-frei (Vitest),
 * keine Allokation pro Frame.
 *
 * Anker: Handgelenk unten rechts im 16:9-Safe-Frame (ui/safeFrame) — auf 21:9/32:9 bleibt
 * der Abstand zur Bildmitte wie auf 16:9, auf 4:3 rückt die Hand mit dem Bildrand nach innen.
 */

/** Handgelenk so weit vom rechten Rand des Safe-Frames und von der Unterkante (Bildhöhen). */
export const ANCHOR_RIGHT = 0.3;
export const ANCHOR_BOTTOM = 0.17;

const DEG = Math.PI / 180;
const GROUND_POSE_AFTER = 0.1;
const RUN_SPEED = 285;
const RUN_SPEED_OFF = 240;
const THUMBS_FINISH = 2.4;
const THUMBS_HOP = 0.75;
const THUMBS_HOP_CHAIN = 5;
const THUMBS_HOP_SYNC = 0.8;
const THUMBS_COOLDOWN = 12;
const FIST_TIME = 0.6;
/** Überblenden der Gelenke (s) ohne Wunsch des Gegenstands. */
const POSE_TAU = 0.07;
/** Posenwechsel mit kurzem Strecken (Cartoon-Smear). */
const POSE_POP = 0.3;

export type AnyTrick = CanTrick | CardTrick | KnifeTrick;

export interface ViewHandState {
  readonly visible: boolean;
  readonly pose: string;
  readonly x: number;
  readonly y: number;
  readonly tilt: number;
  readonly squash: number;
  readonly glove: GloveId;
  readonly item: HeldItemId;
  readonly trick: string;
  readonly trickTime: number;
  readonly canOpen: boolean;
  readonly cardVisible: number;
  readonly knifeOpen: boolean;
  readonly frame: { readonly x: number; readonly y: number; readonly z: number; readonly roll: number; readonly pitch: number; readonly yaw: number };
}

export class ViewHand {
  readonly motion = new HandMotion();
  readonly can = new CanTricks();
  readonly card = new CardTricks();
  readonly knife = new KnifeTricks();
  readonly frame: ViewModelFrame = createViewModelFrame();
  /** Einstellung "Hand anzeigen". */
  enabled = true;
  /** Tools: Pose erzwingen (POSE-Index), −1 = normal. */
  force = -1;
  /** Anker (Bildhöhen) — die Menü-Vorschau rückt die Hand in ihr kleines Bild. */
  anchorRight = ANCHOR_RIGHT;
  anchorBottom = ANCHOR_BOTTOM;

  private glove: GloveId = 'classic';
  private item: HeldItemId = 'none';
  private aspect = 16 / 9;
  private readonly joints = new Float32Array(VM_JOINT_COUNT);
  private pose: number = POSE.relaxed;
  private basePose: number = POSE.relaxed;
  private groundTime = GROUND_POSE_AFTER;
  private override = -1;
  private overrideLeft = 0;
  private thumbsCooldown = 0;
  private started = false;

  constructor() {
    this.joints.set(POSE_JOINTS[POSE.relaxed]);
  }

  get motionFx(): number {
    return this.motion.motionFx;
  }

  set motionFx(v: number) {
    const m = clamp(fin(v), 0, 1);
    this.motion.motionFx = m;
    this.can.motionFx = m;
    this.card.motionFx = m;
    this.knife.motionFx = m;
  }

  get currentItem(): HeldItemId {
    return this.item;
  }

  get currentGlove(): GloveId {
    return this.glove;
  }

  /** Seitenverhältnis des Bildes (Low-Res-Breite / -Höhe) für den Safe-Frame-Anker. */
  setAspect(a: number): void {
    if (Number.isFinite(a) && a > 0.2) this.aspect = a;
  }

  setGlove(g: GloveId): void {
    this.glove = g;
  }

  /** Gegenstand wechseln setzt dessen Tricks/Zustand zurück. */
  setItem(i: HeldItemId): void {
    if (i === this.item) return;
    this.item = i;
    this.prop()?.reset();
  }

  private prop(): PropControl | null {
    const i = this.item;
    return i === 'can' ? this.can : i === 'card' ? this.card : i === 'knife' ? this.knife : null;
  }

  /** Tools (__vel.forceTrick): Trick des aktuellen Gegenstands starten/festhalten. false = unbekannt. */
  forceTrick(name: string, at = -1): boolean {
    if (this.item === 'can' && isCanTrick(name)) this.can.debugPlay(name, at);
    else if (this.item === 'card' && isCardTrick(name)) this.card.debugPlayTier(name, 3, at);
    else if (this.item === 'knife' && isKnifeTrick(name)) this.knife.debugPlay(name, at);
    else if (name === 'none') this.prop()?.stop();
    else return false;
    return true;
  }

  /** Tick-Pfad (EventBus): nur Zahlen setzen. */
  onEvent(e: GameEvent): void {
    this.motion.onEvent(e);
    const p = this.prop();
    p?.onEvent(e);
    const holding = p !== null;
    switch (e.type) {
      case 'jump':
        if (!holding && e.perfect && e.gain > 0 && e.chain >= THUMBS_HOP_CHAIN && e.sync >= THUMBS_HOP_SYNC && this.thumbsCooldown <= 0 && this.override < 0) {
          this.setOverride(POSE.thumbsUp, THUMBS_HOP);
          this.thumbsCooldown = THUMBS_COOLDOWN;
        }
        break;
      case 'checkpoint':
        if (!holding && this.override !== POSE.thumbsUp) this.setOverride(POSE.fist, FIST_TIME);
        break;
      case 'finish':
        if (!holding) this.setOverride(POSE.thumbsUp, THUMBS_FINISH);
        break;
      case 'respawn':
      case 'levelLoaded':
        this.override = -1;
        this.overrideLeft = 0;
        this.groundTime = GROUND_POSE_AFTER;
        break;
      default:
        break;
    }
  }

  private setOverride(pose: number, time: number): void {
    if (this.override !== pose) this.motion.kick(0, POSE_POP);
    this.override = pose;
    this.overrideLeft = time;
  }

  update(dtRaw: number, inp: HandFrameInput): void {
    const dt = Number.isFinite(dtRaw) ? clamp(dtRaw, 0, 0.1) : 0;
    if (!this.started) {
      this.started = true;
      this.writeFrame();
    }
    if (dt <= 0) return;
    const p = this.prop();
    if (p) {
      p.update(dt, inp);
      this.motion.kick(p.out.kickY, p.out.kickSq);
      p.out.kickY = 0;
      p.out.kickSq = 0;
    }
    this.motion.update(dt, inp);

    // Pose
    const speed = Math.max(0, fin(inp.speed));
    const ground = inp.onGround && !inp.surfing;
    this.groundTime = ground ? this.groundTime + dt : 0;
    this.thumbsCooldown = Math.max(0, this.thumbsCooldown - dt);
    if (this.override >= 0) {
      this.overrideLeft -= dt;
      if (this.overrideLeft <= 0) this.override = -1;
    }
    let base: number;
    let tau = POSE_TAU;
    if (p) {
      base = p.out.pose;
      tau = p.out.poseTau;
    } else if (inp.surfing || this.groundTime < GROUND_POSE_AFTER) base = POSE.open;
    else if (speed > RUN_SPEED || (this.basePose === POSE.run && speed > RUN_SPEED_OFF)) base = POSE.run;
    else base = POSE.relaxed;
    const next = this.force >= 0 ? this.force : !p && this.override >= 0 ? this.override : base;
    if (next !== this.pose && !p && !(isGroundPose(next) && isGroundPose(this.pose))) this.motion.kick(0, POSE_POP * 0.5);
    this.basePose = base;
    this.pose = next;
    const target = POSE_JOINTS[next] ?? POSE_JOINTS[POSE.relaxed];
    // Bei motionFx 0 springt die Pose (keine Bewegung), sonst exponentielles Überblenden.
    const k = this.motion.motionFx <= 0 ? 1 : 1 - Math.exp(-dt / Math.max(0.01, tau));
    const j = this.joints;
    for (let i = 0; i < j.length; i++) j[i] += (target[i] - j[i]) * k;
    this.writeFrame();
  }

  /** Frame befüllen; `visible` setzt der Aufrufer (HUD sichtbar, nicht pausiert, Einstellung). */
  private writeFrame(): void {
    const f = this.frame;
    const m = this.motion;
    const a = this.aspect;
    // Safe-Frame in Bildhöhen: bis 16:9 (+1 %) das ganze Bild, darüber zentriert 16:9.
    const safeHalf = (a <= SAFE_ASPECT * 1.01 ? a : SAFE_ASPECT) / 2;
    f.glove = this.glove;
    f.item = this.item;
    f.x = safeHalf - this.anchorRight + m.x;
    f.y = 0.5 - this.anchorBottom + m.y;
    f.z = 0;
    f.roll = -m.tilt * DEG;
    f.pitch = m.pitch;
    f.yaw = m.yaw;
    f.squash = m.squash;
    f.joints.set(this.joints);
    const p = this.prop();
    if (p) {
      const o = p.out;
      f.x += o.hx;
      f.y += o.hy;
      f.z += o.hz;
      f.roll += o.hroll;
      f.pitch += o.hpitch;
      f.yaw += o.hyaw;
      f.propPos[0] = o.pos[0];
      f.propPos[1] = o.pos[1];
      f.propPos[2] = o.pos[2];
      f.propRot[0] = o.rot[0];
      f.propRot[1] = o.rot[1];
      f.propRot[2] = o.rot[2];
      f.propSpin = o.spin;
      f.propVisible = o.visible;
      f.propScale = o.scale;
      f.canTab = o.canTab;
      f.canOpen = o.canOpen;
      f.knifeBlade = o.knifeBlade;
      f.knifeBite = o.knifeBite;
      f.poof = o.poof;
      f.poofPos[0] = o.poofPos[0];
      f.poofPos[1] = o.poofPos[1];
      f.poofPos[2] = o.poofPos[2];
    } else f.poof = -1;
  }

  /** Frame für diesen Frame fertig machen (Sichtbarkeit), Rückgabe für RenderFx.viewModel. */
  output(visible: boolean): ViewModelFrame {
    this.frame.visible = visible && this.enabled;
    return this.frame;
  }

  /** Zustand für Tools (__vel.hand) — allokiert, nur Debug. */
  state(): ViewHandState {
    const f = this.frame;
    const p = this.prop();
    return {
      visible: f.visible,
      pose: HAND_POSES[this.pose] ?? '?',
      x: this.motion.x,
      y: this.motion.y,
      tilt: this.motion.tilt,
      squash: this.motion.squash,
      glove: this.glove,
      item: this.item,
      trick: p ? p.trick : 'none',
      trickTime: p ? p.trickTime : 0,
      canOpen: this.can.opened,
      cardVisible: this.item === 'card' ? f.propVisible : 0,
      knifeOpen: this.knife.isOpen,
      frame: { x: f.x, y: f.y, z: f.z, roll: f.roll, pitch: f.pitch, yaw: f.yaw },
    };
  }
}

function isGroundPose(p: number): boolean {
  return p === POSE.relaxed || p === POSE.run;
}

const CAN_SET: ReadonlySet<string> = new Set<CanTrick>(['tilt', 'crack', 'sip', 'flip', 'highFlip', 'twirl', 'doubleFlip', 'behindThrow']);
const CARD_SET: ReadonlySet<string> = new Set<CardTrick>(['spin', 'turn', 'tossSpin', 'vanish']);
const KNIFE_SET: ReadonlySet<string> = new Set<KnifeTrick>(['open', 'close', 'rollover', 'aerial', 'doubleAerial']);

function isCanTrick(n: string): n is CanTrick {
  return CAN_SET.has(n);
}
function isCardTrick(n: string): n is CardTrick {
  return CARD_SET.has(n);
}
function isKnifeTrick(n: string): n is KnifeTrick {
  return KNIFE_SET.has(n);
}
