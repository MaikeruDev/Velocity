import type { GameEvent } from '../../engine/events';
import { clamp, fin, speedTier } from './anim';
import { VIEW_AXES, axisAngle, fromEulerXYZ, mat3, mul, toEulerXYZ } from './rot';
import type { Mat3 } from './rot';

/**
 * Gemeinsame Trick-Maschine der Gegenstände (Plan 006): Dose, Karte, Messer.
 * DOM-/three-frei, keine Allokation pro Frame.
 *
 * Jeder Trick ist eine feste Zeitleiste über die Trick-Zeit t (Ausholen → Aktion → Fang →
 * Nachwippen) — framerate-unabhängig. Impulse an die Hand fallen auf den Frame, in dem eine
 * Marke überschritten wird (Größe unabhängig von dt). Regeln (Nutzerwunsch): je schneller,
 * desto cooler; Tricks hängen an Sprüngen, perfekten Hops und Meilensteinen; ein laufender
 * Trick wird nie abgebrochen (außer Respawn/Levelstart); motionFx 0 = statisch.
 */

/** Was ein Gegenstand der Hand pro Frame vorgibt (ViewHand kopiert es in den ViewModelFrame). */
export class PropOut {
  /** Posen-Wunsch (POSE-Index), Überblend-Zeitkonstante (s). */
  pose = 0;
  poseTau = 0.08;
  /** Zusätzlicher Hand-Versatz: Bildhöhen (x rechts, y unten), Einheiten zur Kamera, rad. */
  hx = 0;
  hy = 0;
  hz = 0;
  hpitch = 0;
  hyaw = 0;
  hroll = 0;
  readonly pos = new Float32Array(3);
  readonly rot = new Float32Array(3);
  spin = 0;
  visible = 1;
  scale = 1;
  canTab = 0;
  canOpen = false;
  knifeBlade = Math.PI;
  knifeBite = -Math.PI;
  poof = -1;
  readonly poofPos = new Float32Array(3);
  /** Impulse an die Hand seit dem letzten Abholen (Bildhöhen/s nach unten, Squash/s). */
  kickY = 0;
  kickSq = 0;
}

export interface PropFrameInput {
  readonly speed: number;
  readonly onGround: boolean;
  readonly surfing: boolean;
}

/** Nicht-generische Sicht auf einen Gegenstand (ViewHand wechselt zwischen ihnen). */
export interface PropControl {
  readonly out: PropOut;
  readonly trick: string;
  readonly trickTime: number;
  motionFx: number;
  onEvent(e: GameEvent): void;
  update(dt: number, inp: PropFrameInput): void;
  reset(): void;
  /** Laufenden Trick sofort beenden (Tools). */
  stop(): void;
}

/** Wackelfeder für Überschwinger nach dem Fang (rad), exakt gelöst. */
const WOB_OMEGA = Math.PI * 2 * 3.4;
const WOB_ZETA = 0.3;
const WOB_WD = WOB_OMEGA * Math.sqrt(1 - WOB_ZETA * WOB_ZETA);
const WOB_MAX = 0.7;
/** Harte Landung → Wackeln (rad/s je Stärke). */
const LAND_WOBBLE = 4.5;
const LAND_WOBBLE_FROM = 0.55;

export abstract class PropTricks<T extends string> implements PropControl {
  trick: T | 'none' = 'none';
  readonly out = new PropOut();
  /** 0..1 (GameSettings.motionFx). 0 = keine Tricks, Gegenstand steht still in der Hand. */
  motionFx = 1;

  protected t = 0;
  protected now = 0;
  protected cooldownUntil = 0;
  protected idleLeft = 2.2;
  protected wobX = 0;
  protected wobV = 0;
  private seed = 1;
  private fresh = false;
  private debugAt = -1;
  /** Marken, die in diesem Trick schon gefeuert haben (Bitmaske). */
  private marks = 0;
  // Rotations-Scratch
  private readonly mA: Mat3 = mat3();
  private readonly mB: Mat3 = mat3();

  get busy(): boolean {
    return this.trick !== 'none';
  }

  /** Zeitleiste in Sekunden (für Tools/Tests). */
  get trickTime(): number {
    return this.t;
  }

  /** Tools (__vel.forceTrick): Trick starten, optional bei Trick-Zeit `at` festhalten. */
  debugPlay(id: T | 'none', at = -1): void {
    this.softReset();
    if (id === 'none') return;
    this.start(id);
    this.debugAt = at;
  }

  stop(): void {
    this.debugPlay('none');
  }

  /** Neuer Lauf/Leben (Respawn, Levelstart, Gegenstand gewechselt). */
  reset(): void {
    this.softReset();
    this.resetRun();
  }

  private softReset(): void {
    this.debugAt = -1;
    this.trick = 'none';
    this.t = 0;
    this.wobX = 0;
    this.wobV = 0;
    this.marks = 0;
    this.idleLeft = 2.2;
    this.cooldownUntil = 0;
    this.out.kickY = 0;
    this.out.kickSq = 0;
    this.writeRest(this.out);
  }

  /** Tick-Pfad (EventBus): nur Zahlen setzen. */
  onEvent(e: GameEvent): void {
    switch (e.type) {
      case 'jump': {
        if (this.busy || this.now < this.cooldownUntil || this.motionFx <= 0) break;
        const tier = speedTier(e.speed);
        this.onJump(tier, e.perfect && e.gain > 0);
        break;
      }
      case 'speedMilestone':
        if (!this.busy && this.motionFx > 0) this.onMilestone(speedTier(e.speed));
        break;
      case 'land': {
        const k = clamp(fin(e.impact) / 550, 0, 1.6);
        if (!e.jumpQueued && k >= LAND_WOBBLE_FROM && this.motionFx > 0) this.wobV += (this.rand() < 0.5 ? -1 : 1) * LAND_WOBBLE * k;
        if (!this.busy && this.motionFx > 0) this.onLand(k, e.jumpQueued, fin(e.speed));
        break;
      }
      case 'finish':
        if (!this.busy && this.motionFx > 0) this.onFinish();
        break;
      case 'respawn':
      case 'levelLoaded':
        this.reset();
        break;
      default:
        break;
    }
  }

  update(dtRaw: number, inp: PropFrameInput): void {
    const dt = Number.isFinite(dtRaw) ? clamp(dtRaw, 0, 0.1) : 0;
    if (dt <= 0) return;
    this.now += dt;
    const o = this.out;
    const m = clamp(fin(this.motionFx), 0, 1);
    if (m <= 0) {
      if (this.busy) {
        this.trick = 'none';
        this.t = 0;
      }
      this.wobX = 0;
      this.wobV = 0;
      o.kickY = 0;
      o.kickSq = 0;
      this.writeRest(o);
      return;
    }
    const speed = Math.max(0, fin(inp.speed));
    if (!this.busy) {
      if (inp.onGround && !inp.surfing && speed < 300) {
        this.idleLeft -= dt;
        if (this.idleLeft <= 0) this.idleLeft = this.onIdle();
      } else this.idleLeft = Math.max(this.idleLeft, 1.0);
      if (!this.busy) this.onFree(inp, speed);
    }
    if (this.busy) {
      if (this.fresh) this.fresh = false;
      else this.t += dt;
      if (this.debugAt >= 0) {
        this.t = this.debugAt;
        o.kickY = 0;
        o.kickSq = 0;
      }
      this.writeRest(o);
      const id = this.trick;
      if (id !== 'none' && this.evaluate(id, this.t, dt, inp, m, o)) this.finishTrick();
    } else this.writeRest(o);

    // Wackelfeder: kleiner Überschwinger um die Bild-Tiefenachse.
    const e = Math.exp(-WOB_ZETA * WOB_OMEGA * dt);
    const c = Math.cos(WOB_WD * dt);
    const s = Math.sin(WOB_WD * dt);
    const x0 = this.wobX;
    const v0 = this.wobV;
    this.wobX = clamp(e * (x0 * c + ((v0 + WOB_ZETA * WOB_OMEGA * x0) / WOB_WD) * s), -WOB_MAX, WOB_MAX);
    this.wobV = e * (v0 * c - ((WOB_OMEGA * WOB_OMEGA * x0 + WOB_ZETA * WOB_OMEGA * v0) / WOB_WD) * s);
    if (Math.abs(this.wobX) > 1e-5) this.rotateView(o, 0, 0, 1, this.wobX);
    // Höhen mit weniger motionFx flacher (Drehungen bleiben ganz — halbe Flips gibt es nicht).
    const hs = 0.6 + 0.4 * m;
    o.hx *= m;
    o.hy *= m;
    o.hz *= hs;
    o.hpitch *= m;
    o.hyaw *= m;
    o.hroll *= m;
  }

  // ---------------------------------------------------------------- für Unterklassen

  /** Ruhezustand im Griff (Posen, Transform, Zustand wie offen/zu). */
  protected abstract writeRest(o: PropOut): void;
  /** Zeitleiste auswerten (nach writeRest). true = fertig. */
  protected abstract evaluate(id: T, t: number, dt: number, inp: PropFrameInput, m: number, o: PropOut): boolean;
  protected abstract onJump(tier: number, good: boolean): void;
  protected abstract onMilestone(tier: number): void;
  /** Ruhiger Moment am Boden: Trick starten, Rückgabe = Sekunden bis zum nächsten. */
  protected abstract onIdle(): number;
  /** Abklingzeit (s) nach dem Trick. */
  protected abstract cooldownOf(id: T): number;
  /** Zustand, der einen Lauf/ein Leben lang hält (Dose offen, Karte gewendet …). */
  protected abstract resetRun(): void;
  protected onLand(_k: number, _queued: boolean, _speed: number): void {}
  protected onFinish(): void {}
  /** Jeder Frame ohne Trick (z. B. Balancieren starten, Dose öffnen). */
  protected onFree(_inp: PropFrameInput, _speed: number): void {}

  protected start(id: T): void {
    this.trick = id;
    this.t = 0;
    this.marks = 0;
    this.fresh = true;
  }

  /** Marke i einmal pro Trick (Impulse, Poof …). */
  protected mark(i: number, at: number, t: number): boolean {
    const bit = 1 << i;
    if (t < at || (this.marks & bit) !== 0) return false;
    this.marks |= bit;
    return this.debugAt < 0;
  }

  protected kick(o: PropOut, y: number, sq: number): void {
    o.kickY += y;
    o.kickSq += sq;
  }

  protected spinKick(v: number): void {
    this.wobV += v;
  }

  protected rand(): number {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  /** Versatz in Bildrichtungen (Einheiten): rechts, oben, zur Kamera. */
  protected offsetView(o: PropOut, right: number, up: number, cam: number): void {
    const A = VIEW_AXES;
    o.pos[0] += A.right[0] * right + A.up[0] * up + A.cam[0] * cam;
    o.pos[1] += A.right[1] * right + A.up[1] * up + A.cam[1] * cam;
    o.pos[2] += A.right[2] * right + A.up[2] * up + A.cam[2] * cam;
  }

  /** Drehung um eine Bildachse (ax, ay, az in Bildkoordinaten, normiert) VOR die aktuelle Drehung setzen. */
  protected rotateView(o: PropOut, ax: number, ay: number, az: number, angle: number): void {
    const A = VIEW_AXES;
    const lx = A.right[0] * ax + A.up[0] * ay + A.cam[0] * az;
    const ly = A.right[1] * ax + A.up[1] * ay + A.cam[1] * az;
    const lz = A.right[2] * ax + A.up[2] * ay + A.cam[2] * az;
    this.rotateLocal(o, lx, ly, lz, angle);
  }

  /** Drehung um eine Achse im Handgelenk-Raum vor die aktuelle Drehung setzen. */
  protected rotateLocal(o: PropOut, ax: number, ay: number, az: number, angle: number): void {
    const l = Math.hypot(ax, ay, az) || 1;
    axisAngle(this.mA, ax / l, ay / l, az / l, angle);
    fromEulerXYZ(this.mB, o.rot[0], o.rot[1], o.rot[2]);
    mul(this.mB, this.mA, this.mB);
    toEulerXYZ(this.mB, o.rot);
  }

  private finishTrick(): void {
    const id = this.trick;
    if (id !== 'none') this.cooldownUntil = this.now + this.cooldownOf(id);
    this.trick = 'none';
    this.t = 0;
    this.writeRest(this.out);
  }
}
