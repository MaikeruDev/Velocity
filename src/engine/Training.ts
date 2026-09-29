import { Vector3 } from 'three';
import type { Box3 } from 'three';
import { VELOCITY_DEFAULT, withMovement } from '../player/MovementConfig';
import type { MovementConfig } from '../player/MovementConfig';
import { BeginnerHand, DEMO_SEED, HAND_MODELS, PrestrafeHand, SurfHand, demoModel } from '../player/bots/BeginnerHand';
import { makeBotInput, yawOf } from '../player/bots/Bot';
import type { PlayerInput, PlayerSnapshot } from '../player/types';
import type { LessonHud } from '../ui/types';
import type { GatedWorld } from '../world/collision/GatedWorld';
import type { CollisionWorld } from '../world/collision/types';
import { makeTraceResult } from '../world/collision/types';
import type { CompiledLevel } from '../world/level/compileLevel';
import type { DemoDef, RouteNode, StageDef, StageRank, StageTipDef, TrainingDef } from '../world/level/LevelFormat';
import type { GameEvent, RunEvent } from './events';
import { COUNT_SIDE_SHARE, MIN_AIR, MIN_TAKEOFF, NO_MOUSE_RATE, PRESTRAFE_BAND_HI, PRESTRAFE_BAND_LO, SIDE_MIN_SHARE, StrafeJudge, VERDICT_TEXT, turnBandAt } from './strafeJudge';
import { starsFor } from './TrainingProgress';
import type { LessonStars, TrainingSessionApi, TrainingSpawn, TurnBand, Verdict } from './trainingTypes';

/**
 * Eine laufende Lektion (Plan 007, TC2) — implementiert TrainingSessionApi. DOM-frei; tick() ohne
 * Allokation außer bei Ereignissen (Urteil, Stufe, Tor; gemessen nach Aufwärmen: je Urteil ~100–200 B,
 * sonst 0). Ereignis-Objekte kommen aus Ringen (RING je Art) und werden wiederverwendet. Reihenfolge in
 * einem Tick: 'lessonHop' (mit dem Zählerstand der Stufe), dann 'gate', dann 'lessonStage'.
 *
 * Stufen laufen der Reihe nach (Pflicht, dann Bonus, dann Meister). Eine erledigte Stufe öffnet
 * ihre Tore sofort (GatedWorld) und meldet 'lessonStage'/'gate'; das Auflösen der Optik
 * (gateOpen 0 → 1 in GATE_DISSOLVE s) läuft in update(). Zählregeln verzeihen (v2-Entwurf gemessen):
 * - goodHops 'alternate': es zählt nur ein guter Hop auf der anderen Seite als der zuletzt gezählte,
 *   nichts setzt zurück (strenge Serie: ordentlicher Anfänger nur 10/20).
 * - speed.holdHops: Landungen in Folge über min (eine darunter setzt zurück).
 * - surfHold: Kontaktlücken ≤ SURF_GAP zählen weiter.
 * - course: Zonen in Reihenfolge; zurück auf 0 bei zu langer Bodenzeit (groundGrace) oder unter
 *   COURSE_SLOW_SHARE × minSpeed — kein Tod, einfach nochmal.
 * - crouchLand: Landung in der Zone, in der Luft geduckt, Füße ≥ CROUCH_RISE über dem Absprung.
 * - hopChain: die Kette der Physik (PlayerSnapshot.hopChain), aber nur Absprünge ≥ CHAIN_MIN_SPEED; die Pips
 *   zeigen die laufende Kette (reißt sie, fallen sie zurück).
 * - A/D-Pflicht in Strafe-Stufen (Lektion mit hud.turnBand, Aufgabe speed in der Luft oder course — T4/T5): Tempo
 *   und Tore zählen nur mit A/D in der Luft (≥ SIDE_MIN_SHARE des laufenden oder des letzten Luftabschnitts) und
 *   der Maus NICHT gegen die Taste (Netto-Drehung wie StrafeJudge 'against'); holdHops-Landungen nur nach so einem
 *   Abschnitt (sonst: zählt nicht, setzt nicht zurück). Sonst bestanden "nur W + schnelle Maus" (W-Strafe mit Blick
 *   quer zur Fahrt), der W-Lenker aus T2 und der Rückwärts-Strafer (A + Maus rechts: fliegt rückwärts, gewinnt Tempo,
 *   jeder Hop "FALSCHE SEITE") T4/T5 — ohne die gelehrte Technik.
 * - Hops in Prestrafe-Stufen (speed am Boden) bekommen kein Urteil (kein 'lessonHop'): dort zählt kein Sprung, ein
 *   "GUT" widerspräche der Karte "OHNE SPRUNG".
 *
 * Vorführung (suspended = true): nichts zählt für den Spieler, aber die Stufe wird im Schatten weiter
 * ausgewertet (eigener Zähler, HUD unberührt). Schafft die Vorführung die Stufe, gehen deren Tore nur für
 * die Vorführung auf (Kollision + Optik, ohne 'gate'-Ereignis) — sonst liefe die T1-Rutsch-Vorführung ins
 * geschlossene Tunneltor. Ende der Vorführung: Zähler zurück, Vorführungs-Tore wieder zu. `demoPassed` sagt
 * Werkzeugen, ob die Vorführung die Stufe geschafft hätte.
 *
 * Tipps (StageTipDef, Urteils-Wiederholung, "Demo ansehen", gezählt-nicht-gezählt) laufen nicht über den
 * Vertrag: `tip` (Text + Zähler `serial`) — die Anzeige liest das Objekt, wenn sich serial ändert. Auslöser
 * 'land' ist ein Zustand: am Boden seit einer Landung und mindestens `after` s (0 = im Landetick) — ein
 * Bhop (1–2 Bodenticks) löst "nicht stehen bleiben" nie aus.
 */

/**
 * Lehr-Config: Lektionen lehren das VELOCITY-Movement mit allen Hilfen (Auto-Hop, Strafe-Assist, Luftlenkung)
 * — Preset und Movement-Schalter des Spielers gelten in Lektionen nicht. Nur diese Physik ist validiert
 * (Bot-Matrix, Vorführungen, Judge-Tabellen aus turnwindow.ts): mit CS2 gibt es kein Rutschen (T1 RUTSCHEN
 * unmöglich → kein T1-Stern → Spinner/Roboter gesperrt) und 64 Tick, ohne Auto-Hop ist T2 "Leertaste halten"
 * falsch, ohne Luftlenkung der T2-Slalom. Game wendet sie beim Laden einer Lektion an und stellt beim
 * Verlassen die Spieler-Config wieder her. Immer dasselbe Objekt.
 */
export function lessonMovementConfig(): MovementConfig {
  return LESSON_CONFIG;
}
const LESSON_CONFIG: MovementConfig = withMovement(VELOCITY_DEFAULT, { autoHop: true, strafeAssist: true, airControl: VELOCITY_DEFAULT.airControl });

/** Tipp-Sperre zwischen zwei Tipps (s). */
export const TIP_COOLDOWN = 6;
/** Ohne Fortschritt so lange (s) → "Demo ansehen" (Stufen mit Vorführung). */
export const STUCK_AFTER = 20;
/** Gleiches schlechtes Urteil so oft in Folge → Coach-Text des Urteils. */
export const VERDICT_REPEAT = 2;
/** Derselbe Urteils-Text frühestens wieder nach … s. */
export const VERDICT_TIP_AGAIN = 20;
/** surfHold: Kontaktlücke bis zu … s zählt weiter (Flankenwechsel, Clip-Tick). */
export const SURF_GAP = 0.15;
/** course ohne groundGrace: so viel Bodenzeit am Stück (s) ist eine normale Bhop-Landung. */
export const COURSE_GROUND_GRACE = 0.1;
/** course: unter diesem Anteil von minSpeed beginnt der Kurs neu. */
export const COURSE_SLOW_SHARE = 0.8;
/** crouchLand: Füße mindestens so hoch über dem Absprung (u). */
export const CROUCH_RISE = 40;
/** speed.ground (Prestrafe): so lange am Stück am Boden (s), bevor das Tempo zählt — die Landung nach einem Hop zählt nicht. */
export const PRESTRAFE_GROUND = 0.25;
/**
 * speed.ground: so lange (s) am Stück über min. Das Einlenken mit W + A gibt eine kurze Spitze
 * (90 °/s: 356 u/s für 0.05 s, dann 340) — gehalten wird das Tempo nur mit 150–300 °/s.
 */
export const PRESTRAFE_HOLD = 0.3;
/** speed.holdHops: nur Landungen nach mindestens so viel Luft (s). */
export const HOLD_MIN_AIR = 0.2;
/**
 * hopChain: ein Absprung zählt erst ab diesem Tempo (u/s). Mausrad-Hämmern aus dem Stand umgeht den
 * Smart-Auto-Hop und hüpft mit 40 u/s auf der Stelle — das ist keine Bhop-Kette (T2 HALTEN war in 3.8 s
 * "geschafft"). Gehaltene Leertaste springt erst ab 0.97 × Wunschtempo (≥ 242 u/s).
 */
export const CHAIN_MIN_SPEED = 200;
/** Gut, aber nicht gezählt (falsche Seite, A/D zu spät, ohne A/D): derselbe Erklär-Tipp frühestens wieder nach … s. */
export const MISS_TIP_AGAIN = 15;
/** Ohne Anlauf: so viele bewertbar lange Luftabschnitte in Folge mit Absprung unter MIN_TAKEOFF → Erklär-Tipp. */
export const SLOW_TAKEOFF_HOPS = 2;
/** Prestrafe-Stufe (speed am Boden): so viele Hops → Erklär-Tipp "ohne Sprung". */
export const PRESTRAFE_HOPS = 2;
/** Stufen, die Sprint-Tempo brauchen (Rutschen, Prestrafe): so lange (s) W am Boden ohne Sprint → Tipp "Shift los". */
export const NO_SPRINT_AFTER = 0.75;
/**
 * surfSpeed: Surf-Ticks, in denen man langsamer wird, zählen +dt, schnellere −dt (nie unter 0) — ab so viel (s) Tipp zum
 * Blick. T8, 20 Seeds × 60 s: Grundtechnik ±1°/±3° nie, ±6° in 12/20, fester Blick 3°/4° in die Rampe 18/20 bzw. 20/20
 * (Median 7 bzw. 6 s), 4° die Flanke hinab nie. Am Stück (ohne Ausgleich) kam er bei 4° nur in 15/20 und erst nach ~16 s.
 */
export const SURF_SLOW_AFTER = 0.4;
/**
 * Erklär-Tipps (Index = MissReason): für Hops, Landungen und Tore, die fast gezählt hätten — und für Fehler, die der
 * Judge nicht sieht (kein Anlauf, Sprung statt Prestrafe, Shift gehalten, Blick in die Surf-Rampe).
 */
export const MISS_TEXT = [
  'GUT! JETZT DIE ANDERE SEITE:\nD + MAUS NACH RECHTS',
  'GUT! JETZT DIE ANDERE SEITE:\nA + MAUS NACH LINKS',
  'GUT, ABER HIER NACH LINKS:\nA + MAUS NACH LINKS',
  'GUT, ABER HIER NACH RECHTS:\nD + MAUS NACH RECHTS',
  'GUT, ABER A/D GLEICH NACH DEM\nABSPRUNG DRÜCKEN UND HALTEN',
  'ZÄHLT NUR MIT A/D IN DER LUFT:\nW LOS, A ODER D + MAUS MITZIEHEN',
  'ZÄHLT NUR MIT MAUS IN TASTENRICHTUNG:\nA = MAUS LINKS, D = MAUS RECHTS',
  `ERST ANLAUFEN: W + LEERTASTE HALTEN\nSPRÜNGE ZÄHLEN AB ${MIN_TAKEOFF} u/s`,
  'PRESTRAFE GEHT OHNE SPRUNG: LEERTASTE\nLOS, W + A/D HALTEN UND MAUS MITZIEHEN',
  'SHIFT LOSLASSEN: IN LEKTIONEN LÄUFST DU\nOHNE SHIFT SCHON MIT VOLLEM TEMPO',
  'DU WIRST LANGSAMER: NICHT IN DIE RAMPE\nSCHAUEN, DER BLICK GEHT GENAU ENTLANG',
] as const;
const MISS_NEXT_RIGHT = 0;
const MISS_NEXT_LEFT = 1;
const MISS_LEFT = 2;
const MISS_RIGHT = 3;
const MISS_EARLY = 4;
const MISS_NO_SIDE = 5;
const MISS_AGAINST = 6;
const MISS_RUNUP = 7;
const MISS_PRESTRAFE_HOP = 8;
const MISS_NO_SPRINT = 9;
const MISS_SURF_SLOW = 10;
const TWO_PI = 2 * Math.PI;
/** A/D-Pflicht: so lange (s) A/D im laufenden Luftabschnitt, bevor er für sich zählt (davor der letzte Abschnitt). */
export const SIDE_EVIDENCE = 0.1;
/** NO_MOUSE_RATE in rad/s: Netto-Drehung gegen die Taste ab dieser Rate = "gegen die Maus" (wie StrafeJudge). */
const AGAINST_RATE = (NO_MOUSE_RATE * Math.PI) / 180;
/** Auflösen eines Tors in der Optik (s). */
export const GATE_DISSOLVE = 0.4;
/** Tipp-Text, wenn eine Stufe mit Vorführung festhängt (Anzeige darf die Taste ersetzen: kind 'demo'). */
export const DEMO_TIP_TEXT = 'TIPP: [H] ZEIGT ES DIR';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type HopEvent = Mutable<Extract<RunEvent, { type: 'lessonHop' }>>;
type StageEvent = Mutable<Extract<RunEvent, { type: 'lessonStage' }>>;
type GateEvent = Mutable<Extract<RunEvent, { type: 'gate' }>>;
type MutableLessonHud = Mutable<LessonHud>;

/** Tipp im Moment (außerhalb des Vertrags): neuer Tipp = serial + 1. */
export interface LessonTip {
  text: string;
  /** stage = StageTipDef, verdict = wiederholtes Urteil, demo = "Vorführung ansehen" (Taste ersetzen). */
  kind: 'stage' | 'verdict' | 'demo';
  serial: number;
}

export interface TrainingSessionOptions {
  /** Kollision der Tore (Game: dieselbe Welt wie movement.setWorld). null = nur Zustand (Tests). */
  readonly world?: GatedWorld | null;
}

const RING = 8;
/** Double-Startwert für Gleitkomma-Felder im Tick-Pfad (vor dem ersten Lesen gesetzt; s. strafeJudge). */
const D0 = 0.5;
const MAX_TIPS = 16;

export class TrainingSession implements TrainingSessionApi {
  readonly def: TrainingDef;
  readonly level: CompiledLevel;
  readonly judge: StrafeJudge;
  readonly hud: LessonHud;
  readonly gateOpen: Float32Array;
  readonly tip: LessonTip = { text: '', kind: 'stage', serial: 0 };

  private readonly h: MutableLessonHud;
  private readonly stages: readonly StageDef[];
  private readonly world: GatedWorld | null;
  /** Soll-Zustand je Tor (1 = offen); Kollision sofort, Optik über gateOpen. */
  private readonly gateState: Uint8Array;
  private readonly completed = new Set<string>();
  private readonly completedList: string[] = [];
  /** Erledigt oder übersprungen (Ablauf). */
  private readonly passed: Uint8Array;
  private readonly requiredCount: number;
  private si = 0;
  private suspendedFlag = false;
  // Gleitkomma-Felder mit Double-Startwert (D0, vor dem ersten Lesen gesetzt): V8 schreibt sie in place.
  private time = D0;

  // Stufen-Zustand
  private count = D0;
  private goal = 1;
  private lastSide = 0;
  private hold = 0;
  private surfTime = D0;
  private offSurf = D0;
  private coursePos = 0;
  private best = D0;
  private above = D0;
  private lastProgress = D0;
  private repeatVerdict: Verdict = 'good';
  private repeatCount = 0;
  /** hopChain: laufende Kette (nur Absprünge ≥ CHAIN_MIN_SPEED) und zuletzt gesehener Physik-Zähler. */
  private chain = 0;
  private lastChain = 0;
  /** Zähler von enter(): eine Vorführung stellt ihren Stand nur in derselben Stufe wieder her. */
  private epoch = 0;
  /**
   * Stufe bewertet Strafen (= turnBand() ≠ null, wie hudLogic.stageJudges): nur dann Urteils- und Erklär-Tipps.
   * Sonst belegten versteckte Urteils-Tipps (Game zeigt sie dort nicht) die Tipp-Sperre — in T2 LENKEN "W LOSLASSEN"
   * zu einem Spieler, der genau "W HALTEN" befolgt.
   */
  private judges = false;
  /** A/D-Pflicht (s. Kopf): Strafe-Stufe mit Aufgabe speed (nicht am Boden) oder course. */
  private needsSide = false;
  /** Prestrafe-Stufe (speed am Boden): Hops ohne Urteil, Erklär-Tipp nach PRESTRAFE_HOPS. */
  private groundStage = false;
  /** Stufe braucht Sprint-Tempo (Rutschen, Prestrafe): Tipp, wenn W ohne Sprint läuft (Shift gehalten). */
  private needsSprint = false;
  /** Laufender Luftabschnitt ohne Surf: Ticks gesamt und mit A/D, Netto-Drehung in Tastenrichtung (rad, wie StrafeJudge). */
  private airTicks = 0;
  private airSideTicks = 0;
  private airTurn = D0;
  private airPrevYaw = D0;
  /** Laufender Luftabschnitt hatte Surf-Kontakt; Absprungtempo (u/s). */
  private airSurfed = false;
  private takeoffSpeed = D0;
  /** Tick-Länge des laufenden tick() (für sectionAgainst: Kommazahlen als Argument boxen, fallen.md #107). */
  private dt = D0;
  /** Der letzte abgeschlossene Luftabschnitt hatte A/D (≥ SIDE_MIN_SHARE seiner Ticks) und die Maus nicht dagegen. */
  private lastStrafed = false;
  /** Der letzte abgeschlossene Luftabschnitt: Maus gegen die Taste. */
  private lastAgainst = false;
  /** Erklär-Tipps ohne Urteil: Hops ohne Anlauf in Folge, Hops in der Prestrafe-Stufe, W ohne Sprint (s), Surf-Verlust (s). */
  private slowTakeoffs = 0;
  private groundHops = 0;
  private noSprint = D0;
  private surfSlow = D0;

  // Vorführung (Schatten-Auswertung, s. Kopf)
  private demoDone = false;
  private demoEpoch = -1;
  private savedCount = D0;
  private savedSide = 0;
  private savedBest = D0;
  /** Tore, die nur für die laufende Vorführung offen sind (1 = offen). */
  private readonly demoGate: Uint8Array;

  // Bewegungs-Zustand
  private groundTime = D0;
  private airTime = D0;
  private airStartY = D0;
  private airDucked = false;
  private wasGround = true;
  /** Am Boden seit einer echten Landung (nicht seit Spawn/Teleport) — Tipp-Auslöser 'land'. */
  private sinceLanding = false;

  // Tipps
  private readonly tipDue = new Float64Array(MAX_TIPS);
  private readonly tipFired = new Uint8Array(MAX_TIPS);
  private lastTipAt = Number.NEGATIVE_INFINITY;
  private demoTipFired = false;
  private readonly verdictTipAt = new Map<Verdict, number>();
  private readonly missTipAt = new Float64Array(MISS_TEXT.length).fill(Number.NEGATIVE_INFINITY);

  // Ereignisse
  private readonly hopRing: HopEvent[] = [];
  private readonly stageRing: StageEvent[] = [];
  private readonly gateRing: GateEvent[] = [];
  private hopI = 0;
  private stageI = 0;
  private gateI = 0;
  /** Außerhalb von tick() entstandene Ereignisse (skipStage, restartLesson) — gehen mit dem nächsten tick() raus. */
  private readonly pending: RunEvent[] = [];
  private pendingN = 0;

  private readonly spawnPos = new Vector3();
  private readonly spawn: { pos: Vector3; yaw: number } = { pos: this.spawnPos, yaw: 0 };
  private readonly band = { lo: D0, hi: D0 };

  constructor(level: CompiledLevel, cfg: MovementConfig, opts: TrainingSessionOptions = {}) {
    const def = level.def.training;
    if (!def) throw new Error(`Level ${level.def.id} ist keine Lektion (training fehlt)`);
    this.def = def;
    this.level = level;
    this.stages = def.stages;
    this.world = opts.world ?? null;
    this.judge = new StrafeJudge(cfg);
    this.gateOpen = new Float32Array(level.gates.length);
    this.gateState = new Uint8Array(level.gates.length);
    this.demoGate = new Uint8Array(level.gates.length);
    this.passed = new Uint8Array(this.stages.length);
    this.requiredCount = this.stages.filter((s) => rankOf(s) === 'required').length;
    if (this.stages.some((s) => (s.tips?.length ?? 0) > MAX_TIPS)) throw new Error(`Lektion ${def.short}: mehr als ${MAX_TIPS} Tipps in einer Stufe`);
    this.h = {
      lessonTitle: `${def.short} · ${level.def.name}`,
      stageTitle: '',
      text: '',
      count: 0,
      goal: 1,
      style: 'pips',
      rank: 'required',
      stageIndex: 0,
      stageTotal: this.stages.length,
      demo: false,
    };
    this.hud = this.h;
    for (let i = 0; i < RING; i++) {
      this.hopRing.push({ type: 'lessonHop', verdict: 'good', gain: D0, counted: false, count: 0, goal: 0 });
      this.stageRing.push({ type: 'lessonStage', index: 0, total: 0, rank: 'required', lessonDone: false });
      this.gateRing.push({ type: 'gate', id: '', open: false });
    }
    this.time = 0;
    this.enter(0);
  }

  /** Spieler-Einstellung Strafe-Assist (Judge-Urteil 'wHeld'). */
  setConfig(cfg: MovementConfig): void {
    this.judge.setConfig(cfg);
  }

  // ---------------------------------------------------------------- Vertrag

  get suspended(): boolean {
    return this.suspendedFlag;
  }

  set suspended(v: boolean) {
    if (v === this.suspendedFlag) return;
    this.suspendedFlag = v;
    this.h.demo = v;
    if (v) {
      // Stand des Spielers merken; die Vorführung zählt im Schatten ab 0.
      this.savedCount = this.count;
      this.savedSide = this.lastSide;
      this.savedBest = this.best;
      this.demoEpoch = this.epoch;
      this.demoDone = false;
      this.count = 0;
      this.lastSide = 0;
      this.coursePos = 0;
      this.best = 0;
    } else {
      this.closeDemoGates();
      if (this.demoEpoch === this.epoch) {
        this.count = this.savedCount;
        this.lastSide = this.savedSide;
        this.h.count = Math.round(this.savedCount) | 0;
        // Auch der Bestwert des Balkens: blieb er auf dem Ziel der Vorführung, galt kein eigener Anstieg mehr als
        // Fortschritt — nach 20 s kam "[H] ZEIGT ES DIR" trotz stetiger Steigerung (Review rv-tc3, T4 TEMPO 400).
        this.best = this.savedBest;
      }
      this.demoDone = false;
      // Wer eben zugesehen hat, bekommt nicht sofort "hängst du fest?".
      this.lastProgress = this.time;
    }
    // Game setzt den Spieler an den Stufen-Spawn — Laufendes gilt nicht mehr (Kurs, Serie, Luftabschnitt).
    this.resetTransient();
  }

  /** Nur während der Vorführung: hat sie die aktuelle Stufe geschafft? (Werkzeuge, Tests.) */
  get demoPassed(): boolean {
    return this.demoDone;
  }

  get done(): boolean {
    for (let i = 0; i < this.stages.length; i++) if (rankOf(this.stages[i]) === 'required' && this.passed[i] === 0) return false;
    return this.requiredCount > 0;
  }

  get stars(): LessonStars {
    return starsFor(this.stages, this.completed);
  }

  get completedStageIds(): readonly string[] {
    return this.completedList;
  }

  /** Index der aktiven Stufe (= stages.length, wenn alle durch sind). */
  get stageIndex(): number {
    return this.si;
  }

  get stage(): StageDef | null {
    return this.stages[this.si] ?? null;
  }

  tick(dt: number, prev: PlayerSnapshot, cur: PlayerSnapshot, cmd: PlayerInput, hullH: number, out: RunEvent[]): void {
    for (let i = 0; i < this.pendingN; i++) out.push(this.pending[i]);
    this.pendingN = 0;
    this.time += dt;
    this.dt = dt;
    const judged = this.judge.tick(dt, prev, cur, cmd);
    const landed = !this.wasGround && cur.onGround;
    const tookOff = this.wasGround && !cur.onGround;
    const airBefore = this.airTime;
    if (cur.onGround) {
      this.groundTime += dt;
      this.airTime = 0;
    } else {
      this.groundTime = 0;
      this.airTime += dt;
    }
    if (tookOff) {
      this.airStartY = prev.pos.y;
      this.airDucked = false;
      this.sinceLanding = false;
      this.airTicks = 0;
      this.airSideTicks = 0;
      this.airTurn = 0;
      this.airPrevYaw = cmd.yaw;
      this.airSurfed = false;
      this.takeoffSpeed = prev.speed;
    }
    if (!cur.onGround) {
      // Netto-Drehung in Tastenrichtung wie StrafeJudge (Linksdrehung passt zu A: −side·dYaw > 0), gewickelt.
      let dYaw = cmd.yaw - this.airPrevYaw;
      dYaw -= Math.round(dYaw / TWO_PI) * TWO_PI;
      this.airPrevYaw = cmd.yaw;
      if (cur.surfing) this.airSurfed = true;
      else {
        this.airTicks++;
        if (cmd.side !== 0) {
          this.airSideTicks++;
          this.airTurn -= cmd.side * dYaw;
        }
      }
    }
    // Erklär-Tipps ohne Urteil (Index MISS_TEXT): hint nur in Stufen mit Urteil, stageHint überall.
    let hint = -1;
    let stageHint = -1;
    if (landed) {
      this.sinceLanding = true;
      const against = this.sectionAgainst();
      this.lastAgainst = against;
      this.lastStrafed = this.airTicks > 0 && this.airSideTicks >= SIDE_MIN_SHARE * this.airTicks && !against;
      // Ein bewertbar langer Hop (wie StrafeJudge: MIN_AIR, ohne Surf): in der Prestrafe-Stufe falsch, ohne Anlauf zu
      // langsam für ein Urteil — der Judge schweigt dort, der Neuling hüpfte 20 s ohne Rückmeldung (Review training-ui).
      if (airBefore >= MIN_AIR && !this.airSurfed) {
        if (this.groundStage) {
          if (++this.groundHops >= PRESTRAFE_HOPS) hint = MISS_PRESTRAFE_HOP;
        } else if (this.takeoffSpeed < MIN_TAKEOFF) {
          if (++this.slowTakeoffs >= SLOW_TAKEOFF_HOPS) hint = MISS_RUNUP;
        } else this.slowTakeoffs = 0;
      }
    }
    if (!cur.onGround && cur.ducked) this.airDucked = true;
    this.wasGround = cur.onGround;
    // Rutschen/Prestrafe brauchen Sprint-Tempo (> 280/350): wer aus Gewohnheit Shift hält, läuft mit Auto-Sprint 250 u/s.
    // Ganzzahliger Schalter statt `cond ? kommazahl : 0` (am Zusammenfluss geboxt, fallen.md #107.2).
    const walking = this.needsSprint && cur.onGround && cmd.forward > 0 && !cmd.sprint && !cur.ducked ? 1 : 0;
    this.noSprint = (this.noSprint + dt) * walking;
    if (this.noSprint >= NO_SPRINT_AFTER) stageHint = MISS_NO_SPRINT;

    const st = this.stages[this.si];
    const demo = this.suspendedFlag;
    if (!st || (demo && this.demoDone)) {
      if (judged && !this.groundStage) this.emitHop(out, false);
      return;
    }
    const t = st.task;
    let counted = false;
    let finish = false;
    let miss = -1;
    switch (t.kind) {
      case 'reach': {
        const z = this.level.zones.get(t.zone);
        finish = z !== undefined && hullIn(z, cur.pos, hullH);
        break;
      }
      case 'hopChain': {
        const hc = cur.hopChain;
        if (hc !== this.lastChain) {
          // Neuer Absprung (hc steigt oder beginnt neu bei 1) oder Kette gerissen (0).
          if (hc === 0 || cur.speed < CHAIN_MIN_SPEED) this.chain = 0;
          else this.chain = hc === 1 || hc < this.lastChain ? 1 : this.chain + 1;
          this.lastChain = hc;
        }
        this.progress(Math.min(t.count, this.chain), true);
        finish = this.chain >= t.count;
        break;
      }
      case 'goodHops':
        if (judged) {
          const r = this.judge.last;
          const early = r.sideShare >= (t.minSideShare ?? COUNT_SIDE_SHARE);
          let sideOk = true;
          if (t.side === 'left') sideOk = r.side < 0;
          else if (t.side === 'right') sideOk = r.side > 0;
          else if (t.side === 'alternate') sideOk = r.side !== 0 && (this.lastSide === 0 || r.side === -this.lastSide);
          if (r.verdict === 'good' && early && sideOk) {
            this.lastSide = r.side;
            counted = true;
            this.progress(this.count + 1);
            finish = this.count >= t.count;
          } else if (r.verdict === 'good') {
            // Gelobt, aber ohne Pip: sagen, warum (sonst sieht der Anfänger "GUT" und keinen Fortschritt).
            if (!sideOk && t.side === 'alternate' && r.side !== 0) miss = this.lastSide < 0 ? MISS_NEXT_RIGHT : MISS_NEXT_LEFT;
            else if (!sideOk && t.side === 'left') miss = MISS_LEFT;
            else if (!sideOk && t.side === 'right') miss = MISS_RIGHT;
            else if (!early) miss = MISS_EARLY;
          }
        }
        break;
      case 'speed':
        if (t.holdHops !== undefined) {
          if (landed && airBefore >= HOLD_MIN_AIR) {
            if (cur.speed < t.min) this.hold = 0;
            else if (!this.needsSide || this.lastStrafed) {
              this.hold++;
              counted = true;
            } else miss = this.lastAgainst ? MISS_AGAINST : MISS_NO_SIDE; // zählt nicht, reißt die Serie aber auch nicht
            this.progress(Math.min(this.hold, t.holdHops), true);
          }
        } else if (t.ground) {
          const ok = cur.onGround && !cur.ducked && !cur.sliding && this.groundTime >= PRESTRAFE_GROUND;
          this.above = ok && cur.speed >= t.min ? this.above + dt : 0;
          // Balken bis knapp unter das Ziel; voll erst, wenn das Tempo PRESTRAFE_HOLD gehalten ist.
          this.bar(ok ? Math.min(cur.speed, this.above >= PRESTRAFE_HOLD ? t.min : t.min - 1) : 0, t.min);
        } else if (this.needsSide && cur.speed >= t.min && !this.strafing(cur.onGround)) {
          // Tempo ohne die Technik (W-Strafe, Luftlenkung, rückwärts gegen die Maus): Balken bis knapp unter das Ziel, Tipp warum.
          this.bar(t.min - 1, t.min);
          miss = this.sideMiss(cur.onGround);
        } else this.bar(cur.speed, t.min);
        finish = this.count >= this.goal;
        break;
      case 'surfHold':
        if (cur.surfing) {
          this.surfTime += dt;
          this.offSurf = 0;
        } else {
          this.offSurf += dt;
          if (this.offSurf > SURF_GAP) this.surfTime = 0;
        }
        this.bar(Math.floor(this.surfTime * 10 + 1e-6), t.seconds * 10);
        finish = this.surfTime >= t.seconds;
        break;
      case 'surfSpeed':
        if (cur.surfing) this.offSurf = 0;
        else this.offSurf += dt;
        this.bar(this.offSurf <= SURF_GAP ? cur.speed : 0, t.min);
        finish = this.count >= this.goal;
        // Auf der fallenden Rampe surfend langsamer werden = fast immer der Blick in die Rampe (T8: 3° in die Rampe
        // 5/20, 4° 0/20). Ausgleichender Zähler statt "am Stück": einzelne schnellere Ticks unterbrachen sonst jede Serie.
        // Schalter als Ganzzahl (+1 langsamer, −1 schneller, 0 = kein Surf am Stück) statt Kommazahl-Zweigen (#107.2).
        const onSurf = cur.surfing && prev.surfing ? 1 : 0;
        const slower = cur.speed < prev.speed ? 1 : -1;
        this.surfSlow = Math.max(0, this.surfSlow + dt * slower) * onSurf;
        if (this.surfSlow >= SURF_SLOW_AFTER) stageHint = MISS_SURF_SLOW;
        break;
      case 'crouchLand': {
        const z = this.level.zones.get(t.zone);
        if (landed && z && this.airDucked && cur.pos.y >= this.airStartY + CROUCH_RISE && hullIn(z, cur.pos, hullH)) {
          counted = true;
          this.progress(this.count + 1);
          finish = this.count >= t.count;
        }
        break;
      }
      case 'course': {
        const n = t.zones.length;
        const grace = t.groundGrace ?? COURSE_GROUND_GRACE;
        if (this.coursePos > 0 && ((t.airborne && this.groundTime > grace) || cur.speed < t.minSpeed * COURSE_SLOW_SHARE)) this.progress(0, true);
        const side = !this.needsSide || this.strafing(cur.onGround);
        const z0 = this.level.zones.get(t.zones[0]);
        // Wieder durch die erste Zone (neuer Anlauf nach einer Runde) → von vorn ab 1.
        if (this.coursePos > 1 && side && z0 && cur.speed >= t.minSpeed && hullIn(z0, cur.pos, hullH)) this.progress(1, true);
        const z = this.coursePos < n ? this.level.zones.get(t.zones[this.coursePos]) : undefined;
        if (z && cur.speed >= t.minSpeed && hullIn(z, cur.pos, hullH)) {
          if (side) {
            this.progress(this.coursePos + 1);
            finish = this.coursePos >= n;
          } else miss = this.sideMiss(cur.onGround);
        }
        break;
      }
      case 'event':
        finish = this.count >= t.count;
        break;
    }
    if (demo) {
      // Vorführung: Urteile ja (ohne Pip), Stufe nur im Schatten — ihre Tore öffnen nur für die Vorführung.
      if (judged && !this.groundStage) this.emitHop(out, false);
      if (finish) this.demoFinish(st);
      return;
    }
    // Erst das Urteil (mit dem Zählerstand dieser Stufe: die HUD-Pips poppen 5/5), dann der Stufenabschluss.
    // In der Prestrafe-Stufe kein Urteil: dort zählt kein Sprung (Erklär-Tipp statt "GUT").
    if (judged && !this.groundStage) {
      this.emitHop(out, counted);
      if (this.judges) this.noteVerdict();
    }
    if (finish) this.complete(out);
    else {
      // Urteils-nahe Erklär-Tipps nur, wo das HUD urteilt (Game zeigt kind 'verdict' sonst nicht); der Hinweis zum Sprint
      // und zum Surf-Blick ist ein Stufen-Tipp (T1/T8 urteilen nicht).
      if (miss >= 0 && this.judges) this.missTip(miss, 'verdict');
      else if (hint >= 0 && this.judges) this.missTip(hint, 'verdict');
      if (stageHint >= 0) this.missTip(stageHint, 'stage');
      this.tips(st, cur, hullH, judged);
    }
  }

  /**
   * A/D-Pflicht: strafet der Spieler gerade? In der Luft (ohne Surf) mit A/D in ≥ SIDE_MIN_SHARE des laufenden
   * Abschnitts und der Maus nicht gegen die Taste — oder der letzte Abschnitt hatte das (Reaktionszeit nach dem
   * Absprung, bis die Taste kommt). Am Boden zählt der letzte Abschnitt. W-Strafer und W-Lenker haben nie A/D, der
   * Rückwärts-Strafer (A + Maus rechts) zieht immer gegen die Taste. Der laufende Abschnitt zählt erst nach
   * SIDE_EVIDENCE s A/D: im Absprung-Tick ist die Maus noch nicht gemessen (Drehung 0 = "nicht dagegen"), der
   * Rückwärts-Strafer zählte sonst jedes Mal im ersten Luft-Tick.
   */
  private strafing(onGround: boolean): boolean {
    if (onGround || this.airSideTicks * this.dt < SIDE_EVIDENCE) return this.lastStrafed;
    return this.lastStrafed || (this.airSideTicks >= SIDE_MIN_SHARE * this.airTicks && !this.sectionAgainst());
  }

  /** Laufender Luftabschnitt: Maus netto gegen die Taste (≥ NO_MOUSE_RATE über die A/D-Ticks, wie StrafeJudge 'against'). */
  private sectionAgainst(): boolean {
    return this.airSideTicks > 0 && this.airTurn < 0 && -this.airTurn >= AGAINST_RATE * this.airSideTicks * this.dt;
  }

  /**
   * Warum Tempo/Tor ohne die Technik nicht zählt: Maus gegen die Taste oder gar kein A/D; −1 = noch offen (die ersten
   * SIDE_EVIDENCE s eines Luftabschnitts — sonst kam im Absprung-Tick "A/D fehlt", bevor Taste und Maus da waren).
   */
  private sideMiss(onGround: boolean): number {
    if (onGround) return this.lastAgainst ? MISS_AGAINST : MISS_NO_SIDE;
    if (this.airTicks * this.dt < SIDE_EVIDENCE) return -1;
    return this.airSideTicks * this.dt >= SIDE_EVIDENCE && this.sectionAgainst() ? MISS_AGAINST : MISS_NO_SIDE;
  }

  onEvent(e: GameEvent): void {
    switch (e.type) {
      case 'respawn':
        this.resetTransient();
        return;
      case 'lessonHop':
      case 'lessonStage':
      case 'gate':
        return;
      default:
        break;
    }
    const st = this.stages[this.si];
    if (!st || (this.suspendedFlag && this.demoDone) || st.task.kind !== 'event' || st.task.event !== e.type) return;
    // Zählen hier (in der Vorführung im Schatten), abschließen im nächsten tick() (Ereignisse gehen nur dort raus).
    this.progress(this.count + 1);
  }

  update(frameDt: number): void {
    const step = frameDt / GATE_DISSOLVE;
    for (let i = 0; i < this.gateOpen.length; i++) {
      const target = this.gateState[i] | this.demoGate[i];
      const v = this.gateOpen[i];
      if (target === 1 && v < 1) this.gateOpen[i] = Math.min(1, v + step);
      else if (target === 0 && v > 0) this.gateOpen[i] = 0;
    }
  }

  respawnPoint(): TrainingSpawn {
    const def = this.level.def;
    let sp: StageDef['spawn'] | undefined;
    for (let i = Math.min(this.si, this.stages.length - 1); i >= 0 && !sp; i--) sp = this.stages[i].spawn;
    const p = sp?.pos ?? def.spawn.pos;
    this.spawnPos.set(p[0], p[1], p[2]);
    this.spawn.yaw = sp?.yaw ?? def.spawn.yaw;
    return this.spawn;
  }

  skipStage(): void {
    if (!this.stages[this.si]) return;
    this.finishStage(null, false);
  }

  restartLesson(): void {
    this.completed.clear();
    this.completedList.length = 0;
    this.passed.fill(0);
    for (let i = 0; i < this.gateState.length; i++) {
      if (this.gateState[i] === 1) this.queue(this.gateEvent(this.level.gates[i].id, false));
      this.gateState[i] = 0;
      this.gateOpen[i] = 0;
    }
    this.demoGate.fill(0);
    this.world?.closeAll();
    this.lastTipAt = Number.NEGATIVE_INFINITY;
    this.verdictTipAt.clear();
    this.missTipAt.fill(Number.NEGATIVE_INFINITY);
    this.enter(0);
  }

  turnBand(speed: number): TurnBand | null {
    const st = this.stages[this.si];
    if (!this.def.hud?.turnBand || !st) return null;
    const t = st.task;
    if (t.kind === 'speed' && t.ground) {
      // Prestrafe am Boden: eigenes, gemessenes Band (zügig, nicht "ganz langsam").
      this.band.lo = PRESTRAFE_BAND_LO;
      this.band.hi = PRESTRAFE_BAND_HI;
      return this.band;
    }
    if (t.kind !== 'goodHops' && t.kind !== 'speed' && t.kind !== 'course') return null;
    return turnBandAt(speed, this.band);
  }

  // ---------------------------------------------------------------- außerhalb des Vertrags

  /** Direkt zu Stufe i springen (Validierung, Debug); vorige Stufen gelten als übersprungen, Tore gehen auf. */
  jumpTo(i: number): void {
    for (let k = 0; k < i && k < this.stages.length; k++) {
      this.passed[k] = 1;
      for (const g of this.stages[k].opens ?? []) this.openGate(g, null);
    }
    this.enter(Math.min(i, this.stages.length));
  }

  /** Aktueller Zählerstand der Stufe (Hops, Landungen, Zehntelsekunden, u/s). */
  get stageCount(): number {
    return this.count;
  }

  // ---------------------------------------------------------------- intern

  private enter(i: number): void {
    this.si = i;
    this.epoch++;
    const st = this.stages[i];
    const h = this.h;
    h.stageIndex = Math.min(i, this.stages.length);
    this.count = 0;
    this.lastSide = 0;
    this.best = 0;
    this.lastProgress = this.time;
    this.repeatCount = 0;
    this.demoTipFired = false;
    this.tipFired.fill(0);
    this.tipDue.fill(-1);
    // Neue Stufe = neuer Zusammenhang: das HUD verwirft den alten Coach-Tipp bei 'lessonStage', also darf der erste
    // Tipp der neuen Stufe sofort kommen (vorher erst TIP_COOLDOWN nach dem alten — Review training-ui: T3 1.3 s zu spät).
    this.lastTipAt = Number.NEGATIVE_INFINITY;
    this.judges = false;
    this.needsSide = false;
    const tk = st?.task;
    this.groundStage = tk?.kind === 'speed' && tk.ground === true;
    this.needsSprint = this.groundStage || (tk?.kind === 'event' && tk.event === 'slideStart');
    this.resetTransient();
    if (!st) {
      h.stageTitle = '';
      h.text = '';
      h.count = 0;
      h.goal = 0;
      return;
    }
    const t = st.task;
    this.goal =
      t.kind === 'goodHops' || t.kind === 'hopChain' || t.kind === 'crouchLand' || t.kind === 'event'
        ? t.count
        : t.kind === 'speed'
          ? (t.holdHops ?? t.min)
          : t.kind === 'surfHold'
            ? t.seconds * 10
            : t.kind === 'surfSpeed'
              ? t.min
              : t.kind === 'course'
                ? t.zones.length
                : 1;
    h.stageTitle = st.title;
    h.text = st.text;
    h.rank = rankOf(st);
    h.goal = Math.round(this.goal) | 0;
    h.count = 0;
    h.style = t.kind === 'surfHold' || t.kind === 'surfSpeed' || (t.kind === 'speed' && t.holdHops === undefined) ? 'bar' : 'pips';
    // Dieselbe Bedingung wie turnBand() ≠ null (hudLogic.stageJudges): Strafe-Aufgabe in einer Lektion mit Drehbalken.
    const strafeLesson = this.def.hud?.turnBand === true;
    this.judges = strafeLesson && (t.kind === 'goodHops' || t.kind === 'speed' || t.kind === 'course');
    this.needsSide = strafeLesson && ((t.kind === 'speed' && t.ground !== true) || t.kind === 'course');
  }

  /** Was eine Teleportation/Vorführung ungültig macht (nicht der Stufenfortschritt goodHops/crouchLand/event). */
  private resetTransient(): void {
    this.judge.reset();
    this.hold = 0;
    this.above = 0;
    this.surfTime = 0;
    // Nicht surfend beginnen: sonst gälte der erste Luft-Tick als Surf-Lücke (900 u/s im Flug = "Surf 800").
    this.offSurf = Number.POSITIVE_INFINITY;
    this.groundTime = 0;
    this.airTime = 0;
    this.airDucked = false;
    this.wasGround = true;
    this.sinceLanding = false;
    this.chain = 0;
    this.lastChain = 0;
    this.airTicks = 0;
    this.airSideTicks = 0;
    this.airTurn = 0;
    this.airSurfed = false;
    this.lastStrafed = false;
    this.lastAgainst = false;
    this.slowTakeoffs = 0;
    this.groundHops = 0;
    this.noSprint = 0;
    this.surfSlow = 0;
    const st = this.stages[this.si];
    const k = st?.task.kind;
    if (k === 'course' || k === 'surfHold' || k === 'surfSpeed' || k === 'speed' || k === 'hopChain') {
      this.coursePos = 0;
      this.count = 0;
      this.h.count = 0;
    }
  }

  /** Zähler setzen (pips); reset = auch Rückschritt erlaubt (Kurs, Serie). Vorführung: nur der Schatten-Zähler. */
  private progress(n: number, reset = false): void {
    if (n > this.count) this.lastProgress = this.time;
    if (n < this.count && !reset) return;
    this.count = n;
    const st = this.stages[this.si];
    if (st?.task.kind === 'course') this.coursePos = n;
    if (!this.suspendedFlag) this.h.count = Math.round(n) | 0;
  }

  /** Balken (Tempo, Zeit): Anzeige = aktueller Wert bis zum Ziel; Fortschritt = neuer Bestwert. */
  private bar(v: number, goal: number): void {
    const c = v > goal ? goal : v;
    if (c > this.best + 1) {
      this.best = c;
      this.lastProgress = this.time;
    }
    this.count = c;
    if (!this.suspendedFlag) this.h.count = Math.floor(c) | 0;
  }

  private complete(out: RunEvent[]): void {
    this.finishStage(out, true);
  }

  /** Stufe abschließen (counts = zählt für Sterne) oder überspringen; Tore auf, Ereignisse, nächste Stufe. */
  private finishStage(out: RunEvent[] | null, counts: boolean): void {
    const i = this.si;
    const st = this.stages[i];
    if (!st) return;
    const wasDone = this.done;
    this.passed[i] = 1;
    if (counts && !this.completed.has(st.id)) {
      this.completed.add(st.id);
      this.completedList.push(st.id);
    }
    for (const g of st.opens ?? []) this.openGate(g, out);
    const e = this.stageRing[this.stageI];
    this.stageI = (this.stageI + 1) % RING;
    e.index = i;
    e.total = this.stages.length;
    e.rank = rankOf(st);
    e.lessonDone = !wasDone && this.done;
    this.push(out, e);
    this.enter(i + 1);
  }

  private openGate(id: string, out: RunEvent[] | null): void {
    const gi = this.gateIndex(id);
    if (gi < 0 || this.gateState[gi] === 1) return;
    this.gateState[gi] = 1;
    this.demoGate[gi] = 0;
    this.world?.setOpen(gi, true);
    this.push(out, this.gateEvent(id, true));
  }

  /** Vorführung hat die Stufe geschafft: ihre Tore nur für die Vorführung öffnen (kein Ereignis, kein Fortschritt). */
  private demoFinish(st: StageDef): void {
    this.demoDone = true;
    for (const id of st.opens ?? []) {
      const gi = this.gateIndex(id);
      if (gi < 0 || this.gateState[gi] === 1) continue;
      this.demoGate[gi] = 1;
      this.world?.setOpen(gi, true);
    }
  }

  /** Vorführungs-Tore wieder zu (Kollision sofort, Optik in update()). */
  private closeDemoGates(): void {
    for (let i = 0; i < this.demoGate.length; i++) {
      if (this.demoGate[i] === 0) continue;
      this.demoGate[i] = 0;
      if (this.gateState[i] === 0) this.world?.setOpen(i, false);
    }
  }

  private gateIndex(id: string): number {
    const gates = this.level.gates;
    for (let i = 0; i < gates.length; i++) if (gates[i].id === id) return i;
    return -1;
  }

  private gateEvent(id: string, open: boolean): GateEvent {
    const e = this.gateRing[this.gateI];
    this.gateI = (this.gateI + 1) % RING;
    e.id = id;
    e.open = open;
    return e;
  }

  private push(out: RunEvent[] | null, e: RunEvent): void {
    if (out) out.push(e);
    else this.queue(e);
  }

  private queue(e: RunEvent): void {
    if (this.pendingN < this.pending.length) this.pending[this.pendingN] = e;
    else this.pending.push(e);
    this.pendingN++;
  }

  private emitHop(out: RunEvent[], counted: boolean): void {
    const r = this.judge.last;
    const e = this.hopRing[this.hopI];
    this.hopI = (this.hopI + 1) % RING;
    e.verdict = r.verdict;
    e.gain = r.gain;
    e.counted = counted;
    e.count = this.h.count;
    e.goal = this.h.goal;
    out.push(e);
  }

  /** Wiederholtes schlechtes Urteil → Coach-Text (nur in Stufen, die Strafen bewerten: `judges`). */
  private noteVerdict(): void {
    const v = this.judge.last.verdict;
    if (v === 'good') {
      this.repeatCount = 0;
      return;
    }
    this.repeatCount = v === this.repeatVerdict ? this.repeatCount + 1 : 1;
    this.repeatVerdict = v;
    if (this.repeatCount < VERDICT_REPEAT) return;
    const last = this.verdictTipAt.get(v) ?? Number.NEGATIVE_INFINITY;
    if (this.time - last < VERDICT_TIP_AGAIN || !this.tipReady()) return;
    this.verdictTipAt.set(v, this.time);
    this.showTip(VERDICT_TEXT[v].long, 'verdict');
    this.repeatCount = 0;
  }

  private tipReady(): boolean {
    return this.time - this.lastTipAt >= TIP_COOLDOWN;
  }

  private showTip(text: string, kind: LessonTip['kind']): void {
    this.tip.text = text;
    this.tip.kind = kind;
    this.tip.serial++;
    this.lastTipAt = this.time;
  }

  /** Erklär-Tipp (Cooldown wie alle Tipps, derselbe Text frühestens nach MISS_TIP_AGAIN). */
  private missTip(reason: number, kind: LessonTip['kind']): void {
    if (this.time - this.missTipAt[reason] < MISS_TIP_AGAIN || !this.tipReady()) return;
    this.missTipAt[reason] = this.time;
    this.showTip(MISS_TEXT[reason], kind);
  }

  private tips(st: StageDef, cur: PlayerSnapshot, hullH: number, judged: boolean): void {
    const list = st.tips;
    const now = this.time;
    if (list) {
      for (let i = 0; i < list.length; i++) {
        if (this.tipFired[i] === 1) continue;
        const tip = list[i];
        const inZone = tip.zone === undefined ? true : this.inZone(tip.zone, cur, hullH);
        const hold = this.tipCondition(tip, cur, judged, now) && inZone;
        // Zustände (alles außer 'verdict') verfallen, sobald die Bedingung bricht; 'stuck' und 'land' tragen ihr
        // `after` schon in der Bedingung.
        const isState = tip.on !== 'verdict';
        if (hold) {
          if (this.tipDue[i] < 0) this.tipDue[i] = tip.on === 'stuck' || tip.on === 'land' ? now : now + (tip.after ?? 0);
        } else if (isState) this.tipDue[i] = -1;
        if (this.tipDue[i] >= 0 && now >= this.tipDue[i] && this.tipReady()) {
          this.tipFired[i] = 1;
          this.showTip(tip.text, 'stage');
        }
      }
    }
    if (!this.demoTipFired && st.demo && now - this.lastProgress >= STUCK_AFTER && this.tipReady()) {
      this.demoTipFired = true;
      this.showTip(DEMO_TIP_TEXT, 'demo');
    }
  }

  private tipCondition(tip: StageTipDef, cur: PlayerSnapshot, judged: boolean, now: number): boolean {
    switch (tip.on) {
      case 'air':
        // In Stufen mit Urteil ist ein Luft-Tipp Strafe-Anleitung ("JETZT: A HALTEN …") — die gilt erst mit Anlauf. Ohne
        // Anlauf belegte er die Tipp-Sperre, und "ERST ANLAUFEN" kam 6 s zu spät (Probe T3: Leertaste + A ohne W).
        return !cur.onGround && !cur.surfing && (!this.judges || this.takeoffSpeed >= MIN_TAKEOFF);
      case 'land':
        // Zustand: gelandet und seither ≥ after s am Boden (0 = schon im Landetick).
        return cur.onGround && this.sinceLanding && this.groundTime >= (tip.after ?? 0) - 1e-9;
      case 'surf':
        return cur.surfing;
      case 'zone':
        return true;
      case 'verdict':
        return judged && this.judge.last.verdict === tip.verdict;
      case 'stuck':
        return now - this.lastProgress >= (tip.after ?? STUCK_AFTER);
    }
  }

  private inZone(id: string, cur: PlayerSnapshot, hullH: number): boolean {
    const z = this.level.zones.get(id);
    return z !== undefined && hullIn(z, cur.pos, hullH);
  }
}

/** Vorführung einer Stufe (Taste H): Eingabe je Tick; Game übergibt pm.state und pm.surfNormal. */
export interface DemoRunner {
  /** Höchstdauer (s), danach endet die Vorführung. */
  readonly seconds: number;
  next(s: PlayerSnapshot, surfNormal: Vector3): PlayerInput;
}

/**
 * Routen-Vorführung in Strafe-Lektionen (T5): ein Knoten gilt als erreicht, sobald die Füße so nah sind (u, waagrecht) —
 * dann zielt die Hand aufs nächste Tor (Tore 576 breit; 300/400 tragen alle T5-Stufen, 250 nicht jede).
 */
export const DEMO_STEER_REACH = 300;
/** Surf-Vorführung: Reaktion nach dem ersten Flankenkontakt (s) — sauber, aber menschlich. */
export const DEMO_SURF_REACT = 0.1;
/** Vorführung: niedrige Decke so weit voraus (s × Tempo, mindestens DUCK_LOOK_MIN u) → ducken; DUCK_PLAN → nicht mehr hüpfen. */
const DUCK_LOOK = 0.35;
const DUCK_PLAN = 1.5;
const DUCK_LOOK_MIN = 48;

/**
 * Vorführung bauen (einmal je Druck auf H, nicht im Tick-Pfad), deterministisch — dieselbe Stufe zeigt jedes
 * Mal dieselbe Vorführung (check.ts prüft, dass sie die Stufe schafft):
 * - hand: fehlerfreie BeginnerHand mit festem Seed (Strafe-Lektionen). In einer Prestrafe-Stufe (speed am Boden) die
 *   PrestrafeHand: Anlauf mit W, dann W + A/D und die Maus mit `rateDeg` in Tastenrichtung, nie ein Sprung — die
 *   Stufe gehört zur Vorführung (gleiches DemoDef-Objekt wie in der Stufe; Game, Werkzeuge und Tests reichen es durch).
 * - route mit Surf-Knoten: SurfHand entlang der Achse der Surf-Knoten (Taste in die Rampe, Blick entlang) —
 *   genau die Grundtechnik der Lektion. Der RouteFollower regelt auf eine Linie und strafet an der Flanke;
 *   in T8 kam er so nie über 800 u/s (Median 613).
 * - route mit style 'walk'/'hold' (DemoDef): schlichte Vorführung ohne A/D (PlainDemo) — nur W bzw. W + Leertaste.
 * - route ohne style in einer Lektion OHNE Drehbalken (hud.turnBand; T1/T2/T6 lehren kein Strafen): 'jump' — W mit
 *   Sprint, Sprung an jedem `jump`-Knoten, bei `crouch` in der Luft ducken, vor einer niedrigen Decke ducken statt
 *   springen (T1 Tunnel: Sprint + C = Rutschen). Vorher strafte dort der RouteFollower mit A/D bis 640 u/s, während
 *   die Stufe "NORMAL SPRINGEN" bzw. "W HALTEN" sagte (Review rv-tc3).
 * - route sonst (Strafe-Lektion, T5): SteerDemo — die fehlerfreie Demo-Hand fliegt von Knoten zu Knoten wie ein Mensch,
 *   der das nächste Tor sieht: je Landung die Seite zum Ziel, A bzw. D die ganze Luft und die Maus mit (Rate aus der
 *   Kursabweichung, HAND_MODELS.demoLenker). Vorher der RouteFollower: A/D wechselte alle 0.03–0.1 s (Showkeys
 *   flackerten, 1216 A/D-Ticks in 9.7 s, bis 940 u/s) — nicht "KURVE = EINE SEITE HALTEN". `DemoDef.aimNoiseDeg` liest
 *   niemand mehr. `world` (GatedWorld des Spiels) braucht heute keine Vorführung; Decken sieht DuckAhead in level.world.
 */
export function createDemo(demo: DemoDef, level: CompiledLevel, cfg: MovementConfig, world: CollisionWorld, spawn: TrainingSpawn): DemoRunner {
  if (demo.kind === 'hand') {
    const heading = (spawn.yaw * Math.PI) / 180;
    if (isPrestrafeDemo(demo, level)) {
      const pre = new PrestrafeHand(cfg, { rateDeg: demo.rateDeg, side: demo.side, heading });
      return { seconds: demo.seconds, next: () => pre.next() };
    }
    const hand = new BeginnerHand(cfg, demoModel(demo), { seed: DEMO_SEED, heading, side: demo.side });
    return { seconds: demo.seconds, next: (s) => hand.next(s) };
  }
  const route = (level.def.route ?? []).slice(demo.from, demo.to + 1);
  const style = routeStyle(demo, level, route);
  if (style === 'walk' || style === 'hold' || style === 'jump') {
    // 'hold' lehrt Auto-Hop: ohne Auto-Hop (nur, wenn doch eine Spieler-Config durchschlägt) hüpft sie einmal —
    // frisch drücken je Landung hüpfte auf der Stelle ohne Anlauf (Info-Zeile in check.ts).
    const plain = new PlainDemo(route, style, spawn.pos, style === 'jump' ? new DuckAhead(cfg, level.world) : null, cfg.tickRate);
    return { seconds: demo.seconds, next: (s) => plain.next(s) };
  }
  const axis = surfAxis(route);
  if (axis !== null) {
    const surf = new SurfHand(cfg, { seed: DEMO_SEED, heading: axis, react: DEMO_SURF_REACT, noiseDeg: 0 });
    return { seconds: demo.seconds, next: (s, n) => surf.next(s, n) };
  }
  const steer = new SteerDemo(route, cfg, spawn);
  return { seconds: demo.seconds, next: (s) => steer.next(s) };
}

/**
 * Routen-Vorführung in Strafe-Lektionen: BeginnerHand (HAND_MODELS.demoLenker, fester Seed) mit dem nächsten Knoten
 * als Ziel; Knoten hinter dem Start gelten als erreicht, ein Knoten näher als DEMO_STEER_REACH auch. Am letzten Knoten
 * bleibt er das Ziel. Tick-Pfad ohne Allokation (Ziel-Objekt wird fortgeschrieben).
 */
class SteerDemo {
  private i = 0;
  private readonly goal = { x: D0, z: D0 };
  private readonly hand: BeginnerHand;

  constructor(
    private readonly route: readonly RouteNode[],
    cfg: MovementConfig,
    spawn: TrainingSpawn,
  ) {
    const start = spawn.pos;
    while (this.i < route.length - 1) {
      const a = route[this.i].pos;
      const b = route[this.i + 1].pos;
      if ((start.x - a[0]) * (b[0] - a[0]) + (start.z - a[2]) * (b[2] - a[2]) <= 0) break;
      this.i++;
    }
    this.aim();
    this.hand = new BeginnerHand(cfg, HAND_MODELS.demoLenker, { seed: DEMO_SEED, heading: (spawn.yaw * Math.PI) / 180, goal: this.goal });
  }

  next(s: PlayerSnapshot): PlayerInput {
    const r = this.route;
    while (this.i < r.length - 1) {
      const dx = r[this.i].pos[0] - s.pos.x;
      const dz = r[this.i].pos[2] - s.pos.z;
      if (dx * dx + dz * dz >= DEMO_STEER_REACH * DEMO_STEER_REACH) break;
      this.i++;
    }
    this.aim();
    return this.hand.next(s);
  }

  private aim(): void {
    const p = this.route[this.i].pos;
    this.goal.x = p[0];
    this.goal.z = p[2];
  }
}

/** Wer eine Vorführung spielt (createDemo). */
export type DemoStyle = 'hand' | 'prestrafe' | 'surf' | 'route' | 'walk' | 'hold' | 'jump';

/** Welcher Bot eine Vorführung spielt (wie createDemo entscheidet) — für Werkzeuge und Tests. */
export function demoStyle(demo: DemoDef, level: CompiledLevel): DemoStyle {
  if (demo.kind === 'hand') return isPrestrafeDemo(demo, level) ? 'prestrafe' : 'hand';
  return routeStyle(demo, level, (level.def.route ?? []).slice(demo.from, demo.to + 1));
}

/** Hand-Vorführung einer Prestrafe-Stufe (speed am Boden)? Die Stufe über das DemoDef-Objekt (einmal je H, kein Tick-Pfad). */
function isPrestrafeDemo(demo: DemoDef, level: CompiledLevel): boolean {
  const st = level.def.training?.stages.find((s) => s.demo === demo);
  return st !== undefined && st.task.kind === 'speed' && st.task.ground === true;
}

function routeStyle(demo: Extract<DemoDef, { kind: 'route' }>, level: CompiledLevel, route: readonly RouteNode[]): DemoStyle {
  if (demo.style) return demo.style;
  if (surfAxis(route) !== null) return 'surf';
  // Ohne Drehbalken lehrt die Lektion kein Strafen (dieselbe Grenze wie die Urteile, hudLogic.stageJudges).
  return level.def.training?.hud?.turnBand === true ? 'route' : 'jump';
}

/** Schlichte Vorführung: nächster Knoten gilt als erreicht unter so viel Abstand (u, waagrecht). */
const PLAIN_REACH = 96;
/**
 * 'jump': C so lange (s) nach dem Absprung an einem crouch-Knoten, bis zur Landung gehalten. T6-Raster: 66er-Kante
 * trägt Ducken 0.05–0.35 s nach dem Absprung, 72er 0.05–0.2 s — 0.1 liegt in beiden.
 */
const PLAIN_DUCK_AFTER = 0.1;

/**
 * Vorführung ohne Strafen, nie A/D (Plan 007 Phase 3 + Review rv-tc3): 'walk' = nur W (mit Sprint wie Auto-Sprint),
 * 'hold' = W + Leertaste gehalten, 'jump' = W, an jedem `jump`-Knoten ein Druck auf die Leertaste (bei `crouch` in
 * der Luft C) und vor einer niedrigen Decke ducken statt springen (DuckAhead). Blick auf den nächsten Route-Knoten,
 * der noch > PLAIN_REACH voraus liegt — in der Luft zieht die Luftlenkung mit W die Bahn nach; einen Absprung-Knoten
 * überspringt sie nicht, sie springt, sobald sie ihn (am Boden) erreicht oder überlaufen hat. Knoten, hinter denen der
 * Start schon liegt, gelten als erreicht (sonst lief sie vom Stufen-Spawn zurück). Vorher zeigte T1 LAUFEN einen
 * strafenden Bhop mit 509 u/s, T2 HALTEN 608 u/s mit gedrücktem D. Am letzten Knoten bleibt sie stehen.
 * Tick-Pfad: ohne Allokation.
 */
class PlainDemo {
  private i = 0;
  private first = true;
  /** Luftzeit seit dem Absprung (s); 0 am Boden. Double-Startwert (D0), im Konstruktor auf 0. */
  private airT = D0;
  /** Der letzte Absprung war an einem crouch-Knoten: in der Luft ducken. */
  private duckJump = false;
  private readonly out = makeBotInput();
  private readonly dt: number;

  constructor(
    private readonly route: readonly RouteNode[],
    private readonly mode: 'walk' | 'hold' | 'jump',
    start: Vector3,
    private readonly duck: DuckAhead | null,
    tickRate: number,
  ) {
    this.dt = 1 / tickRate;
    this.airT = 0;
    while (this.i < route.length - 1) {
      const a = route[this.i].pos;
      const b = route[this.i + 1].pos;
      if ((start.x - a[0]) * (b[0] - a[0]) + (start.z - a[2]) * (b[2] - a[2]) <= 0) break;
      this.i++;
    }
  }

  next(s: PlayerSnapshot): PlayerInput {
    const r = this.route;
    const last = r.length - 1;
    const jumpMode = this.mode === 'jump';
    let dx = 0;
    let dz = 0;
    let jump = false;
    let aim = this.i;
    for (;;) {
      const n = r[this.i];
      dx = n.pos[0] - s.pos.x;
      dz = n.pos[2] - s.pos.z;
      aim = this.i;
      if (this.i >= last) break;
      const near = dx * dx + dz * dz <= PLAIN_REACH * PLAIN_REACH;
      if (jumpMode && n.jump === true) {
        // Absprung-Knoten: in der Nähe schon auf den Landeknoten zielen (sonst dreht der Blick auf den letzten u um).
        if (near) aim = this.i + 1;
        const nb = r[this.i + 1].pos;
        const passed = -dx * (nb[0] - n.pos[0]) - dz * (nb[2] - n.pos[2]) >= 0;
        if (!passed || !s.onGround) break;
        jump = true;
        this.duckJump = n.crouch === true;
        this.i++;
        continue;
      }
      if (!near) break;
      this.i++;
    }
    const t = r[aim].pos;
    const ax = t[0] - s.pos.x;
    const az = t[2] - s.pos.z;
    const o = this.out;
    const done = this.i >= last && dx * dx + dz * dz <= PLAIN_REACH * PLAIN_REACH;
    o.yaw = yawOf(ax, az);
    o.pitch = 0;
    o.forward = done ? 0 : 1;
    o.side = 0;
    o.sprint = true;
    if (s.onGround) {
      if (this.airT > 0) this.duckJump = false;
      this.airT = 0;
    } else this.airT += this.dt;
    let crouch = this.duckJump && this.airT >= PLAIN_DUCK_AFTER;
    const d = this.duck;
    if (d !== null) {
      d.update(s);
      if (!d.jump) jump = false;
      crouch = crouch || d.duck;
    }
    o.crouch = crouch;
    if (jumpMode) {
      o.jumpHeld = jump;
      o.jumpPressed = jump;
    } else {
      o.jumpHeld = this.mode === 'hold' && !done;
      o.jumpPressed = this.mode === 'hold' && this.first;
    }
    this.first = false;
    return o;
  }
}

/** Achse (yaw, rad) vom ersten zum letzten Surf-Knoten einer Route; null = weniger als zwei Surf-Knoten. */
function surfAxis(route: readonly RouteNode[]): number | null {
  let first: RouteNode | null = null;
  let last: RouteNode | null = null;
  for (const n of route) {
    if (!n.surf) continue;
    if (!first) first = n;
    last = n;
  }
  if (!first || !last || first === last) return null;
  return yawOf(last.pos[0] - first.pos[0], last.pos[2] - first.pos[2]);
}

/**
 * Niedrige Decke voraus? Stand-Hull und Duck-Hull entlang der Fahrt (1 u angehoben, Stufen) sweepen: kommt die
 * geduckte deutlich weiter, liegt eine Decke im Weg (Wände und Stufen blockieren beide gleich). Liegt sie
 * innerhalb von DUCK_PLAN s, bleibt die Vorführung am Boden (kein Hüpfen: Rutschen geht nur vom Boden aus), ab
 * DUCK_LOOK s duckt sie. Unter einer Decke (Stand-Hull steckt) bleibt sie geduckt. Einmal je Tick
 * (update), danach `jump`/`duck` lesen. Ohne Allokation.
 */
class DuckAhead {
  /** Hüpfen erlaubt (keine Decke in Sicht). */
  jump = true;
  duck = false;
  private readonly from = new Vector3();
  private readonly to = new Vector3();
  private readonly mins: Vector3;
  private readonly stand: Vector3;
  private readonly crouch: Vector3;
  private readonly tr = makeTraceResult();

  constructor(
    cfg: MovementConfig,
    private readonly world: CollisionWorld,
  ) {
    const h = cfg.hull;
    this.mins = new Vector3(-h.halfWidth, 0, -h.halfWidth);
    this.stand = new Vector3(h.halfWidth, h.standHeight, h.halfWidth);
    this.crouch = new Vector3(h.halfWidth, h.duckHeight, h.halfWidth);
  }

  update(s: PlayerSnapshot): void {
    this.jump = true;
    this.duck = false;
    const sp = s.speed;
    this.from.set(s.pos.x, s.pos.y + 1, s.pos.z);
    if (s.onGround && this.world.testBox(this.from, this.mins, this.stand)) {
      this.jump = false;
      this.duck = true;
      return;
    }
    if (sp < 1) return;
    const far = Math.max(DUCK_LOOK_MIN, sp * DUCK_PLAN);
    const k = far / sp;
    this.to.set(s.pos.x + s.vel.x * k, s.pos.y + 1, s.pos.z + s.vel.z * k);
    const standFrac = this.world.traceBox(this.from, this.to, this.mins, this.stand, this.tr).fraction;
    if (standFrac >= 1) return;
    if (this.world.traceBox(this.from, this.to, this.mins, this.crouch, this.tr).fraction <= standFrac + 0.05) return;
    this.jump = false;
    this.duck = s.onGround && standFrac * far <= Math.max(DUCK_LOOK_MIN, sp * DUCK_LOOK);
  }
}

function rankOf(s: StageDef): StageRank {
  return s.rank ?? 'required';
}

/** Hull (32 breit, Höhe hullH, Füße bei pos) überlappt die Zone. */
export function hullIn(z: Box3, pos: Vector3, hullH: number): boolean {
  return pos.x - 16 < z.max.x && pos.x + 16 > z.min.x && pos.y < z.max.y && pos.y + hullH > z.min.y && pos.z - 16 < z.max.z && pos.z + 16 > z.min.z;
}
