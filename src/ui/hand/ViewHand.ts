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
import type { PropControl, PropFrameInput } from './propTricks';
import { CLAW_REST, SkinFx } from './skinFx';
import { SpinnerTricks } from './spinnerTricks';
import type { SpinnerTrick } from './spinnerTricks';
import { YoyoTricks } from './yoyoTricks';
import { LighterTricks } from './lighterTricks';
import { CoinTricks } from './coinTricks';
import { KendamaTricks } from './kendamaTricks';
import { PhoneTricks } from './phoneTricks';
import type { PhoneTrick } from './phoneTricks';
import type { KendamaTrick } from './kendamaTricks';
import type { CoinTrick } from './coinTricks';
import type { LighterTrick } from './lighterTricks';
import type { YoyoTrick } from './yoyoTricks';

/**
 * View-Hand (Plan 006): steuert die 3D-Hand — Bewegung (HandMotion), Posen als Gelenkwinkel
 * mit weichem Überblenden, Gegenstand mit Tricks — und schreibt pro Frame einen
 * ViewModelFrame, den der Renderer nach der Welt zeichnet. DOM- und three-frei (Vitest),
 * keine Allokation pro Frame.
 *
 * Anker: Handgelenk unten rechts im 16:9-Safe-Frame (ui/safeFrame) — auf 21:9/32:9 bleibt
 * der Abstand zur Bildmitte wie auf 16:9, auf 4:3 rückt die Hand mit dem Bildrand nach innen.
 *
 * Plan 007: Gegenstände kommen aus PROP_FACTORIES (lazy, je Gegenstand eine Trick-Maschine),
 * forceTrick ist generisch (PropControl.debugPlayName), Skin-Effekte (Gold-Funkeln, Roboter-LED)
 * aus SkinFx. Reaktionen auf Movement-Events (K8, liest nur Events): Rutschen → Hand flach, tief
 * und außen, keine neuen Tricks; Lip-Step → kurzer Griff; Vault → Abdrücken.
 *
 * Phase 2 (cosmetics-items): Training (KI9) — lessonStage = Faust 0.6 s, lessonDone = Daumen hoch 2.4 s,
 * gezählter Hop = kleiner Ruck; mit Gegenstand jubelt der Gegenstand (PropTricks.onLesson, bricht wie das Ziel
 * Laufendes am Frame-Ende ab — Review: als Checkpoint verpuffte es meist): Stufe = Checkpoint-Reaktion ohne
 * Referenz (Münze Kopf, Spinner-Nabe neutral, Handy vibriert ohne Split; Dose twirl, Karte spin, Messer auf/zu),
 * Lektion = Ziel-Trick ohne Foto (Handy vibriert). Skin-Gelenke (Skelett klappert, Katze tretelt) nur auf den
 * Frame. Handy: takeShutter()/selfieFrame() für das Selfie.
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
/** Kanten-Assist (Plan 007 K8): Lip-Step = kurzer Griff, Vault = flache Hand drückt ab. */
const LEDGE_GRIP_TIME = 0.22;
const LEDGE_VAULT_TIME = 0.35;
/** Überblenden der Gelenke (s) ohne Wunsch des Gegenstands. */
const POSE_TAU = 0.07;
/** Posenwechsel mit kurzem Strecken (Cartoon-Smear). */
const POSE_POP = 0.3;
/** Training (KI9): Stufe geschafft = Ruck wie am Checkpoint, gezählter Hop = kleiner Ruck. */
const LESSON_KICK = -0.8;
const HOP_COUNT_KICK = 0.3;
const HOP_COUNT_SQUASH = -0.5;
/** Selfie-Hand (Peace) im 16:9-Bild der Rückansicht: Lage und Drehung (gemessen im Kontaktblatt). */
const SELFIE = { x: 0.3, y: 0.16, z: 6, pitch: 0.2, yaw: -1.5, roll: -0.6 } as const;

export type AnyTrick = CanTrick | CardTrick | KnifeTrick | SpinnerTrick | YoyoTrick | LighterTrick | CoinTrick | KendamaTrick | PhoneTrick;

/**
 * Registry der Trick-Maschinen (Plan 007): je Gegenstand eine Fabrik, lazy beim ersten Anlegen.
 * Gegenstände ohne Eintrag hält die Hand nicht (leere Hand, Renderer zeichnet nichts).
 * Vollständig seit Plan 007 Phase 2 (tests/cosmetics: Registries decken sich mit render/viewmodel/items).
 */
export const PROP_FACTORIES: { readonly [K in HeldItemId]?: () => PropControl } = {
  can: () => new CanTricks(),
  card: () => new CardTricks(),
  knife: () => new KnifeTricks(),
  spinner: () => new SpinnerTricks(),
  yoyo: () => new YoyoTricks(),
  lighter: () => new LighterTricks(),
  coin: () => new CoinTricks(),
  kendama: () => new KendamaTricks(),
  phone: () => new PhoneTricks(),
};

/** Hat die Hand für diesen Gegenstand eine Trick-Maschine? */
export function hasPropTricks(i: HeldItemId): boolean {
  return PROP_FACTORIES[i] !== undefined;
}

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
  /** Plan 007: Skin (= glove), Skin-Effekt, zweiter Körper, Schnur, Gegenstands-Kanäle, Rutschen. */
  readonly skin: GloveId;
  readonly skinFx: number;
  readonly sub: { readonly x: number; readonly y: number; readonly z: number; readonly visible: number };
  readonly stringCount: number;
  readonly param: readonly number[];
  readonly sliding: boolean;
  /** Trick-Namen des gehaltenen Gegenstands (leer ohne Gegenstand). */
  readonly tricks: readonly string[];
}

/** Halbe Breite des Safe-Frames (Bildhöhen) zum Seitenverhältnis `a`: bis 16:9 (+1 %) das ganze Bild. */
function safeHalfOf(a: number): number {
  return (a <= SAFE_ASPECT * 1.01 ? a : SAFE_ASPECT) / 2;
}

export class ViewHand {
  readonly motion = new HandMotion();
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
  /**
   * Halbe Safe-Frame-Breite in Bildhöhen (aus setAspect): bis 16:9 (+1 %) das ganze Bild, darüber zentriert 16:9.
   * Einmal je Seitenverhältnis — je Frame gerechnet boxte der Zusammenfluss aus Feld und Konstante eine HeapNumber
   * (fallen.md #107.2; 0.7 KiB/s Dauer-Müll in writeFrame, bei jedem Gegenstand und Skin).
   */
  private safeHalf = safeHalfOf(16 / 9);
  private readonly joints = new Float32Array(VM_JOINT_COUNT);
  private pose: number = POSE.relaxed;
  private basePose: number = POSE.relaxed;
  private groundTime = GROUND_POSE_AFTER;
  private override = -1;
  private overrideLeft = 0;
  private thumbsCooldown = 0;
  private started = false;
  private motionFxValue = 1;
  private readonly props = new Map<HeldItemId, PropControl>();
  private current: PropControl | null = null;
  private readonly skinFx = new SkinFx();
  /** Selfie-Frame (Peace-Hand), einmal angelegt; zuletzt gesehener Auslöser des Handys. */
  private readonly selfie: ViewModelFrame = createViewModelFrame();
  private seenShutter = 0;
  /** Eingabe an den Gegenstand (einmal angelegt, pro Frame befüllt). */
  private readonly propIn = { speed: 0, onGround: true, surfing: false, surfSide: 0, handX: 0, handY: 0, handTilt: 0 };

  constructor() {
    this.joints.set(POSE_JOINTS[POSE.relaxed]);
  }

  get motionFx(): number {
    return this.motion.motionFx;
  }

  set motionFx(v: number) {
    const m = clamp(fin(v), 0, 1);
    this.motionFxValue = m;
    this.motion.motionFx = m;
    for (const p of this.props.values()) p.motionFx = m;
  }

  get currentItem(): HeldItemId {
    return this.item;
  }

  get currentGlove(): GloveId {
    return this.glove;
  }

  /** Dose/Karte/Messer als typisierte Sicht (Tools, Tests, Dev-Seite) — legt die Maschine bei Bedarf an. */
  get can(): CanTricks {
    const p = this.propFor('can');
    if (p instanceof CanTricks) return p;
    throw new Error('Dose fehlt in PROP_FACTORIES');
  }

  get card(): CardTricks {
    const p = this.propFor('card');
    if (p instanceof CardTricks) return p;
    throw new Error('Karte fehlt in PROP_FACTORIES');
  }

  get knife(): KnifeTricks {
    const p = this.propFor('knife');
    if (p instanceof KnifeTricks) return p;
    throw new Error('Messer fehlt in PROP_FACTORIES');
  }

  get spinner(): SpinnerTricks {
    const p = this.propFor('spinner');
    if (p instanceof SpinnerTricks) return p;
    throw new Error('Spinner fehlt in PROP_FACTORIES');
  }

  /** Seitenverhältnis des Bildes (Low-Res-Breite / -Höhe) für den Safe-Frame-Anker. */
  setAspect(a: number): void {
    if (Number.isFinite(a) && a > 0.2) this.safeHalf = safeHalfOf(a);
  }

  setGlove(g: GloveId): void {
    if (g !== this.glove) this.skinFx.reset();
    this.glove = g;
  }

  /** Gegenstand wechseln setzt dessen Tricks/Zustand zurück. */
  setItem(i: HeldItemId): void {
    if (i === this.item) return;
    this.item = i;
    this.current = this.propFor(i);
    this.current?.reset();
  }

  /** Trick-Maschine eines Gegenstands (lazy aus PROP_FACTORIES), null = keine. */
  private propFor(i: HeldItemId): PropControl | null {
    const have = this.props.get(i);
    if (have) return have;
    const make = PROP_FACTORIES[i];
    if (!make) return null;
    const p = make();
    p.motionFx = this.motionFxValue;
    this.props.set(i, p);
    return p;
  }

  private prop(): PropControl | null {
    return this.current;
  }

  /** Tools/Tests: Trick-Maschine des gehaltenen Gegenstands (null = leere Hand). */
  get activeProp(): PropControl | null {
    return this.current;
  }

  /** Tools (__vel.forceTrick): Trick des aktuellen Gegenstands starten/festhalten. false = unbekannt. */
  forceTrick(name: string, at = -1): boolean {
    const p = this.prop();
    if (name === 'none') {
      p?.stop();
      return true;
    }
    return p ? p.debugPlayName(name, at) : false;
  }

  /** Tick-Pfad (EventBus): nur Zahlen setzen. */
  onEvent(e: GameEvent): void {
    this.motion.onEvent(e);
    this.skinFx.onEvent(e, this.glove, this.motionFxValue);
    const p = this.prop();
    if (p) p.hold = this.motion.isSliding;
    p?.onEvent(e);
    const holding = p !== null;
    switch (e.type) {
      case 'jump':
        if (!holding && e.clean && e.gain > 0 && e.chain >= THUMBS_HOP_CHAIN && e.sync >= THUMBS_HOP_SYNC && this.thumbsCooldown <= 0 && this.override < 0) {
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
      case 'lessonStage':
        // KI9: Faust (Stufe) bzw. Daumen hoch (Lektion fertig); mit Gegenstand jubelt der (p.onEvent oben, onLesson).
        this.motion.queueKick(LESSON_KICK, 0);
        if (holding) break;
        if (e.lessonDone) this.setOverride(POSE.thumbsUp, THUMBS_FINISH);
        else if (this.override !== POSE.thumbsUp) this.setOverride(POSE.fist, FIST_TIME);
        break;
      case 'lessonHop':
        if (e.counted) this.motion.queueKick(HOP_COUNT_KICK, HOP_COUNT_SQUASH);
        break;
      case 'ledge':
        // Mit Gegenstand hält die Hand fest (nur der Ruck aus HandMotion).
        if (!holding && this.override !== POSE.thumbsUp) this.setOverride(e.kind === 'vault' ? POSE.flat : POSE.grip, e.kind === 'vault' ? LEDGE_VAULT_TIME : LEDGE_GRIP_TIME);
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

  /** Nur aus onEvent (Tick-Pfad): der Posen-Pop wirkt am Frame-Ende wie die Event-Impulse. */
  private setOverride(pose: number, time: number): void {
    if (this.override !== pose) this.motion.queueKick(0, POSE_POP);
    this.override = pose;
    this.overrideLeft = time;
  }

  update(dtRaw: number, inp: HandFrameInput): void {
    const dt = dtRaw - dtRaw === 0 ? clamp(dtRaw, 0, 0.1) : 0;
    if (!this.started) {
      this.started = true;
      this.writeFrame();
    }
    if (dt <= 0) return;
    const p = this.prop();
    const sliding = this.motion.isSliding;
    if (p) {
      const pi = this.propIn;
      pi.speed = inp.speed;
      pi.onGround = inp.onGround;
      pi.surfing = inp.surfing;
      pi.surfSide = inp.surfSide;
      // Hand-Bewegung des letzten Frames (der Gegenstand läuft vor HandMotion, sein Ruck geht an sie).
      pi.handX = this.motion.x;
      pi.handY = this.motion.y;
      pi.handTilt = this.motion.tilt;
      p.hold = sliding;
      p.update(dt, pi);
    }
    this.motion.update(dt, inp);
    if (p) {
      // Trick-Impulse fallen auf den Frame, in dem ihre Marke überschritten wird = sein Ende (fallen.md #77).
      this.motion.kickFrom(p.out);
      p.out.kickY = 0;
      p.out.kickSq = 0;
    }
    this.skinFx.update(dt, this.glove, inp, !p && this.override < 0 && this.force < 0 && this.groundTime > 0.5, this.motionFxValue);

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
    } else if (this.motion.isSliding) base = POSE.flat;
    else if (inp.surfing || this.groundTime < GROUND_POSE_AFTER) base = POSE.open;
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
    if (p) {
      // Schnur-Anker & Co. per FK aus den Gelenken DIESES Frames, Hand-Bewegung dieses Frames.
      const pi = this.propIn;
      pi.handX = this.motion.x;
      pi.handY = this.motion.y;
      pi.handTilt = this.motion.tilt;
      p.afterPose(j, pi, dt);
    }
    this.writeFrame();
  }

  /** Frame befüllen; `visible` setzt der Aufrufer (HUD sichtbar, nicht pausiert, Einstellung). */
  private writeFrame(): void {
    const f = this.frame;
    const m = this.motion;
    const safeHalf = this.safeHalf;
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
    this.skinFx.applyJoints(this.glove, f.joints);
    f.skinFx = this.skinFx.value;
    const p = this.prop();
    if (p) {
      const o = p.out;
      f.x += o.hx;
      f.y += o.hy;
      f.z += o.hz;
      f.roll += o.hroll;
      f.pitch += o.hpitch;
      f.yaw += o.hyaw;
      // Plan 008: Gelenk-Versatz des Gegenstands (Handgelenk-Flick, Finger-Kontakt) auf die Pose.
      const ja = o.jointAdd;
      for (let i = 0; i < ja.length; i++) f.joints[i] += ja[i];
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
      f.subPos[0] = o.sub[0];
      f.subPos[1] = o.sub[1];
      f.subPos[2] = o.sub[2];
      f.subRot[0] = o.subRot[0];
      f.subRot[1] = o.subRot[1];
      f.subRot[2] = o.subRot[2];
      f.subSpin = o.subSpin;
      f.subVisible = o.subVisible;
      f.stringCount = o.stringCount;
      if (o.stringCount > 0) f.stringPts.set(o.string);
      f.propParam.set(o.param);
    } else {
      f.poof = -1;
      f.subVisible = 0;
      f.stringCount = 0;
    }
  }

  /**
   * Handy (KI7): true genau einmal je Auslöser des Ziel-Fotos — dann macht Game das Selfie
   * (RendererApi.selfie(96, 54, selfieFrame())). Andere Gegenstände: immer false. Der Auslöser kommt
   * SHUTTER_AT (0.76 s) nach dem Ziel-Event: Game fragt JEDEN Frame des Ziel-Ausrollens ab (bis zum Ergebnis,
   * FINISH_MENU_DELAY 1.1 s); erscheint das Ergebnis früher, takeShutterNow().
   */
  takeShutter(): boolean {
    const p = this.current;
    if (p instanceof PhoneTricks && p.shutterCount > this.seenShutter) {
      this.seenShutter = p.shutterCount;
      return true;
    }
    return false;
  }

  /**
   * Ergebnis erscheint jetzt, vor dem Auslöser (Enter/Esc im Ziel-Ausrollen, Tod nach dem Ziel): ein
   * anstehendes Ziel-Foto sofort auslösen. true = Game macht jetzt das Selfie (auch, wenn der Auslöser schon
   * kam, aber noch nicht abgeholt wurde). Ohne Handy oder ohne Ziel-Foto: false.
   */
  takeShutterNow(): boolean {
    const p = this.current;
    if (p instanceof PhoneTricks) p.shootNow();
    return this.takeShutter();
  }

  /** Peace-Hand für das Selfie (zweiter Viewmodel-Durchgang): aktueller Skin, ohne Gegenstand. */
  selfieFrame(): ViewModelFrame {
    const f = this.selfie;
    f.visible = true;
    f.glove = this.glove;
    f.item = 'none';
    f.x = SELFIE.x;
    f.y = SELFIE.y;
    f.z = SELFIE.z;
    f.pitch = SELFIE.pitch;
    f.yaw = SELFIE.yaw;
    f.roll = SELFIE.roll;
    f.squash = 1;
    f.joints.set(POSE_JOINTS[POSE.peace]);
    f.skinFx = this.glove === 'cat' ? CLAW_REST : 0;
    f.poof = -1;
    f.subVisible = 0;
    f.stringCount = 0;
    return f;
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
    const can = this.props.get('can');
    const knife = this.props.get('knife');
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
      canOpen: can instanceof CanTricks ? can.opened : false,
      cardVisible: this.item === 'card' ? f.propVisible : 0,
      knifeOpen: knife instanceof KnifeTricks ? knife.isOpen : false,
      frame: { x: f.x, y: f.y, z: f.z, roll: f.roll, pitch: f.pitch, yaw: f.yaw },
      skin: this.glove,
      skinFx: f.skinFx,
      sub: { x: f.subPos[0], y: f.subPos[1], z: f.subPos[2], visible: f.subVisible },
      stringCount: f.stringCount,
      param: Array.from(f.propParam),
      sliding: this.motion.isSliding,
      tricks: p ? p.trickNames : [],
    };
  }
}

function isGroundPose(p: number): boolean {
  return p === POSE.relaxed || p === POSE.run;
}
