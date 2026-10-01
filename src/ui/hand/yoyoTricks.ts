import { VM_JOINT, VM_JOINT_COUNT, VM_RIG, VM_STRING_POINTS } from '../../render/types';
import { arc, bell, clamp, fin, smooth } from './anim';
import { Track } from './curves';
import { fingerPoint, fingerTip, thumbPoint } from './fk';
import { POSE, POSE_JOINTS } from './poses';
import { PropTricks } from './propTricks';
import type { PropFrameInput, PropOut } from './propTricks';
import { VIEW_AXES, fromEulerXYZ, mat3 } from './rot';
import { Rope, RopeDrive, RopeHandGuard } from './rope';
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
 * Plan 008 Schritt 2: Wurf aus dem Handgelenk (Ausholen, Schnipp, die Finger öffnen sich und das Jo-Jo rollt über sie
 * ab; Drehung = abgewickelte Schnur / Achs-Radius, im Schlaf Reibung), Zupfen holt es auf einer kubischen Bézier unten-
 * vorn in die Tasche zwischen Kuppen und Daumen (fester Fangpunkt), die Finger öffnen sich entgegen und schnappen zu.
 * Around the World als gekippte Bahn (rechts hinter der Faust), Pass/Breakaway/Wiege beginnen am Austrittspunkt der
 * Tasche statt im Mittelfinger. Finger-Schutz: Jo-Jo als Kugel-Wolke (pushOut), Schnur-Punkte und -Sehnen aus der Hand
 * (RopeHandGuard.project/projectChords). Hand-Öffnen als zeitexakter Gelenk-Versatz über der festen Griff-Pose
 * (Posenwechsel lägen auf dem Frame-Raster und stießen das Pendel über die Schlaufe je Framerate anders an).
 *
 * Takt (tools/cosmetics/event-probe.ts): Sleeper 0.7 s, Pass 0.5 s (Plan 007 kalibriert).
 * Abwechslung (Review Phase 2: Breakaway war Stufe-2- UND -3-Trick, Meilenstein- und Checkpoint-Trick — 57–60 %
 * aller Starts; mit Pass statt Breakaway überall dominierte Pass mit 46–63 %): Breakaway nur in Stufe 2, dort
 * mit Snap und Pass im Wechsel, Meilenstein Stufe 2 abwechselnd Breakaway/Snap (Meilensteine achten auf die
 * Abklingzeit); Checkpoint vor der Bestzeit = Wiege (die Figur sieht man so auch im Lauf, nicht nur im Ziel),
 * sonst Around und Breakaway im Wechsel.
 */

export const YOYO_TRICKS = ['none', 'sleeper', 'pass', 'snap', 'breakaway', 'around', 'aroundDouble', 'cradle', 'walkDog', 'surfSleeper'] as const;
export type YoyoTrick = Exclude<(typeof YOYO_TRICKS)[number], 'none'>;
const YOYO_NAMES: readonly string[] = YOYO_TRICKS.filter((t) => t !== 'none');

/** Tricks je Tempo-Stufe bei Sprüngen (Tests prüfen genau diese Zuordnung). */
export const YOYO_TIER_TRICKS: readonly (readonly YoyoTrick[])[] = [[], ['snap', 'pass', 'walkDog'], ['breakaway', 'snap', 'pass'], ['around', 'pass']];

/** Schnur voll abgewickelt (Hand-Einheiten, Cartoon-kurz: hängend bleibt das Jo-Jo im Bild). */
export const YOYO_STRING = 9.5;

/** Abklingzeiten: kalibriert mit event-probe (vorher L1 sync 1.0: 52 % Trick-Anteil ohne Surf-Zustände). */
const COOLDOWN: { readonly [K in YoyoTrick]: number } = { sleeper: 1.0, pass: 1.0, snap: 0.9, breakaway: 1.1, around: 1.3, aroundDouble: 1.4, cradle: 1.0, walkDog: 1.0, surfSleeper: 0.5 };

const THROW = 0.25;
/**
 * Plan 008 — Wurf aus dem Handgelenk: bis WIND holt die Hand aus (hebt sich, Handgelenk rollt ein), dann Schnipp nach
 * unten, die Finger öffnen, das Jo-Jo rollt die Schnur ab — beschleunigt (Weg s(τ) = v0·τ + ½·a·τ², normiert), die
 * Drehung folgt dem abgewickelten Weg (Winkel = Weg / Achs-Radius). Am Ende fängt die Schnur es (freies Pendel mit der
 * exakten Geschwindigkeit der Bahn), es schläft mit langsam abklingender Drehzahl.
 */
const WIND = 0.08;
/**
 * Hand beim Wurf: öffnet ab THROW_OPEN (s), schließt nach dem Abwurf in SLEEP_CLOSE s wieder locker — offen hingen die
 * Finger so tief, dass das schlafende Jo-Jo am kleinen Finger anlag (−0.6).
 */
const THROW_OPEN = 0.03;
const SLEEP_CLOSE = 0.3;
const SNAP_CLOSE = 0.08;
const MID_OPEN = 0.3;
/** Offene Hand als Gelenk-Versatz zur Griff-Pose (relaxed − yoyo), Ladezeit. */
const OPEN_DELTA = ((): Float32Array => {
  const d = new Float32Array(VM_JOINT_COUNT);
  const a = POSE_JOINTS[POSE.relaxed];
  const b = POSE_JOINTS[POSE.yoyo];
  for (let i = VM_JOINT.thumbAbd; i < VM_JOINT_COUNT; i++) d[i] = a[i] - b[i];
  // Der Schnur-Finger (Mittelfinger) öffnet nur wenig: die Schlaufe sitzt an ihm, ihre Bewegung stößt das Pendel an
  // (Snap: 30 Hz 3.7 px über der Grenze).
  for (let i = 0; i < 4; i++) d[VM_JOINT.finger + 4 + i] *= MID_OPEN;
  return d;
})();
/**
 * Einflug/Austritt der Tasche (Bildrichtungen ab der Ruhelage): die Ruhelage liegt zwischen gekrümmten Kuppen und
 * Daumen, offen ist die Tasche nur nach unten-vorn (Suche gegen das Hand-Modell). Würfe verlassen sie über diesen
 * Punkt, Rückwege kommen über ihn herein.
 */
const CATCH_VIA_U = -4;
const CATCH_VIA_C = 2.5;
const THROW_FLY = THROW - WIND;
/** Normierter Weg: Anfangsgeschwindigkeit aus dem Schnipp (Anteil), Rest Beschleunigung. */
const THROW_V0 = 0.45;
/** Wirk-Radius der Achse (Einheiten): Drehwinkel = abgewickelte Schnur / Radius. */
const AXLE_R = 1.4;
/** Abklingen der Schlaf-Drehzahl (s) — Reibung in der Achse. */
const SLEEP_TAU = 3.0;
/** Hand beim Wurf: heben (−) und schnippen (+, Bildhöhen); Handgelenk einrollen, dann schnippen (rad). */
const HY_THROW = new Track(
  [
    [0, 0],
    [WIND, -0.02],
    [0.15, 0.022],
    [0.32, 0],
  ],
  { smooth: true },
);
const FLEX_THROW = new Track(
  [
    [0, 0],
    [WIND, -0.3],
    [0.15, 0.26],
    [0.34, 0],
  ],
  { smooth: true },
);
/** Zupfen: die Hand ruckt kurz hoch (Bildhöhen), dann senkt sie sich dem Jo-Jo entgegen. */
const HY_TUG = new Track(
  [
    [0, 0],
    [0.045, -0.024],
    [0.14, 0.006],
    [0.25, 0.004],
    [0.36, 0],
  ],
  { smooth: true },
);
/** Walk the dog (angedeutet, ohne Boden): das Jo-Jo rollt unten nach rechts, die Hand geht mit. */
const WALK = 0.6;
/** Nach links = in Fingerrichtung ("vorwärts"); nach rechts lief die Schnur durch Handfläche und Handgelenk. */
const WALK_R = -4.2;
/** Die Hand geht ein Stück mit (Bildbreiten, − = links). */
const WALK_HX = -0.015;
/** Bahn-Ende des Wurfs nach unten (Versatz vom Anker, Bildrichtungen). */
const THROW_END_R = 0.8;
const THROW_END_U = -YOYO_STRING * 0.96;
const THROW_END_C = 0.6;
const SLEEP = 0.7;
const SNAP_SLEEP = 0.05;
const RETURN = 0.25;
/** Nach dem Fang (s): Takt-Vertrag (cosmetics.test) — Zuschnappen und Nachdrücken klingen darin ganz aus. */
const SETTLE = 0.06;
/** Fang: Finger öffnen sich dem Jo-Jo entgegen (rad, Grund-/Mittelgelenk), schnappen in CATCH_SNAP s zu, drücken nach. */
const CATCH_OPEN_MCP = 0.55;
const CATCH_OPEN_PIP = 0.7;
const CATCH_SNAP = 0.04;
/** Nachdrücken der Finger und Nachgeben des Handgelenks beim Fang (rad, Höhepunkt). */
const CATCH_SQUEEZE = 0.25;
const CATCH_GIVE = 0.12;
/** Übergang Faust → Bahn beim Wurf (s). */
const LAUNCH = 0.1;
const PASS_T = 0.5;
/** Pass: Rückweg ab diesem Anteil der Dauer (Trick-Zeit). */
const PASS_TR = PASS_T * 0.85;
const BREAK_T = 0.6;
const AROUND_W = 0.15;
/** Tempo-Schwankung im Kreis (Anteil): unten schneller, oben langsamer. */
const AROUND_SWAY = 0.22;
const LOOP = 1 / 2;
/** Kreismitte links vom Anker (Einheiten): unten läuft das Jo-Jo so links an Ring-/kleinem Finger vorbei. */
const AROUND_SHIFT = 2.0;
/**
 * Kreis gestaucht (quer, hoch): so bleibt er in der Hülle des Prototyps (KI1: höchster Punkt −0.037,
 * linkester 0.09 Bildhöhen, envelope.ts) — mit 0.78/1.0 lag er bei −0.069 / 0.062.
 */
const AROUND_SQUASH = 0.66;
const AROUND_TALL = 0.82;
/**
 * Plan 008 — gekippte Bahn wie beim echten Around the World (Schwungebene längs des Unterarms): die rechte Hälfte
 * läuft HINTER der Faust durch (die Schnur wickelt über die Hand), die linke kommt zur Kamera. Vorher lag die rechte
 * Hälfte 3.4 vor der Hand — mitten in Handfläche und Daumen (−2.4); davor frei wäre erst ab +12 (Daumen), dahinter
 * ab −7 (Kartierung der Hand mit der Scheibe, fallen.md). Tiefe c = D·s·(2 − |s|), s = sin ph: rechts −D, links +D,
 * C1-glatt durch oben/unten.
 */
const AROUND_DEPTH = 7.5;
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
const CRADLE_LEFT = 4.6;
const CRADLE_HX = 0.03;
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
const BREAK_END_U = -R * BREAK_R;
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
/** Drehung stoppt nach dem Fang in der Hand (s). */
const CATCH_TAU = 0.04;
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

/**
 * Finger-Schutz: das Jo-Jo als Kugel-Wolke (items/yoyo: zwei Hälften, voller Radius 2.6 nahe den Flanken bei |y| ≈ 0.9,
 * Dicke 2.4). Je Flanke (y = ±DISK_Y) ein Rand-Ring (DISK_RIM Kugeln auf Radius DISK_RIM_AT, Radius DISK_RIM_R — reicht
 * zwischen zwei Kugeln bis ~2.5) und ein innerer Ring + Achse für Finger auf der Flanke. Ein Kugel-Ring in der Mitte
 * (y = 0) unterschätzte den Rand an den Flanken um 0.3–0.5 (Mesh-Vergleich).
 */
const DISK_Y = 0.6;
const DISK_RIM = 20;
const DISK_RIM_AT = 2.0;
const DISK_RIM_R = 0.6;
const DISK_IN = 6;
const DISK_IN_AT = 1.0;
const DISK_N = 2 * (DISK_RIM + DISK_IN + 1);
/** Hüllkugel (Vorab-Test: weiter weg = kein Kontakt möglich). */
const DISK_HULL = 2.75;
/**
 * Erlaubtes Anliegen (Einheiten, < 0 = so weit darf die Näherung "eindringen" — in Ruhe liegt das Jo-Jo an den
 * Fingern an, das soll nicht verschoben werden) und weiche Einsatz-Breite.
 */
const PUSH_TOL = -0.12;
const PUSH_BAND = 0.2;

const enum Mode {
  Hand = 0,
  Guided = 1,
  Free = 2,
  Return = 3,
}

/** Puffer als Float64Array: Kommazahlen in JS-Arrays kosten beim Umstellen der Elementart, typed nie. */
type V = Float64Array;

/** Ruhelage in der Faust: zwischen Zeige-/Mittelfinger-Kuppe und Handfläche (FK aus den Gelenken). */
function holdRaw(joints: ArrayLike<number>, out: V, tmp: V): void {
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

/**
 * Plan 008: die Griff-Pose yoyo schließt die Finger enger als run (Finger liegen am Rand an). Die Ruhelage bleibt,
 * wo sie mit run lag (Bild unverändert) — als fester Versatz zur FK der yoyo-Pose, damit das Jo-Jo weiter den
 * Fingern folgt.
 */
const HOLD_SHIFT = ((): Float64Array => {
  const a = new Float64Array(3);
  const b = new Float64Array(3);
  const t = new Float64Array(3);
  holdRaw(POSE_JOINTS[POSE.run], a, t);
  holdRaw(POSE_JOINTS[POSE.yoyo], b, t);
  return Float64Array.of(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
})();

function holdPoint(joints: ArrayLike<number>, out: V, tmp: V): void {
  holdRaw(joints, out, tmp);
  const s = HOLD_SHIFT;
  out[0] += s[0];
  out[1] += s[1];
  out[2] += s[2];
}

/**
 * Austrittspunkt relativ zum Anker der Griff-Pose (Bildrichtungen, Ladezeit): Anfang der geführten Bahnen. Vorher
 * begannen Pass/Breakaway/Wiege AM Anker — mitten im Mittelfinger, das Jo-Jo lief durch Handfläche und Finger (−2.3).
 */
const EXIT = ((): Float64Array => {
  const j = POSE_JOINTS[POSE.yoyo];
  const a = new Float64Array(3);
  const h = new Float64Array(3);
  const t = new Float64Array(3);
  fingerPoint(j, 1, 1, 0, 1.2, 0, a);
  holdPoint(j, h, t);
  const A = VIEW_AXES;
  const d = [h[0] - a[0], h[1] - a[1], h[2] - a[2]];
  const dot = (v: readonly number[]): number => v[0] * d[0] + v[1] * d[1] + v[2] * d[2];
  return Float64Array.of(dot(A.right), dot(A.up) + CATCH_VIA_U, dot(A.cam) + CATCH_VIA_C);
})();
const EXIT_R = EXIT[0];
const EXIT_U = EXIT[1];
const EXIT_C = EXIT[2];
/** Pass: über links unten (frei neben der Faust) weit nach links oben-hinten und zurück (Bézier). */
const PASS_MID_R = -7;
const PASS_MID_U = -6;
const PASS_MID_C = 4;
const PASS_FAR_R = -6;
const PASS_FAR_U = 2.5;
const PASS_FAR_C = -5;
/** Breakaway: Pendel-Ausschlag nach links oben (rad) und Tiefe vor der Hand (unten liegt der kleine Finger dicht). */
const BREAK_A = 0.66 * Math.PI;
const BREAK_C = 3;

/** Abwickel-Strecke des Wurfs (Faust → Bahn-Ende, ungefähr): für Drehwinkel und -rate. */
const THROW_DIST = YOYO_STRING * 0.97;

/** Normierter Abwickel-Weg 0..1 zur Flugzeit τ (0..THROW_FLY): Schnipp-Geschwindigkeit + Beschleunigung. */
function throwS(tau: number): number {
  const x = tau < 0 ? 0 : tau > THROW_FLY ? 1 : tau / THROW_FLY;
  return THROW_V0 * x + (1 - THROW_V0) * x * x;
}

/** Drehrate am Wurf-Ende (rad/s) und Winkel/Rate im Schlaf (geschlossen, Reibung SLEEP_TAU). */
/** Ableitung des normierten Wegs am Wurf-Ende (1/s). */
const THROW_SPEED = (THROW_V0 + 2 * (1 - THROW_V0)) / THROW_FLY;
const THROW_RATE = THROW_SPEED * (THROW_DIST / AXLE_R);
const THROW_ANGLE = THROW_DIST / AXLE_R;
function sleepRate(t: number): number {
  return THROW_RATE * Math.exp(-(t - THROW) / SLEEP_TAU);
}
function sleepAngle(t: number): number {
  return THROW_ANGLE + THROW_RATE * SLEEP_TAU * (1 - Math.exp(-(t - THROW) / SLEEP_TAU));
}

export class YoyoTricks extends PropTricks<YoyoTrick> {
  readonly rope = new Rope({ segments: VM_STRING_POINTS - 1, length: YOYO_STRING, substep: 1 / 240, iterations: 4, endWeight: 0.15 });
  readonly drive = new RopeDrive();
  /** Gezeigte Schnur und das schlafende Jo-Jo aus der Hand geschoben (Plan 008: Schnur nicht durch die Finger). */
  readonly guard = new RopeHandGuard();
  /** Zuletzt übergebene Gelenke (afterPose) — Hand-Modell beim Ziel-Abbruch. */
  private readonly poseJ = new Float32Array(POSE_JOINTS[POSE.yoyo]);
  private readonly jj = new Float32Array(VM_JOINT_COUNT);
  private readonly vel = new Float64Array(3);
  /** Rückweg: Start und Einflug-Punkt (place, Handgelenk-Raum). */
  private readonly retF = new Float64Array(3);
  private readonly retV = new Float64Array(3);
  /**
   * Scheibe des Jo-Jos (Ø 5.2, Dicke 2.3, Achse = lokal y) als Kugeln für den Finger-Schutz: Mitte + 16 auf dem Ring,
   * Versätze im Handgelenk-Raum (Lage YOYO_ROT ist fest, die Drehung um die Achse ändert die Scheibe nicht).
   */
  private readonly disk = new Float64Array(DISK_N * 3);
  private readonly dq = new Float64Array(3);
  private readonly dc = new Float64Array(3);
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
  /** Gezeigte Schnur vor dem Schutz (Wiege: Figur bleibt exakt). */
  private readonly rawS = new Float32Array(VM_STRING_POINTS * 3);
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
    this.guard.cfg[0] = 0.2;
    this.guard.cfg[1] = 2.6;
    // Kugel-Wolke: lokal x/z ist die Ebene (Achse y), aus der festen Lage YOYO_ROT in den Handgelenk-Raum.
    const R = fromEulerXYZ(mat3(), YOYO_ROT[0], YOYO_ROT[1], YOYO_ROT[2]);
    let n = 0;
    for (let side = -1; side <= 1; side += 2) {
      for (let i = 0; i < DISK_RIM + DISK_IN + 1; i++) {
        const rim = i < DISK_RIM;
        const axis = i === DISK_RIM + DISK_IN;
        const ang = rim ? (i / DISK_RIM) * TAU : ((i - DISK_RIM) / DISK_IN) * TAU;
        const rr = axis ? 0 : rim ? DISK_RIM_AT : DISK_IN_AT;
        const lx = Math.cos(ang) * rr;
        const lz = Math.sin(ang) * rr;
        const ly = side * DISK_Y;
        for (let k = 0; k < 3; k++) this.disk[n * 3 + k] = R[k * 3] * lx + R[k * 3 + 1] * ly + R[k * 3 + 2] * lz;
        n++;
      }
    }
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
    const j = POSE_JOINTS[POSE.yoyo];
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
    if (!this.xfFreeStep) {
      // Hand-Modell dieses Frames (feste Pose + Gelenk-Versatz des alten Tricks): genau die Lage, die afterPose ohne
      // Abbruch gezeigt hätte (Schutz pushOut hängt an ihr).
      const j = this.jj;
      for (let i = 0; i < j.length; i++) j[i] = this.poseJ[i] + this.out.jointAdd[i];
      this.guard.setJoints(j);
      if (this.fingersMoved(j)) fingerPoint(j, 1, 1, 0, 1.2, 0, this.anchor);
      this.place(s);
    }
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
    o.pose = POSE.yoyo;
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
    // Sleeper, Sleeper, Wiege, Walk the dog (die Reihenfolge der ersten drei prüft ein Test).
    const k = this.idleCount++ % 4;
    this.start(k === 2 ? 'cradle' : k === 3 ? 'walkDog' : 'sleeper');
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


  /** Hand öffnen (w 0 = Griff, 1 = relaxed) als Gelenk-Versatz. */
  private openHand(o: PropOut, w: number): void {
    const ja = o.jointAdd;
    for (let i = VM_JOINT.thumbAbd; i < VM_JOINT_COUNT; i++) ja[i] += OPEN_DELTA[i] * w;
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
    const tau = t - at;
    const k = clamp(tau / RETURN, 0, 1);
    this.mode = Mode.Return;
    // Klettert die Schnur hoch und wird schneller (Aufwickeln), klatscht mit Schwung in die Handfläche.
    this.retU = k * k * (1.6 - 0.6 * k);
    // Dreht bis zum Fang weiter, in der Hand stoppt es schnell (Reibung an den Fingern).
    // Nach SETTLE fest (Trick-Ende): der Winkel am Ende hängt so nicht an der Framerate.
    const caught = tau > RETURN ? (tau - RETURN < SETTLE ? tau - RETURN : SETTLE) : 0;
    this.spinNow = rate * at + rate * (tau < RETURN ? tau : RETURN) + rate * CATCH_TAU * (1 - Math.exp(-caught / CATCH_TAU));
    // Zupfen (Ruck hoch). Die lockere Faust bleibt (offen lägen die Finger im Rückweg), aber die Finger öffnen sich
    // dem ankommenden Jo-Jo entgegen und schnappen beim Fang zu — das Klatschen in die Hand.
    o.hy += HY_TUG.value(tau);
    o.pose = POSE.yoyo;
    o.poseTau = 0.05;
    const open = tau < RETURN ? smooth((k - 0.35) / 0.45) : 1 - smooth(caught / CATCH_SNAP);
    // Fang: die Finger drücken nach (kurzer Buckel über die Beugung), bis zum Trick-Ende ganz aus.
    const fade = 1 - smooth((caught - SETTLE * 0.5) / (SETTLE * 0.5));
    const cx = caught / (SETTLE * 0.3);
    const sq = CATCH_SQUEEZE * cx * Math.exp(1 - cx) * fade;
    const ja = o.jointAdd;
    for (let f = 0; f < 4; f++) {
      ja[VM_JOINT.finger + f * 4 + 1] += sq - CATCH_OPEN_MCP * open;
      ja[VM_JOINT.finger + f * 4 + 2] += sq * 0.6 - CATCH_OPEN_PIP * open;
    }
    ja[VM_JOINT.wristFlex] -= CATCH_GIVE * cx * Math.exp(1 - cx) * fade;
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
    o.pose = POSE.yoyo;
    o.poseTau = 0.06;
    if (id === 'sleeper' || id === 'snap' || id === 'surfSleeper' || id === 'walkDog') return this.sleeper(id, t, inp, o);
    if (id === 'pass') return this.pass(t, o);
    if (id === 'breakaway') return this.breakaway(t, o);
    if (id === 'around') return this.around(t, 1, o);
    if (id === 'aroundDouble') return this.around(t, 2, o);
    return this.cradle(t, o);
  }

  private pass(t: number, o: PropOut): boolean {
    if (t >= PASS_TR) return this.from(EXIT_R, EXIT_U, EXIT_C).back(PASS_TR).returning(t, SPIN_PASS, o);
    const e = arc(t / PASS_TR);
    const w0 = (1 - e) * (1 - e);
    const w1 = 2 * e * (1 - e);
    const w2 = e * e;
    this.mode = Mode.Guided;
    this.offR = w0 * EXIT_R + w1 * PASS_MID_R + w2 * PASS_FAR_R;
    this.offU = w0 * EXIT_U + w1 * PASS_MID_U + w2 * PASS_FAR_U;
    this.offC = w0 * EXIT_C + w1 * PASS_MID_C + w2 * PASS_FAR_C;
    this.spinNow = SPIN_PASS * t;
    if (this.mark(0, 0, t)) this.kick(o, -0.25, 0);
    return false;
  }

  /**
   * Breakaway (Seitwurf): das Jo-Jo schwingt als Pendel unter der Faust nach links oben aus und zurück nach unten
   * (wie echt — es endet hängend), dann Zupfen. Rechts unter der Hand liegen Handfläche und Handgelenk im Weg (der
   * alte Bogen von rechts unten lief hindurch, −2.0); links ist frei.
   */
  private breakaway(t: number, o: PropOut): boolean {
    if (t >= BREAK_T) return this.from(0, BREAK_END_U, BREAK_C).back(BREAK_T).returning(t, SPIN_BREAK, o);
    const u = t / BREAK_T;
    const a = BREAK_A * Math.sin(Math.PI * u);
    const r = R * BREAK_R;
    const b = bell(u);
    this.mode = Mode.Guided;
    this.offR = -Math.sin(a) * r;
    this.offU = -Math.cos(a) * r;
    this.offC = BREAK_C + 2 * b;
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
      this.offR = -AROUND_SHIFT * smooth(u);
      this.offU = -R * AROUND_TALL * smooth(u);
      this.offC = 0;
      this.spinNow = SPIN_AROUND * t;
      if (this.mark(0, 0, t)) this.kick(o, -0.3, 0);
      return false;
    }
    if (t < AROUND_W + L) {
      // Kreis in der Bildebene um den Anker: von unten nach vorn-links hoch, oben rüber, rechts runter.
      // Schnurphysik angedeutet: unten schnell, oben langsam (Energie: v² = v0² − 2gh) — Phase mit Sinus-Anteil,
      // Anfang und Ende jeder Runde bleiben (Rückweg-Punkt unverändert).
      const ph0 = ((t - AROUND_W) / L) * loops * TAU;
      const ph = ph0 + AROUND_SWAY * Math.sin(ph0);
      const sp = Math.sin(ph);
      // Die Hand kreist mit (eilt voraus) — der Schwung kommt aus dem Handgelenk.
      const hw = smooth((t - AROUND_W) / 0.15) * (1 - smooth((t - AROUND_W - L + 0.15) / 0.15));
      o.hx += 0.009 * Math.cos(ph) * hw;
      o.hy += 0.009 * Math.sin(ph) * hw;
      // Gekippt: rechts hinter der Faust, links zur Kamera (AROUND_DEPTH).
      this.mode = Mode.Guided;
      this.offR = -AROUND_SHIFT - sp * R * AROUND_SQUASH;
      this.offU = -Math.cos(ph) * R * AROUND_TALL;
      this.offC = AROUND_DEPTH * sp * (2 - Math.abs(sp));
      this.spinNow = SPIN_AROUND * t;
      o.hroll = 0.12 * sp;
      o.pose = POSE.yoyo;
      return false;
    }
    return this.from(AROUND_END_R, AROUND_END_U, 0).back(loops === 2 ? AROUND_BACK_2 : AROUND_BACK_1).returning(t, SPIN_AROUND, o);
  }

  /** Cradle ("Rock the Baby"): hängt vor der Hand und wiegt hin und her, die Hand wiegt mit. */
  private cradle(t: number, o: PropOut): boolean {
    if (t >= CRADLE_T) return this.from(EXIT_R, EXIT_U, EXIT_C).back(CRADLE_T).returning(t, SPIN_CRADLE, o);
    const u = t / CRADLE_T;
    const env = smooth(u / 0.15) * (1 - smooth((u - 0.8) / 0.2));
    const wave = Math.sin(TAU * CRADLE_HZ * t);
    const swing = CRADLE_SWING * wave * env;
    this.mode = Mode.Guided;
    // Ein-/Ausblenden zwischen Austrittspunkt und Wiegen-Lage (nicht vom Anker aus, der liegt im Mittelfinger).
    const ex = 1 - env;
    this.offR = Math.sin(swing) * CRADLE_R * env - CRADLE_LEFT * env + EXIT_R * ex;
    this.offU = -Math.cos(swing) * CRADLE_R * env + EXIT_U * ex;
    this.offC = CRADLE_CAM * env + EXIT_C * ex;
    this.spinNow = SPIN_CRADLE * t;
    o.hroll = -0.08 * wave * env;
    // Die Hand rückt mit nach rechts (Bildhöhen): die Wiege liegt links neben der Faust, bleibt so in der Jo-Jo-Hülle.
    o.hx += CRADLE_HX * env;
    this.cradleW = smooth((u - CRADLE_IN) / 0.12) * (1 - smooth((u - CRADLE_OUT) / 0.1));
    if (u > CRADLE_IN * 0.5 && u < CRADLE_OUT + 0.05) o.pose = POSE.cradle;
    o.poseTau = 0.08;
    if (this.mark(0, 0, t)) this.kick(o, -0.2, 0);
    return false;
  }

  /** Wurf nach unten (geführt, aus dem Handgelenk), dann frei hängend schlafen (bzw. Walk the dog), Zupfen und Rückweg. */
  private sleeper(id: YoyoTrick, t: number, inp: PropFrameInput, o: PropOut): boolean {
    // Hand: ausholen und schnippen (in allen Varianten gleich).
    o.hy += HY_THROW.value(t);
    o.jointAdd[VM_JOINT.wristFlex] += FLEX_THROW.value(t);
    // Finger öffnen sich beim Schnipp (das Jo-Jo rollt über sie ab) und schließen im Schlaf wieder locker — als
    // Gelenk-Versatz über der festen Griff-Pose, geschlossen in der Trick-Zeit (ein Posenwechsel läge auf dem Frame-
    // Raster: die Schlaufe am Mittelfinger stieß das Pendel je Framerate anders an, 30 Hz 9 px).
    // Snap (kurzer Schlaf): die Hand muss zum Zupfen zu sein, sonst stehen die hängenden Finger im Rückweg.
    // Walk the dog: die Hand bleibt offen, solange das Jo-Jo rollt (schließend klemmte sie die Schnur), und schließt
    // beim Zurückholen.
    const closeAt = id === 'walkDog' ? THROW + WALK : THROW;
    const closeT = id === 'snap' ? SNAP_CLOSE : id === 'walkDog' ? RETURN : SLEEP_CLOSE;
    this.openHand(o, smooth((t - THROW_OPEN) / 0.06) * (1 - smooth((t - closeAt) / closeT)));
    if (t < THROW) {
      if (t < WIND) {
        // Noch in der Faust: das Jo-Jo geht mit der Hand.
        this.mode = Mode.Hand;
        this.stringOn = false;
        this.spinNow = 0;
        return false;
      }
      const s = throwS(t - WIND);
      this.mode = Mode.Guided;
      this.launch = s;
      this.offR = THROW_END_R;
      this.offU = THROW_END_U;
      this.offC = THROW_END_C;
      this.spinNow = (s * THROW_DIST) / AXLE_R;
      if (this.mark(0, WIND, t)) this.kick(o, -0.3, 0);
      return false;
    }
    this.launch = 1;
    if (id === 'walkDog') return this.walk(t, o);
    const sleepUntil = id === 'snap' ? THROW + SNAP_SLEEP : THROW + SLEEP;
    if (id === 'surfSleeper' && this.surfOut < 0 && !inp.surfing && t >= SURF_MIN) this.surfOut = t;
    const sleeping = id === 'surfSleeper' ? this.surfOut < 0 : t < sleepUntil;
    if (sleeping) {
      this.mode = Mode.Free;
      this.spinNow = sleepAngle(t);
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
    const rate = sleepRate(at);
    const done = this.from(0, 0, 0).returning(t, rate, o);
    // Winkel stetig: bis zum Zupfen der Schlaf-Winkel, danach mit der Rate von dort weiter.
    this.spinNow += sleepAngle(at) - rate * at;
    return done;
  }

  /** Walk the dog: unten angekommen rollt das Jo-Jo nach rechts (kein Boden — nur angedeutet), die Hand geht mit. */
  private walk(t: number, o: PropOut): boolean {
    const end = THROW + WALK;
    const rate = sleepRate(THROW);
    if (t >= end) {
      const r = this.from(THROW_END_R + WALK_R, THROW_END_U, THROW_END_C).back(end).returning(t, rate, o);
      // Die Hand kommt beim Zurückholen wieder zur Mitte.
      o.hx += WALK_HX * (1 - smooth((t - end) / RETURN));
      this.spinNow += sleepAngle(THROW) - rate * THROW;
      return r;
    }
    const u = (t - THROW) / WALK;
    const e = smooth(u);
    this.mode = Mode.Guided;
    this.offR = THROW_END_R + WALK_R * e;
    // Kleine Hüpfer, als rolle es über Boden-Fugen; die Schnur bleibt gespannt.
    this.offU = THROW_END_U + 0.35 * Math.abs(Math.sin(Math.PI * 5 * u)) * (1 - u);
    this.offC = THROW_END_C;
    this.spinNow = sleepAngle(THROW) + rate * (t - THROW);
    o.hx += WALK_HX * e;
    o.hy += 0.022 * bell(u);
    o.hroll -= 0.06 * bell(u);
    return false;
  }

  /**
   * Nach dem Überblenden der Gelenke: Anker per FK aus DIESEN Gelenken, Jo-Jo-Lage aus dem Zeitleisten-Ergebnis,
   * dann die Schnur (fester Unterschritt, RopeDrive).
   * Plan 008: die Ruhelage (Fangpunkt) ist FEST (FK der Griff-Pose, Konstruktor). Folgte sie der FK der aktuellen
   * Finger, lag sie bei offener Hand an den Kuppen — der Fang sprang beim Schließen 5 Einheiten in 1/30 s, und der
   * Wurf zog das Jo-Jo mit den sich öffnenden Fingern durch Ring-/kleinen Finger (−1.2).
   */
  override afterPose(joints: ArrayLike<number>, inp: PropFrameInput, dtRaw: number): void {
    const dt = dtRaw - dtRaw === 0 ? clamp(dtRaw, 0, 0.1) : 0;
    const a = this.anchor;
    const h = this.rest;
    // Gezeigte Hand dieses Frames (Pose wie die ViewHand überblendet + Gelenk-Versatz): Hand-Modell für Schnur und
    // Jo-Jo, Schlaufe am Mittelfinger. FK nur, wenn sich Zeige-/Mittelfinger bewegt haben (in Ruhe meist nicht).
    // Literale statt ANCHOR_LOCAL[i]: Konstanten sind fertige Objekte.
    const jj = this.handJoints(dt, joints);
    if (this.fingersMoved(jj)) fingerPoint(jj, 1, 1, 0, 1.2, 0, a);
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
    if (on) {
      o.string.set(rope.out);
      this.guardString(dt, rope.freeEnd);
    }
  }

  /**
   * Gelenke der gezeigten Hand → jj: übergebene (überblendete) Gelenke + Gelenk-Versatz dieses Frames, Hand-Modell des
   * Schutzes danach. Nicht selbst überblendet: Posenwechsel (Wiege) liegen auf dem Frame-Raster, Schlaufe und Schutz
   * hingen sonst an der Framerate; Proben mit fester Pose bekommen eine konstante Hand. Die übergebenen Gelenke merkt
   * poseJ für den Ziel-Abbruch (onInterrupt).
   */
  private handJoints(_dt: number, joints: ArrayLike<number>): Float32Array {
    const o = this.out;
    const pj = this.poseJ;
    const j = this.jj;
    for (let i = 0; i < j.length; i++) {
      pj[i] = joints[i];
      j[i] = pj[i] + o.jointAdd[i];
    }
    this.guard.setJoints(j);
    return j;
  }

  /**
   * Gezeigte Schnur aus der Hand schieben (Innenpunkte), das schlafende Jo-Jo ebenso — geführt bleibt es auf der Bahn.
   * Hand-Modell aus der selbst überblendeten Pose + Gelenk-Versatz dieses Frames (wie die ViewHand).
   */
  private guardString(_dt: number, free: boolean): void {
    const o = this.out;
    const n = this.rope.n;
    const S = o.string;
    const s = o.sub;
    // Innenpunkte der Schnur aus der Hand; das Jo-Jo selbst schiebt der Scheiben-Schutz (pushOut) — frei wie geführt
    // dieselbe Abbildung, deshalb ohne Einblenden stetig am Wurf-Ende (vorher Kugel-Projektion mit 0.15 s Einblenden:
    // in dieser Zeit lag das gerade gefangene Jo-Jo −0.6 im kleinen Finger).
    if (free && this.motionFx > 0) this.pushOut(s);
    const e = (n - 1) * 3;
    S[e] = s[0];
    S[e + 1] = s[1];
    S[e + 2] = s[2];
    // Wiegen-Figur vor dem Schutz: auch das Dreieck über Daumen und Zeigefinger liegt auf den Fingern, nicht in ihnen.
    if (this.cradleW > 0) this.cradleString();
    const raw = this.rawS;
    raw.set(S);
    this.guard.project(S, n, n - 2);
    // Sehnen nicht während der Wiege: die Figur ist exakt (Daumen-/Zeigefingerspitze, Knoten), Auflegen verschöbe ihre
    // Punkte ungleich; die Punkt-Projektion bewegt gleiche Punkte gleich.
    if (this.cradleW <= 0) this.guard.projectChords(S, n, n - 2, 1);
    else {
      // Die Figur liegt per Entwurf an den Kuppen (Test: an den echten Fingerspitzen): Schutz mit ihrem Gewicht aus.
      const w = this.cradleW;
      for (let i = 0; i < n * 3; i++) S[i] += (raw[i] - S[i]) * w;
    }
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
      // Schnur zur Marke ruhig neu auslegen: ihre Innenpunkte flatterten vom Abwickeln (je Framerate anders).
      rope.reset(rope.out[0], rope.out[1], rope.out[2], e[0], e[1], e[2]);
      // Mit der exakten Geschwindigkeit am Wurf-Ende weiter (Ende der Abwickel-Bahn), nicht der aus Frame-Lagen.
      const h = this.rest;
      const v = this.vel;
      for (let i = 0; i < 3; i++) v[i] = (e[i] - h[i]) * THROW_SPEED;
      // Die Schnur fängt den Fall unelastisch (die Schlaufe auf der Achse dämpft): nur der Anteil quer zur Schnur
      // bleibt — sonst federte die Kette mit 80 u/s zurück, je Framerate verschieden.
      let dx = e[0] - a[0];
      let dy = e[1] - a[1];
      let dz = e[2] - a[2];
      const dl = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      dx /= dl;
      dy /= dl;
      dz /= dl;
      const vr = v[0] * dx + v[1] * dy + v[2] * dz;
      v[0] -= dx * vr;
      v[1] -= dy * vr;
      v[2] -= dz * vr;
      rope.setEndVelocity(v);
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

  /** Abstand der Scheibe (Mitte dc) zur Hand → Rückgabe; Hand-Modell aus guard.hand (handJoints dieses Frames). */
  private diskGap(): number {
    const hs = this.guard.hand;
    const q = this.dq;
    const c = this.dc;
    const D = this.disk;
    // Vorab: Hüllkugel frei → Abstand der Hülle (untere Schranke reicht, es wird dann nicht geschoben).
    hs.measure(c);
    const hull = hs.res[0] - DISK_HULL;
    if (hull > 0) return hull;
    let m = 1e9;
    for (let i = 0; i < DISK_N; i++) {
      q[0] = c[0] + D[i * 3];
      q[1] = c[1] + D[i * 3 + 1];
      q[2] = c[2] + D[i * 3 + 2];
      hs.measure(q);
      const d = hs.res[0] - DISK_RIM_R;
      if (d < m) m = d;
    }
    return m;
  }

  /**
   * Plan 008 — Finger schieben das geführte Jo-Jo: liegt die Scheibe tiefer als PUSH_TOL in der Hand, wird sie entlang
   * des Abstands-Gradienten herausgeschoben (weicher Einsatz, stetig in der Lage — eine Abbildung der Bahn, framerate-
   * unabhängig, weil Hand und Bahn es sind). So rollt das Jo-Jo beim Wurf über die sich öffnenden Finger ab, statt
   * durch sie hindurch; die Bahnen selbst sind um die Hand gelegt, der Schutz fängt nur Zehntel ab.
   */
  private pushOut(s: Float32Array): void {
    const c = this.dc;
    for (let pass = 0; pass < 2; pass++) {
      c[0] = s[0];
      c[1] = s[1];
      c[2] = s[2];
      const d = this.diskGap();
      const pen = PUSH_TOL - d;
      if (pen <= 0) return;
      const hh = 0.05;
      c[0] = s[0] + hh;
      let gx = this.diskGap();
      c[0] = s[0] - hh;
      gx -= this.diskGap();
      c[0] = s[0];
      c[1] = s[1] + hh;
      let gy = this.diskGap();
      c[1] = s[1] - hh;
      gy -= this.diskGap();
      c[1] = s[1];
      c[2] = s[2] + hh;
      let gz = this.diskGap();
      c[2] = s[2] - hh;
      gz -= this.diskGap();
      const l = Math.sqrt(gx * gx + gy * gy + gz * gz);
      if (!(l > 1e-9)) return;
      // Weicher Einsatz: bis PUSH_BAND tief quadratisch, danach voll (stetig differenzierbar).
      const push = pen < PUSH_BAND ? (pen * pen) / (2 * PUSH_BAND) : pen - PUSH_BAND / 2;
      s[0] += (gx / l) * push;
      s[1] += (gy / l) * push;
      s[2] += (gz / l) * push;
    }
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
      // Finger schließen nach dem Fang auf das Jo-Jo: in Ruhe greift der Schutz nicht (Anliegen über PUSH_TOL).
      if (this.motionFx > 0) this.pushOut(s);
    } else if (this.mode === Mode.Free) return;
    else {
      const F = this.retF;
      const W = this.retV;
      for (let k = 0; k < 3; k++) {
        const path = a[k] + A.right[k] * this.offR + A.up[k] * this.offU + A.cam[k] * this.offC;
        // Abwurf aus der Tasche nach unten-vorn (Bézier über den Austrittspunkt), dann auf die Bahn.
        const l = this.launch;
        const via = h[k] + A.up[k] * CATCH_VIA_U + A.cam[k] * CATCH_VIA_C;
        const guided = (1 - l) * (1 - l) * h[k] + 2 * l * (1 - l) * via + l * l * path;
        s[k] = guided;
        F[k] = this.retFromFree ? this.fromAbs[k] : guided;
        W[k] = via;
      }
      if (this.mode === Mode.Return) {
        // Kubische Bézier: erst unten auf die Tiefe des Einflug-Punkts nach vorn (P1), dann über ihn hoch in die Tasche —
        // die ist nur nach unten-vorn offen. Direkt (oder quadratisch) lief das Jo-Jo durch Faust und Kuppen (−2.3; Snap:
        // das Pendel schwang beim Zupfen noch hinter der Hand, der Schutz zitterte 3 Einheiten je Frame).
        const c = A.cam;
        const depth = Math.max(0, c[0] * (W[0] - F[0]) + c[1] * (W[1] - F[1]) + c[2] * (W[2] - F[2]));
        const u = this.retU;
        const v = 1 - u;
        for (let k = 0; k < 3; k++) s[k] = v * v * v * F[k] + 3 * u * v * v * (F[k] + c[k] * depth) + 3 * u * u * v * W[k] + u * u * u * h[k];
      }
      this.pushOut(s);
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
