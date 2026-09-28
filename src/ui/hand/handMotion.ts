import type { GameEvent } from '../../engine/events';
import { Spring, approach, clamp, fin } from './anim';

/**
 * Bewegung der View-Hand (Plan 004, in Plan 006 unverändert übernommen und um 3D-Drehungen
 * ergänzt): Versatz, Neigung, Squash und Sway aus Spieler-Snapshot, Blick-Delta und Events.
 * DOM-frei, keine Allokation pro Frame. Längen in Bildhöhen (0.01 = 1 % der Höhe), y nach
 * unten; Winkel: tilt in Grad (Bildneigung), yaw/pitch in rad (3D-Sway des Viewmodels).
 *
 * Gefühl vor Show: alle Auslenkungen weich gesättigt und hart geklemmt, Bhop-Landungen und
 * Kettensprünge nur leicht (50 Hops sollen nicht nerven), Landungen einen Tick zurückgehalten
 * (fallen.md #54).
 *
 * Zeitpunkt der Events (Plan 007 K9): sie kommen aus den Ticks DIESES Frames, gelten also am
 * Frame-Ende (fallen.md #77) — Impulse wirken nach dem Federschritt, Zustände aus Events (Rutschen,
 * Einfahren) ab dem nächsten Frame, die Lande-Verzögerung wird per Spring.impulse exakt nachgeholt.
 * Am Frame-Anfang angesetzt lief die Hand bei 30 Hz einen Frame vor (6.6 px gegen 2400 Hz).
 */

/** Grenzen der Auslenkung (Bildhöhen, Grad) — Tests prüfen genau diese. */
export const HAND_LIMITS = {
  x: 0.07,
  yUp: 0.08,
  yDown: 0.12,
  /** Zusätzlich beim Respawn-Einfahren (von unten). */
  enter: 0.42,
  tilt: 14,
  squashMin: 0.86,
  squashMax: 1.12,
  /** 3D-Sway (rad). */
  yaw: 0.16,
  pitch: 0.14,
} as const;

const TAU = Math.PI * 2;

const Y_OMEGA = TAU * 3.1;
const Y_ZETA = 0.42;
const X_OMEGA = TAU * 2.6;
const X_ZETA = 0.5;
const TILT_OMEGA = TAU * 2.3;
const TILT_ZETA = 0.5;
const SQ_OMEGA = TAU * 4.6;
const SQ_ZETA = 0.34;
const ROT_OMEGA = TAU * 2.2;
const ROT_ZETA = 0.45;

const JUMP_KICK = -0.95;
const JUMP_CHAIN_SHARE = 0.3;
const JUMP_STRETCH = 1.1;
/** Sprung: Hand kippt kurz nach oben (rad/s auf den Pitch). */
const JUMP_PITCH = 1.4;
const LAND_KICK = 1.0;
const LAND_REF = 550;
const LAND_SQUASH = 3.2;
const LAND_PITCH = -1.8;
const LAND_HOP_SHARE = 0.18;
const LAND_HOLD = 0.012;

const SWAY_RATE_REF = 4.5;
const SWAY_X = 0.05;
const SWAY_Y = 0.03;
const SWAY_TILT = 5;
const SWAY_YAW = 0.12;
const SWAY_PITCH = 0.1;
const STRAFE_TILT = 4.5;

const BOB_REF_SPEED = 300;
const BOB_MAX = 1.2;
const BOB_X = 0.011;
const BOB_Y = 0.012;
const BOB_FADE = 0.08;
const BREATH_Y = 0.004;
const BREATH_PERIOD = 3.4;

const AIR_LIFT = -0.012;
const AIR_SINK_FROM = 0.3;
const AIR_SINK_RATE = 0.022;
const AIR_SINK_MAX = 0.035;

const DUCK_Y = 0.04;
const DUCK_X = 0.008;

const WIND_FROM = 480;
const WIND_FULL = 1100;
const WIND_Y = 0.04;
const WIND_X = 0.028;
/** Fahrtwind drückt die Hand nach hinten (Pitch weg von der Kamera, rad). */
const WIND_PITCH = -0.1;
const VIB_LOW = 0.0018;
const VIB_HIGH = 0.0055;
const VIB_HIGH_FROM = 1000;

const SURF_TILT = 12;
const SURF_X = 0.022;
const SURF_Y = -0.02;
const SURF_YAW = 0.1;

/** Rutschen (Plan 007 K8): Hand tief und nach außen, leicht nach hinten gekippt ("Tuck"). */
const SLIDE_Y = 0.055;
const SLIDE_X = 0.03;
const SLIDE_TILT = -7;
const SLIDE_PITCH = -0.08;
/** Rutsch-Zustand ohne slideEnd löschen, wenn man länger in der Luft ist (Absicherung). */
const SLIDE_AIR_CLEAR = 0.25;
/** Kanten-Assist: Lip-Step = kurzer Griff (Hand taucht leicht ab), Vault = Abdrücken (kräftig nach unten). */
const STEP_KICK = 0.55;
const STEP_PITCH = -0.6;
const VAULT_KICK = 1.3;
const VAULT_SQUASH = 1.6;
const VAULT_PITCH = -1.4;

const TARGET_TAU = 0.07;
const ENTER_TAU = 0.11;
const FIST_KICK = -0.8;

/** Eingabe pro Frame — Game füllt ein wiederverwendetes Objekt. */
export interface HandFrameInput {
  speed: number;
  onGround: boolean;
  surfing: boolean;
  ducked: boolean;
  /** 0..1 Schrittzyklus (PlayerSnapshot.stridePhase). */
  stridePhase: number;
  airTime: number;
  /** Blick-Änderung seit dem letzten Frame (rad, yaw > 0 = nach links, pitch > 0 = nach oben). */
  yawDelta: number;
  pitchDelta: number;
  /** A/D −1..1 (D = +1). */
  side: number;
  /** Seitenanteil der Surf-Normale in Blickrichtung rechts (dot(n, right)), 0 ohne Surf. */
  surfSide: number;
}

export function makeHandInput(): HandFrameInput {
  return { speed: 0, onGround: true, surfing: false, ducked: false, stridePhase: 0, airTime: 0, yawDelta: 0, pitchDelta: 0, side: 0, surfSide: 0 };
}

export class HandMotion {
  x = 0;
  y = 0;
  tilt = 0;
  squash = 1;
  yaw = 0;
  pitch = 0;
  /** 0..1 Stärke aller Bewegungen (GameSettings.motionFx). 0 = statische Pose. */
  motionFx = 1;

  private t = 0;
  private readonly sy = new Spring(0, Y_OMEGA, Y_ZETA);
  private readonly sx = new Spring(0, X_OMEGA, X_ZETA);
  private readonly st = new Spring(0, TILT_OMEGA, TILT_ZETA);
  private readonly sq = new Spring(1, SQ_OMEGA, SQ_ZETA);
  private readonly syaw = new Spring(0, ROT_OMEGA, ROT_ZETA);
  private readonly spitch = new Spring(0, ROT_OMEGA, ROT_ZETA);
  private bob = 0;
  private duck = 0;
  private wind = 0;
  private surf = 0;
  private surfSide = 0;
  private enter = 0;
  private landPending = -1;
  private landAge = 0;
  private landHop = false;
  /** Landung kam in diesem Frame: die Verzögerung läuft erst ab seinem Ende. */
  private landFresh = false;
  private enterFresh = false;
  private slide = 0;
  private sliding = false;
  /** Rutschen, wie es während dieses Frames galt (slideStart/-End wirken ab Frame-Ende). */
  private slideWas = 0;
  /** Impulse aus Events dieses Frames (y, Squash, Pitch pro s) — wirken am Ende des nächsten update(). */
  private qy = 0;
  private qsq = 0;
  private qpitch = 0;
  /** dt des laufenden update() (Feld statt Argument: kein Boxing, falls V8 nicht inlinet). */
  private frameDt = 0;
  /**
   * Zustands-Eingaben, die WÄHREND dieses Frames galten = Stand am Ende des letzten: ein Wechsel
   * (Absprung, A/D, Ducken) kommt wie die Events aus den Ticks dieses Frames und gilt ab seinem Ende
   * (#77). Das Blick-Delta ist ein Intervall-Maß und gilt sofort. Erster Frame = aktuelle Eingabe
   * (gleichbleibende Eingaben rechnen bitgleich wie vorher).
   */
  private readonly held: HandFrameInput = makeHandInput();
  private heldPrimed = false;
  /** Tempo aus `held` (für die Vibration in writeOutput, nach hold()). */
  private heldSpeed = 0;

  /** Rutscht der Spieler gerade (slideStart … slideEnd)? */
  get isSliding(): boolean {
    return this.sliding;
  }

  /** Neigungsrate der Hand (°/s) — Tricks (Balancieren) lesen sie. */
  get tiltRate(): number {
    return this.st.v;
  }

  reset(): void {
    this.sy.reset(0);
    this.sx.reset(0);
    this.st.reset(0);
    this.sq.reset(1);
    this.syaw.reset(0);
    this.spitch.reset(0);
    this.bob = 0;
    this.duck = 0;
    this.wind = 0;
    this.surf = 0;
    this.surfSide = 0;
    this.enter = 0;
    this.enterFresh = false;
    this.landPending = -1;
    this.landFresh = false;
    this.slide = 0;
    this.sliding = false;
    this.slideWas = 0;
    this.qy = 0;
    this.qsq = 0;
    this.qpitch = 0;
    this.heldPrimed = false;
    this.x = 0;
    this.y = 0;
    this.tilt = 0;
    this.squash = 1;
    this.yaw = 0;
    this.pitch = 0;
  }

  /**
   * Impuls JETZT (y in Bildhöhen/s nach unten, Squash/s): für Aufrufer nach update() — Tricks und
   * Posenwechsel dieses Frames, deren Marke am Frame-Ende liegt. Aus dem Tick-Pfad: queueKick.
   */
  kick(y: number, sq: number): void {
    this.sy.v += fin(y);
    this.sq.v += fin(sq);
  }

  /** Wie kick(), aber aus einem Objekt gelesen (Trick-Impulse): keine Kommazahl-Argumente, kein Boxing. */
  kickFrom(o: { readonly kickY: number; readonly kickSq: number }): void {
    this.sy.v += fin(o.kickY);
    this.sq.v += fin(o.kickSq);
  }

  /** Impuls aus dem Tick-Pfad (Event dieses Frames): wirkt am Ende des nächsten update(). */
  queueKick(y: number, sq: number): void {
    this.qy += fin(y);
    this.qsq += fin(sq);
  }

  /** Tick-Pfad (EventBus): nur Zahlen, nichts allokieren. */
  onEvent(e: GameEvent): void {
    switch (e.type) {
      case 'jump': {
        if (this.landPending >= 0) this.landHop = true;
        // Ein Sprung beendet die Rutsche immer (PlayerMovement schickt slideEnd erst NACH dem jump).
        this.sliding = false;
        const k = e.chain >= 2 ? JUMP_CHAIN_SHARE : 1;
        this.qy += JUMP_KICK * k;
        this.qsq += JUMP_STRETCH * k;
        this.qpitch += JUMP_PITCH * k;
        break;
      }
      case 'land': {
        this.landPending = clamp(fin(e.impact) / LAND_REF, 0, 1.6);
        this.landAge = 0;
        this.landFresh = true;
        this.landHop = e.jumpQueued;
        break;
      }
      case 'checkpoint':
      case 'finish':
        this.qy += FIST_KICK;
        break;
      case 'slideStart':
        this.sliding = true;
        break;
      case 'slideEnd':
        this.sliding = false;
        break;
      case 'ledge':
        if (e.kind === 'vault') {
          this.qy += VAULT_KICK;
          this.qsq -= VAULT_SQUASH;
          this.qpitch += VAULT_PITCH;
        } else {
          this.qy += STEP_KICK;
          this.qpitch += STEP_PITCH;
        }
        break;
      case 'respawn':
      case 'levelLoaded':
        this.reset();
        this.enter = 1;
        this.enterFresh = true;
        break;
      default:
        break;
    }
  }

  update(dtRaw: number, inp: HandFrameInput): void {
    const dt = Number.isFinite(dtRaw) ? clamp(dtRaw, 0, 0.1) : 0;
    if (dt <= 0) return;
    this.t += dt;
    this.frameDt = dt;
    if (!this.heldPrimed) {
      this.hold(inp);
      this.heldPrimed = true;
    }
    // Kleine Methoden ohne Kommazahl-Argumente (dt als Feld): ein großes update() sprengte das
    // Inlining-Budget von V8, dann boxt jeder Aufruf von step/approach seine Zahlen (Dauer-Müll).
    this.updateStates();
    this.stepSprings(inp);
    this.frameEndImpulses();
    this.sy.x = clamp(this.sy.x, -HAND_LIMITS.yUp * 1.5, HAND_LIMITS.yDown * 1.5);
    this.sq.x = clamp(this.sq.x, HAND_LIMITS.squashMin - 0.1, HAND_LIMITS.squashMax + 0.1);
    this.writeOutput(inp);
  }

  /** Geglättete Zustände aus den Eingaben, die während dieses Frames galten (held). */
  private updateStates(): void {
    const dt = this.frameDt;
    const s = this.held;
    const speed = Math.max(0, fin(s.speed));
    this.heldSpeed = speed;
    const ground = s.onGround && !s.surfing;
    if (this.sliding && !s.onGround && fin(s.airTime) > SLIDE_AIR_CLEAR) this.sliding = false;
    this.slide = approach(this.slide, this.slideWas, TARGET_TAU, dt);
    this.slideWas = this.sliding ? 1 : 0;
    // Beim Rutschen kein Lauf-Bob (keine Schritte).
    const bobTarget = ground && !this.sliding ? clamp(speed / BOB_REF_SPEED, 0, BOB_MAX) : 0;
    this.bob = approach(this.bob, bobTarget, BOB_FADE, dt);
    this.duck = approach(this.duck, s.ducked ? 1 : 0, TARGET_TAU, dt);
    const windTarget = clamp((speed - WIND_FROM) / (WIND_FULL - WIND_FROM), 0, 1);
    this.wind = approach(this.wind, windTarget, TARGET_TAU * 3, dt);
    this.surf = approach(this.surf, s.surfing ? 1 : 0, TARGET_TAU, dt);
    if (s.surfing) this.surfSide = approach(this.surfSide, clamp(fin(s.surfSide), -1, 1), TARGET_TAU, dt);
    if (this.enterFresh) this.enterFresh = false;
    else this.enter = approach(this.enter, 0, ENTER_TAU, dt);
  }

  /** Federziele (Zustand + Maus-Sway dieses Frames) und Federschritt; merkt danach die neue Eingabe. */
  private stepSprings(inp: HandFrameInput): void {
    const dt = this.frameDt;
    const s = this.held;
    // Maus-Sway: Trägheit gegen die Drehung (links drehen → Hand bleibt rechts zurück).
    const swX = Math.tanh(fin(inp.yawDelta) / dt / SWAY_RATE_REF);
    const swY = Math.tanh(fin(inp.pitchDelta) / dt / SWAY_RATE_REF);
    const air = !s.onGround && !s.surfing;
    const sink = air ? AIR_LIFT + clamp((fin(s.airTime) - AIR_SINK_FROM) * AIR_SINK_RATE, 0, AIR_SINK_MAX - AIR_LIFT) : 0;
    const yTarget = SWAY_Y * swY + sink + DUCK_Y * this.duck + WIND_Y * this.wind + SURF_Y * this.surf + SLIDE_Y * this.slide;
    const xTarget = SWAY_X * swX + DUCK_X * this.duck + WIND_X * this.wind - SURF_X * this.surf * this.surfSide + SLIDE_X * this.slide;
    const side = clamp(fin(s.side), -1, 1);
    const tiltTarget = -STRAFE_TILT * side * (air ? 1 : 0.5) + SWAY_TILT * swX + SURF_TILT * this.surf * this.surfSide + SLIDE_TILT * this.slide;
    this.hold(inp);
    // Ziel/Schrittweite als Felder (Spring.stepGoal): kein Aufruf mit Kommazahlen im Frame-Pfad.
    this.sy.goal = yTarget;
    this.sx.goal = xTarget;
    this.st.goal = tiltTarget;
    this.sq.goal = 1;
    this.syaw.goal = SWAY_YAW * swX + SURF_YAW * this.surf * this.surfSide;
    this.spitch.goal = -SWAY_PITCH * swY + WIND_PITCH * this.wind + SLIDE_PITCH * this.slide;
    this.sy.h = dt;
    this.sx.h = dt;
    this.st.h = dt;
    this.sq.h = dt;
    this.syaw.h = dt;
    this.spitch.h = dt;
    this.sy.stepGoal();
    this.sx.stepGoal();
    this.st.stepGoal();
    this.sq.stepGoal();
    this.syaw.stepGoal();
    this.spitch.stepGoal();
  }

  /** Ausgabe: Federn + Lauf-Bob, Atmen, Fahrtwind-Vibration, geklemmt und × motionFx. */
  private writeOutput(inp: HandFrameInput): void {
    const speed = this.heldSpeed;
    const ph = TAU * fin(inp.stridePhase);
    const bw = this.bob;
    const bobX = BOB_X * bw * Math.sin(ph);
    const bobY = 0.5 * BOB_Y * bw * (1 + Math.cos(2 * ph));
    const still = clamp(1 - bw, 0, 1);
    const breath = BREATH_Y * still * Math.sin((TAU * this.t) / BREATH_PERIOD);
    const vibAmp = this.wind > 0.001 ? VIB_LOW + (VIB_HIGH - VIB_LOW) * clamp((speed - VIB_HIGH_FROM) / 200, 0, 1) : 0;
    const vib = vibAmp * this.wind;
    const t = this.t;
    const vibX = vib * (Math.sin(t * 157) * 0.6 + Math.sin(t * 241 + 1.3) * 0.4);
    const vibY = vib * (Math.sin(t * 199 + 0.7) * 0.6 + Math.sin(t * 283 + 2.1) * 0.4);

    const m = clamp(fin(this.motionFx), 0, 1);
    if (m <= 0) {
      this.x = 0;
      this.y = 0;
      this.tilt = 0;
      this.squash = 1;
      this.yaw = 0;
      this.pitch = 0;
      return;
    }
    const L = HAND_LIMITS;
    this.x = m * clamp(this.sx.x + bobX + vibX, -L.x, L.x);
    this.y = m * (clamp(this.sy.x + bobY + breath + vibY, -L.yUp, L.yDown) + L.enter * this.enter);
    this.tilt = m * clamp(this.st.x + 0.6 * Math.sin((TAU * t) / (BREATH_PERIOD * 1.3)) * still, -L.tilt, L.tilt);
    this.squash = 1 + m * (clamp(this.sq.x, L.squashMin, L.squashMax) - 1);
    this.yaw = m * clamp(this.syaw.x, -L.yaw, L.yaw);
    this.pitch = m * clamp(this.spitch.x, -L.pitch, L.pitch);
  }

  /**
   * Nach dem Federschritt: Impulse der Events dieses Frames (Frame-Ende = τ 0) und die fällige
   * Lande-Verzögerung (12 ms ab Frame-Ende der Landung) — die liegt meist mitten in einem Frame
   * und wird mit ihrem Alter exakt nachgeholt (bei 30 Hz sonst bis 21 ms zu spät). Bhop-Landung
   * (Sprung folgt) wirkt mit dem Sprung.
   */
  private frameEndImpulses(): void {
    if (this.landPending >= 0) {
      if (this.landHop) this.landImpulse(LAND_HOP_SHARE, 0);
      else if (this.landFresh) this.landAge = 0;
      else {
        this.landAge += this.frameDt;
        if (this.landAge >= LAND_HOLD) this.landImpulse(1, this.landAge - LAND_HOLD);
      }
    }
    this.landFresh = false;
    if (this.qy !== 0 || this.qsq !== 0 || this.qpitch !== 0) {
      this.sy.v += this.qy;
      this.sq.v += this.qsq;
      this.spitch.v += this.qpitch;
      this.qy = 0;
      this.qsq = 0;
      this.qpitch = 0;
    }
  }

  /** Zustands-Eingaben für den nächsten Frame merken (nur Kopie, keine Allokation). */
  private hold(inp: HandFrameInput): void {
    const h = this.held;
    h.speed = inp.speed;
    h.onGround = inp.onGround;
    h.surfing = inp.surfing;
    h.ducked = inp.ducked;
    h.airTime = inp.airTime;
    h.side = inp.side;
    h.surfSide = inp.surfSide;
  }

  private landImpulse(share: number, age: number): void {
    const k = this.landPending * share;
    this.sy.impulse(LAND_KICK * k, age);
    this.sq.impulse(-LAND_SQUASH * k, age);
    this.spitch.impulse(LAND_PITCH * k, age);
    this.landPending = -1;
  }
}
