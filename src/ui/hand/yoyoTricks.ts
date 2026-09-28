import { VM_JOINT, VM_STRING_POINTS } from '../../render/types';
import { arc, bell, clamp, fin, smooth } from './anim';
import { fingerPoint } from './fk';
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
 */

export const YOYO_TRICKS = ['none', 'sleeper', 'pass', 'snap', 'breakaway', 'around', 'aroundDouble', 'cradle', 'surfSleeper'] as const;
export type YoyoTrick = Exclude<(typeof YOYO_TRICKS)[number], 'none'>;
const YOYO_NAMES: readonly string[] = YOYO_TRICKS.filter((t) => t !== 'none');

/** Tricks je Tempo-Stufe bei Sprüngen (Tests prüfen genau diese Zuordnung). */
export const YOYO_TIER_TRICKS: readonly (readonly YoyoTrick[])[] = [[], ['pass', 'snap'], ['breakaway', 'pass'], ['around', 'breakaway']];

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
const BREAK_T = 0.6;
const AROUND_W = 0.15;
const LOOP = 1 / 2;
/** Kreismitte links vom Anker (Einheiten), damit die rechte Hälfte nicht in der Hand verschwindet. */
const AROUND_SHIFT = 1.5;
/** Kreis quer gestaucht: so bleibt der linke Rand in der abgenommenen Hülle (≥ 0.055 Bildhöhen, envelope.ts). */
const AROUND_SQUASH = 0.78;
const CRADLE_T = 1.8;
const CRADLE_R = 7.2;
const CRADLE_SWING = 0.6;
const CRADLE_HZ = 1.3;
const SURF_MIN = 0.5;
const SURF_FROM = 500;
const R = YOYO_STRING * 0.9;
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
  // Zeitleisten-Ergebnis (update) → Aufbau im Handgelenk-Raum (afterPose).
  private mode: Mode = Mode.Hand;
  private offR = 0;
  private offU = 0;
  private offC = 0;
  private retU = 0;
  /** Absprung aus der Hand: 0 = Ruhelage, 1 = Bahn (die Bahnen beginnen am Anker, nicht in der Faust). */
  private launch = 1;
  /** Rückweg ab einem festen Punkt (freies Ende) statt vom Anker + Versatz. */
  private retFromFree = false;
  private readonly fromAbs: V = new Float64Array(3);
  /** Rückweg-Beginn (Trick-Zeit), −1 = noch nicht; Freies Ende seit (Trick-Zeit). */
  private retAt = -1;
  private surfOut = -1;
  private spinBase = 0;
  private spinNow = 0;
  private stringOn = false;
  // Scratch (keine Allokation pro Frame).
  private readonly anchor: V = new Float64Array(3);
  private readonly rest: V = new Float64Array(3);
  private readonly tmp: V = new Float64Array(3);
  /** Zuletzt gesehene Gelenke von Zeige- und Mittelfinger (NaN = noch keine). */
  private readonly lastJ = new Float32Array(8).fill(Number.NaN);

  constructor() {
    super();
    const j = POSE_JOINTS[POSE.run];
    fingerPoint(j, 1, 1, ANCHOR_LOCAL[0], ANCHOR_LOCAL[1], ANCHOR_LOCAL[2], this.anchor);
    holdPoint(j, this.rest, this.tmp);
    this.rope.drive = this.drive;
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
    if (tier >= 3) this.start('aroundDouble');
    else if (tier === 2) this.start('breakaway');
  }

  protected onIdle(): number {
    this.start(this.idleCount++ % 3 === 2 ? 'cradle' : 'sleeper');
    return 3 + 2 * this.rand();
  }

  protected override onFinish(): void {
    this.start('cradle');
  }

  protected override onCheckpoint(_split: number | null): void {
    this.start('breakaway');
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

  /** Geführter Versatz vom Anker (Bildrichtungen). */
  private guide(r: number, u: number, c: number): void {
    this.mode = Mode.Guided;
    this.offR = r;
    this.offU = u;
    this.offC = c;
  }

  /** Rückweg ab Trick-Zeit `at` (fester Beginn = framerate-unabhängig); Versatz am Beginn (r, u, c). */
  private returning(t: number, at: number, r: number, u: number, c: number, rate: number, o: PropOut): boolean {
    const k = clamp((t - at) / RETURN, 0, 1);
    this.mode = Mode.Return;
    this.retU = smooth(k);
    this.offR = r;
    this.offU = u;
    this.offC = c;
    this.spinNow = this.spinAt(at, rate) + rate * SPIN_TAU * (1 - Math.exp(-Math.min(t - at, RETURN + SETTLE) / SPIN_TAU));
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

  /** Drehwinkel bis zur Trick-Zeit t bei konstanter Rate (Sleeper: Rampe im Wurf). */
  private spinAt(t: number, rate: number): number {
    return rate * t;
  }

  protected evaluate(id: YoyoTrick, t: number, _dt: number, inp: PropFrameInput, _m: number, o: PropOut): boolean {
    this.stringOn = true;
    this.launch = smooth(t / LAUNCH);
    o.pose = POSE.relaxed;
    o.poseTau = 0.06;
    if (id === 'sleeper' || id === 'snap' || id === 'surfSleeper') return this.sleeper(id, t, inp, o);
    if (id === 'pass') {
      const tr = PASS_T * 0.85;
      if (t < tr) {
        const e = arc(t / tr);
        this.guide(-6 * e, 2.5 * e, -5 * e);
        this.spinNow = SPIN_PASS * t;
        if (this.mark(0, 0, t)) this.kick(o, -0.25, 0);
        return false;
      }
      return this.returning(t, tr, 0, 0, 0, SPIN_PASS, o);
    }
    if (id === 'breakaway') {
      if (t < BREAK_T) {
        const u = t / BREAK_T;
        this.breakaway(u);
        this.spinNow = SPIN_BREAK * t;
        o.hroll = -0.2 * bell(u);
        if (this.mark(0, 0, t)) this.kick(o, -0.3, 0);
        return false;
      }
      const a = 0.7 * Math.PI;
      return this.returning(t, BREAK_T, -Math.sin(a) * R, -Math.cos(a) * R, 0, SPIN_BREAK, o);
    }
    if (id === 'around' || id === 'aroundDouble') {
      const loops = id === 'aroundDouble' ? 2 : 1;
      const L = loops * LOOP;
      if (t < AROUND_W) {
        const u = t / AROUND_W;
        this.guide(0.5 * u, -R * smooth(u), 0);
        this.spinNow = SPIN_AROUND * t;
        if (this.mark(0, 0, t)) this.kick(o, -0.3, 0);
        return false;
      }
      if (t < AROUND_W + L) {
        // Kreis in der Bildebene um den Anker: von unten nach vorn-links hoch, oben rüber, rechts runter.
        const ph = ((t - AROUND_W) / L) * loops * TAU;
        // Rechte Hälfte zur Kamera gekippt: sonst läuft es hinter Hand und Handgelenk durch.
        const k = smooth((t - AROUND_W) / 0.2);
        this.guide(0.5 * (1 - k) - AROUND_SHIFT * k - Math.sin(ph) * R * AROUND_SQUASH, -Math.cos(ph) * R, -3.5 * Math.sin(ph));
        this.spinNow = SPIN_AROUND * t;
        o.hroll = 0.12 * Math.sin(ph);
        o.pose = POSE.run;
        return false;
      }
      return this.returning(t, AROUND_W + L, -AROUND_SHIFT, -R, 0, SPIN_AROUND, o);
    }
    // cradle ("Rock the Baby"): hängt vor der Hand und wiegt hin und her, die Hand wiegt mit.
    if (t < CRADLE_T) {
      const u = t / CRADLE_T;
      const env = smooth(u / 0.15) * (1 - smooth((u - 0.8) / 0.2));
      const swing = CRADLE_SWING * Math.sin(TAU * CRADLE_HZ * t) * env;
      const r = CRADLE_R * env;
      this.guide(Math.sin(swing) * r, -Math.cos(swing) * r, 2 * env);
      this.spinNow = SPIN_CRADLE * t;
      o.hroll = -0.08 * Math.sin(TAU * CRADLE_HZ * t) * env;
      if (this.mark(0, 0, t)) this.kick(o, -0.2, 0);
      return false;
    }
    return this.returning(t, CRADLE_T, 0, 0, 0, SPIN_CRADLE, o);
  }

  private breakaway(u: number): void {
    // Seitwurf: Bogen rechts-unten → unter der Hand durch → nach vorn-links hoch.
    // Start rechts-unten schräg (nicht waagerecht rechts: dort liegt der Unterarm vor dem Jo-Jo).
    const a = -0.3 * Math.PI + Math.PI * smooth(u);
    const r = R * Math.min(1, u * 5);
    // Vor der Hand durch (zur Kamera), sonst verschwindet es rechts-unten hinter dem Handgelenk.
    this.guide(-Math.sin(a) * r, -Math.cos(a) * r, 3 * bell(u));
  }

  /** Wurf nach unten (geführt), dann frei hängend schlafen, Zupfen und Rückweg. */
  private sleeper(id: YoyoTrick, t: number, inp: PropFrameInput, o: PropOut): boolean {
    if (t < THROW) {
      const u = t / THROW;
      this.guide(THROW_END_R * u * u, THROW_END_U * u * u, THROW_END_C * u * u);
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
    const done = this.returning(t, at, 0, 0, 0, SPIN_SLEEP, o);
    // Auslauf ab dem Schlaf-Ende (Winkel stetig).
    this.spinNow = spin0 + SPIN_SLEEP * (at - THROW) + SPIN_SLEEP * SPIN_TAU * (1 - Math.exp(-Math.min(t - at, RETURN + SETTLE) / SPIN_TAU));
    return done;
  }

  /**
   * Nach dem Überblenden der Gelenke: Anker und Ruhelage per FK aus DIESEN Gelenken, Jo-Jo-Lage
   * aus dem Zeitleisten-Ergebnis, dann die Schnur (fester Unterschritt, RopeDrive).
   */
  override afterPose(joints: ArrayLike<number>, inp: PropFrameInput, dtRaw: number): void {
    const dt = Number.isFinite(dtRaw) ? clamp(dtRaw, 0, 0.1) : 0;
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
    if (back >= 0 && back < dt) this.switchFrame(dt, back, free);
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
      if (!rope.freeEnd) this.tautLength(s);
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

  /** Geführt: gespannt wie beim echten Wurf (Länge = Abstand + 3 %). */
  private tautLength(s: Float32Array): void {
    const a = this.anchor;
    const dx = s[0] - a[0];
    const dy = s[1] - a[1];
    const dz = s[2] - a[2];
    this.rope.setLength(Math.min(YOYO_STRING, Math.max(0.6, Math.sqrt(dx * dx + dy * dy + dz * dz) * 1.03)));
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
      rope.setLength(Math.min(YOYO_STRING, Math.sqrt(THROW_END_R ** 2 + THROW_END_U ** 2 + THROW_END_C ** 2) * 1.03));
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
    this.tautLength(s);
    if (back > 0) rope.updateRest(dt, k, a, s);
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
      return;
    }
    if (this.mode === Mode.Free) return;
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
}
