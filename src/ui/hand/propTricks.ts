import type { GameEvent } from '../../engine/events';
import { VM_STRING_POINTS } from '../../render/types';
import { clamp, fin, speedTier } from './anim';
import { VIEW_AXES, axisAngle, fromEulerXYZ, mat3, mul, toEulerXYZ } from './rot';
import type { Mat3 } from './rot';

/**
 * Gemeinsame Trick-Maschine der Gegenstände (Plan 006): Dose, Karte, Messer — seit Plan 007
 * auch Spinner, Jo-Jo, Münze, Feuerzeug, Kendama und Handy.
 * DOM-/three-frei, keine Allokation pro Frame.
 *
 * Jeder Trick ist eine feste Zeitleiste über die Trick-Zeit t (Ausholen → Aktion → Fang →
 * Nachwippen) — framerate-unabhängig. Impulse an die Hand fallen auf den Frame, in dem eine
 * Marke überschritten wird (Größe unabhängig von dt). Regeln (Nutzerwunsch): je schneller,
 * desto cooler; Tricks hängen an Sprüngen, guten Hops (jump.clean: perfekt oder in der Lande-Gnade,
 * lobt wie Kamera und Landewelle) und Meilensteinen; ein laufender
 * Trick wird nie abgebrochen (außer Respawn/Levelstart); motionFx 0 = statisch.
 *
 * Plan 007: Haken für Checkpoint, Surf-Beginn und -Ende (nur ohne laufenden Trick und mit
 * motionFx > 0), Zustands-Tricks (ein Trick wartet auf einen Zustand, z. B. "balanciert, solange
 * gesurft wird" — passt zu "nie abbrechen"), `hold` (Rutschen: keine neuen Tricks) und
 * Ausgabefelder für einen zweiten Körper, eine Schnur und Gegenstands-Kanäle (VM_PARAM).
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
  /** Zweiter Körper im Handgelenk-Raum (Jo-Jo, Kendama-Kugel): Mitte, Euler XYZ, Eigendrehung, Sichtbarkeit (0 = keiner). */
  readonly sub = new Float32Array(3);
  readonly subRot = new Float32Array(3);
  subSpin = 0;
  subVisible = 0;
  /** Schnur: VM_STRING_POINTS Punkte xyz, Punkt 0 = Finger/Griff; stringCount 0 = keine. */
  readonly string = new Float32Array(VM_STRING_POINTS * 3);
  stringCount = 0;
  /** Gegenstands-Kanäle (render/types VM_PARAM). */
  readonly param = new Float32Array(4);
  /** Impulse an die Hand seit dem letzten Abholen (Bildhöhen/s nach unten, Squash/s). */
  kickY = 0;
  kickSq = 0;
}

export interface PropFrameInput {
  readonly speed: number;
  readonly onGround: boolean;
  readonly surfing: boolean;
  /**
   * Bewegung der Hand (HandMotion, letzter Frame): Versatz des Handgelenk-Ankers in Bildhöhen
   * (x rechts, y unten) und Neigung in Grad (+ = gegen den Uhrzeigersinn). Schnur und Pendel
   * rechnen daraus Scheinkraft und Schwerkraft (ui/hand/rope RopeDrive.setFrame).
   */
  readonly handX?: number;
  readonly handY?: number;
  readonly handTilt?: number;
  /** Seitenanteil der Surf-Normale (dot(n, rechts)), 0 ohne Surf. */
  readonly surfSide?: number;
}

/** Nicht-generische Sicht auf einen Gegenstand (ViewHand wechselt zwischen ihnen). */
export interface PropControl {
  readonly out: PropOut;
  readonly trick: string;
  readonly trickTime: number;
  /** Alle Trick-Namen dieses Gegenstands (Tools: __vel.forceTrick, Kontaktblätter). */
  readonly trickNames: readonly string[];
  /** Läuft gerade ein Zustands-Trick (Surf-Balance …)? Zählt in Takt-Messungen nicht als Trick. */
  readonly inState: boolean;
  motionFx: number;
  /** Keine NEUEN Tricks (Rutschen, Plan 007 K8); laufende spielen zu Ende. */
  hold: boolean;
  onEvent(e: GameEvent): void;
  update(dt: number, inp: PropFrameInput): void;
  /**
   * Plan 007: nach dem Überblenden der Gelenke (ViewHand), mit den Gelenkwinkeln DIESES Frames und der
   * Hand-Bewegung dieses Frames (handX/handY/handTilt) — Schnur-Anker per FK sitzen so exakt am Finger.
   * Standard: nichts. Ohne ViewHand (Proben) wird es nicht gerufen; die Zeitleisten laufen trotzdem.
   */
  afterPose(joints: ArrayLike<number>, inp: PropFrameInput, dt: number): void;
  reset(): void;
  /** Laufenden Trick sofort beenden (Tools). */
  stop(): void;
  /** Tools: Trick per Namen starten, bei `at` ≥ 0 festhalten; 'none' = zurück. false = unbekannt. */
  debugPlayName(name: string, at: number): boolean;
}

/** Wackelfeder für Überschwinger nach dem Fang (rad), exakt gelöst. */
const WOB_OMEGA = Math.PI * 2 * 3.4;
const WOB_ZETA = 0.3;
const WOB_WD = WOB_OMEGA * Math.sqrt(1 - WOB_ZETA * WOB_ZETA);
const WOB_MAX = 0.7;
/** Harte Landung → Wackeln (rad/s je Stärke). */
const LAND_WOBBLE = 4.5;
const LAND_WOBBLE_FROM = 0.55;
const NO_TRICKS: readonly string[] = [];

export abstract class PropTricks<T extends string> implements PropControl {
  trick: T | 'none' = 'none';
  readonly out = new PropOut();
  /** 0..1 (GameSettings.motionFx). 0 = keine Tricks, Gegenstand steht still in der Hand. */
  motionFx = 1;
  hold = false;

  protected t = 0;
  protected now = 0;
  protected cooldownUntil = 0;
  protected idleLeft = 2.2;
  protected wobX = 0;
  protected wobV = 0;
  /** Tempo des letzten Frames (der Surf-Beginn kommt als Event ohne Tempo). */
  protected lastSpeed = 0;
  /**
   * Seitenneigung der Rampe (surfSide) — nur beim Surfen aktualisiert, danach gehalten: Surf-Zustände
   * blenden sie mit ihrem Ausklang weich aus. Live gelesen sprang sie am Surf-Ende auf 0 (Ruck in der
   * Lage; beim Kendama warf das die Kugel aus dem Becher, 3.3 Einheiten Unterschied zwischen Frameraten).
   */
  protected surfLean = 0;
  private seed = 1;
  private fresh = false;
  private debugAt = -1;
  /** Marken, die in diesem Trick schon gefeuert haben (Bitmaske). */
  private marks = 0;
  /** Wie lange die zuletzt gefeuerte Marke schon zurückliegt (s, Trick-Zeit − Marke). */
  private markLate = 0;
  /** Wackel-Impulse dieses Frames als Beitrag zu Lage/Rate am Frame-Ende (exakt nachgeholt, s. spinKick). */
  private wobQX = 0;
  private wobQV = 0;
  private wobDt = 0;
  // Rotations-Scratch
  private readonly mA: Mat3 = mat3();
  private readonly mB: Mat3 = mat3();

  get busy(): boolean {
    return this.trick !== 'none';
  }

  /** Trick-Namen (Unterklassen überschreiben; Standard leer, z. B. für Prototypen). */
  get trickNames(): readonly string[] {
    return NO_TRICKS;
  }

  get inState(): boolean {
    return this.trick !== 'none' && this.isState(this.trick);
  }

  /** Tools: Trick festgehalten (forceTrick mit `at`) — Kontaktblätter zeigen dann den eingeschwungenen Zustand. */
  protected get held(): boolean {
    return this.debugAt >= 0;
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

  debugPlayName(name: string, at: number): boolean {
    if (name === 'none') {
      this.stop();
      return true;
    }
    if (!this.isTrick(name)) return false;
    this.debugPlay(name, at);
    return true;
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
    this.wobQX = 0;
    this.wobQV = 0;
    this.marks = 0;
    this.idleLeft = 2.2;
    this.cooldownUntil = 0;
    this.out.kickY = 0;
    this.out.kickSq = 0;
    this.writeRest(this.out);
  }

  /** Neue Tricks erlaubt? Kein laufender, Bewegung an, nicht beim Rutschen. */
  protected get free(): boolean {
    return !this.busy && this.motionFx > 0 && !this.hold;
  }

  /** Tick-Pfad (EventBus): nur Zahlen setzen. */
  onEvent(e: GameEvent): void {
    switch (e.type) {
      case 'jump': {
        if (!this.free || this.now < this.cooldownUntil) break;
        const tier = speedTier(e.speed);
        this.onJump(tier, e.clean && e.gain > 0);
        break;
      }
      case 'speedMilestone':
        if (this.free) this.onMilestone(speedTier(e.speed));
        break;
      case 'land': {
        const k = clamp(fin(e.impact) / 550, 0, 1.6);
        // Landung = Frame-Ende (#77): wirkt nach dem Wackel-Schritt des nächsten update().
        if (!e.jumpQueued && k >= LAND_WOBBLE_FROM && this.motionFx > 0) this.wobQV += (this.rand() < 0.5 ? -1 : 1) * LAND_WOBBLE * k;
        if (this.free) this.onLand(k, e.jumpQueued, fin(e.speed));
        break;
      }
      case 'finish':
        if (this.free) this.onFinish();
        break;
      case 'checkpoint':
        if (this.free) this.onCheckpoint(e.split);
        break;
      case 'surfStart':
        if (this.free) this.onSurfStart(this.lastSpeed);
        break;
      case 'surfEnd':
        if (this.free) this.onSurfEnd();
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
      this.wobQX = 0;
      this.wobQV = 0;
      o.kickY = 0;
      o.kickSq = 0;
      this.writeRest(o);
      return;
    }
    const speed = Math.max(0, fin(inp.speed));
    this.lastSpeed = speed;
    if (inp.surfing) this.surfLean = clamp(fin(inp.surfSide ?? 0), -1, 1);
    if (!this.busy && !this.hold) {
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

    this.wobDt = dt;
    this.stepWobble(o);
    // Höhen mit weniger motionFx flacher (Drehungen bleiben ganz — halbe Flips gibt es nicht).
    const hs = 0.6 + 0.4 * m;
    o.hx *= m;
    o.hy *= m;
    o.hz *= hs;
    o.hpitch *= m;
    o.hyaw *= m;
    o.hroll *= m;
  }

  /**
   * Wackelfeder: kleiner Überschwinger um die Bild-Tiefenachse, danach die Impulse dieses Frames.
   * Eigene kleine Methode (dt als Feld): in update() verlor rotateView sein Inlining (+1.6 KiB/s Müll).
   */
  private stepWobble(o: PropOut): void {
    const dt = this.wobDt;
    const e = Math.exp(-WOB_ZETA * WOB_OMEGA * dt);
    const c = Math.cos(WOB_WD * dt);
    const s = Math.sin(WOB_WD * dt);
    const x0 = this.wobX;
    const v0 = this.wobV;
    this.wobX = clamp(e * (x0 * c + ((v0 + WOB_ZETA * WOB_OMEGA * x0) / WOB_WD) * s) + this.wobQX, -WOB_MAX, WOB_MAX);
    this.wobV = e * (v0 * c - ((WOB_OMEGA * WOB_OMEGA * x0 + WOB_ZETA * WOB_OMEGA * v0) / WOB_WD) * s) + this.wobQV;
    this.wobQX = 0;
    this.wobQV = 0;
    if (Math.abs(this.wobX) > 1e-5) this.rotateView(o, 0, 0, 1, this.wobX);
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
  /** Name gehört zu diesem Gegenstand (Tools, debugPlayName) — Standard: aus trickNames. */
  protected isTrick(name: string): name is T {
    return this.trickNames.includes(name);
  }
  /** Zustands-Trick (wartet auf einen Zustand, z. B. Surf-Balance) — Standard: keiner. */
  protected isState(_id: T): boolean {
    return false;
  }
  afterPose(_joints: ArrayLike<number>, _inp: PropFrameInput, _dt: number): void {}
  protected onLand(_k: number, _queued: boolean, _speed: number): void {}
  protected onFinish(): void {}
  /** Plan 007: Checkpoint (split = Laufzeit − Bestzeit-Split, null ohne Referenz). */
  protected onCheckpoint(_split: number | null): void {}
  /** Plan 007: Surf-Beginn (Tempo des letzten Frames) und -Ende. */
  protected onSurfStart(_speed: number): void {}
  protected onSurfEnd(): void {}
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
    this.markLate = t - at;
    return this.debugAt < 0;
  }

  protected kick(o: PropOut, y: number, sq: number): void {
    o.kickY += y;
    o.kickSq += sq;
  }

  /**
   * Wackel-Impuls (rad/s) zur zuletzt gefeuerten Marke — exakt zu ihrer Zeit: die Marke liegt meist
   * mitten im Frame, ihr Impuls ist am Frame-Ende schon markLate s alt (Impulsantwort der Feder).
   * Direkt auf wobV vor dem Schritt lief er bei 30 Hz bis zu einen Frame vor (0.02 rad nach dem Fang).
   */
  protected spinKick(v: number): void {
    const a = this.markLate;
    const e = Math.exp(-WOB_ZETA * WOB_OMEGA * a);
    const c = Math.cos(WOB_WD * a);
    const s = Math.sin(WOB_WD * a);
    this.wobQX += (v * e * s) / WOB_WD;
    this.wobQV += v * e * (c - ((WOB_ZETA * WOB_OMEGA) / WOB_WD) * s);
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
    // sqrt statt Math.hypot: der Builtin allokiert pro Aufruf (Node-Heap-Probe 4–13 KiB/s im Trick-Pfad).
    const l = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
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
