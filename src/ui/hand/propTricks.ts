import type { GameEvent } from '../../engine/events';
import { VM_STRING_POINTS } from '../../render/types';
import { clamp, fin, smooth, speedTier } from './anim';
import { VIEW_AXES, axisAngleQ, fromEulerXYZV, mat3, mul, mulT, toAxisAngleQ, toEulerXYZ } from './rot';
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
 * Trick wird nie abgebrochen (außer Respawn/Levelstart, dem Ziel und einer geschafften Trainings-Stufe); motionFx 0 = statisch.
 *
 * Ziel (Phase-2-Review): die Ziel-Reaktion ist die Belohnung (Handy-Selfie, Jo-Jo-Wiege, Feuerzeug-Finale)
 * und kommt SOFORT — sie bricht laufende Tricks und Surf-Zustände ab, auch beim Rutschen. Vorher wartete sie
 * auf "frei": wer ins Ziel surft oder springt, sah sie nie (L1 sync 1.0: 0 von 15 Selfies). Der Abbruch
 * gilt am Frame-Ende (#77): der alte Trick läuft den Frame zu Ende, dann startet der Ziel-Trick bei Trick-
 * Zeit 0 — und der Versatz zwischen beiden klingt über XFADE s ab (kein Sprung, framerate-unabhängig).
 *
 * Plan 007: Haken für Checkpoint, Surf-Beginn und -Ende (nur ohne laufenden Trick und mit
 * motionFx > 0), Zustands-Tricks (ein Trick wartet auf einen Zustand, z. B. "balanciert, solange
 * gesurft wird" — passt zu "nie abbrechen"), `hold` (Rutschen: keine neuen Tricks) und
 * Ausgabefelder für einen zweiten Körper, eine Schnur und Gegenstands-Kanäle (VM_PARAM).
 *
 * Training (Review Phase 2, KI9): eine geschaffte Stufe / Lektion ist eine Belohnung wie das Ziel und nimmt
 * denselben Weg (Abbruch am Frame-Ende + XFADE) — vorher lief sie als Checkpoint nur ohne laufenden Trick und
 * verpuffte meist (Dose/Karte/Messer nie, die übrigen in 12–27 % der Fälle). Haken `onLesson(done)`.
 *
 * Einlagen im Zustand (Review Phase 2): auf L3 (reiner Surf) hielt die Hand 10–20 s denselben statischen
 * Zustand. Im Surf-Zustand kommt jetzt eine kurze Einlage (BEAT_T) im Takt (BEAT_FIRST, dann BEAT_EVERY, über die
 * Trick-Zeit → framerate-unabhängig), vorgezogen durch eine Kehre (surfSide wechselt das Vorzeichen) oder einen
 * Tempo-Meilenstein (am Frame-Ende, #77). Sie beendet den Zustand nicht; die Unterklasse formt sie über `beatU`
 * (0..1, 1 = keine) — bell(beatU)/arc(beatU) sind außerhalb einer Einlage 0.
 */

/**
 * Was ein Gegenstand der Hand pro Frame vorgibt (ViewHand kopiert es in den ViewModelFrame). Kommazahl-Felder
 * mit Double-Startwert, der Konstruktor setzt die Ruhe-Werte — mit Smi-Start boxte Chrome jedes Schreiben aus
 * den Trick-Zeitleisten (fallen.md #107.4); Werte danach wie zuvor.
 */
export class PropOut {
  /** Posen-Wunsch (POSE-Index), Überblend-Zeitkonstante (s). */
  pose = 0;
  poseTau = 0.08;
  /** Zusätzlicher Hand-Versatz: Bildhöhen (x rechts, y unten), Einheiten zur Kamera, rad. */
  hx = 0.5;
  hy = 0.5;
  hz = 0.5;
  hpitch = 0.5;
  hyaw = 0.5;
  hroll = 0.5;
  readonly pos = new Float32Array(3);
  readonly rot = new Float32Array(3);
  spin = 0.5;
  visible = 0.5;
  scale = 0.5;
  canTab = 0.5;
  canOpen = false;
  knifeBlade = Math.PI;
  knifeBite = -Math.PI;
  poof = -0.5;
  readonly poofPos = new Float32Array(3);
  /** Zweiter Körper im Handgelenk-Raum (Jo-Jo, Kendama-Kugel): Mitte, Euler XYZ, Eigendrehung, Sichtbarkeit (0 = keiner). */
  readonly sub = new Float32Array(3);
  readonly subRot = new Float32Array(3);
  subSpin = 0.5;
  subVisible = 0.5;
  /** Schnur: VM_STRING_POINTS Punkte xyz, Punkt 0 = Finger/Griff; stringCount 0 = keine. */
  readonly string = new Float32Array(VM_STRING_POINTS * 3);
  stringCount = 0;
  /** Gegenstands-Kanäle (render/types VM_PARAM). */
  readonly param = new Float32Array(4);
  /** Impulse an die Hand seit dem letzten Abholen (Bildhöhen/s nach unten, Squash/s). */
  kickY = 0.5;
  kickSq = 0.5;

  constructor() {
    this.hx = 0;
    this.hy = 0;
    this.hz = 0;
    this.hpitch = 0;
    this.hyaw = 0;
    this.hroll = 0;
    this.spin = 0;
    this.visible = 1;
    this.scale = 1;
    this.canTab = 0;
    this.poof = -1;
    this.subSpin = 0;
    this.subVisible = 0;
    this.kickY = 0;
    this.kickSq = 0;
  }
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
  /** Zähler der Einlagen im Zustand (Takt-Messung, event-probe). */
  readonly flourishes: number;
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
/** Überblenden nach einem Abbruch durch das Ziel (s, gezählt wie die Trick-Zeit: erster Frame 0). */
export const XFADE = 0.25;
const NO_TRICKS: readonly string[] = [];

/** Belohnung, die laufende Tricks am Frame-Ende abbricht; größer gewinnt, wenn zwei im selben Frame kommen. */
const enum Reward {
  None = 0,
  Stage = 1,
  LessonDone = 2,
  Finish = 3,
}

/** Einlagen im Surf-Zustand (Trick-Zeit, s): erste, Takt, Dauer, Mindestabstand bei Auslösern, Einschwingen. */
export const BEAT_FIRST = 1.05;
export const BEAT_EVERY = 2.4;
export const BEAT_T = 0.62;
const BEAT_GAP = 0.9;
const BEAT_SETTLE = 0.5;
/** Kehre: surfSide wechselt das Vorzeichen, beide Seiten mindestens so deutlich. */
const CARVE_SIDE = 0.25;

export abstract class PropTricks<T extends string> implements PropControl {
  trick: T | 'none' = 'none';
  readonly out = new PropOut();
  /** 0..1 (GameSettings.motionFx). 0 = keine Tricks, Gegenstand steht still in der Hand. */
  motionFx = 1;
  hold = false;

  // Kommazahl-Felder, die der Frame-Pfad schreibt: Double-Startwert (0.5), der Konstruktor setzt 0 — mit Smi-Start
  // (0) boxte Chrome jedes Schreiben (wie Spring, fallen.md #107; Review-Nachmessung: stepWobble 0.8 KiB/s nach 150 s).
  protected t = 0.5;
  protected now = 0.5;
  protected cooldownUntil = 0;
  protected idleLeft = 2.2;
  protected wobX = 0.5;
  protected wobV = 0.5;
  /** Tempo des letzten Frames (der Surf-Beginn kommt als Event ohne Tempo). */
  protected lastSpeed = 0.5;
  /**
   * Seitenneigung der Rampe (surfSide) — nur beim Surfen aktualisiert, danach gehalten: Surf-Zustände
   * blenden sie mit ihrem Ausklang weich aus. Live gelesen sprang sie am Surf-Ende auf 0 (Ruck in der
   * Lage; beim Kendama warf das die Kugel aus dem Becher, 3.3 Einheiten Unterschied zwischen Frameraten).
   */
  protected surfLean = 0.5;
  private seed = 1;
  private fresh = false;
  private debugAt = -1;
  /** Marken, die in diesem Trick schon gefeuert haben (Bitmaske). */
  private marks = 0;
  /** Wie lange die zuletzt gefeuerte Marke schon zurückliegt (s, Trick-Zeit − Marke). */
  private markLate = 0.5;
  /** Wackel-Impulse dieses Frames als Beitrag zu Lage/Rate am Frame-Ende (exakt nachgeholt, s. spinKick). */
  private wobQX = 0.5;
  private wobQV = 0.5;
  private wobDt = 0.5;
  // Rotations-Scratch
  private readonly mA: Mat3 = mat3();
  private readonly mB: Mat3 = mat3();
  private readonly mC: Mat3 = mat3();
  /** Drehachse (Handgelenk-Raum) und Winkel für applyRot — Plätze statt Argumente (siehe axisAngleQ). */
  private readonly rq = new Float64Array(4);
  /**
   * Abbruch-Überblenden: erst die Ausgabe beim Abbruch, ab dem ersten Frame des neuen Tricks der Versatz
   * dazu (pos 0–2, spin 3, visible 4, scale 5, hx…hroll 6–11, knifeBlade 12, knifeBite 13); Lage beim
   * Abbruch, dann der Versatz als Achse-Winkel (xfQ). Alter wie eine Trick-Zeit (frisch = 0 im ersten Frame).
   */
  private readonly xf = new Float64Array(14);
  private readonly xfRot = new Float32Array(3);
  private readonly xfQ = new Float64Array(4);
  private xfOn = false;
  private xfFresh = false;
  private xfAge = 0.5;
  /** Belohnung (Ziel, Trainings-Stufe) kam mitten im Trick: Abbruch am Ende des nächsten update() (dort gilt das Event, #77). */
  private rewardQueued: Reward = Reward.None;
  private finishBest = false;
  /**
   * Winkel (rad) für rotateCam — Drehung um die Bild-Tiefenachse ohne Kommazahl-Argument (Frame-Pfad: die
   * Kendama-Kippung boxte als Argument von rotateView im Spiel nach 60 s noch, Review Phase 2).
   */
  protected camTurn = 0.5;
  /** Einlage im Zustand: Anteil 0..1 der laufenden (1 = keine), Beginn und nächste im Takt (Trick-Zeit). */
  protected beatU = 0.5;
  private beatStart = 0.5;
  private beatNext = 0.5;
  private beatQueued = false;
  private beatCount = 0;
  /** Die laufende Einlage endete in diesem Frame (beatEnd()); Zählerstand der in diesem Frame begonnenen (beatBegin()). */
  private beatEnded = false;
  private beatBegan = -1;
  /** Seite der Rampe beim letzten Surf-Frame (−1/0/1) für die Kehre. */
  private beatSide = 0;

  constructor() {
    this.t = 0;
    this.now = 0;
    this.wobX = 0;
    this.wobV = 0;
    this.lastSpeed = 0;
    this.surfLean = 0;
    this.markLate = 0;
    this.wobQX = 0;
    this.wobQV = 0;
    this.wobDt = 0;
    this.xfAge = 0;
    this.camTurn = 0;
    this.beatU = 1;
    this.beatStart = -BEAT_GAP;
    this.beatNext = BEAT_FIRST;
  }

  get flourishes(): number {
    return this.beatCount;
  }

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
    this.xfOn = false;
    this.rewardQueued = Reward.None;
    this.beatU = 1;
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
        else if (this.inState) this.beatQueued = true;
        break;
      case 'land': {
        const k = clamp(fin(e.impact) / 550, 0, 1.6);
        // Landung = Frame-Ende (#77): wirkt nach dem Wackel-Schritt des nächsten update().
        if (!e.jumpQueued && k >= LAND_WOBBLE_FROM && this.motionFx > 0) this.wobQV += (this.rand() < 0.5 ? -1 : 1) * LAND_WOBBLE * k;
        if (this.free) this.onLand(k, e.jumpQueued, fin(e.speed));
        break;
      }
      case 'finish':
        // Sofort, auch mitten im Trick, im Surf-Zustand oder beim Rutschen (siehe Kopf); Abklingzeit egal.
        // Festgehaltene Tricks (Tools) bleiben stehen.
        this.reward(Reward.Finish, e.best);
        break;
      case 'lessonStage':
        // Training (KI9): wie das Ziel — sofort, bricht Laufendes am Frame-Ende ab.
        this.reward(e.lessonDone ? Reward.LessonDone : Reward.Stage, true);
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

  /** Belohnung (Ziel, Trainings-Stufe): frei → sofort, sonst Abbruch am Ende des nächsten update(). */
  private reward(kind: Reward, best: boolean): void {
    if (this.motionFx <= 0 || this.debugAt >= 0) return;
    if (!this.busy) {
      this.startReward(kind, best);
      return;
    }
    if (kind >= this.rewardQueued) {
      this.rewardQueued = kind;
      this.finishBest = best;
    }
  }

  private startReward(kind: Reward, best: boolean): void {
    if (kind === Reward.Finish) this.onFinish(best);
    else this.onLesson(kind === Reward.LessonDone);
  }

  update(dtRaw: number, inp: PropFrameInput): void {
    const dt = dtRaw - dtRaw === 0 ? clamp(dtRaw, 0, 0.1) : 0;
    if (dt <= 0) return;
    this.now += dt;
    const o = this.out;
    const m = clamp(fin(this.motionFx), 0, 1);
    if (m <= 0) {
      if (this.busy) {
        this.trick = 'none';
        this.t = 0;
      }
      this.xfOn = false;
      this.rewardQueued = Reward.None;
      this.beatU = 1;
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
      if (id !== 'none' && this.isState(id)) this.stepBeat(inp);
      else {
        this.beatU = 1;
        this.beatEnded = false;
        this.beatBegan = -1;
      }
      if (id !== 'none' && this.evaluate(id, this.t, dt, inp, m, o)) this.finishTrick();
    } else this.writeRest(o);

    this.wobDt = dt;
    this.stepWobble(o);
    this.scaleOut(o, m);
    if (this.rewardQueued !== Reward.None) this.switchToReward(dt, inp, m);
    if (this.xfOn) this.crossFade(o, dt);
  }

  /**
   * Einlage im Surf-Zustand (siehe Kopf): im Takt über die Trick-Zeit (Beginn exakt auf dem Takt), Kehre und
   * Meilenstein am Frame-Ende; nur solange gesurft wird (im Ausklang keine neue). Setzt beatU.
   */
  private stepBeat(inp: PropFrameInput): void {
    const t = this.t;
    this.beatBegan = -1;
    if (inp.surfing) {
      const sv = fin(inp.surfSide ?? 0);
      const side = sv > CARVE_SIDE ? 1 : sv < -CARVE_SIDE ? -1 : 0;
      if (side !== 0) {
        if (this.beatSide !== 0 && side !== this.beatSide) this.beatQueued = true;
        this.beatSide = side;
      }
      if (this.beatQueued && t >= BEAT_SETTLE && t - this.beatStart >= BEAT_GAP) {
        this.beatStart = t;
        this.beatNext = t + BEAT_EVERY;
        this.beatBegan = ++this.beatCount;
      } else if (t >= this.beatNext) {
        this.beatStart = this.beatNext;
        this.beatNext += BEAT_EVERY;
        this.beatBegan = ++this.beatCount;
      }
    }
    this.beatQueued = false;
    const was = this.beatU;
    this.beatU = clamp((t - this.beatStart) / BEAT_T, 0, 1);
    this.beatEnded = was < 1 && this.beatU >= 1;
  }

  /**
   * true genau im Frame, in dem die laufende Einlage endet (Landung/Fang) — setzt markLate wie mark(), damit
   * spinKick den Impuls exakt zur Endzeit nachholt. Festgehaltene Tricks (Tools) kicken nicht.
   */
  protected beatEnd(): boolean {
    if (!this.beatEnded) return false;
    this.beatEnded = false;
    this.markLate = this.t - (this.beatStart + BEAT_T);
    return this.debugAt < 0;
  }

  /** true genau im Frame, in dem eine Einlage beginnt (setzt markLate wie mark()); festgehalten nie. */
  protected beatBegin(): boolean {
    if (this.beatBegan !== this.beatCount) return false;
    this.beatBegan = -1;
    this.markLate = this.t - this.beatStart;
    return this.debugAt < 0;
  }

  /** Wie lange die zuletzt gefeuerte Marke (mark, beatBegin, beatEnd) am Frame-Ende zurückliegt (s) — für exakte Alter. */
  protected get lateness(): number {
    return this.markLate;
  }

  /** Höhen mit weniger motionFx flacher (Drehungen bleiben ganz — halbe Flips gibt es nicht). */
  private scaleOut(o: PropOut, m: number): void {
    const hs = 0.6 + 0.4 * m;
    o.hx *= m;
    o.hy *= m;
    o.hz *= hs;
    o.hpitch *= m;
    o.hyaw *= m;
    o.hroll *= m;
  }

  /**
   * Ziel (oder Trainings-Stufe) mitten im Trick: der alte Trick lief bis zum Frame-Ende, dort gilt das Event
   * (#77). Seine Ausgabe merken (interrupt), Belohnungs-Trick starten und bei Trick-Zeit 0 auswerten (wie ein
   * frischer Start) — crossFade zeigt in diesem Frame genau die alte Ausgabe und lässt den Versatz abklingen.
   */
  private switchToReward(dt: number, inp: PropFrameInput, m: number): void {
    const kind = this.rewardQueued;
    this.rewardQueued = Reward.None;
    const o = this.out;
    this.interrupt();
    this.startReward(kind, this.finishBest);
    this.writeRest(o);
    const id = this.trick;
    if (id !== 'none') {
      // Trick-Zeit 0 in diesem Frame ausgewertet: der nächste Frame zählt weiter (nicht noch einmal 0).
      this.fresh = false;
      if (this.evaluate(id, 0, dt, inp, m, o)) this.finishTrick();
    }
    if (Math.abs(this.wobX) > 1e-5) this.wobbleRot(o);
    this.scaleOut(o, m);
  }

  /**
   * Laufenden Trick/Zustand abbrechen (nur das Ziel, am Frame-Ende): Unterklassen merken sich zuerst ihren
   * Stand zu dieser Zeit (onInterrupt, this.trick ist noch der alte), dann die gezeigte Ausgabe — der nächste
   * Trick (oder die Ruhe) blendet über XFADE von ihr ein.
   */
  private interrupt(): void {
    this.onInterrupt();
    const o = this.out;
    const x = this.xf;
    x[0] = o.pos[0];
    x[1] = o.pos[1];
    x[2] = o.pos[2];
    x[3] = o.spin;
    x[4] = o.visible;
    x[5] = o.scale;
    x[6] = o.hx;
    x[7] = o.hy;
    x[8] = o.hz;
    x[9] = o.hpitch;
    x[10] = o.hyaw;
    x[11] = o.hroll;
    x[12] = o.knifeBlade;
    x[13] = o.knifeBite;
    this.xfRot[0] = o.rot[0];
    this.xfRot[1] = o.rot[1];
    this.xfRot[2] = o.rot[2];
    this.xfOn = true;
    this.xfFresh = true;
    this.xfAge = 0;
    this.trick = 'none';
    this.t = 0;
  }

  /** Ziel angekommen, Ziel-Trick startet am Ende des nächsten update() (Handy: Auslöser vorziehen). */
  protected get finishPending(): boolean {
    return this.rewardQueued === Reward.Finish;
  }

  /** Gewicht der Abbruch-Ausgabe in diesem Frame (1 → 0 über XFADE; 0 ohne Abbruch). */
  protected get fadeW(): number {
    return this.xfOn ? 1 - smooth(this.xfAge / XFADE) : 0;
  }

  /**
   * Versatz zur Abbruch-Ausgabe abklingen lassen (Gewicht fadeW). Im ersten Frame des neuen Tricks wird er
   * festgehalten: Ausgabe beim Abbruch − erste Ausgabe des neuen Tricks, Lage als feste Differenz-Drehung
   * D = R(alt)·R(neu)ᵀ. Fest, weil ein je Frame neu gerechnetes D bei schnell drehenden Tricks (Messer-Aerial,
   * 16 rad/s) über π kippt und die kürzeste Achse die Seite wechselt — das Messer sprang dann um ~π.
   */
  private crossFade(o: PropOut, dt: number): void {
    const x = this.xf;
    if (this.xfFresh) {
      this.xfFresh = false;
      for (let k = 0; k < 3; k++) x[k] -= o.pos[k];
      // Winkel-Kanäle über die kürzere Richtung; die Klinge läuft 0 (offen) … π (zu), also linear.
      x[3] = wrapPi(x[3] - o.spin);
      x[4] -= o.visible;
      x[5] -= o.scale;
      x[6] -= o.hx;
      x[7] -= o.hy;
      x[8] -= o.hz;
      x[9] -= o.hpitch;
      x[10] -= o.hyaw;
      x[11] -= o.hroll;
      x[12] -= o.knifeBlade;
      x[13] = wrapPi(x[13] - o.knifeBite);
      fromEulerXYZV(this.mA, this.xfRot);
      fromEulerXYZV(this.mB, o.rot);
      mulT(this.mC, this.mA, this.mB);
      toAxisAngleQ(this.mC, this.xfQ);
    } else this.xfAge += dt;
    const w = this.fadeW;
    if (w <= 0) {
      this.xfOn = false;
      return;
    }
    for (let k = 0; k < 3; k++) o.pos[k] += x[k] * w;
    o.spin += x[3] * w;
    o.visible = clamp(o.visible + x[4] * w, 0, 1);
    o.scale += x[5] * w;
    o.hx += x[6] * w;
    o.hy += x[7] * w;
    o.hz += x[8] * w;
    o.hpitch += x[9] * w;
    o.hyaw += x[10] * w;
    o.hroll += x[11] * w;
    o.knifeBlade += x[12] * w;
    o.knifeBite += x[13] * w;
    const q = this.rq;
    const d = this.xfQ;
    q[0] = d[0];
    q[1] = d[1];
    q[2] = d[2];
    q[3] = d[3] * w;
    axisAngleQ(this.mA, q);
    fromEulerXYZV(this.mB, o.rot);
    mul(this.mB, this.mA, this.mB);
    toEulerXYZ(this.mB, o.rot);
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
    if (Math.abs(this.wobX) > 1e-5) this.wobbleRot(o);
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
  /** Ziel (best = neue Bestzeit). Läuft sofort, auch nach einem Abbruch (interrupt). */
  protected onFinish(_best: boolean): void {}
  /**
   * Das Ziel bricht den laufenden Trick am Frame-Ende ab (in update(), nach seiner Auswertung; this.trick ist
   * noch der alte): Trick-Zustand aufräumen, Stand fürs Überblenden merken (zweiter Körper).
   */
  protected onInterrupt(): void {}
  /** Plan 007: Checkpoint (split = Laufzeit − Bestzeit-Split, null ohne Referenz). */
  protected onCheckpoint(_split: number | null): void {}
  /**
   * Training (KI9): Stufe geschafft bzw. Lektion fertig (done). Läuft sofort, auch nach einem Abbruch — wie
   * onFinish. Standard: Stufe = Checkpoint ohne Referenz, Lektion = Ziel-Trick mit Bestzeit (Erfolg).
   * Gegenstände mit Foto oder ohne Checkpoint-Reaktion überschreiben das (kein Selfie in der Lektion).
   */
  protected onLesson(done: boolean): void {
    if (done) this.onFinish(true);
    else this.onCheckpoint(null);
  }
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
    this.beatStart = -BEAT_GAP;
    this.beatNext = BEAT_FIRST;
    this.beatQueued = false;
    this.beatSide = 0;
    this.beatU = 1;
    this.beatEnded = false;
    this.beatBegan = -1;
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

  /**
   * Wackeln um die Bild-Tiefenachse vor die aktuelle Drehung — wie rotateView(o, 0, 0, 1, wobX), aber ohne das
   * Feld als Kommazahl-Argument (boxte je Frame, Review-Nachmessung stepWobble 0.8 KiB/s); gleiche Rechnung.
   */
  private wobbleRot(o: PropOut): void {
    const q = this.rq;
    const c = VIEW_AXES.cam;
    q[0] = c[0];
    q[1] = c[1];
    q[2] = c[2];
    q[3] = this.wobX;
    this.applyRot(o);
  }

  /** Wie rotateView(o, 0, 0, 1, camTurn): Winkel aus dem Feld camTurn (Frame-Pfad ohne Kommazahl-Argument). */
  protected rotateCam(o: PropOut): void {
    const q = this.rq;
    const c = VIEW_AXES.cam;
    q[0] = c[0];
    q[1] = c[1];
    q[2] = c[2];
    q[3] = this.camTurn;
    this.applyRot(o);
  }

  /** Drehung um eine Bildachse (ax, ay, az in Bildkoordinaten, normiert) VOR die aktuelle Drehung setzen. */
  protected rotateView(o: PropOut, ax: number, ay: number, az: number, angle: number): void {
    const A = VIEW_AXES;
    const q = this.rq;
    q[0] = A.right[0] * ax + A.up[0] * ay + A.cam[0] * az;
    q[1] = A.right[1] * ax + A.up[1] * ay + A.cam[1] * az;
    q[2] = A.right[2] * ax + A.up[2] * ay + A.cam[2] * az;
    q[3] = angle;
    this.applyRot(o);
  }

  /** Drehung um eine Achse im Handgelenk-Raum vor die aktuelle Drehung setzen. */
  protected rotateLocal(o: PropOut, ax: number, ay: number, az: number, angle: number): void {
    const q = this.rq;
    q[0] = ax;
    q[1] = ay;
    q[2] = az;
    q[3] = angle;
    this.applyRot(o);
  }

  /**
   * Drehung aus rq vor o.rot setzen. Achse/Winkel über Plätze statt Argumente, klein gehalten (inlinebar):
   * rotateView/rotateLocal boxten in Chrome 17–59 B/Frame (Kommazahl-Argumente, Kette aus vier Aufrufen).
   */
  private applyRot(o: PropOut): void {
    const q = this.rq;
    // sqrt statt Math.hypot: der Builtin allokiert pro Aufruf (Node-Heap-Probe 4–13 KiB/s im Trick-Pfad).
    const l = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2]) || 1;
    q[0] = q[0] / l;
    q[1] = q[1] / l;
    q[2] = q[2] / l;
    axisAngleQ(this.mA, q);
    fromEulerXYZV(this.mB, o.rot);
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

/** Winkel auf (−π, π]. */
function wrapPi(a: number): number {
  const t = Math.PI * 2;
  return a - t * Math.floor((a + Math.PI) / t);
}
