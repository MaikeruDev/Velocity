import { Vector3 } from 'three';
import type { Box3 } from 'three';
import { VELOCITY_DEFAULT, withMovement } from '../player/MovementConfig';
import type { MovementConfig } from '../player/MovementConfig';
import { BeginnerHand, DEMO_SEED, SurfHand, demoModel } from '../player/bots/BeginnerHand';
import { makeBotInput, yawOf } from '../player/bots/Bot';
import { RouteFollower } from '../player/bots/RouteFollower';
import type { PlayerInput, PlayerSnapshot } from '../player/types';
import type { LessonHud } from '../ui/types';
import type { GatedWorld } from '../world/collision/GatedWorld';
import type { CollisionWorld } from '../world/collision/types';
import { makeTraceResult } from '../world/collision/types';
import type { CompiledLevel } from '../world/level/compileLevel';
import type { DemoDef, RouteNode, StageDef, StageRank, StageTipDef, TrainingDef } from '../world/level/LevelFormat';
import type { GameEvent, RunEvent } from './events';
import { COUNT_SIDE_SHARE, PRESTRAFE_BAND_HI, PRESTRAFE_BAND_LO, StrafeJudge, VERDICT_TEXT, turnBandAt } from './strafeJudge';
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
/** Gut, aber nicht gezählt (falsche Seite, A/D zu spät): derselbe Erklär-Tipp frühestens wieder nach … s. */
export const MISS_TIP_AGAIN = 15;
/** Erklär-Tipps für gute, aber nicht gezählte Hops (Index = MissReason). */
export const MISS_TEXT = [
  'GUT! JETZT DIE ANDERE SEITE:\nD + MAUS NACH RECHTS',
  'GUT! JETZT DIE ANDERE SEITE:\nA + MAUS NACH LINKS',
  'GUT, ABER HIER NACH LINKS:\nA + MAUS NACH LINKS',
  'GUT, ABER HIER NACH RECHTS:\nD + MAUS NACH RECHTS',
  'GUT, ABER A/D GLEICH NACH DEM\nABSPRUNG DRÜCKEN UND HALTEN',
] as const;
const MISS_NEXT_RIGHT = 0;
const MISS_NEXT_LEFT = 1;
const MISS_LEFT = 2;
const MISS_RIGHT = 3;
const MISS_EARLY = 4;
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

  // Vorführung (Schatten-Auswertung, s. Kopf)
  private demoDone = false;
  private demoEpoch = -1;
  private savedCount = D0;
  private savedSide = 0;
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
      this.demoEpoch = this.epoch;
      this.demoDone = false;
      this.count = 0;
      this.lastSide = 0;
      this.coursePos = 0;
    } else {
      this.closeDemoGates();
      if (this.demoEpoch === this.epoch) {
        this.count = this.savedCount;
        this.lastSide = this.savedSide;
        this.h.count = Math.round(this.savedCount) | 0;
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
    }
    if (landed) this.sinceLanding = true;
    if (!cur.onGround && cur.ducked) this.airDucked = true;
    this.wasGround = cur.onGround;

    const st = this.stages[this.si];
    const demo = this.suspendedFlag;
    if (!st || (demo && this.demoDone)) {
      if (judged) this.emitHop(out, false);
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
            if (cur.speed >= t.min) {
              this.hold++;
              counted = true;
            } else this.hold = 0;
            this.progress(Math.min(this.hold, t.holdHops), true);
          }
        } else if (t.ground) {
          const ok = cur.onGround && !cur.ducked && !cur.sliding && this.groundTime >= PRESTRAFE_GROUND;
          this.above = ok && cur.speed >= t.min ? this.above + dt : 0;
          // Balken bis knapp unter das Ziel; voll erst, wenn das Tempo PRESTRAFE_HOLD gehalten ist.
          this.bar(ok ? Math.min(cur.speed, this.above >= PRESTRAFE_HOLD ? t.min : t.min - 1) : 0, t.min);
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
        const z0 = this.level.zones.get(t.zones[0]);
        // Wieder durch die erste Zone (neuer Anlauf nach einer Runde) → von vorn ab 1.
        if (this.coursePos > 1 && z0 && cur.speed >= t.minSpeed && hullIn(z0, cur.pos, hullH)) this.progress(1, true);
        const z = this.coursePos < n ? this.level.zones.get(t.zones[this.coursePos]) : undefined;
        if (z && cur.speed >= t.minSpeed && hullIn(z, cur.pos, hullH)) {
          this.progress(this.coursePos + 1);
          finish = this.coursePos >= n;
        }
        break;
      }
      case 'event':
        finish = this.count >= t.count;
        break;
    }
    if (demo) {
      // Vorführung: Urteile ja (ohne Pip), Stufe nur im Schatten — ihre Tore öffnen nur für die Vorführung.
      if (judged) this.emitHop(out, false);
      if (finish) this.demoFinish(st);
      return;
    }
    // Erst das Urteil (mit dem Zählerstand dieser Stufe: die HUD-Pips poppen 5/5), dann der Stufenabschluss.
    if (judged) {
      this.emitHop(out, counted);
      this.noteVerdict(st);
    }
    if (finish) this.complete(out);
    else {
      if (miss >= 0) this.missTip(miss);
      this.tips(st, cur, hullH, judged);
    }
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

  /** Wiederholtes schlechtes Urteil → Coach-Text (nur in Stufen, in denen Strafen zählt). */
  private noteVerdict(st: StageDef): void {
    const v = this.judge.last.verdict;
    if (v === 'good') {
      this.repeatCount = 0;
      return;
    }
    const k = st.task.kind;
    if (k !== 'goodHops' && k !== 'speed' && k !== 'course') return;
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

  /** Gut, aber nicht gezählt: Erklär-Tipp (Cooldown wie alle Tipps, derselbe Text frühestens nach MISS_TIP_AGAIN). */
  private missTip(reason: number): void {
    if (this.time - this.missTipAt[reason] < MISS_TIP_AGAIN || !this.tipReady()) return;
    this.missTipAt[reason] = this.time;
    this.showTip(MISS_TEXT[reason], 'verdict');
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
        return !cur.onGround && !cur.surfing;
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

/** Zielfehler der Routen-Vorführung, wenn DemoDef keinen nennt (Grad, 1σ — "Hand 3°"). */
export const DEMO_ROUTE_NOISE = 3;
/** Surf-Vorführung: Reaktion nach dem ersten Flankenkontakt (s) — sauber, aber menschlich. */
export const DEMO_SURF_REACT = 0.1;
/** Vorführung: niedrige Decke so weit voraus (s × Tempo, mindestens DUCK_LOOK_MIN u) → ducken; DUCK_PLAN → nicht mehr hüpfen. */
const DUCK_LOOK = 0.35;
const DUCK_PLAN = 1.5;
const DUCK_LOOK_MIN = 48;

/**
 * Vorführung bauen (einmal je Druck auf H, nicht im Tick-Pfad), deterministisch — dieselbe Stufe zeigt jedes
 * Mal dieselbe Vorführung (check.ts prüft, dass sie die Stufe schafft):
 * - hand: fehlerfreie BeginnerHand mit festem Seed (Strafe-Lektionen).
 * - route mit Surf-Knoten: SurfHand entlang der Achse der Surf-Knoten (Taste in die Rampe, Blick entlang) —
 *   genau die Grundtechnik der Lektion. Der RouteFollower regelt auf eine Linie und strafet an der Flanke;
 *   in T8 kam er so nie über 800 u/s (Median 613).
 * - route sonst: RouteFollower auf LevelFile.route[from..to] ab dem Stufen-Spawn; am Boden duckt die Vorführung
 *   vor einer niedrigen Decke (T1 Tunnel: Sprint + C = Rutschen), wie ein Mensch, der den Tunnel sieht.
 */
export function createDemo(demo: DemoDef, level: CompiledLevel, cfg: MovementConfig, world: CollisionWorld, spawn: TrainingSpawn): DemoRunner {
  if (demo.kind === 'hand') {
    const hand = new BeginnerHand(cfg, demoModel(demo), { seed: DEMO_SEED, heading: (spawn.yaw * Math.PI) / 180, side: demo.side });
    return { seconds: demo.seconds, next: (s) => hand.next(s) };
  }
  const route = (level.def.route ?? []).slice(demo.from, demo.to + 1);
  const axis = surfAxis(route);
  if (axis !== null) {
    const surf = new SurfHand(cfg, { seed: DEMO_SEED, heading: axis, react: DEMO_SURF_REACT, noiseDeg: 0 });
    return { seconds: demo.seconds, next: (s, n) => surf.next(s, n) };
  }
  const rf = new RouteFollower(route, cfg, {
    aimNoiseDeg: demo.aimNoiseDeg ?? DEMO_ROUTE_NOISE,
    seed: DEMO_SEED,
    killY: level.def.killY,
    start: { x: spawn.pos.x, z: spawn.pos.z },
    world,
    timeout: demo.seconds,
  });
  // Decken sieht die Vorführung in der statischen Welt: ein geschlossenes Tor vor dem Tunnel ist keine Decke.
  const duck = new DuckAhead(cfg, level.world);
  const out = makeBotInput();
  return {
    seconds: demo.seconds,
    next: (s, n) => {
      const i = rf.next(s, n);
      out.forward = i.forward;
      out.side = i.side;
      duck.update(s);
      out.jumpHeld = i.jumpHeld && duck.jump;
      out.jumpPressed = i.jumpPressed && duck.jump;
      out.sprint = i.sprint;
      out.yaw = i.yaw;
      out.pitch = i.pitch;
      out.crouch = i.crouch || duck.duck;
      return out;
    },
  };
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
