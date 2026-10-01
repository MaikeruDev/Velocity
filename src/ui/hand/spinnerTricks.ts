import type { GameEvent } from '../../engine/events';
import { VM_JOINT, VM_JOINT_COUNT, VM_PARAM, VM_RIG } from '../../render/types';
import { arc, bell, clamp, fin, smooth } from './anim';
import { Track } from './curves';
import { Toss, settle } from './rigid';
import { fingerPoint, fingerTip, thumbPoint } from './fk';
import { POSE, POSE_JOINTS } from './poses';
import { PropTricks } from './propTricks';
import type { PropFrameInput, PropOut } from './propTricks';
import { VIEW_AXES, fromEulerXYZV, mat3, toEulerXYZ } from './rot';
import { RopeHandGuard } from './rope';
import { relRot, viewPoint, viewRot } from './view';
import type { V3 } from './view';

/**
 * Fidget-Spinner (Plan 007, K5): "Tacho in der Hand". Die Drehzahl folgt dem Tempo
 * (ω = 6 + 0.07 · Tempo rad/s, hoch τ 0.8 s, runter 3 s), jeder Sprung schnippt nach (+8, guter Hop
 * (jump.clean) +14, Meilenstein +20; Deckel 110 rad/s). Plan 008: gehalten am Mittellager zwischen Daumen- und
 * Mittelfinger-Kuppe, der Zeigefinger schnippt einen Lappen an (streift, statt in den Rotor zu tauchen); auf der
 * Fingerspitze liegt die Achse längs des Zeigefinger-Endglieds (Kreisel auf dem Finger). Hüpfer/Würfe als Parabeln,
 * vorher löst der Daumen die Lager-Kappe; Finger-Schutz als Kugel-Wolke (Toleranz aus der Ruhelage kalibriert).
 *
 * Tricks je Tempo (Takt gemessen mit tools/cosmetics/event-probe.ts):
 * - Stand: flick (Zeigefinger schnippt), jedes 3. Mal swap (auf die Zeigefinger-Spitze und zurück),
 * - Lauf: flick, Flow: toss (flach drehend hoch, Fang im Pinch) / swap im Wechsel,
 * - Overdrive / Ziel: ufo (hoch wie ein UFO, Fang auf der Fingerspitze), guter Hop im Wechsel ufo / toss,
 * - Surf ≥ 500 u/s: Zustand balance — auf der Fingerspitze, die Achse präzediert (Kreis ∝ 1/ω) und
 *   neigt sich mit der Rampe, hüpft als Einlage kurz hoch; endet mit dem Surf ("nie abbrechen" bleibt wahr),
 * - Checkpoint: großer flick, die Nabe blinkt grün (vor der Bestzeit) oder rot (dahinter).
 *
 * Gegen Wagenrad-Aliasing (3-fache Symmetrie) zeigt der Renderer höchstens 0.9 rad Drehung pro
 * Frame; darüber blendet ein Unschärfe-Ring (Bayer-Screen-Door) ein. Das ist absichtlich pro Frame
 * (Aliasing entsteht pro Frame) — Winkel und Unschärfe sind deshalb NICHT framerate-unabhängig,
 * ω und alle Zeitleisten schon. motionFx 0: der Spinner steht.
 */

export const SPINNER_TRICKS = ['none', 'flick', 'swap', 'toss', 'ufo', 'balance'] as const;
export type SpinnerTrick = Exclude<(typeof SPINNER_TRICKS)[number], 'none'>;
const SPINNER_NAMES: readonly string[] = SPINNER_TRICKS.filter((t) => t !== 'none');

/** Tricks je Tempo-Stufe bei Sprüngen (Tests prüfen genau diese Zuordnung). */
export const SPINNER_TIER_TRICKS: readonly (readonly SpinnerTrick[])[] = [[], ['flick'], ['toss', 'swap'], ['ufo', 'toss']];

/** Drehzahl: Ziel ω = BASE + PER_SPEED · Tempo (rad/s). */
export const SPINNER_OMEGA_BASE = 6;
export const SPINNER_OMEGA_PER_SPEED = 0.07;
export const SPINNER_OMEGA_MAX = 110;
const TAU_UP = 0.8;
const TAU_DOWN = 3;
const KICK_JUMP = 8;
const KICK_PERFECT = 14;
const KICK_MILESTONE = 20;
const KICK_FLICK = 10;
const KICK_FLICK_BIG = 20;
/** Größter angezeigter Drehschritt pro Frame (rad) — darüber Unschärfe statt Wagenrad. */
export const SPINNER_STEP_CAP = 0.9;
const BLUR_FROM = 0.75;
const BLUR_MAX = 0.45;
/** Rotor ist 3-fach symmetrisch: Winkel nur modulo 2π/3 nötig (bleibt klein, keine Präzisionsverluste). */
const SYM = (Math.PI * 2) / 3;
const SURF_FROM = 500;

/** Abklingzeiten: Würfe sind kürzer (echte Parabeln, 0.3 s Flug) — um die Differenz länger, der Takt bleibt. */
const COOLDOWN = { flick: 1.0, swap: 1.0, toss: 1.55, ufo: 1.4, balance: 0.5 } as const;
/**
 * Plan 008 — Anschnippen mit dem Zeigefinger: er spannt sich zurück (streckt), schnellt herunter und trifft einen Lappen bei FLICK_HIT
 * (Drehimpuls am Frame-Ende der Marke, #77), schwingt über und federt zurück; der Spinner kippt vom Stoß kurz und
 * pendelt sich ein. Die Drehzahl läuft danach mit Lager-Reibung aus (exponentiell, TAU_DOWN).
 */
const FLICK_TIME = 0.4;
/**
 * Zeigefinger-Schnipp gedämpft (Anteil der Spuren): er liegt über der Rotor-Fläche, voll gebeugt schlug er 1.4 tief in
 * sie hinein — so streift die Kuppe den Lappen. Nachwackeln des Rotors gedämpft (im Lager-Halt kippt er kaum; voll
 * stieß er an den Daumen).
 */
const FLICK_FLEX = 0.25;
const FLICK_WOB = 0.4;
const FLICK_HIT = 0.085;
/** Zeigefinger (rad, Grund-/Mittel-/Endgelenk): zurückspannen (strecken), über den Lappen herunterschnellen, zurückfedern. */
const IDX_MCP = new Track(
  [
    [0, 0],
    [0.06, -0.34],
    [FLICK_HIT, 0.12],
    [0.12, 0.42],
    [0.26, -0.05],
    [FLICK_TIME, 0],
  ],
  { smooth: true },
);
const IDX_PIP = new Track(
  [
    [0, 0],
    [0.06, -0.3],
    [FLICK_HIT, 0.15],
    [0.12, 0.5],
    [0.26, -0.04],
    [FLICK_TIME, 0],
  ],
  { smooth: true },
);
/** Wurf-Schwerkraft der Spinner-Würfe (Einheiten/s²) und Flugzeit: Scheitel g·T²/8 ≈ 8 Einheiten (Hülle). */
const SPIN_G = 820;
const AIR_T = 0.28;
/** Hüpfer auf den Zeigefinger und zurück (s). */
const SWAP_UP = 0.08;
/** Hüpfer-Flugzeit: Scheitel g·T²/8 ≈ 7 — der Rotor fällt von oben auf den gestreckten Finger (0.2 s streifte ihn). */
const SWAP_HOP = 0.26;
const SWAP_BACK = 0.72;
/** Ende nach der Landung im Halt: Lösen und Nachfedern klingen vorher ganz aus. */
const SWAP_TIME = SWAP_BACK + SWAP_HOP + 0.16;
const TOSS_WINDUP = 0.1;
const TOSS_AIR = AIR_T;
const TOSS_TOTAL = TOSS_WINDUP + TOSS_AIR + 0.22;
const UFO_WINDUP = 0.1;
const UFO_AIR = AIR_T;
/** Auf der Fingerspitze balancieren (Präzession), dann zurück in den Griff. */
const UFO_SHOW = 0.42;
/** Rückweg in den Griff = Hüpfer (HOP_BACK), danach Nachfassen. */
const UFO_BACK = SWAP_HOP;
const UFO_SETTLE = 0.16;
const UFO_LAND = UFO_WINDUP + UFO_AIR + UFO_SHOW + UFO_BACK;
const UFO_TOTAL = UFO_LAND + UFO_SETTLE;
/** Ausholen vor einem Wurf: Hand sinkt (Bildhöhen +), dann der Wurf-Ruck (Impuls). */
const DIP = new Track(
  [
    [0, 0],
    [0.1, 0.018],
    [0.16, -0.006],
    [0.3, 0],
  ],
  { smooth: true },
);
/** Balance: Lösen bis zum Hüpfer (s); Ein-/Ausstieg dauern je SWAP_HOP (+ Nachfassen). */
const BAL_UP = 0.06;
const BAL_IN = BAL_UP + SWAP_HOP;
const BAL_OUT = SWAP_HOP + 0.1;
const BAL_MIN = 0.5;
/** Einlage im Surf-Zustand: Scheitel des Hüpfers von der Fingerspitze (Einheiten). */
const BEAT_HOP = 3.2;
const HUB_TIME = 0.9;

/** Halt lösen: Daumen spreizt ab (rad) — die Kuppe hebt von der Lager-Kappe (Suche: Opposition/Mittelfinger halfen nicht). */
const REL_TA = 0.8;
/** … und der Mittelfinger gibt die Gegen-Kappe frei (rad, strecken), sonst stieß er beim Landen im Halt an. */
const REL_M = -0.4;
/** Größer als ein echter Spinner (7 cm): im Low-Res-Bild liest er sich sonst als kleines Kreuz. */
const SPINNER_SCALE = 1.25;
/** Halbe Nabenlänge (items/spinner, Modell-Einheiten) und wie weit die Nabe in die Kuppe drückt (Einheiten). */
const TIP_HUB_HALF = 0.75;
const TIP_PRESS = 0.15;

/**
 * Halt am Mittellager (Plan 008, Griff-Audit): Daumen- und Mittelfinger-Kuppe drücken auf die beiden Lager-Kappen,
 * die Spinner-Achse liegt auf ihrer Verbindung (aus der Pose spin per FK, Ladezeit). Vorher lag der Spinner auf der
 * Zeigefinger-Kuppe, das Grundglied steckte 1.35 cm im Rotor.
 */
const HOLD_FRAME = ((): { pos: V3; rot: V3 } => {
  const j = POSE_JOINTS[POSE.spin];
  const t: [number, number, number] = [0, 0, 0];
  const m: [number, number, number] = [0, 0, 0];
  thumbPoint(j, 2, 0, VM_RIG.thumb.len[2] + VM_RIG.thumb.r[2] * 0.6, 0, t);
  fingerTip(j, 1, m, 0.6);
  const z = norm3(t[0] - m[0], t[1] - m[1], t[2] - m[2]);
  const rot = frameRot(z);
  return { pos: [(t[0] + m[0]) / 2, (t[1] + m[1]) / 2, (t[2] + m[2]) / 2], rot };
})();
export const SPINNER_HOLD_POS: V3 = HOLD_FRAME.pos;
export const SPINNER_HOLD_ROT: V3 = HOLD_FRAME.rot;

/** Lage (Euler XYZ) mit Spinner-Achse (lokal z) = z, Rotor-"oben" (lokal y) möglichst Bild-oben. */
function frameRot(z: readonly number[]): V3 {
  const u = VIEW_AXES.up;
  const d = u[0] * z[0] + u[1] * z[1] + u[2] * z[2];
  const y = norm3(u[0] - d * z[0], u[1] - d * z[1], u[2] - d * z[2]);
  const x = [y[1] * z[2] - y[2] * z[1], y[2] * z[0] - y[0] * z[2], y[0] * z[1] - y[1] * z[0]];
  const R = mat3();
  for (let k = 0; k < 3; k++) {
    R[k * 3] = x[k];
    R[k * 3 + 1] = y[k];
    R[k * 3 + 2] = z[k];
  }
  const e = new Float32Array(3);
  toEulerXYZ(R, e);
  return [e[0], e[1], e[2]];
}

function norm3(x: number, y: number, z: number): [number, number, number] {
  const l = Math.sqrt(x * x + y * y + z * z) || 1;
  return [x / l, y / l, z / l];
}
/**
 * Auf der Zeigefinger-Spitze (Pose point, per FK), Plan 008: die Achse liegt längs des Endglieds, die Nabe sitzt auf der
 * Kuppe — wie ein Kreisel auf dem Finger. Vorher lag die Scheibe flach über dem waagerecht zeigenden Finger und
 * schnitt ihn (−1.4). Das Endglied zeigt in point nach links-oben und von der Kamera weg: die Scheibe steht so fast
 * frontal zur Kamera. Abstand Kuppe → Mitte: Kuppen-Radius + halbe Nabe − Anliegen (Nabe drückt leicht in die Kuppe).
 */
const TIP_FRAME = ((): { pos: V3; rot: V3 } => {
  const j = POSE_JOINTS[POSE.point];
  const a: [number, number, number] = [0, 0, 0];
  const b: [number, number, number] = [0, 0, 0];
  const len = VM_RIG.fingers[0].len[2];
  fingerPoint(j, 0, 2, 0, 0, 0, a);
  fingerPoint(j, 0, 2, 0, len, 0, b);
  const z = norm3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const off = VM_RIG.fingers[0].r * 0.885 * 0.95 + TIP_HUB_HALF * SPINNER_SCALE - TIP_PRESS;
  return { pos: [b[0] + z[0] * off, b[1] + z[1] * off, b[2] + z[2] * off], rot: frameRot(z) };
})();
const TIP_ROT: V3 = TIP_FRAME.rot;
/** Drehung vom Halt am Lager zur Lage auf der Fingerspitze (Achse/Winkel, Ladezeit). */
const HOLD_TO_TIP = relRot(SPINNER_HOLD_ROT, TIP_ROT);
export const SPINNER_TIP_POS: V3 = TIP_FRAME.pos;
/** Würfe als geschlossene Parabeln (Ladezeit): hoch und zurück in den Griff, auf die Fingerspitze, zurück. */
function tossOf(from: V3, to: V3, T: number): Toss {
  const t = new Toss(SPIN_G);
  t.plan(from, to, T, 0, 0);
  return t;
}
const TOSS_UP = tossOf(SPINNER_HOLD_POS, SPINNER_HOLD_POS, AIR_T);
const TOSS_TIP = tossOf(SPINNER_HOLD_POS, SPINNER_TIP_POS, AIR_T);
const HOP_TIP = tossOf(SPINNER_HOLD_POS, SPINNER_TIP_POS, SWAP_HOP);
const HOP_BACK = tossOf(SPINNER_TIP_POS, SPINNER_HOLD_POS, SWAP_HOP);

const P = VM_PARAM.spinner;

/**
 * Finger-Schutz (Plan 008): der Spinner als Kugel-Wolke — Rotor als volle Scheibe (Radius 4.5 = Lappen-Spitzen, Dicke
 * 1.1; er dreht, also zählt die Hülle), Ringe in der Rotor-Ebene, dazu die Nabe (zwei Kugeln auf der Achse). Lokal z ist
 * die Achse (items/spinner). Liegt die Wolke tiefer als in Ruhe in der Hand (Toleranz aus der Ruhelage kalibriert:
 * Daumen und Mittelfinger drücken dort auf die Lager-Kappen), schieben die Finger ihn heraus — Hüpfer, Würfe und
 * Posenwechsel fegten sonst Daumen/Zeigefinger durch den Rotor (−1.3).
 */
const CLOUD_RINGS: readonly (readonly [number, number])[] = [
  [3.94, 28],
  [2.8, 20],
  [1.7, 12],
  [0.6, 6],
];
const CLOUD_R = 0.56;
/** Nabe (Radius 1.25, halbe Länge 0.94 skaliert): je Seite ein Ring aus Kugeln, der sie umschreibt. */
const CLOUD_HUB_Z = 0.4;
const CLOUD_HUB_AT = 0.7;
const CLOUD_HUB_R = 0.55;
const CLOUD_HUB_K = 6;
const CLOUD_N = ((): number => {
  let n = 2 * CLOUD_HUB_K;
  for (const [, k] of CLOUD_RINGS) n += k;
  return n;
})();
/** Hüllkugel der Wolke (Vorab-Test). */
const CLOUD_HULL = 4.55;
const PUSH_BAND = 0.2;
/** Lokale Punkte und Radien der Wolke (Ladezeit). */
const CLOUD = ((): { p: Float64Array; r: Float64Array } => {
  const p = new Float64Array(CLOUD_N * 3);
  const r = new Float64Array(CLOUD_N);
  let n = 0;
  for (const [rad, k] of CLOUD_RINGS) {
    for (let i = 0; i < k; i++) {
      const a = (i / k) * Math.PI * 2;
      p[n * 3] = Math.cos(a) * rad;
      p[n * 3 + 1] = Math.sin(a) * rad;
      r[n] = CLOUD_R;
      n++;
    }
  }
  for (let side = -1; side <= 1; side += 2) {
    for (let i = 0; i < CLOUD_HUB_K; i++) {
      const a = (i / CLOUD_HUB_K) * Math.PI * 2;
      p[n * 3] = Math.cos(a) * CLOUD_HUB_AT;
      p[n * 3 + 1] = Math.sin(a) * CLOUD_HUB_AT;
      p[n * 3 + 2] = side * CLOUD_HUB_Z;
      r[n] = CLOUD_HUB_R;
      n++;
    }
  }
  return { p, r };
})();

export class SpinnerTricks extends PropTricks<SpinnerTrick> {
  /** Drehzahl (rad/s). */
  omega = SPINNER_OMEGA_BASE;
  /** Angezeigter Rotor-Winkel (rad, modulo 2π/3) und Unschärfe 0..1 (Tools/Tests). */
  shownAngle = 0;
  blur = 0;
  private pick = 0;
  private goodCount = 0;
  private milestoneCount = 0;
  private idleCount = 0;
  private bigFlick = false;
  private hubSign = 0;
  private hubT = HUB_TIME;
  /** Balance: Ende des Surfs (Trick-Zeit), −1 = läuft noch. */
  private balOut = -1;
  private precess = 0;
  /** Trick-Zeit beim letzten Präzessions-Schritt (der erste Frame eines Tricks ist τ 0, #77). */
  private precessT = 0;
  /** ω am Frame-Anfang (Trapez für die Präzession). */
  private omegaStart = SPINNER_OMEGA_BASE;
  private readonly fly = new Float64Array(3);
  // Finger-Schutz: Hand-Modell (RopeHandGuard.setJoints: FK ohne Kommazahl-Argumente) aus den gezeigten Gelenken
  // (afterPose-Gelenke + Gelenk-Versatz), Wolke im Handgelenk-Raum dieses Frames.
  private readonly guard = new RopeHandGuard();
  private readonly jj = new Float32Array(VM_JOINT_COUNT);
  private readonly cw = new Float64Array(CLOUD_N * 3);
  private readonly rm = mat3();
  private readonly dq = new Float64Array(3);
  private readonly dc = new Float64Array(3);
  private pushTol = -0.5;

  constructor() {
    super();
    // Toleranz = Anliegen in Ruhe (Griff-Pose, Halt am Lager) − 0.05: in Ruhe schiebt der Schutz nie.
    this.guard.setJoints(POSE_JOINTS[POSE.spin]);
    const o = this.out;
    this.writeRest(o);
    this.cloudAt(o);
    this.dc[0] = o.pos[0];
    this.dc[1] = o.pos[1];
    this.dc[2] = o.pos[2];
    this.pushTol = Math.min(-0.2, this.cloudGap() - 0.05);
  }

  override get trickNames(): readonly string[] {
    return SPINNER_NAMES;
  }

  protected override isState(id: SpinnerTrick): boolean {
    return id === 'balance';
  }

  /** Wolke in der aktuellen Lage o.rot (Skalierung steckt in den Maßen) → cw. */
  private cloudAt(o: PropOut): void {
    const m = fromEulerXYZV(this.rm, o.rot);
    const L = CLOUD.p;
    const W = this.cw;
    for (let i = 0; i < CLOUD_N; i++) {
      const x = L[i * 3];
      const y = L[i * 3 + 1];
      const z = L[i * 3 + 2];
      W[i * 3] = m[0] * x + m[1] * y + m[2] * z;
      W[i * 3 + 1] = m[3] * x + m[4] * y + m[5] * z;
      W[i * 3 + 2] = m[6] * x + m[7] * y + m[8] * z;
    }
  }

  /** Abstand der Wolke (Mitte dc) zur Hand. */
  private cloudGap(): number {
    const hs = this.guard.hand;
    const c = this.dc;
    const q = this.dq;
    hs.measure(c);
    const hull = hs.res[0] - CLOUD_HULL;
    if (hull > 0) return hull;
    const W = this.cw;
    const R = CLOUD.r;
    let m = 1e9;
    for (let i = 0; i < CLOUD_N; i++) {
      q[0] = c[0] + W[i * 3];
      q[1] = c[1] + W[i * 3 + 1];
      q[2] = c[2] + W[i * 3 + 2];
      hs.measure(q);
      const d = hs.res[0] - R[i];
      if (d < m) m = d;
    }
    return m;
  }

  /**
   * Nach dem Überblenden: gezeigte Hand dieses Frames (übergebene Gelenke + Gelenk-Versatz), dann den Spinner aus ihr
   * schieben (stetige Abbildung der Zeitleiste, wie Jo-Jo pushOut). Nicht die eigene Überblendung: die läge mit jedem
   * Posenwechsel auf dem Frame-Raster und die Lage hinge an der Framerate (Proben mit fester Pose: Hand konstant).
   */
  override afterPose(joints: ArrayLike<number>, _inp: PropFrameInput, _dt: number): void {
    const o = this.out;
    const j = this.jj;
    for (let i = 0; i < j.length; i++) j[i] = joints[i] + o.jointAdd[i];
    if (this.motionFx <= 0) return;
    this.guard.setJoints(j);
    this.cloudAt(o);
    const s = o.pos;
    const c = this.dc;
    for (let pass = 0; pass < 2; pass++) {
      c[0] = s[0];
      c[1] = s[1];
      c[2] = s[2];
      const pen = this.pushTol - this.cloudGap();
      if (pen <= 0) return;
      const h = 0.05;
      c[0] = s[0] + h;
      let gx = this.cloudGap();
      c[0] = s[0] - h;
      gx -= this.cloudGap();
      c[0] = s[0];
      c[1] = s[1] + h;
      let gy = this.cloudGap();
      c[1] = s[1] - h;
      gy -= this.cloudGap();
      c[1] = s[1];
      c[2] = s[2] + h;
      let gz = this.cloudGap();
      c[2] = s[2] - h;
      gz -= this.cloudGap();
      const l = Math.sqrt(gx * gx + gy * gy + gz * gz);
      if (!(l > 1e-9)) return;
      const push = pen < PUSH_BAND ? (pen * pen) / (2 * PUSH_BAND) : pen - PUSH_BAND / 2;
      s[0] += (gx / l) * push;
      s[1] += (gy / l) * push;
      s[2] += (gz / l) * push;
    }
  }

  protected resetRun(): void {
    this.omega = SPINNER_OMEGA_BASE;
    this.hubT = HUB_TIME;
    this.hubSign = 0;
    this.balOut = -1;
    this.writeRest(this.out);
  }

  protected override start(id: SpinnerTrick): void {
    super.start(id);
    this.balOut = -1;
    this.bigFlick = false;
    this.precess = 0;
    this.precessT = 0;
  }

  protected writeRest(o: PropOut): void {
    o.pose = POSE.spin;
    o.poseTau = 0.08;
    o.hx = 0;
    o.hy = 0;
    o.hz = 0;
    o.hpitch = 0;
    o.hyaw = 0;
    o.hroll = 0;
    this.place(o, 0);
    o.spin = 0;
    o.visible = 1;
    o.scale = SPINNER_SCALE;
    o.poof = -1;
  }

  /**
   * Halt lösen (w 0..1): Daumen und Mittelfinger heben von den Lager-Kappen ab, bevor der Spinner den Halt verlässt
   * (bzw. bevor er beim Fang ankommt) — sonst glitt der Rotor seitlich über die drückende Daumenkuppe (−1.3).
   */
  private release(o: PropOut, w: number): void {
    o.jointAdd[VM_JOINT.thumbAbd] += REL_TA * w;
    o.jointAdd[VM_JOINT.finger + 5] += REL_M * w;
    o.jointAdd[VM_JOINT.finger + 6] += REL_M * w;
  }

  /** Lage zwischen Pinch (e) und Fingerspitze, Ort aus einem Wurf zur Flugzeit `ft`. */
  private placeFly(o: PropOut, e: number, toss: Toss, ft: number): void {
    this.place(o, e);
    const p = this.fly;
    toss.at(ft, p);
    o.pos[0] = p[0];
    o.pos[1] = p[1];
    o.pos[2] = p[2];
  }

  /** Ort und Lage zwischen Pinch (e = 0) und Fingerspitze (e = 1). */
  private place(o: PropOut, e: number): void {
    const h = SPINNER_HOLD_POS;
    const t = SPINNER_TIP_POS;
    o.pos[0] = h[0] + (t[0] - h[0]) * e;
    o.pos[1] = h[1] + (t[1] - h[1]) * e;
    o.pos[2] = h[2] + (t[2] - h[2]) * e;
    o.rot[0] = SPINNER_HOLD_ROT[0];
    o.rot[1] = SPINNER_HOLD_ROT[1];
    o.rot[2] = SPINNER_HOLD_ROT[2];
    if (e > 0) this.rotateLocal(o, HOLD_TO_TIP[0], HOLD_TO_TIP[1], HOLD_TO_TIP[2], HOLD_TO_TIP[3] * e);
  }


  protected cooldownOf(id: SpinnerTrick): number {
    return COOLDOWN[id];
  }

  /** Schnipp-Impulse kommen bei JEDEM Sprung (auch mitten im Trick) — die Drehzahl ist der Tacho. */
  override onEvent(e: GameEvent): void {
    if (this.motionFx > 0) {
      if (e.type === 'jump') this.addOmega(e.clean && e.gain > 0 ? KICK_PERFECT : KICK_JUMP);
      else if (e.type === 'speedMilestone') this.addOmega(KICK_MILESTONE);
      else if (e.type === 'checkpoint') {
        // Nabe blinkt auch mitten im Trick: grün vor der Bestzeit, rot dahinter, ohne Referenz cyan.
        this.hubSign = e.split === null ? 0 : e.split <= 0 ? 1 : -1;
        this.hubT = 0;
      }
    }
    super.onEvent(e);
  }

  private addOmega(d: number): void {
    this.omega = Math.min(SPINNER_OMEGA_MAX, this.omega + d);
  }

  /**
   * Abwechslung (Review Phase 2: toss machte 45–62 % der Starts — jeder gute Hop im Flow war ein toss): Flow
   * immer im Wechsel toss/swap, Overdrive guter Hop im Wechsel ufo/toss, sonst die Liste reihum.
   */
  protected onJump(tier: number, good: boolean): void {
    if (tier === 0) return;
    const list = SPINNER_TIER_TRICKS[tier];
    if (tier === 3 && good) this.start(this.goodCount++ % 2 === 0 ? 'ufo' : 'toss');
    else this.start(list[this.pick++ % list.length]);
  }

  protected onMilestone(tier: number): void {
    if (tier >= 3) this.start('ufo');
    else if (tier === 2) this.start(this.milestoneCount++ % 2 === 0 ? 'toss' : 'swap');
  }

  protected onIdle(): number {
    this.start(this.idleCount++ % 3 === 2 ? 'swap' : 'flick');
    return 2.6 + 1.8 * this.rand();
  }

  protected override onFinish(): void {
    this.start('ufo');
  }

  protected override onCheckpoint(_split: number | null): void {
    this.start('flick');
    this.bigFlick = true;
  }

  protected override onSurfStart(speed: number): void {
    if (speed >= SURF_FROM) this.start('balance');
  }

  protected override onFree(inp: PropFrameInput, speed: number): void {
    if (inp.surfing && speed >= SURF_FROM) this.start('balance');
  }

  override update(dtRaw: number, inp: PropFrameInput): void {
    const dt = dtRaw - dtRaw === 0 ? clamp(dtRaw, 0, 0.1) : 0;
    const m = clamp(fin(this.motionFx), 0, 1);
    // Drehzahl VOR der Zeitleiste aufs Frame-Ende bringen: die Balance liest sie (Präzession), und
    // Schnipps der Marken kommen danach — am Frame-Ende wie alle Impulse (#77). Umgekehrt lief die
    // Präzession einen Frame hinter ω her (0.085 rad bei 30 Hz gegen 1440 Hz).
    this.omegaStart = this.omega;
    if (dt > 0 && m > 0) {
      const target = SPINNER_OMEGA_BASE + SPINNER_OMEGA_PER_SPEED * Math.max(0, fin(inp.speed));
      const tau = target > this.omega ? TAU_UP : TAU_DOWN;
      this.omega = Math.min(SPINNER_OMEGA_MAX, target + (this.omega - target) * Math.exp(-dt / tau));
    }
    super.update(dtRaw, inp);
    if (dt <= 0) return;
    const o = this.out;
    this.hubT += dt;
    if (m <= 0) {
      // Statisch: der Spinner steht (Winkel bleibt, keine Unschärfe).
      this.omega = 0;
      this.blur = 0;
    } else {
      const step = this.omega * dt;
      this.shownAngle = (this.shownAngle + Math.min(step, SPINNER_STEP_CAP)) % SYM;
      this.blur = clamp((step - BLUR_FROM) / (SPINNER_STEP_CAP * 2 - BLUR_FROM), 0, 1) * BLUR_MAX;
    }
    o.param[P.angle] = this.shownAngle;
    o.param[P.blur] = this.blur;
    const hubOn = this.hubT < HUB_TIME ? (Math.sin((this.hubT / HUB_TIME) * Math.PI * 5) > -0.4 ? 1 : 0.3) * (1 - smooth((this.hubT - HUB_TIME * 0.6) / (HUB_TIME * 0.4))) : 0;
    // Ohne Blinken exakt 0 (nicht −0: Float32Array speichert das Vorzeichen).
    o.param[P.hub] = hubOn > 0 && this.hubSign !== 0 ? this.hubSign * hubOn : 0;
    o.param[3] = 0;
  }

  /** Zeigefinger schnippt einen Lappen an (siehe FLICK_*); Spinner kippt vom Stoß und pendelt sich ein. */
  private flick(t: number, o: PropOut): boolean {
    if (t >= FLICK_TIME) return true;
    const big = this.bigFlick ? 1.4 : 1;
    const ja = o.jointAdd;
    // Beugung gleich, auch beim großen Schnipp (stärker ist der Impuls, nicht das Eintauchen in den Rotor).
    const fm = IDX_MCP.value(t);
    const fp = IDX_PIP.value(t);
    ja[VM_JOINT.finger + 1] += fm * FLICK_FLEX;
    ja[VM_JOINT.finger + 2] += fp * FLICK_FLEX;
    ja[VM_JOINT.finger + 3] += fp * 0.5 * FLICK_FLEX;
    if (this.mark(0, FLICK_HIT, t)) {
      this.addOmega(this.bigFlick ? KICK_FLICK_BIG : KICK_FLICK);
      this.kick(o, 0.1 * big, -0.25 * big);
    }
    // Stoß am Rand: der Rotor kippt um die Bild-Querachse und federt zurück (geschlossen), die Hand gibt kurz nach.
    const hit = t - FLICK_HIT;
    // Nachfedern klingt bis zum Trick-Ende ganz aus (sonst spränge die Lage auf die Ruhe).
    const fade = 1 - smooth((t - 0.25) / (FLICK_TIME - 0.25));
    this.rotateView(o, 1, 0, 0, settle(-4.2 * big, hit, Math.PI * 2 * 4.5, 0.3) * fade * FLICK_WOB);
    this.rotateView(o, 0, 0, 1, settle(1.8 * big, hit, Math.PI * 2 * 3.5, 0.35) * fade * FLICK_WOB);
    o.hroll += settle(0.5 * big, hit, Math.PI * 2 * 3, 0.45) * fade;
    // Der Stoß schiebt das Lager zwischen den Fingerkuppen ein Stück weg (die Kuppen geben nach).
    const push = settle(5 * big, hit, Math.PI * 2 * 5, 0.4) * fade * FLICK_WOB;
    this.offsetView(o, 0.6 * push, -0.4 * push, 0);
    return false;
  }

  /** Finger-Wechsel: kleiner Hüpfer vom Lager auf die Zeigefinger-Spitze, balancieren, Hüpfer zurück. */
  private swap(t: number, o: PropOut): boolean {
    if (t >= SWAP_TIME) return true;
    o.hy += 0.012 * bell(clamp(t / SWAP_UP, 0, 1)) + 0.012 * bell(clamp((t - SWAP_BACK + SWAP_UP) / SWAP_UP, 0, 1));
    // Lösen vor dem Hüpfer (bis er weg ist), Öffnen vor der Landung im Halt, dann schließen.
    this.release(o, smooth(t / SWAP_UP) * (1 - smooth((t - SWAP_UP - 0.08) / 0.08)) + smooth((t - SWAP_BACK - 0.05) / 0.1) * (1 - smooth((t - SWAP_BACK - SWAP_HOP) / 0.08)));
    o.poseTau = 0.06;
    if (t < SWAP_UP) {
      this.place(o, 0);
      o.pose = POSE.spin;
      return false;
    }
    if (this.mark(0, SWAP_UP, t)) this.kick(o, -0.25, 0);
    const up = SWAP_UP + SWAP_HOP;
    if (t < up) {
      const u = (t - SWAP_UP) / SWAP_HOP;
      this.placeFly(o, smooth(u), HOP_TIP, t - SWAP_UP);
      o.pose = u < 0.3 ? POSE.spin : POSE.point;
      return false;
    }
    if (this.mark(1, up, t)) this.kick(o, 0.14, -0.3);
    if (t < SWAP_BACK) {
      // Auf der Spitze: Präzession (Kreisel), nach der Landung stärker, dann ruhiger.
      this.place(o, 1);
      const w = settle(3, t - up, Math.PI * 2 * 3, 0.25) * (1 - smooth((t - SWAP_BACK + 0.15) / 0.15));
      const env = 0.06 * bell((t - up) / (SWAP_BACK - up));
      this.rotateView(o, 1, 0, 0, env * Math.sin(t * 17) + w);
      this.rotateView(o, 0, 0, 1, env * Math.cos(t * 17));
      o.pose = POSE.point;
      return false;
    }
    if (this.mark(2, SWAP_BACK, t)) this.kick(o, -0.22, 0);
    const back = SWAP_BACK + SWAP_HOP;
    if (t < back) {
      const u = (t - SWAP_BACK) / SWAP_HOP;
      this.placeFly(o, 1 - smooth(u), HOP_BACK, t - SWAP_BACK);
      o.pose = u < 0.6 ? POSE.point : POSE.spin;
      return false;
    }
    if (this.mark(3, back, t)) this.kick(o, 0.12, -0.25);
    this.place(o, 0);
    this.rotateView(o, 1, 0, 0, settle(-2.5, t - back, Math.PI * 2 * 4, 0.35) * (1 - smooth((t - back) / (SWAP_TIME - back))));
    o.pose = POSE.spin;
    return false;
  }

  /** Wurf flach drehend hoch (Parabel), Fang wieder im Griff am Lager. */
  private tossTrick(t: number, o: PropOut): boolean {
    o.hy += DIP.value(t);
    // Halt lösen vor dem Abwurf, vor dem Fang öffnen, beim Fang schließen.
    this.release(o, smooth(t / TOSS_WINDUP) * (1 - smooth((t - TOSS_WINDUP - 0.06) / 0.08)) + smooth((t - TOSS_WINDUP - TOSS_AIR + 0.12) / 0.08) * (1 - smooth((t - TOSS_WINDUP - TOSS_AIR) / 0.1)));
    if (t < TOSS_WINDUP) {
      if (this.mark(0, 0, t)) this.kick(o, 0.12, 0);
      return false;
    }
    if (this.mark(1, TOSS_WINDUP, t)) {
      this.kick(o, -0.45, 0);
      this.addOmega(KICK_FLICK);
    }
    const ft = t - TOSS_WINDUP;
    if (ft < TOSS_AIR) {
      const s = ft / TOSS_AIR;
      // Kippt im Flug zur Waagerechten (UFO-Lage), die Hand öffnet sich und greift kurz vor der Landung nach.
      this.placeFly(o, 0, TOSS_UP, ft);
      this.rotateView(o, 1, 0, 0, -1.1 * bell(s));
      o.pose = s < 0.7 ? POSE.open : POSE.spin;
      o.poseTau = 0.05;
      return false;
    }
    if (this.mark(2, TOSS_WINDUP + TOSS_AIR, t)) {
      this.kick(o, 0.32, -0.8);
      this.spinKick(-1.0);
    }
    // Fang: Rotor federt im Griff nach.
    this.rotateView(o, 1, 0, 0, settle(-3, ft - TOSS_AIR, Math.PI * 2 * 4, 0.35) * (1 - smooth((t - TOSS_TOTAL + 0.12) / 0.12)));
    return t >= TOSS_TOTAL;
  }

  /** UFO: hoch wie eine Untertasse (Parabel), Landung auf der Zeigefinger-Spitze, balancieren, zurück in den Griff. */
  private ufo(t: number, o: PropOut): boolean {
    o.hy += DIP.value(t);
    this.release(o, smooth(t / UFO_WINDUP) * (1 - smooth((t - UFO_WINDUP - 0.06) / 0.08)) + smooth((t - UFO_LAND + UFO_BACK - 0.05) / 0.1) * (1 - smooth((t - UFO_LAND) / 0.08)));
    if (t < UFO_WINDUP) {
      if (this.mark(0, 0, t)) this.kick(o, 0.14, 0);
      return false;
    }
    if (this.mark(1, UFO_WINDUP, t)) {
      this.kick(o, -0.6, 0);
      this.addOmega(KICK_FLICK_BIG);
    }
    const ft = t - UFO_WINDUP;
    if (ft < UFO_AIR) {
      const s = ft / UFO_AIR;
      this.placeFly(o, smooth(s), TOSS_TIP, ft);
      this.rotateView(o, 1, 0, 0, -0.5 * bell(s));
      o.pose = s < 0.45 ? POSE.open : POSE.point;
      o.poseTau = 0.06;
      return false;
    }
    if (this.mark(2, UFO_WINDUP + UFO_AIR, t)) {
      this.kick(o, 0.35, -0.9);
      this.spinKick(-1.2);
    }
    const st = ft - UFO_AIR;
    if (st < UFO_SHOW) {
      // Landung: Kreisel wackelt (gedämpft) und präzediert, die Hand balanciert mit.
      this.place(o, 1);
      const w = settle(3.5, st, Math.PI * 2 * 3, 0.22) * (1 - smooth((st - UFO_SHOW + 0.15) / 0.15));
      const env = 0.05 * bell(st / UFO_SHOW);
      this.rotateView(o, 1, 0, 0, w + env * Math.sin(st * 16));
      this.rotateView(o, 0, 0, 1, env * Math.cos(st * 16));
      o.hroll += -0.3 * w;
      o.pose = POSE.point;
      o.poseTau = 0.06;
      return false;
    }
    // Zurück in den Griff als Hüpfer (Parabel; linear geschoben lief der Rotor durch den Zeigefinger).
    const bt = st - UFO_SHOW;
    const b = clamp(bt / UFO_BACK, 0, 1);
    if (b < 1) this.placeFly(o, 1 - smooth(b), HOP_BACK, bt);
    else this.place(o, 0);
    o.pose = b < 0.6 ? POSE.point : POSE.spin;
    o.poseTau = 0.06;
    if (this.mark(3, UFO_LAND, t)) this.kick(o, 0.1, -0.2);
    return t >= UFO_TOTAL;
  }

  protected evaluate(id: SpinnerTrick, t: number, dt: number, inp: PropFrameInput, _m: number, o: PropOut): boolean {
    if (id === 'flick') return this.flick(t, o);
    if (id === 'swap') return this.swap(t, o);
    if (id === 'toss') return this.tossTrick(t, o);
    if (id === 'ufo') return this.ufo(t, o);
    // balance: auf der Fingerspitze, solange gesurft wird.
    if (this.balOut < 0 && !inp.surfing && t >= BAL_MIN) this.balOut = t;
    // Hinauf und zurück als Hüpfer (Parabel, wie Swap) mit gelöstem Daumen — linear geschoben lief der Rotor durch den
    // sich streckenden Zeigefinger (−1.4). e (0 Halt … 1 Spitze) steuert Präzession und Neigung.
    const inU = clamp((t - BAL_UP) / SWAP_HOP, 0, 1);
    const outT = this.balOut < 0 ? -1 : t - this.balOut;
    const outU = clamp(outT / SWAP_HOP, 0, 1);
    const e = smooth(inU) * (1 - smooth(outU));
    if (outT >= 0 && outU < 1) {
      this.placeFly(o, 1 - smooth(outU), HOP_BACK, outT);
      o.pose = outU < 0.6 ? POSE.point : POSE.spin;
    } else if (outT < 0 && inU > 0 && inU < 1) {
      this.placeFly(o, smooth(inU), HOP_TIP, t - BAL_UP);
      o.pose = POSE.point;
    } else {
      this.place(o, e);
      o.pose = e > 0.5 ? POSE.point : POSE.spin;
    }
    o.poseTau = 0.06;
    this.release(o, smooth(t / BAL_UP) * (1 - smooth((t - BAL_UP - 0.08) / 0.08)) + smooth((outT - 0.05) / 0.1) * (1 - smooth((outT - SWAP_HOP) / 0.08)));
    // Präzession: Kreis ∝ 1/ω (langsamer Kreisel wackelt weiter), Neigung folgt der Rampe.
    // Winkel = Integral der Rate über die TRICK-Zeit (erster Frame 0), Trapez über den Frame.
    const w = Math.max(8, this.omega);
    this.precess += (1.5 + 0.01 * (Math.max(8, this.omegaStart) + w)) * Math.max(0, t - this.precessT);
    this.precessT = t;
    const amp = clamp(9 / w, 0.06, 0.35) * e;
    this.rotateView(o, 1, 0, 0, amp * Math.sin(this.precess));
    this.rotateView(o, 0, 0, 1, amp * Math.cos(this.precess) - 0.35 * this.surfLean * e);
    // Einlage (PropTricks.beatU): hüpft von der Fingerspitze wie ein kleines UFO und landet wieder.
    const u = this.beatU;
    if (u < 1) {
      this.offsetView(o, 0.3 * arc(u) * e, BEAT_HOP * arc(u) * e, 0.6 * arc(u) * e);
      this.rotateView(o, 1, 0, 0, -0.5 * bell(u) * e);
    }
    if (this.beatEnd()) this.kick(o, 0.1, -0.25);
    if (this.mark(0, BAL_IN, t)) this.kick(o, 0.1, -0.2);
    return this.balOut >= 0 && t >= this.balOut + BAL_OUT;
  }
}
