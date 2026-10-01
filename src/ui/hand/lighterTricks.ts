import type { GameEvent } from '../../engine/events';
import { VM_JOINT, VM_PARAM } from '../../render/types';
import { clamp, fin, smooth } from './anim';
import type { TossTrackSet } from './canTricks';
import { CAN_HOLD_ROT, GripTricks, TossRig, fingerKey, poseDelta, settleIn } from './canTricks';
import { Track, cubicIn, cubicInOut, quadIn, quadOut, sineInOut } from './curves';
import type { Key } from './curves';
import { POSE } from './poses';
import type { PropFrameInput, PropOut } from './propTricks';
import { Overlap } from './secondary';

/**
 * Sturmfeuerzeug (Plan 007 KI2, Animation Plan 008 Schritt 2), Zippo-artig ohne Marke: breite Seite flach an der
 * Handfläche, Daumen am Deckel. Der Fahrtwind pustet die Flamme aus.
 *
 * Mechanik aus der Hand (jointAdd auf der Griff-Pose `lighter`, Daumen-Schlüssel per IK gegen das Griff-Modell):
 * - Aufschnippen: der Daumen legt sich an die freie Deckelecke, drückt sie hoch, schnippt ab — der Deckel fliegt
 *   allein weiter, schlägt an den Anschlag und federt zurück (Überschwinger, Klick-Ruck an die Hand).
 * - Reibrad: Daumen auf das Rad, rollt es nach vorn-unten ab (das Rad dreht im Takt des Daumens), Funken, Flamme.
 * - Zuklappen: Handgelenk-Schnipp — erst spannt es zurück (der Deckel hinkt nach), dann schnellt es vor und der
 *   Deckel schlägt aus Trägheit zu (prallt kurz ab).
 * - Tricks bei Tempo: Spin um die Hochachse (kleiner Wurf, zwei Umdrehungen um die Längsachse), Wurf mit Überschlag,
 *   der Deckel springt im Flug auf, Fang mit Flamme.
 *
 * Flamme (läuft unabhängig von den Tricks, framerate-unabhängig über Alter statt Summen):
 * - Windneigung = clamp(Tempo/900)·(1 + 0.3·surfSide) plus Nachlauf der Hand-Bewegung (Overlap: die Flamme hinkt
 *   der Hand hinterher), mit dem Tempo kürzer,
 * - ≥ 950 u/s für 0.4 s → ausgeblasen (grauer Rauch),
 * - im nächsten ruhigen Moment (< 300 u/s am Boden) zündet sie wieder: das Rad dreht nach 0.65 s,
 *   die Flamme steht nach 0.8 s,
 * - Deckel zu löscht sie.
 * Auslöser: Stand flickOpen → strike, später twirl / snapClose; Lauf lidFlick / strike; Flow twirl / lidFlick;
 * Overdrive/guter Hop tossOpen; Surf ≥ 500 = Zustand surfFlame; Checkpoint strike / twirl mit Aufflackern; Ziel finale.
 */

export const LIGHTER_TRICKS = ['none', 'flickOpen', 'strike', 'snapClose', 'lidFlick', 'twirl', 'tossOpen', 'finale', 'surfFlame'] as const;
export type LighterTrick = Exclude<(typeof LIGHTER_TRICKS)[number], 'none'>;
const LIGHTER_NAMES: readonly string[] = LIGHTER_TRICKS.filter((t) => t !== 'none');

/**
 * Tricks je Tempo-Stufe bei Sprüngen (Tests prüfen genau diese Zuordnung). Lauf lidFlick / strike (Rad, Funken,
 * Aufflackern): mit lidFlick allein machte er bei der 1.5°-Hand 56 % der Starts (Review Phase 2).
 */
export const LIGHTER_TIER_TRICKS: readonly (readonly LighterTrick[])[] = [[], ['lidFlick', 'strike'], ['twirl', 'lidFlick'], ['tossOpen', 'twirl']];

/**
 * Plan 008 (Griff-Audit): breite Seite flach an der Handfläche, Deckel über dem Zeigefinger, wo der Daumen ihn
 * aufschnippt. Vorher steckte der Daumen 1.15 cm und der Mittelfinger 1.4 cm im Feuerzeug.
 */
export const LIGHTER_HOLD_POS: readonly [number, number, number] = [-4.1, 7.9, -3.6];
export const LIGHTER_SCALE = 1.3;

/** Flammen-Regeln (Tests prüfen genau diese). */
export const BLOW_SPEED = 950;
export const BLOW_TIME = 0.4;
export const CALM_SPEED = 300;
export const RELIGHT_TIME = 0.8;
/** Zündung im strike: Funken, dann Flamme (Trick-Zeit ab dem Rad). */
const SPARK_AT = 0.1;
const IGNITE_AT = 0.15;
/** Das Rad dreht so früh, dass die Flamme nach RELIGHT_TIME Ruhe steht. */
const RELIGHT_START = RELIGHT_TIME - IGNITE_AT;
const WIND_FULL = 900;
/** Nachlauf der Flamme hinter der Hand: Bildhöhen Versatz → Neigung. */
const WIND_LAG = 22;
const GROW = 0.12;
const FLARE_TIME = 0.3;
const FLARE = 0.6;
/** Rauch-Dauer: endet nicht auf einem gemeinsamen Frame-Raster (0.4 + 0.587 s), sonst kippt der Frame-Vergleich. */
const SMOKE_TIME = 0.587;
const SPARK_TIME = 0.35;
const SURF_FROM = 500;
const SURF_MIN = 0.5;

/**
 * Abklingzeiten (event-probe). tossOpen 1.3 → 1.6: seit das Ziel-Finale immer kommt (Review Phase 2, vorher fiel
 * es mitten im Trick weg), lag L1 sync 1.0 bei 33.4 Tricks/min (Band 20–32); danach 27.8.
 */
const COOLDOWN: { readonly [K in LighterTrick]: number } = { flickOpen: 0.3, strike: 0.5, snapClose: 0.5, lidFlick: 1.1, twirl: 1.1, tossOpen: 1.6, finale: 0.5, surfFlame: 0.5 };
const FLICK_T = 0.35;
const CLOSE_T = 0.3;
/** Deckel schlägt zu (Trick-Zeit im Schnipp): ab hier zu, Flamme aus. */
const CLOSE_AT = 0.2;
const LIDFLICK_T = 0.5;
/** Rad-Dreh im strike (s): 0.32 → 0.44, seit er auch im Lauf kommt — kurz gerieben lag L2 sync 1.0 bei 24 % (Band ≥ 25). */
const STRIKE_T = 0.44;
const STRIKE_OPEN = 0.12;
const FINALE_T = 2.0;
const TAU = Math.PI * 2;

const P = VM_PARAM.lighter;
const JA = VM_JOINT;

// ---------------------------------------------------------------- Daumen-Schlüssel (IK gegen das Griff-Modell)

/** Daumen [Abspreizen, Opposition, Grund, End] relativ zur Pose lighter. */
const T_REST = fingerKey(4, [0, 0, 0, 0]);
/** an der freien Deckelecke (unter ihr, vorn) */
const T_LOAD = fingerKey(4, [-0.342, 0.175, -0.332, -0.103]);
/** Ecke ~35° hochgedrückt */
const T_PUSH = fingerKey(4, [0.3, 0.2, -0.3, -0.1]);
/** abgeschnippt, Daumen schwingt nach */
const T_FOLLOW = fingerKey(4, [0.422, 0.135, -0.186, 0.101]);
/** oben auf dem Reibrad / nach vorn-unten abgerollt */
const T_WHEEL = fingerKey(4, [0.592, 0.135, 0.015, 0.899]);
const T_ROLLED = fingerKey(4, [0.11, -0.021, -0.681, 1.717]);

const FLICK_KEYS: readonly Float32Array[] = [T_REST, T_LOAD, T_PUSH, T_FOLLOW];
const WHEEL_KEYS: readonly Float32Array[] = [T_REST, T_WHEEL, T_ROLLED];
/** Strike mit geschlossenem Deckel: erst aufschnippen, dann direkt aufs Rad. */
const OPEN_WHEEL_KEYS: readonly Float32Array[] = [T_REST, T_LOAD, T_PUSH, T_WHEEL, T_ROLLED];

/** Aufschnippen: Daumen-Phase (FLICK_KEYS) und Deckel. Klick bei FLICK_CLICK. */
const FLICK_THUMB = new Track([
  [0, 0, sineInOut],
  [0.05, 1, quadIn],
  [0.1, 2, quadOut],
  [0.15, 3, sineInOut],
  [0.21, 3, cubicInOut],
  [FLICK_T, 0],
]);
const FLICK_LID = new Track([
  [0, 0],
  [0.05, 0, quadIn],
  [0.1, 0.2, quadOut],
  [0.165, 1.08, quadOut],
  [0.2, 0.95, sineInOut],
  [0.25, 1.02, sineInOut],
  [0.3, 1],
]);
const FLICK_CLICK = 0.165;

/** Zuklappen per Handgelenk-Schnipp: Drehen (Unterarm), Beugen, Deckel hinkt nach und schlägt zu. */
const SNAP_TWIST = new Track([
  [0, 0, sineInOut],
  [0.08, -0.2, cubicIn],
  [0.15, 0.3, quadOut],
  [CLOSE_T, 0, sineInOut],
]);
const SNAP_FLEX = new Track([
  [0, 0, sineInOut],
  [0.08, 0.1, cubicIn],
  [0.15, -0.16, quadOut],
  [CLOSE_T, 0, sineInOut],
]);
const SNAP_LID = new Track([
  [0, 1, sineInOut],
  [0.09, 1.05, cubicIn],
  [CLOSE_AT, 0, quadOut],
  [0.23, 0.05, quadIn],
  [0.26, 0],
]);

/** Reibrad (Zeit ab dem Rad): Daumen-Phase (WHEEL_KEYS), Rad-Drehung. */
const WHEEL_THUMB = new Track([
  [0, 0, sineInOut],
  [0.05, 1, quadIn],
  [0.13, 2, quadOut],
  [0.2, 2, sineInOut],
  [0.36, 0],
]);
const WHEEL_TURN = new Track([
  [0, 0],
  [0.05, 0, quadIn],
  [0.13, 1, quadOut],
  [0.2, 1.08],
]);
/** Strike mit geschlossenem Deckel (Zeit ab Trick-Start): OPEN_WHEEL_KEYS, Deckel schnippt in STRIKE_OPEN auf. */
const OPEN_THUMB = new Track([
  [0, 0, sineInOut],
  [0.04, 1, quadIn],
  [0.08, 2, quadOut],
  [STRIKE_OPEN + 0.05, 3, quadIn],
  [STRIKE_OPEN + 0.13, 4, quadOut],
  [STRIKE_OPEN + 0.2, 4, sineInOut],
  [STRIKE_OPEN + 0.36, 0],
]);
const OPEN_LID = new Track([
  [0, 0],
  [0.04, 0, quadIn],
  [0.08, 0.2, quadOut],
  [STRIKE_OPEN, 1.06, quadOut],
  [STRIKE_OPEN + 0.04, 0.97, sineInOut],
  [STRIKE_OPEN + 0.09, 1],
]);

/**
 * Finger öffnen sich zum Wurf (Pose lighter → open); der Daumen nicht (THUMB_AWAY) — in der offenen Pose stand er
 * senkrecht in der Flugbahn, in der Griff-Pose lag er davor.
 */
const OPEN_D = ((): Float32Array => {
  const d = poseDelta(POSE.lighter, POSE.open);
  for (let i = JA.thumbAbd; i <= JA.thumbIp; i++) d[i] = 0;
  return d;
})();
/** Daumen klappt nach oben weg (wie nach dem Aufschnippen). */
const THUMB_AWAY = fingerKey(4, [0.9, 0, -0.4, 0]);

interface LTossSpec {
  readonly rel: number;
  readonly air: number;
  readonly apex: number;
  readonly turns: number;
  readonly spins: number;
  readonly total: number;
  readonly kick: number;
  /** Anteil "von der Handfläche weg" (PropFlight.setAway): der Spin um die Längsachse schwingt die breite Seite in die Hand. */
  readonly away: number;
}
const TWIRL: LTossSpec = { rel: 0.12, air: 0.4, apex: 7.5, turns: 0, spins: -2, total: 0.72, kick: 0.22, away: 0.6 };
const TOSS: LTossSpec = { rel: 0.13, air: 0.5, apex: 8, turns: 1, spins: 0, total: 0.9, kick: 0.36, away: 0.55 };

function lTracks(s: LTossSpec): TossTrackSet {
  const r = s.rel;
  const c = s.rel + s.air;
  const big = s.apex / 8;
  const hy: Key[] = [
    [0, 0, sineInOut],
    [r - 0.07, 0.012 + 0.008 * big, quadIn],
    [r, -0.018 - 0.008 * big, quadOut],
    [r + 0.14, -0.003, sineInOut],
    [c - 0.08, -0.01, sineInOut],
    [c, -0.006, sineInOut],
    [c + 0.25, 0],
  ];
  const hx: Key[] = [
    [0, 0, sineInOut],
    [r, 0.02 * big, sineInOut],
    [c, 0.045 * big, sineInOut],
    [c + 0.1, 0.045 * big, cubicInOut],
    [s.total - 0.02, 0],
  ];
  const flex: Key[] = [
    [0, 0, sineInOut],
    [r - 0.07, 0.24, quadIn],
    [r, -0.22, quadOut],
    [r + 0.15, -0.04, sineInOut],
    [c, -0.03, sineInOut],
    [c + 0.28, 0],
  ];
  const open: Key[] = [
    [0, 0, sineInOut],
    [r - 0.04, 0, quadIn],
    [r + 0.025, 0.7, quadOut],
    [r + 0.09, 0.85, sineInOut],
    [c - 0.1, 0.75, sineInOut],
    [c - 0.02, 0.5, quadIn],
    [c + 0.04, 0, quadOut],
    [c + 0.2, 0],
  ];
  const thumb: Key[] = [
    [0, 0, sineInOut],
    [r - 0.04, 0, quadIn],
    [r + 0.03, 1, sineInOut],
    [c + 0.01, 1, sineInOut],
    [c + 0.14, 0],
  ];
  return { hy: new Track(hy), hx: new Track(hx), flex: new Track(flex), open: new Track(open), thumb: new Track(thumb) };
}
function lRig(s: LTossSpec): TossRig {
  const k = s.kick / 0.3;
  return new TossRig(s.rel, s.air, s.total, s.apex, s.turns, s.away, lTracks(s), { hy: 0.45 * k, flex: 2.6 * k, fingers: 1.2, carry: 0.05, omega: TAU * 3.4, zeta: 0.42 });
}
const TWIRL_RIG = lRig(TWIRL);
const TOSS_RIG = lRig(TOSS);
/** Deckel springt im Wurf auf (Flugzeit-Anteil). */
const TOSS_LID = new Track([
  [0, 0],
  [0.32, 0, quadIn],
  [0.5, 1.07, quadOut],
  [0.6, 0.96, sineInOut],
  [0.7, 1],
]);

/** 0..1 mit quadratischen Rampen der Längen a (Anfang) und b (Ende), dazwischen linear (C1). */
function ramp2(u: number, a: number, b: number): number {
  const x = u < 0 ? 0 : u > 1 ? 1 : u;
  const k = 1 / (1 - a / 2 - b / 2);
  if (x < a) return (k * x * x) / (2 * a);
  if (x > 1 - b) return 1 - (k * (1 - x) * (1 - x)) / (2 * b);
  return k * (x - a / 2);
}

const RAMP_IN = 0.3;
const RAMP_OUT = 0.5;

export class LighterTricks extends GripTricks<LighterTrick> {
  /** Deckel offen / Flamme brennt (Zustand bis Respawn). */
  lidOpen = false;
  lit = false;
  private pick = 0;
  private idleCount = 0;
  private cpCount = 0;
  /** Zeit ≥ BLOW_SPEED mit Flamme, Ruhe am Boden (s). */
  private windT = 0;
  private calmT = 0;
  /** Alter von Flamme, Aufflackern, Rauch, Funken (s; groß = vorbei). */
  private flameAge = 0;
  private flareAge = 9;
  private smokeAge = 9;
  private sparkAge = 9;
  /** In DIESEM Frame gesetzt (Alter schon exakt ab der Marke): nicht noch einmal dt addieren. */
  private stamped = 0;
  private lidFrom = 0;
  /** Rad-Winkel (rad): Stand vor dem laufenden strike und aktueller Wert. */
  private wheelBase = 0;
  private wheel = 0;
  private surfSide = 0;
  private surfOut = -1;
  private tossLight = false;
  /** Zustandswechsel dieses Tricks schon passiert (über die Zeit, nicht über Marken — gilt auch festgehalten in Tools). */
  private didSpark = false;
  private didIgnite = false;
  private planned = false;
  /** surfFlame: beim Start war die Flamme aus → zünden (strike bis zu seinem Ende). */
  private stateStrike = false;
  /** Flamme hinkt der Hand nach (Bildhöhen), ergibt den Bewegungs-Anteil der Windneigung. */
  private readonly lagX = new Overlap(Math.PI * 2 * 2.2, 0.55, WIND_LAG);
  private readonly lagY = new Overlap(Math.PI * 2 * 2.2, 0.55, WIND_LAG * 0.5);

  constructor() {
    super();
    this.flight.setHold(LIGHTER_HOLD_POS, CAN_HOLD_ROT);
  }

  override get trickNames(): readonly string[] {
    return LIGHTER_NAMES;
  }

  protected override isState(id: LighterTrick): boolean {
    return id === 'surfFlame';
  }

  protected resetRun(): void {
    this.lidOpen = false;
    this.lit = false;
    this.windT = 0;
    this.calmT = 0;
    this.flameAge = 0;
    this.flareAge = 9;
    this.smokeAge = 9;
    this.sparkAge = 9;
    this.stamped = 0;
    this.lagX.reset(0);
    this.lagY.reset(0);
    this.writeRest(this.out);
  }

  protected override start(id: LighterTrick): void {
    super.start(id);
    this.lidFrom = this.lidOpen ? 1 : 0;
    this.surfOut = -1;
    this.didSpark = false;
    this.didIgnite = false;
    this.planned = false;
    this.wheelBase = this.wheel;
    this.stateStrike = !this.lit;
  }

  protected writeRest(o: PropOut): void {
    o.pose = POSE.lighter;
    o.poseTau = 0.08;
    o.hx = 0;
    o.hy = 0;
    o.hz = 0;
    o.hpitch = 0;
    o.hyaw = 0;
    o.hroll = 0;
    o.pos[0] = LIGHTER_HOLD_POS[0];
    o.pos[1] = LIGHTER_HOLD_POS[1];
    o.pos[2] = LIGHTER_HOLD_POS[2];
    o.rot[0] = CAN_HOLD_ROT[0];
    o.rot[1] = CAN_HOLD_ROT[1];
    o.rot[2] = CAN_HOLD_ROT[2];
    o.spin = 0;
    o.visible = 1;
    o.scale = LIGHTER_SCALE;
    o.param[P.lid] = this.lidOpen ? 1 : 0;
    o.param[P.wheel] = this.wheel;
  }

  protected cooldownOf(id: LighterTrick): number {
    return COOLDOWN[id];
  }

  protected onJump(tier: number, good: boolean): void {
    if (tier === 0) return;
    const list = LIGHTER_TIER_TRICKS[tier];
    if (tier === 3 && good) this.start('tossOpen');
    else this.start(list[this.pick++ % list.length]);
  }

  protected onMilestone(tier: number): void {
    // Meilensteine achten auf die Abklingzeit (event-probe: L1 sync 1.0 sonst 35 Tricks/min, Grenze 32).
    if (this.now < this.cooldownUntil) return;
    if (tier >= 3) this.start('tossOpen');
    else if (tier === 2) this.start('twirl');
  }

  protected onIdle(): number {
    if (!this.lidOpen) this.start('flickOpen');
    else if (this.lit) this.start(this.idleCount++ % 2 === 0 ? 'twirl' : 'snapClose');
    else this.start('strike');
    return 3 + 2 * this.rand();
  }

  protected override onFinish(): void {
    this.start('finale');
  }

  /**
   * Checkpoint: Aufflackern kommt ohnehin (onEvent); dazu strike und twirl im Wechsel — nur strike machte auf L2
   * seit dem Lauf-strike die Hälfte aller Starts. Ist sie aus, zündet der strike sie wieder.
   */
  protected override onCheckpoint(_split: number | null): void {
    this.start(this.lit && this.cpCount++ % 2 === 1 ? 'twirl' : 'strike');
  }

  protected override onSurfStart(speed: number): void {
    if (speed >= SURF_FROM) this.start('surfFlame');
  }

  protected override onFree(inp: PropFrameInput, speed: number): void {
    if (inp.surfing && speed >= SURF_FROM) this.start('surfFlame');
    // Wieder zünden: offen, aus, ruhig am Boden — das Rad dreht so, dass die Flamme nach RELIGHT_TIME steht.
    // Start rückdatiert auf den Moment, in dem die Ruhe RELIGHT_START erreichte (sonst bis 1 Frame spät).
    else if (this.lidOpen && !this.lit && this.calmT >= RELIGHT_START) {
      this.start('strike');
      this.t = this.calmT - RELIGHT_START;
    }
  }

  override onEvent(e: GameEvent): void {
    // Checkpoint lässt die Flamme auch mitten im Trick aufflackern.
    if (e.type === 'checkpoint' && this.lit && this.motionFx > 0) this.flareAge = 0;
    super.onEvent(e);
  }

  override update(dtRaw: number, inp: PropFrameInput): void {
    const dt = dtRaw - dtRaw === 0 ? clamp(dtRaw, 0, 0.1) : 0;
    const speed = Math.max(0, fin(inp.speed));
    // Ruhe vor den Tricks zählen (onFree liest sie): ruhig = am Boden, kein Surf, < 300 u/s.
    if (dt > 0) this.calmT = inp.onGround && !inp.surfing && speed < CALM_SPEED ? this.calmT + dt : 0;
    this.surfSide = clamp(fin(inp.surfSide ?? 0), -1, 1);
    this.stamped = 0;
    super.update(dtRaw, inp);
    if (dt <= 0) return;
    this.stepFlame(dt, speed);
    // Nachlauf der Flamme hinter der Hand (Follower exakt für ein im Frame linear laufendes Ziel → framerate-unabhängig).
    this.lagX.step(clamp(fin(inp.handX ?? 0), -1, 1), dt);
    this.lagY.step(clamp(fin(inp.handY ?? 0), -1, 1), dt);
    this.writeFlame(speed);
  }

  /** Alter und Ausblasen (nach der Zeitleiste; Marken dieses Frames setzen ihr Alter exakt). */
  private stepFlame(dt: number, speed: number): void {
    const f = this.stamped;
    if ((f & 1) === 0) this.flameAge += dt;
    if ((f & 2) === 0) this.flareAge += dt;
    if ((f & 4) === 0) this.sparkAge += dt;
    this.smokeAge += dt;
    if (this.lit && speed >= BLOW_SPEED && this.motionFx > 0) {
      this.windT += dt;
      if (this.windT >= BLOW_TIME) {
        // Ausgeblasen — Rauch ab dem genauen Zeitpunkt.
        this.lit = false;
        this.smokeAge = this.windT - BLOW_TIME;
        this.windT = 0;
      }
    } else this.windT = 0;
  }

  private writeFlame(speed: number): void {
    const o = this.out;
    const m = this.motionFx > 0;
    // Fahrtwind (nach hinten = im Bild nach rechts unten, siehe items/lighter) plus Nachlauf der Hand: bewegt sie sich
    // nach rechts, hinkt die Flamme nach links (Overlap negativ) und umgekehrt; nach unten → Flamme streckt sich.
    const wind = clamp(speed / WIND_FULL, 0, 1) * (1 + 0.3 * this.surfSide) + this.lagX.value - 0.4 * this.lagY.value;
    o.param[P.wind] = m ? clamp(wind, -1, 1) : 0;
    let flame = 0;
    const lid = o.param[P.lid];
    if (this.lit && lid > 0.45) {
      const flare = this.flareAge < FLARE_TIME ? 1 + FLARE * (1 - this.flareAge / FLARE_TIME) : 1;
      // Der Deckel verdeckt die Flamme stetig (0.45 … 0.65 offen), statt sie an einer Schwelle abzuschalten: der
      // Deckel-Klack der Surf-Einlage schließt und öffnet ihn, eine harte Schwelle hinge an der Framerate.
      flame = smooth(this.flameAge / GROW) * (1 - 0.45 * clamp(speed / BLOW_SPEED, 0, 1)) * flare * smooth((lid - 0.45) / 0.2);
    } else if (!this.lit && this.smokeAge < SMOKE_TIME) flame = -1;
    o.param[P.flame] = flame;
    o.param[P.wheel] = this.wheel;
    if (this.sparkAge < SPARK_TIME) o.poof = this.sparkAge / SPARK_TIME;
    else if (flame < 0) o.poof = this.smokeAge / SMOKE_TIME;
    else o.poof = -1;
  }

  /** Zünden zur Trick-Zeit `at` (Marke): Flamme und Aufflackern ab genau dort. */
  private ignite(t: number, at: number): void {
    this.lit = true;
    this.lidOpen = true;
    this.flameAge = t - at;
    this.flareAge = t - at;
    this.windT = 0;
    this.stamped |= 3;
  }

  private sparkAt(t: number, at: number): void {
    this.sparkAge = t - at;
    this.stamped |= 4;
  }

  protected evaluate(id: LighterTrick, t: number, _dt: number, inp: PropFrameInput, m: number, o: PropOut): boolean {
    let done: boolean;
    if (id === 'flickOpen') done = this.flickOpen(t, o);
    else if (id === 'snapClose') done = this.snapClose(t, o);
    else if (id === 'strike') done = this.strike(t, 0, o);
    else if (id === 'lidFlick') done = this.lidFlick(t, o);
    else if (id === 'twirl') done = this.toss(t, TWIRL, TWIRL_RIG, false, inp, m, o);
    else if (id === 'tossOpen') done = this.toss(t, TOSS, TOSS_RIG, true, inp, m, o);
    else if (id === 'finale') done = this.finale(t, o);
    else done = this.surfFlame(t, inp, o);
    this.fadeFingers(o, t, m);
    return done;
  }

  /** Daumen schnippt den Deckel auf: Ecke hochdrücken, abschnippen, Deckel schlägt an und federt (siehe Kopf). */
  private flickOpen(t: number, o: PropOut): boolean {
    if (t >= FLICK_T) {
      this.lidOpen = true;
      o.param[P.lid] = 1;
      return true;
    }
    this.flickAt(t, o, 1);
    if (t >= FLICK_CLICK) this.lidOpen = true;
    return false;
  }

  /** Aufschnippen zur Zeit t (Hand-Anteil × k, für lidFlick stärker). */
  private flickAt(t: number, o: PropOut, k: number): void {
    o.param[P.lid] = this.lidFrom + (1 - this.lidFrom) * FLICK_LID.value(t);
    this.addKeys(o, FLICK_KEYS, (1 - this.lidFrom) * FLICK_THUMB.value(t));
    // Klick am Anschlag: die Hand zuckt (Handgelenk federt), kleiner Ruck.
    const s = t - FLICK_CLICK;
    o.jointAdd[JA.wristTwist] += settleIn(1.4 * k, s, 0.18, TAU * 7, 0.4) * (1 - this.lidFrom);
    if (this.lidFrom < 0.5 && this.mark(0, FLICK_CLICK, t)) this.kick(o, 0.1 * k, -0.25 * k);
  }

  /** Handgelenk-Schnipp: Deckel hinkt nach und schlägt aus Trägheit zu (löscht die Flamme). */
  private snapClose(t: number, o: PropOut): boolean {
    this.snapAt(t, o, 1);
    if (t >= CLOSE_AT) {
      this.lidOpen = false;
      this.lit = false;
    }
    if (t >= CLOSE_T) {
      o.param[P.lid] = 0;
      return true;
    }
    return false;
  }

  private snapAt(t: number, o: PropOut, k: number): void {
    o.jointAdd[JA.wristTwist] += SNAP_TWIST.value(t) * k;
    o.jointAdd[JA.wristFlex] += SNAP_FLEX.value(t) * k;
    o.param[P.lid] = this.lidFrom * SNAP_LID.value(t);
    if (this.mark(1, CLOSE_AT, t)) {
      this.kick(o, 0.14, -0.4);
      this.spinKick(0.6);
    }
  }

  /**
   * Reibrad: (wenn zu, erst aufschnippen) Daumen aufs Rad, nach vorn-unten abrollen — das Rad dreht im Takt —, Funken,
   * Flamme. `lead` = Vorlauf in der Zeitleiste (finale, surfFlame).
   */
  private strike(t: number, lead: number, o: PropOut): boolean {
    const closed = this.lidFrom < 0.5;
    const open = closed ? STRIKE_OPEN : 0;
    const tt = t - lead;
    const s = tt - open;
    if (closed) {
      o.param[P.lid] = OPEN_LID.value(tt);
      this.addKeys(o, OPEN_WHEEL_KEYS, OPEN_THUMB.value(tt));
      if (tt >= STRIKE_OPEN) this.lidOpen = true;
      if (this.mark(2, lead + STRIKE_OPEN, t)) this.kick(o, 0.08, -0.2);
    } else {
      o.param[P.lid] = 1;
      this.lidOpen = true;
      this.addKeys(o, WHEEL_KEYS, WHEEL_THUMB.value(s));
    }
    this.wheel = (this.wheelBase + Math.PI * 1.5 * WHEEL_TURN.value(s)) % TAU;
    o.param[P.wheel] = this.wheel;
    // Der Daumen drückt beim Rollen: die Hand gibt ein wenig nach.
    o.hroll += 0.05 * Math.sin(Math.PI * clamp(s / 0.25, 0, 1));
    const base = lead + open;
    if (this.mark(0, base + SPARK_AT, t)) this.kick(o, 0.08, -0.15);
    if (!this.didSpark && t >= base + SPARK_AT) {
      this.didSpark = true;
      this.sparkAt(t, base + SPARK_AT);
    }
    if (!this.didIgnite && t >= base + IGNITE_AT) {
      this.didIgnite = true;
      this.ignite(t, base + IGNITE_AT);
    }
    return s >= STRIKE_T;
  }

  /** Auf/zu in einer Handbewegung (Zustand wechselt; zu löscht): auf per Daumen, zu per Handgelenk. */
  private lidFlick(t: number, o: PropOut): boolean {
    const opening = this.lidFrom < 0.5;
    const u = t / LIDFLICK_T;
    const b = Math.sin(Math.PI * clamp(u, 0, 1));
    o.hroll = (opening ? 0.16 : -0.12) * b * b;
    o.hy = -0.01 * b * b;
    if (opening) {
      this.flickAt(t, o, 1.4);
      if (t >= FLICK_CLICK) this.lidOpen = true;
    } else {
      this.snapAt(t, o, 1.25);
      if (t >= CLOSE_AT) {
        this.lidOpen = false;
        this.lit = false;
      }
    }
    if (u >= 1) {
      o.param[P.lid] = opening ? 1 : 0;
      return true;
    }
    return false;
  }

  /**
   * Würfe: twirl = kleiner Wurf, zwei Umdrehungen um die Längsachse (Hochachse des Feuerzeugs); tossOpen = Wurf mit
   * Überschlag, der Deckel springt im Flug auf, Flamme beim Fang (nicht bei ≥ 950 u/s).
   */
  private toss(t: number, s: LTossSpec, rig: TossRig, opens: boolean, inp: PropFrameInput, m: number, o: PropOut): boolean {
    const r = rig.rel;
    const c = rig.cat;
    if (!this.planned) {
      this.planned = true;
      this.tossLight = !this.lit;
    }
    this.ftT = t;
    this.ftM = m;
    this.flyToss(o, rig, OPEN_D, null, THUMB_AWAY, null);
    if (t >= r && t < c) this.inFlight(o, s, rig, opens);
    else if (opens && t >= c) {
      o.param[P.lid] = 1;
      this.lidOpen = true;
    }
    if (this.mark(2, c, t)) this.kick(o, s.kick, -s.kick * 2.6);
    if (opens && !this.didIgnite && t >= c) {
      this.didIgnite = true;
      if (this.tossLight && fin(inp.speed) < BLOW_SPEED) this.ignite(t, c);
      else if (this.lit) {
        this.flareAge = t - c;
        this.stamped |= 2;
      }
    }
    return t >= s.total;
  }

  /**
   * Im Flug: Eigendrehung und Deckel (Zeit aus rig.time). Eigene kleine Methode ohne Kommazahl-Argumente: in toss()
   * sprengten ramp2/Track.value das Inlining-Budget, ihre Rückgaben wurden je Frame HeapNumbers (Node-Probe 24
   * Scavenges je 12 000 Frames).
   */
  private inFlight(o: PropOut, s: LTossSpec, rig: TossRig, opens: boolean): void {
    const u = (rig.time - rig.rel) / s.air;
    // Drall baut sich beim Verlassen der Finger auf und wird beim Zugreifen abgebremst (Rampen an beiden Enden, C1) —
    // mit konstanter Drehung schlug die breite Seite direkt nach dem Abwurf und vor dem Fang in Daumen und Finger.
    o.spin = TAU * s.spins * ramp2(u, RAMP_IN, RAMP_OUT);
    if (opens) o.param[P.lid] = this.lidFrom + (1 - this.lidFrom) * TOSS_LID.value(u);
  }

  /** Ziel: auf, zünden, aufflackern, Flamme zeigen, per Handgelenk zu. */
  private finale(t: number, o: PropOut): boolean {
    const hold = FINALE_T - CLOSE_T - 0.2;
    if (t < hold) {
      if (!this.lit || t < 0.6) this.strike(t, 0, o);
      else {
        o.param[P.lid] = 1;
        this.lidOpen = true;
      }
      // Flamme präsentieren: Hand hebt das Feuerzeug ein Stück und neigt es zur Bildmitte.
      const b = Math.sin(Math.PI * clamp((t - 0.35) / 1.1, 0, 1));
      o.hy += -0.025 * b * b;
      o.hroll += 0.08 * b * b;
      return false;
    }
    const s = t - hold;
    if (s < 0.2) {
      o.param[P.lid] = 1;
      return false;
    }
    this.lidFrom = 1;
    this.snapClose(s - 0.2, o);
    return t >= FINALE_T;
  }

  /**
   * Surf: Deckel auf (falls zu), hochhalten, zünden (wenn aus), Flamme weht seitlich; endet mit dem Surf. Einlage
   * (PropTricks.beatU): Deckel schnappt zu und wieder auf (Daumen), die Hand wippt; brennt sie, flackert sie beim
   * Aufschnappen auf — auch ausgeblasen (≥ 950 u/s, L3) sieht man den Klack.
   */
  private surfFlame(t: number, inp: PropFrameInput, o: PropOut): boolean {
    if (this.surfOut < 0 && !inp.surfing && t >= SURF_MIN) this.surfOut = t;
    const inE = smooth(t / 0.25);
    const outE = this.surfOut < 0 ? 0 : smooth((t - this.surfOut) / 0.3);
    const e = inE * (1 - outE);
    // Erst zünden (setzt Daumen/Neigung), dann die Surf-Lage darauf — so bleibt der Übergang stetig.
    if (this.stateStrike && this.strike(t, 0, o)) this.stateStrike = false;
    if (!this.stateStrike) o.param[P.lid] = 1;
    // Plan 008: die HAND hebt das Feuerzeug (vorher wurde es aus dem Griff geschoben — der Daumen steckte darin).
    o.hx += 0.015 * e;
    o.hy -= 0.034 * e;
    o.hz += 1.6 * e;
    o.jointAdd[JA.wristDev] -= 0.25 * this.surfLean * e;
    o.hroll += 0.1 * this.surfLean * e;
    const u = this.beatU;
    if (u < 1 && !this.stateStrike) {
      // Mit dem Zustand ausgeblendet (e): endet der Surf mitten im Klack, geht der Deckel stetig wieder auf.
      const b = Math.sin(Math.PI * u);
      o.param[P.lid] = 1 - 0.95 * b * b * e;
      o.hroll -= 0.2 * b * b * e;
      // Daumen drückt den Deckel zu und schnippt ihn wieder auf (Phase über die Daumen-Schlüssel des Aufschnippens).
      this.addKeys(o, FLICK_KEYS, 2.4 * b * e);
    }
    // Wieder auf: Klack, und die Flamme flackert ab genau dort (Alter exakt, framerate-unabhängig).
    if (this.beatEnd()) {
      this.kick(o, 0.1, -0.3);
      if (this.lit) {
        this.flareAge = this.lateness;
        this.stamped |= 2;
      }
    }
    this.lidOpen = true;
    return this.surfOut >= 0 && t >= this.surfOut + 0.3;
  }
}
