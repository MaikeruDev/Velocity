import { VM_JOINT, VM_RIG, VM_STRING_POINTS } from '../../render/types';
import { arc, bell, clamp, fin, smooth } from './anim';
import { fingerPoint, fingerTip, thumbPoint } from './fk';
import { POSE, POSE_JOINTS } from './poses';
import { PropTricks } from './propTricks';
import type { PropFrameInput, PropOut } from './propTricks';
import { VIEW_AXES } from './rot';
import { Rope, RopeDrive } from './rope';
import { viewRot } from './view';
import type { V3 } from './view';

/**
 * Jo-Jo (Plan 007, KI1): das Jo-Jo ist der zweite Körper (`sub`), die Schnur eine Verlet-Kette
 * (ui/hand/rope) von der Schlaufe am Mittelfinger (FK, exakt am Finger: afterPose) zum Jo-Jo.
 *
 * - Geführt (Zeitleiste, framerate-unabhängig): Wurf, Pass, Breakaway, Around-the-World, Cradle,
 *   Rückweg in die Hand. Die Bahnen sind Versätze vom Anker in Bildrichtungen.
 * - Frei (Pendel): Sleeper und der Surf-Zustand `surfSleeper` — es schläft, solange gesurft wird,
 *   und pendelt mit Neigung und Ruck der Hand (RopeDrive, Deckel 0.6 g).
 * - Drehung um die Achse geschlossen über die Trick-Zeit (keine Summe über dt).
 *
 * Takt (tools/cosmetics/event-probe.ts): Sleeper 0.7 s, Pass 0.5 s (Plan 007 kalibriert).
 * Abwechslung (Review Phase 2: Breakaway war Stufe-2- UND -3-Trick, Meilenstein- und Checkpoint-Trick — 57–60 %
 * aller Starts; mit Pass statt Breakaway überall dominierte Pass mit 46–63 %): Breakaway nur in Stufe 2, dort
 * mit Snap und Pass im Wechsel, Meilenstein Stufe 2 abwechselnd Breakaway/Snap (Meilensteine achten auf die
 * Abklingzeit); Checkpoint vor der Bestzeit = Wiege (die Figur sieht man so auch im Lauf, nicht nur im Ziel),
 * sonst Around und Breakaway im Wechsel.
 */

export const YOYO_TRICKS = ['none', 'sleeper', 'pass', 'snap', 'breakaway', 'around', 'aroundDouble', 'cradle', 'surfSleeper'] as const;
export type YoyoTrick = Exclude<(typeof YOYO_TRICKS)[number], 'none'>;
const YOYO_NAMES: readonly string[] = YOYO_TRICKS.filter((t) => t !== 'none');

/** Tricks je Tempo-Stufe bei Sprüngen (Tests prüfen genau diese Zuordnung). */
export const YOYO_TIER_TRICKS: readonly (readonly YoyoTrick[])[] = [[], ['snap', 'pass'], ['breakaway', 'snap', 'pass'], ['around', 'pass']];

/** Schnur voll abgewickelt (Hand-Einheiten, Cartoon-kurz: hängend bleibt das Jo-Jo im Bild). */
export const YOYO_STRING = 9.5;

/** Abklingzeiten: kalibriert mit event-probe (vorher L1 sync 1.0: 52 % Trick-Anteil ohne Surf-Zustände). */
const COOLDOWN: { readonly [K in YoyoTrick]: number } = { sleeper: 1.0, pass: 1.0, snap: 0.9, breakaway: 1.1, around: 1.3, aroundDouble: 1.4, cradle: 1.0, surfSleeper: 0.5 };

const THROW = 0.25;
/** Bahn-Ende des Wurfs nach unten (Versatz vom Anker, Bildrichtungen). */
const THROW_END_R = 0.8;
const THROW_END_U = -YOYO_STRING * 0.96;
const THROW_END_C = 0.6;
const SLEEP = 0.7;
const SNAP_SLEEP = 0.05;
const RETURN = 0.25;
const SETTLE = 0.06;
/** Übergang Faust → Bahn beim Wurf (s). */
const LAUNCH = 0.1;
const PASS_T = 0.5;
/** Pass: Rückweg ab diesem Anteil der Dauer (Trick-Zeit). */
const PASS_TR = PASS_T * 0.85;
const BREAK_T = 0.6;
const AROUND_W = 0.15;
const LOOP = 1 / 2;
/** Kreismitte links vom Anker (Einheiten), damit die rechte Hälfte nicht in der Hand verschwindet. */
const AROUND_SHIFT = 1.2;
/**
 * Kreis gestaucht (quer, hoch): so bleibt er in der Hülle des Prototyps (KI1: höchster Punkt −0.037,
 * linkester 0.09 Bildhöhen, envelope.ts) — mit 0.78/1.0 lag er bei −0.069 / 0.062.
 */
const AROUND_SQUASH = 0.66;
const AROUND_TALL = 0.82;
/**
 * Kippung des Kreises zur Kamera: rechte Hälfte A + B vor (sonst läuft er hinter Hand und Handgelenk
 * durch), linke Hälfte nicht nach hinten — ein zurückweichender Punkt rückt zur Bildmitte (Hülle).
 * c(ph) = −A·sin ph + B·sin² ph: rechts (sin −1) A + B, links (sin 1) B − A.
 */
const AROUND_TILT_A = 1.0;
const AROUND_TILT_B = 2.5;
/** Seitwurf-Radius (Anteil von R): der Bogen kam bis 0.080 an die Bildmitte. */
const BREAK_R = 0.92;
const CRADLE_T = 1.8;
const CRADLE_R = 7.2;
const CRADLE_SWING = 0.6;
const CRADLE_HZ = 1.3;
/**
 * Schnur-Figur der Wiege: Daumen- und Zeigefingerspitze spannen mit einem Punkt auf der Schnur (Anteil
 * CRADLE_KNOT vom Anker zum Jo-Jo) ein Dreieck, darunter schaukelt das Jo-Jo. Vorher hing es nur und
 * wippte — im Kontaktblatt nicht von einem Sleeper zu unterscheiden. Punkte etwas zur Kamera, damit die
 * Finger die Schnur nicht verdecken; Ein-/Ausblenden als Anteil der Trick-Dauer.
 */
const CRADLE_KNOT = 0.62;
export const CRADLE_FRONT = 0.9;
const CRADLE_IN = 0.1;
const CRADLE_OUT = 0.8;
/**
 * Schwing-Mitte der Wiege: links neben die eingerollten Finger und zur Kamera. Direkt unter der Schlaufe
 * schaukelte das Jo-Jo hinter Ring- und kleinem Finger (bei der Katze fast ganz hinter den Zehen, Review).
 */
const CRADLE_LEFT = 2.6;
const CRADLE_CAM = 3.6;
/** Daumenspitze: so weit über das Endglied hinaus (Kuppe, VM_RIG.thumb.r[2] 1.48 × ~0.8). Zeigefinger: fingerTip(…, 0.9). */
export const CRADLE_THUMB_BEYOND = 1.2;
export const CRADLE_INDEX_BEYOND = 0.9;
const SURF_MIN = 0.5;
const SURF_FROM = 500;
/** Einlage im surfSleeper: Handgelenk kippt (rad), dazu ein Ruck nach oben. */
const BEAT_ROLL = 0.22;
const R = YOYO_STRING * 0.9;
/**
 * Rückweg-Beginn als Konstanten (Seitwurf-Ende bei 0.7π, Around unten links): returning() liest die Versätze
 * aus Feldern — berechnete Kommazahlen als Argumente boxte V8 je Frame (Review: returning 0.6 KiB/s).
 */
const BREAK_END_R = -Math.sin(0.7 * Math.PI) * R * BREAK_R;
const BREAK_END_U = -Math.cos(0.7 * Math.PI) * R * BREAK_R;
const AROUND_END_R = -AROUND_SHIFT;
const AROUND_END_U = -R * AROUND_TALL;
/** Rückweg-Beginn (Trick-Zeit) nach einem bzw. zwei Kreisen. */
const AROUND_BACK_1 = AROUND_W + LOOP;
const AROUND_BACK_2 = AROUND_W + 2 * LOOP;
/** Drehzahlen (rad/s) je Trick, Auslauf beim Rückweg (τ). */
const SPIN_SLEEP = 60;
const SPIN_PASS = 50;
const SPIN_BREAK = 55;
const SPIN_AROUND = 70;
const SPIN_CRADLE = 45;
const SPIN_TAU = 0.12;
const TAU = Math.PI * 2;

/** Ruhelage relativ zur Faust (Bildrichtungen): tiefer und zur Kamera, damit das Jo-Jo herausschaut. */
const REST_UP = -1.6;
const REST_CAM = 2.4;

/** Anker: Mittelglied des Mittelfingers (Schlaufe), im Glied-Raum (afterPose nutzt die Werte als Literale). */
const ANCHOR_LOCAL: V3 = [0, 1.2, 0];

/** Achse zur Kamera (man sieht das Muster), leicht gekippt, damit man die Dicke ahnt. */
export const YOYO_ROT: V3 = viewRot([
  [0, Math.PI / 2 - 0.35],
  [1, 0.3],
]);

const enum Mode {
  Hand = 0,
  Guided = 1,
  Free = 2,
  Return = 3,
}

/** Puffer als Float64Array: Kommazahlen in JS-Arrays kosten beim Umstellen der Elementart, typed nie. */
type V = Float64Array;

/** Ruhelage in der Faust: zwischen Zeige-/Mittelfinger-Kuppe und Handfläche (FK aus den Gelenken). */
function holdPoint(joints: ArrayLike<number>, out: V, tmp: V): void {
  fingerPoint(joints, 0, 2, 0, 1.9, 0, tmp);
  out[0] = tmp[0];
  out[1] = tmp[1];
  out[2] = tmp[2];
  fingerPoint(joints, 1, 2, 0, 2.0, 0, tmp);
  out[0] = (out[0] + tmp[0]) / 3;
  out[1] = (out[1] + tmp[1] + 6.5) / 3;
  out[2] = (out[2] + tmp[2] - 2.4) / 3;
  // Etwas unter und vor die gekrümmten Finger: in der Faust versteckt läse es sich nicht als Jo-Jo.
  const A = VIEW_AXES;
  for (let k = 0; k < 3; k++) out[k] += A.up[k] * REST_UP + A.cam[k] * REST_CAM;
}

export class YoyoTricks extends PropTricks<YoyoTrick> {
  readonly rope = new Rope({ segments: VM_STRING_POINTS - 1, length: YOYO_STRING, substep: 1 / 240, iterations: 4, endWeight: 0.15 });
  readonly drive = new RopeDrive();
  private pick = 0;
  private goodCount = 0;
  private idleCount = 0;
  private milestoneCount = 0;
  private cpCount = 0;
  // Zeitleisten-Ergebnis (update) → Aufbau im Handgelenk-Raum (afterPose). Kommazahl-Felder des Frame-Pfads mit
  // Double-Startwert, der Konstruktor setzt sie (Smi-Start boxte jedes Schreiben, fallen.md #107.4).
  private mode: Mode = Mode.Hand;
  private offR = 0.5;
  private offU = 0.5;
  private offC = 0.5;
  private retU = 0.5;
  /** Absprung aus der Hand: 0 = Ruhelage, 1 = Bahn (die Bahnen beginnen am Anker, nicht in der Faust). */
  private launch = 0.5;
  /** Rückweg ab einem festen Punkt (freies Ende) statt vom Anker + Versatz. */
  private retFromFree = false;
  private readonly fromAbs: V = new Float64Array(3);
  /** Rückweg-Beginn (Trick-Zeit), −1 = noch nicht; Freies Ende seit (Trick-Zeit). */
  private retAt = -1.5;
  private surfOut = -1.5;
  private spinBase = 0.5;
  private spinNow = 0.5;
  /** Rückweg-Beginn (Trick-Zeit) für returning() — Feld statt Argument (Frame-Pfad). */
  private retBegin = 0.5;
  private stringOn = false;
  // Scratch (keine Allokation pro Frame).
  private readonly anchor: V = new Float64Array(3);
  private readonly rest: V = new Float64Array(3);
  private readonly tmp: V = new Float64Array(3);
  /** Zuletzt gesehene Gelenke von Zeige- und Mittelfinger (NaN = noch keine). */
  private readonly lastJ = new Float32Array(8).fill(Number.NaN);
  /** Gewicht der Wiegen-Figur (0 = Schnur wie gerechnet, 1 = Dreieck), aus der Zeitleiste. */
  private cradleW = 0.5;
  private readonly tipT: V = new Float64Array(3);
  private readonly tipI: V = new Float64Array(3);
  private readonly knot: V = new Float64Array(3);
  /** Figur der Wiege, 9 Punkte xyz (Punkt 0 und 8 bleiben die gerechnete Schnur). */
  private readonly figure: V = new Float64Array(VM_STRING_POINTS * 3);
  /** Jo-Jo-Mitte beim Abbruch durch das Ziel, ab dem ersten Frame danach der Versatz dazu (klingt mit fadeW ab). */
  private readonly xfSub: V = new Float64Array(3);
  private xfSubFresh = false;
  /** Abbruch aus dem freien Pendel: afterPose rechnet den Frame noch frei und nimmt dessen Lage als Start. */
  private xfFreeStep = false;

  constructor() {
    super();
    this.offR = 0;
    this.offU = 0;
    this.offC = 0;
    this.retU = 0;
    this.launch = 1;
    this.retAt = -1;
    this.surfOut = -1;
    this.spinBase = 0;
    this.spinNow = 0;
    this.retBegin = 0;
    this.cradleW = 0;
    // Wiege: Daumen- und Zeigefingerspitze der Wiegen-Pose, einmal (die Figur blendet erst ein, wenn die
    // Pose angekommen ist — FK je Frame lief im Spiel selten und damit unoptimiert: 9 KiB/s Müll). Aus VM_RIG
    // abgeleitet: ändert jemand Rig oder Pose, wandert die Figur mit (Test gegen die FK der ViewHand).
    const cj = POSE_JOINTS[POSE.cradle];
    thumbPoint(cj, 2, 0, VM_RIG.thumb.len[2] + CRADLE_THUMB_BEYOND, 0, this.tipT);
    fingerTip(cj, 0, this.tipI, CRADLE_INDEX_BEYOND);
    for (let k = 0; k < 3; k++) {
      this.tipT[k] += VIEW_AXES.cam[k] * CRADLE_FRONT;
      this.tipI[k] += VIEW_AXES.cam[k] * CRADLE_FRONT;
    }
    const j = POSE_JOINTS[POSE.run];
    fingerPoint(j, 1, 1, ANCHOR_LOCAL[0], ANCHOR_LOCAL[1], ANCHOR_LOCAL[2], this.anchor);
    holdPoint(j, this.rest, this.tmp);
    this.rope.drive = this.drive;
    // Geführt gespannt wie beim echten Wurf (Länge = Abstand + 3 %), frei voll abgewickelt (setLength).
    this.rope.setTaut(1.03, 0.6, YOYO_STRING);
    this.rope.reset(this.anchor[0], this.anchor[1], this.anchor[2], this.rest[0], this.rest[1], this.rest[2]);
    this.writeRest(this.out);
  }

  override get trickNames(): readonly string[] {
    return YOYO_NAMES;
  }

  /** Tools: ein festgehaltener Start (at ≥ 0, Kontaktblätter) beginnt mit dem Jo-Jo in der Faust (reproduzierbar). */
  override debugPlayName(name: string, at: number): boolean {
    if (at >= 0 && name !== 'none' && this.isTrick(name)) {
      this.rope.freeEnd = false;
      this.rope.reset(this.anchor[0], this.anchor[1], this.anchor[2], this.rest[0], this.rest[1], this.rest[2]);
    }
    return super.debugPlayName(name, at);
  }

  protected override isState(id: YoyoTrick): boolean {
    return id === 'surfSleeper';
  }

  protected resetRun(): void {
    this.drive.reset();
    this.rope.freeEnd = false;
    this.rope.setLength(YOYO_STRING);
    this.rope.reset(this.anchor[0], this.anchor[1], this.anchor[2], this.rest[0], this.rest[1], this.rest[2]);
    this.stringOn = false;
    this.writeRest(this.out);
  }

  /**
   * Ziel bricht ab (Frame-Ende): Drehung übernehmen (sonst spränge sie auf den Sockel-Winkel), Jo-Jo-Lage zu
   * dieser Zeit fürs Überblenden — geführt direkt aus der Bahn des alten Tricks, aus dem freien Pendel erst
   * nach dessen Schritt in afterPose (xfFreeStep).
   */
  protected override onInterrupt(): void {
    this.spinBase = (this.spinBase + this.spinNow) % TAU;
    this.spinNow = 0;
    this.xfFreeStep = this.mode === Mode.Free && this.rope.freeEnd && this.motionFx > 0;
    const s = this.out.sub;
    if (!this.xfFreeStep) this.place(s);
    this.xfSub[0] = s[0];
    this.xfSub[1] = s[1];
    this.xfSub[2] = s[2];
    this.xfSubFresh = true;
  }

  protected override start(id: YoyoTrick): void {
    super.start(id);
    this.retAt = -1;
    this.surfOut = -1;
    this.retFromFree = false;
    this.spinNow = 0;
  }

  protected writeRest(o: PropOut): void {
    o.pose = POSE.run;
    o.poseTau = 0.08;
    o.hx = 0;
    o.hy = 0;
    o.hz = 0;
    o.hpitch = 0;
    o.hyaw = 0;
    o.hroll = 0;
    // Kein Gegenstand im Sockel — das Jo-Jo ist der zweite Körper.
    o.pos[0] = this.rest[0];
    o.pos[1] = this.rest[1];
    o.pos[2] = this.rest[2];
    // Der Sockel trägt nichts (das Jo-Jo ist der zweite Körper) — Lage trotzdem fest, sonst summiert sich
    // das Nachwackeln Frame für Frame (rotateView setzt vor die aktuelle Lage).
    o.rot[0] = 0;
    o.rot[1] = 0;
    o.rot[2] = 0;
    o.spin = 0;
    o.visible = 1;
    o.scale = 1;
    o.poof = -1;
    o.subVisible = 1;
    o.subRot[0] = YOYO_ROT[0];
    o.subRot[1] = YOYO_ROT[1];
    o.subRot[2] = YOYO_ROT[2];
    this.mode = Mode.Hand;
    this.stringOn = false;
    this.cradleW = 0;
  }

  protected cooldownOf(id: YoyoTrick): number {
    return COOLDOWN[id];
  }

  protected onJump(tier: number, good: boolean): void {
    if (tier === 0) return;
    const list = YOYO_TIER_TRICKS[tier];
    // Guter Hop im Overdrive: abwechselnd einfach und doppelt (immer doppelt war zu viel Trick-Zeit).
    if (tier === 3 && good) this.start(this.goodCount++ % 2 === 0 ? 'around' : 'aroundDouble');
    else this.start(list[this.pick++ % list.length]);
  }

  protected onMilestone(tier: number): void {
    // Wie Münze/Kendama/Feuerzeug/Handy: Meilensteine achten auf die Abklingzeit (sonst füllen sie jede Lücke nach
    // einem Sprung-Trick — auf dem umgebauten L1 lag sync 1.0 bei 45.1 %, Band ≤ 45).
    if (this.now < this.cooldownUntil) return;
    if (tier >= 3) this.start('aroundDouble');
    else if (tier === 2) this.start(this.milestoneCount++ % 2 === 0 ? 'breakaway' : 'snap');
  }

  protected onIdle(): number {
    this.start(this.idleCount++ % 3 === 2 ? 'cradle' : 'sleeper');
    return 3 + 2 * this.rand();
  }

  protected override onFinish(): void {
    this.start('cradle');
  }

  /** Checkpoint vor der Bestzeit = Wiege; sonst Around und Breakaway im Wechsel (nur Around: 57 % der Starts auf L1). */
  protected override onCheckpoint(split: number | null): void {
    if (split !== null && split < 0) this.start('cradle');
    else this.start(this.cpCount++ % 2 === 0 ? 'around' : 'breakaway');
  }

  protected override onSurfStart(speed: number): void {
    if (speed >= SURF_FROM) this.start('surfSleeper');
  }

  protected override onFree(inp: PropFrameInput, speed: number): void {
    if (inp.surfing && speed >= SURF_FROM) this.start('surfSleeper');
  }

  override update(dt: number, inp: PropFrameInput): void {
    const wasBusy = this.busy;
    super.update(dt, inp);
    if (wasBusy && !this.busy) this.spinBase = (this.spinBase + this.spinNow) % TAU;
    this.out.subSpin = (this.spinBase + (this.busy ? this.spinNow : 0)) % TAU;
  }


  /** Versatz am Rückweg-Beginn für returning() (Bildrichtungen; Aufrufer übergeben Konstanten). */
  private from(r: number, u: number, c: number): this {
    this.offR = r;
    this.offU = u;
    this.offC = c;
    return this;
  }

  /** Rückweg-Beginn (Trick-Zeit) für returning() — Aufrufer übergeben Konstanten, der Sleeper setzt retBegin selbst. */
  private back(at: number): this {
    this.retBegin = at;
    return this;
  }

  /**
   * Rückweg ab Trick-Zeit retBegin (fester Beginn = framerate-unabhängig); Versatz am Beginn vorher per from().
   * Beginn als Feld (back(at) setzt es), nicht als Argument: berechnete Kommazahlen boxt V8 je Aufruf.
   */
  private returning(t: number, rate: number, o: PropOut): boolean {
    const at = this.retBegin;
    const k = clamp((t - at) / RETURN, 0, 1);
    this.mode = Mode.Return;
    this.retU = smooth(k);
    this.spinNow = rate * at + rate * SPIN_TAU * (1 - Math.exp(-Math.min(t - at, RETURN + SETTLE) / SPIN_TAU));
    o.pose = k > 0.6 ? POSE.run : POSE.relaxed;
    o.poseTau = 0.05;
    if (this.mark(1, at, t)) this.kick(o, -0.35, 0.3);
    if (this.mark(2, at + RETURN, t)) {
      this.kick(o, 0.35, -0.8);
      this.spinKick(-1.2);
    }
    this.stringOn = k < 1;
    return t >= at + RETURN + SETTLE;
  }

  /**
   * Geführte Bahnen schreiben ihren Versatz vom Anker (Bildrichtungen) direkt in offR/offU/offC und setzen
   * mode = Guided — ein Helfer guide(r, u, c) boxte die drei berechneten Kommazahlen je Frame. Je Trick eine
   * kleine Methode: V8 stuft Funktionen nach ausgeführtem Anteil ihres Bytecodes hoch — die große evaluate mit
   * allen Tricks lief im Spiel nach 60 s noch in Sparkplug (jede Kommazahl-Operation eine HeapNumber, 4.6 KiB/s;
   * Review Phase 2), die kleinen Trick-Methoden des Kendama schon in Maglev.
   */
  protected evaluate(id: YoyoTrick, t: number, _dt: number, inp: PropFrameInput, _m: number, o: PropOut): boolean {
    this.stringOn = true;
    this.launch = smooth(t / LAUNCH);
    this.cradleW = 0;
    o.pose = POSE.relaxed;
    o.poseTau = 0.06;
    if (id === 'sleeper' || id === 'snap' || id === 'surfSleeper') return this.sleeper(id, t, inp, o);
    if (id === 'pass') return this.pass(t, o);
    if (id === 'breakaway') return this.breakaway(t, o);
    if (id === 'around') return this.around(t, 1, o);
    if (id === 'aroundDouble') return this.around(t, 2, o);
    return this.cradle(t, o);
  }

  private pass(t: number, o: PropOut): boolean {
    if (t >= PASS_TR) return this.from(0, 0, 0).back(PASS_TR).returning(t, SPIN_PASS, o);
    const e = arc(t / PASS_TR);
    this.mode = Mode.Guided;
    this.offR = -6 * e;
    this.offU = 2.5 * e;
    this.offC = -5 * e;
    this.spinNow = SPIN_PASS * t;
    if (this.mark(0, 0, t)) this.kick(o, -0.25, 0);
    return false;
  }

  /**
   * Seitwurf: Bogen rechts-unten → unter der Hand durch → nach vorn-links hoch. Start rechts-unten schräg (nicht
   * waagerecht rechts: dort liegt der Unterarm vor dem Jo-Jo); vor der Hand durch (zur Kamera), sonst verschwindet
   * es rechts-unten hinter dem Handgelenk.
   */
  private breakaway(t: number, o: PropOut): boolean {
    if (t >= BREAK_T) return this.from(BREAK_END_R, BREAK_END_U, 0).back(BREAK_T).returning(t, SPIN_BREAK, o);
    const u = t / BREAK_T;
    const a = -0.3 * Math.PI + Math.PI * smooth(u);
    const r = R * BREAK_R * Math.min(1, u * 5);
    const b = bell(u);
    this.mode = Mode.Guided;
    this.offR = -Math.sin(a) * r;
    this.offU = -Math.cos(a) * r;
    this.offC = 3 * b;
    this.spinNow = SPIN_BREAK * t;
    o.hroll = -0.2 * b;
    if (this.mark(0, 0, t)) this.kick(o, -0.3, 0);
    return false;
  }

  /** Around the World (loops 1) bzw. doppelt: Kreis in der Bildebene um den Anker, dann zurück. */
  private around(t: number, loops: number, o: PropOut): boolean {
    const L = loops * LOOP;
    if (t < AROUND_W) {
      const u = t / AROUND_W;
      this.mode = Mode.Guided;
      this.offR = 0.5 * u;
      this.offU = -R * AROUND_TALL * smooth(u);
      this.offC = 0;
      this.spinNow = SPIN_AROUND * t;
      if (this.mark(0, 0, t)) this.kick(o, -0.3, 0);
      return false;
    }
    if (t < AROUND_W + L) {
      // Kreis in der Bildebene um den Anker: von unten nach vorn-links hoch, oben rüber, rechts runter.
      const ph = ((t - AROUND_W) / L) * loops * TAU;
      const sp = Math.sin(ph);
      // Rechte Hälfte zur Kamera gekippt (AROUND_TILT_*).
      const k = smooth((t - AROUND_W) / 0.2);
      this.mode = Mode.Guided;
      this.offR = 0.5 * (1 - k) - AROUND_SHIFT * k - sp * R * AROUND_SQUASH;
      this.offU = -Math.cos(ph) * R * AROUND_TALL;
      this.offC = -AROUND_TILT_A * sp + AROUND_TILT_B * sp * sp;
      this.spinNow = SPIN_AROUND * t;
      o.hroll = 0.12 * sp;
      o.pose = POSE.run;
      return false;
    }
    return this.from(AROUND_END_R, AROUND_END_U, 0).back(loops === 2 ? AROUND_BACK_2 : AROUND_BACK_1).returning(t, SPIN_AROUND, o);
  }

  /** Cradle ("Rock the Baby"): hängt vor der Hand und wiegt hin und her, die Hand wiegt mit. */
  private cradle(t: number, o: PropOut): boolean {
    if (t >= CRADLE_T) return this.from(0, 0, 0).back(CRADLE_T).returning(t, SPIN_CRADLE, o);
    const u = t / CRADLE_T;
    const env = smooth(u / 0.15) * (1 - smooth((u - 0.8) / 0.2));
    const wave = Math.sin(TAU * CRADLE_HZ * t);
    const swing = CRADLE_SWING * wave * env;
    const r = CRADLE_R * env;
    this.mode = Mode.Guided;
    this.offR = Math.sin(swing) * r - CRADLE_LEFT * env;
    this.offU = -Math.cos(swing) * r;
    this.offC = CRADLE_CAM * env;
    this.spinNow = SPIN_CRADLE * t;
    o.hroll = -0.08 * wave * env;
    this.cradleW = smooth((u - CRADLE_IN) / 0.12) * (1 - smooth((u - CRADLE_OUT) / 0.1));
    if (u > CRADLE_IN * 0.5 && u < CRADLE_OUT + 0.05) o.pose = POSE.cradle;
    o.poseTau = 0.08;
    if (this.mark(0, 0, t)) this.kick(o, -0.2, 0);
    return false;
  }

  /** Wurf nach unten (geführt), dann frei hängend schlafen, Zupfen und Rückweg. */
  private sleeper(id: YoyoTrick, t: number, inp: PropFrameInput, o: PropOut): boolean {
    if (t < THROW) {
      const u = t / THROW;
      this.mode = Mode.Guided;
      this.offR = THROW_END_R * u * u;
      this.offU = THROW_END_U * u * u;
      this.offC = THROW_END_C * u * u;
      this.spinNow = (SPIN_SLEEP * t * t) / (2 * THROW);
      if (this.mark(0, 0, t)) this.kick(o, -0.3, 0);
      return false;
    }
    const sleepUntil = id === 'snap' ? THROW + SNAP_SLEEP : THROW + SLEEP;
    if (id === 'surfSleeper' && this.surfOut < 0 && !inp.surfing && t >= SURF_MIN) this.surfOut = t;
    const sleeping = id === 'surfSleeper' ? this.surfOut < 0 : t < sleepUntil;
    const spin0 = (SPIN_SLEEP * THROW) / 2;
    if (sleeping) {
      this.mode = Mode.Free;
      this.spinNow = spin0 + SPIN_SLEEP * (t - THROW);
      // Einlage im Surf (PropTricks.beatU): das Handgelenk zuckt hoch und kippt — das schlafende Jo-Jo schwingt
      // aus (Pendel über RopeDrive: der Ruck geht an HandMotion, die Schnur spürt ihn als Scheinkraft).
      if (id === 'surfSleeper') {
        const u = this.beatU;
        if (u < 1) o.hroll = BEAT_ROLL * bell(u);
        if (this.beatBegin()) this.kick(o, -0.55, 0.15);
      }
      return false;
    }
    // Zupfen: Rückweg ab der Pendel-Position (freies Ende, einmal eingefangen).
    const at = id === 'surfSleeper' ? this.surfOut : sleepUntil;
    if (this.retAt < 0) {
      this.retAt = at;
      this.retFromFree = true;
      this.fromAbs[0] = this.rope.endX;
      this.fromAbs[1] = this.rope.endY;
      this.fromAbs[2] = this.rope.endZ;
    }
    this.retBegin = at;
    const done = this.from(0, 0, 0).returning(t, SPIN_SLEEP, o);
    // Auslauf ab dem Schlaf-Ende (Winkel stetig).
    this.spinNow = spin0 + SPIN_SLEEP * (at - THROW) + SPIN_SLEEP * SPIN_TAU * (1 - Math.exp(-Math.min(t - at, RETURN + SETTLE) / SPIN_TAU));
    return done;
  }

  /**
   * Nach dem Überblenden der Gelenke: Anker und Ruhelage per FK aus DIESEN Gelenken, Jo-Jo-Lage
   * aus dem Zeitleisten-Ergebnis, dann die Schnur (fester Unterschritt, RopeDrive).
   */
  override afterPose(joints: ArrayLike<number>, inp: PropFrameInput, dtRaw: number): void {
    const dt = dtRaw - dtRaw === 0 ? clamp(dtRaw, 0, 0.1) : 0;
    const a = this.anchor;
    const h = this.rest;
    // FK nur, wenn sich Zeige-/Mittelfinger bewegt haben (in Ruhe meist nicht; spart die Rechnung und in
    // Chrome geboxte Zwischenwerte). Literale statt ANCHOR_LOCAL[i]: Konstanten sind fertige Objekte.
    if (this.fingersMoved(joints)) {
      fingerPoint(joints, 1, 1, 0, 1.2, 0, a);
      holdPoint(joints, h, this.tmp);
    }
    const o = this.out;
    const s = o.sub;
    const rope = this.rope;
    const free = this.mode === Mode.Free && this.motionFx > 0;
    this.drive.setFrameFrom(inp, this.motionFx);
    // Wechsel geführt ↔ frei mitten im Frame (Wurf-Ende, Zupfen): bis zur Marke im alten Modus — so
    // beginnt das Pendel bei jeder Framerate zur selben Zeit am selben Ort (vorher Frame-Ende: 30 Hz 2.7 px).
    const sw = free === rope.freeEnd || this.held ? -1 : free ? THROW : this.retAt;
    const back = sw >= 0 ? this.t - sw : -1;
    if (this.xfFreeStep) this.freeUntilFinish(dt);
    else if (back >= 0 && back < dt) this.switchFrame(dt, back, free);
    else {
      if (free && !rope.freeEnd) {
        rope.freeEnd = true;
        rope.setLength(YOYO_STRING);
      } else if (!free) rope.freeEnd = false;
      this.place(s);
      // Festgehalten (Kontaktblatt): die Dev-Seite startet den Trick jeden Frame neu — ruhig hängend zeigen.
      if (rope.freeEnd && this.held) {
        const A = VIEW_AXES;
        rope.reset(a[0], a[1], a[2], a[0] - A.up[0] * YOYO_STRING, a[1] - A.up[1] * YOYO_STRING, a[2] - A.up[2] * YOYO_STRING);
      }
      rope.updateV(dt, a, s);
    }
    if (rope.freeEnd) {
      s[0] = rope.endX;
      s[1] = rope.endY;
      s[2] = rope.endZ;
    }
    o.pos[0] = h[0];
    o.pos[1] = h[1];
    o.pos[2] = h[2];
    const on = this.stringOn && this.motionFx > 0;
    o.stringCount = on ? rope.n : 0;
    if (on) o.string.set(rope.out);
    if (on && this.cradleW > 0) this.cradleString();
  }

  /**
   * Wiege: Schnur-Punkte zwischen gerechneter Schnur und Figur überblenden — Anker → Daumenspitze →
   * Zeigefingerspitze → Knoten → Daumenspitze → Knoten → (gerade) → Jo-Jo. Das Dreieck schaukelt mit,
   * weil der Knoten auf der Linie zum schaukelnden Jo-Jo liegt. Anfang und Ende bleiben exakt.
   */
  private cradleString(): void {
    const A = VIEW_AXES;
    const T = this.tipT;
    const I = this.tipI;
    const K = this.knot;
    const F = this.figure;
    const a = this.anchor;
    const y = this.out.sub;
    for (let k = 0; k < 3; k++) {
      K[k] = a[k] + (y[k] - a[k]) * CRADLE_KNOT + A.cam[k] * CRADLE_FRONT;
      F[3 + k] = T[k];
      F[6 + k] = I[k];
      F[9 + k] = K[k];
      F[12 + k] = T[k];
      F[15 + k] = K[k];
      F[18 + k] = K[k] + (y[k] - K[k]) / 3;
      F[21 + k] = K[k] + ((y[k] - K[k]) * 2) / 3;
    }
    // Überblenden ohne Hilfs-Aufruf: Kommazahlen als Argumente boxt V8 (Chrome-Probe +10 B/Frame).
    const w = this.cradleW;
    const out = this.out.string;
    for (let j = 3; j < 24; j++) out[j] += (F[j] - out[j]) * w;
  }

  /** Gelenke von Zeige- und Mittelfinger seit dem letzten Aufruf verändert? (merkt sie sich) */
  private fingersMoved(joints: ArrayLike<number>): boolean {
    const b = VM_JOINT.finger;
    const last = this.lastJ;
    let moved = false;
    for (let i = 0; i < 8; i++) {
      if (joints[b + i] !== last[i]) {
        last[i] = joints[b + i];
        moved = true;
      }
    }
    return moved;
  }


  /**
   * Frame mit Moduswechsel `back` s vor seinem Ende. Wurf-Ende: bis dahin geführt ans Bahn-Ende (Wurf
   * bei u = 1), dann frei. Zupfen: bis dahin Pendel, der Rückweg startet EXAKT an der Pendel-Lage zur
   * Marke (vorher: an der vom letzten Frame-Ende).
   */
  private switchFrame(dt: number, back: number, free: boolean): void {
    const a = this.anchor;
    const rope = this.rope;
    const s = this.out.sub;
    const k = 1 - back / dt;
    if (free) {
      const A = VIEW_AXES;
      const e = this.tmp;
      for (let i = 0; i < 3; i++) e[i] = a[i] + A.right[i] * THROW_END_R + A.up[i] * THROW_END_U + A.cam[i] * THROW_END_C;
      rope.updatePart(dt, k, a, e);
      rope.freeEnd = true;
      rope.setLength(YOYO_STRING);
      if (back > 0) rope.updateRest(dt, k, a, a);
      return;
    }
    rope.updatePart(dt, k, a, a);
    this.fromAbs[0] = rope.endX;
    this.fromAbs[1] = rope.endY;
    this.fromAbs[2] = rope.endZ;
    rope.freeEnd = false;
    this.place(s);
    if (back > 0) rope.updateRest(dt, k, a, s);
  }

  /**
   * Ziel-Abbruch aus dem freien Pendel (Sleeper, surfSleeper): bis zum Frame-Ende gilt der alte Modus (dort
   * gilt das Ziel) — Pendel frei rechnen, seine Lage ist der Start; die neue Bahn blendet von dort ein.
   */
  private freeUntilFinish(dt: number): void {
    this.xfFreeStep = false;
    const a = this.anchor;
    const rope = this.rope;
    const s = this.out.sub;
    rope.updatePart(dt, 1, a, a);
    this.xfSub[0] = rope.endX;
    this.xfSub[1] = rope.endY;
    this.xfSub[2] = rope.endZ;
    rope.freeEnd = false;
    this.place(s);
    // Rest-Frame der Länge 0: Ziele setzen (Ende = Pendel-Lage), der nächste Frame zieht von hier.
    rope.updateRest(dt, 1, a, s);
  }

  /** Jo-Jo-Mitte aus Modus und Versatz (Handgelenk-Raum). */
  private place(s: Float32Array): void {
    const a = this.anchor;
    const h = this.rest;
    const A = VIEW_AXES;
    if (this.mode === Mode.Hand || this.motionFx <= 0) {
      s[0] = h[0];
      s[1] = h[1];
      s[2] = h[2];
    } else if (this.mode === Mode.Free) return;
    else {
      for (let k = 0; k < 3; k++) {
        const path = a[k] + A.right[k] * this.offR + A.up[k] * this.offU + A.cam[k] * this.offC;
        const guided = h[k] + (path - h[k]) * this.launch;
        if (this.mode === Mode.Guided) s[k] = guided;
        else {
          const from = this.retFromFree ? this.fromAbs[k] : guided;
          s[k] = from + (h[k] - from) * this.retU;
        }
      }
    }
    // Nach einem Ziel-Abbruch: Versatz zur zuletzt gezeigten Lage abklingen lassen (sonst spränge das Jo-Jo
    // in die Faust); festgehalten im ersten Frame, wie PropTricks.crossFade.
    const w = this.fadeW;
    if (w <= 0) return;
    const x = this.xfSub;
    if (this.xfSubFresh) {
      this.xfSubFresh = false;
      for (let k = 0; k < 3; k++) x[k] -= s[k];
    }
    for (let k = 0; k < 3; k++) s[k] += x[k] * w;
  }
}
