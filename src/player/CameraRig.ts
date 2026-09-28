import { MathUtils, type PerspectiveCamera, Vector3 } from 'three';
import type { GameEvent } from '../engine/events';
import { VELOCITY_DEFAULT, airSpeedCapAt, type MovementConfig } from './MovementConfig';
import type { PlayerSnapshot } from './types';

/**
 * First-Person-Kamera (die View-Hand ist ein eigenes 3D-Viewmodel mit fester Kamera, render/viewmodel — die Kamera weiß nichts von ihr). Der Blick (yaw/pitch) geht 1:1 durch —
 * nie geglättet, nie verzögert; Yaw ist immer exakt der Blick. Alles andere
 * sind additive Offsets mit eigener Dynamik, jeweils mit ihrer Einstellung
 * skaliert (0 = exakt aus):
 *   headBob     → nur der Lauf-Bob (Hub, seitlich, Nicken)
 *   motionFx    → Bewegungs-Feedback: Lande-Dip, Sprung-Kick, Carve-Roll,
 *                 Surf-Lean, Perfekt-Hop-Pop und Sync-Surge (die beiden FOV-
 *                 Signale zusätzlich × fovKick), Surf-Rumpeln (× screenShake)
 *   screenShake → Rumpeln harter Landungen — nur Translation (+ etwas Roll); Surf- und
 *                 Rutsch-Rumpeln hängen zusätzlich an motionFx
 *   fovKick     → FOV-Kick mit Speed (Log-Kurve: jede Verdopplung gleich viel,
 *                 ab 800 u/s weich gesättigt, gesamt ≤ 11° = 116.5° bei 16:9)
 * Stufen-, Lip-Step- und Duck-Glättung sind keine Effekte, sondern Ruck-Schutz — immer an.
 * Rutschen (Plan 007): kein Head-Bob (keine Schritte), Carve-Roll aus dem Lenken, Rumpeln.
 *
 * Vokabular: Tempo = FOV (log), Timing = Pop (perfekter Hop, statt Dip),
 * Strafe-Qualität = Surge (FOV öffnet sich, solange der Strafe sitzt),
 * Kurve = Roll aus der Querbeschleunigung, Surf = Lean zur Rampennormale.
 */

export interface CameraRigSettings {
  readonly headBob: number;
  readonly screenShake: number;
  readonly fovKick: number;
  /** Horizontales FOV in Grad bei 4:3 (CS-Konvention, 90). */
  readonly fov: number;
  /** Bewegungs-Feedback (Dip, Pop, Roll, Surge, Surf-Lean). Fehlt → 1. */
  readonly motionFx?: number;
}

export interface CameraView {
  /** Augenposition in Weltkoordinaten (interpoliert: pos + eyeHeight). */
  readonly eyePos: Vector3;
  /** Augenhöhe über den Füßen (Füße = eyePos.y − eyeHeight) — trennt Ducken von Stufen. */
  readonly eyeHeight: number;
  /** Bodennormale ((0,1,0) in der Luft) — trennt Rampen von Stufen. */
  readonly groundNormal: Vector3;
  /** Geschwindigkeit; am Boden ist vel.y im Snapshot exakt 0 (PlayerMovement). */
  readonly vel: Vector3;
  /** Horizontal-Speed u/s (vom neueren Tick, nicht interpoliert). */
  readonly speed: number;
  readonly onGround: boolean;
  readonly ducked: boolean;
  readonly stridePhase: number;
  readonly surfing: boolean;
  /** Normale der Surf-Fläche ((0,0,0), wenn nicht surfend) — für den Surf-Lean. */
  readonly surfNormal: Vector3;
  /** Sprint-Taste gehalten (nur Information; der FOV hängt allein am Speed). */
  readonly sprinting: boolean;
  /** -1..1 (A = -1, D = +1). Nur Information — der Roll kommt aus der Bewegung, nicht aus der Taste. */
  readonly strafeInput: number;
  /** Rutscht (Snapshot.sliding): kein Head-Bob, Rutsch-Rumpeln, Carve-Roll aus dem Lenken. */
  readonly sliding: boolean;
  /**
   * Interpolationsanteil des neuesten Ticks (0..1), 1 = ohne Interpolation. Der Lip-Step-Versatz
   * gleicht damit genau den Teil der Stufe aus, den die Interpolation schon zeigt.
   */
  readonly tickAlpha: number;
}

export type MutableCameraView = { -readonly [K in keyof CameraView]: CameraView[K] };

/** Effekt-Anteile nach dem letzten update(), bereits mit den Einstellungen skaliert — für Tests und Messwerkzeuge. */
export interface CameraFxState {
  /** Speed-FOV-Kick (horizontale Grad bei 4:3, × fovKick). */
  readonly speedKick: number;
  /** Perfekt-Hop-Pop (Grad, × fovKick × motionFx). */
  readonly pop: number;
  /** Sync-Surge (Grad, × fovKick × motionFx). */
  readonly surge: number;
  /** Gesamter FOV-Offset nach der weichen Kappe (Grad). */
  readonly fovOffset: number;
  /** Roll in Grad (+ = rechts neigen), ohne Shake. */
  readonly roll: number;
  /** Lande-Dip in u (≤ 0). */
  readonly dip: number;
  /** Shake-Hüllkurve: maximale Translation in u. */
  readonly shake: number;
  /** Surf-Rumpeln: Amplitude in u. */
  readonly rumble: number;
  /** Rutsch-Rumpeln: Amplitude in u (× screenShake × motionFx). */
  readonly slideRumble: number;
  /** Lip-Step-Versatz in u (≤ 0, Ruck-Schutz — immer an). */
  readonly ledgeOffset: number;
  /** Querbeschleunigung u/s² (+ = Rechtskurve) und Speed-Gewinnrate u/s² (geglättet). */
  readonly aLat: number;
  readonly gain: number;
}

type MutableFxState = { -readonly [K in keyof CameraFxState]: CameraFxState[K] };

export const DEFAULT_CAMERA_SETTINGS: CameraRigSettings = { headBob: 1, screenShake: 1, fovKick: 1, fov: 90, motionFx: 1 };

export const CAMERA_NEAR = 2;
export const CAMERA_FAR = 30000;

const DEG = Math.PI / 180;

// Head-Bob (Werte bei runSpeed 250; skaliert linear mit Boden-Speed bis ×1.25)
const BOB_REF_SPEED = 250;
const BOB_MAX_FACTOR = 1.25;
/** Vertikaler Hub Spitze-Spitze in u. */
const BOB_VERTICAL = 1.2;
/** Seitlicher Hub Spitze-Spitze in u. */
const BOB_LATERAL = 0.5;
/** Pitch-Bob-Amplitude bei maximalem Faktor (Grad). */
const BOB_PITCH_MAX = 0.25;
/** Ein-/Ausblenden am Boden / in der Luft (s). Gleichzeitig Boden-Gewicht für den Roll. */
const BOB_FADE_TAU = 0.08;

// Lande-Dip (kritisch gedämpfte Feder). Tiefe weich gesättigt: 300 u/s ≈ 3.4 u (verpatzter
// Hop liest sich trotz Bob noch > 3 u), 600 ≈ 8.2, 800 ≈ 10.4, 1400 ≈ 13.2 — harte Landungen bleiben unterscheidbar.
const DIP_OMEGA = 18;
const DIP_MAX = 14;
const DIP_SOFT = 1.5;
const DIP_NOD_PER_UNIT = 1.5 / DIP_MAX; // Grad pro u Einsinken → max. 1.5°
const JUMP_KICK_DEG = 0.35;

// Perfekt-Hop-Pop: FOV-Impuls statt Dip. Kurzer Anstieg (kein 1-Frame-Sprung), Abklingen τ 0.12 s.
const POP_DEG = 1.2;
const POP_GAIN_FULL = 30;
const POP_ATTACK = 0.02;
const POP_DECAY = 0.12;
/** Normierung: Spitze von e^(−t/τd) − e^(−t/τa) → Pop-Spitze = Amplitude. */
const POP_NORM = (() => {
  const tPeak = ((POP_ATTACK * POP_DECAY) / (POP_DECAY - POP_ATTACK)) * Math.log(POP_DECAY / POP_ATTACK);
  return 1 / (Math.exp(-tPeak / POP_DECAY) - Math.exp(-tPeak / POP_ATTACK));
})();

// Screenshake (Trauma-Modell, linear) — nur Translation, damit er nie das Ziel verdreht.
const SHAKE_MIN_IMPACT = 550;
const SHAKE_FULL_IMPACT = 1000;
/** Trauma ab der Schwelle (sonst ist der Shake zu kurz, um ihn zu spüren), linear bis 1. */
const SHAKE_BASE_TRAUMA = 0.45;
const SHAKE_DECAY = 1.5; // Trauma pro Sekunde: 650 u/s ≈ 0.38 s, ab 1000 u/s 0.67 s (die zweite Hälfte ist sub-pixel)
const SHAKE_POS = 2;
const SHAKE_ROLL_DEG = 0.3;
/** Rumpeln statt Wackeln: ~9–24 Hz. */
const SHAKE_FREQ = 2.5;

// FOV-Kick (horizontale Grad bei 4:3): Log-Kurve relativ zu runSpeed (Weber-Fechner).
const FOV_KICK_REF = 250;
const FOV_KICK_PER_DOUBLING = 6; // 320 → 2.1°, 500 → 6°, 800 → 10.07° (1000 → 12° roh, gekappt 10.97°)
const FOV_KICK_MAX = 15; // Roh-Kurve ab ~1410 u/s; sichtbar begrenzt erst die Gesamtkappe
/**
 * Gesamt (Speed + Pop + Surge): exakt bis zum Knie, darüber weich (tanh) zur Kappe.
 * Knie = Speed-Kick bei 800 u/s (10.07°) → die Log-Kurve bleibt im Kernband 300–800
 * unverändert. Kappe 11° (4:3) = 116.5° horizontal bei 16:9 (vorher 17° = 121.9°):
 * über 1000 u/s war das Bild für Präzisionslandungen zu fischaugig (Runde 2).
 * 112° bei 16:9 wären nur 5.8° — das erreicht die Kurve schon bei 500 u/s.
 */
const FOV_KNEE_SPEED = 800;
const FOV_TOTAL_KNEE = FOV_KICK_PER_DOUBLING * Math.log2(FOV_KNEE_SPEED / FOV_KICK_REF);
const FOV_TOTAL_CAP = 11;
const FOV_TAU_UP = 0.2;
const FOV_TAU_DOWN = 0.6;

// Sync-Surge: Speed-Gewinnrate in der Luft relativ zum theoretischen Maximum cap²·tick/(2v).
const SURGE_DEG = 2.5;
/** Entzerrt die Tick-Treppe (0/1/2 Ticks pro Frame), bevor asymmetrisch geglättet wird. */
const GAIN_DEALIAS_TAU = 0.03;
const GAIN_TAU_UP = 0.3;
const GAIN_TAU_DOWN = 0.07;
/** Kurzer Bodenkontakt (Bhop) lässt den Surge stehen; länger → abbauen. */
const GAIN_GROUND_HOLD = 0.1;
const GAIN_CLIP = 3000;
const SURGE_EFF_LO = 0.4;
const SURGE_EFF_HI = 0.9;

// Roll (Grad, positiv = nach rechts neigen)
const ROLL_GROUND = 0.7;
const ROLL_GROUND_TAU = 0.1;
/** Luft: Carve-Roll aus der Querbeschleunigung, voll bei airSpeedCap·tickRate (Strafe am Cap). */
const ROLL_AIR = 2.5;
const LAT_TAU = 0.08;
const LAT_MIN_SPEED = 150;
/** Surf-Lean: Kamera-Oben kippt zur Rampennormale (45–60°-Rampe → 5.4–7.2°). */
const SURF_LEAN_K = 0.12;
const SURF_LEAN_TAU = 0.15;
const SURF_FADE_TAU = 0.12;
// Surf-Rumpeln (nur Translation): 0.3 u bei 500 u/s, 0.8 u ab 1000 u/s, 19–25 Hz.
const RUMBLE_MIN = 0.3;
const RUMBLE_MAX = 0.8;
const RUMBLE_REF_SPEED = 500;
/** Seitlicher Anteil: mit 0.8 u entlang der Normale bleibt der Versatz ≤ 0.85 u → Ziel in 500 u < 0.1°. */
const RUMBLE_LATERAL = 0.35;
// Rutsch-Rumpeln (Plan 007, nur Translation): 0.15 u beim Eintritt (280 u/s), 0.5 u ab 900 u/s.
// Leiser als das Surf-Rumpeln — der Boden ist fest, das Kratzen trägt der Ton.
const SLIDE_RUMBLE_MIN = 0.15;
const SLIDE_RUMBLE_MAX = 0.5;
const SLIDE_RUMBLE_FROM = 280;
const SLIDE_RUMBLE_TO = 900;
const SLIDE_FADE_TAU = 0.06;
/** Lip-Step (Kanten-Assist): Versatz linear in dieser Zeit abbauen (wie eine einzelne Stufe). */
const LEDGE_STEP_TIME = 0.1;

// Duck-Glättung am Boden: Anteil f als smoothstep(f) — stetige Ableitung an den Enden.
const DUCK_AIR_TAU = 0.04;

// Stufen-Glättung (Source SmoothViewOnStairs: linear abbauen, Rate hier tempo- und treppenabhängig)
/** Kleinere Resthöhen sind Rundung (Trace-Abstand, Rampenübergang) — kein Glätten. */
const STEP_DEADZONE = 0.25;
/** Größere Höhensprünge pro Frame am Boden sind Teleports, keine Stufen (zwei 18er-Stufen + Reserve). */
const STEP_MAX_FRAME = 40;
/** Horizontal mehr als das pro Frame → Teleport. */
const STEP_TELEPORT_HORIZ = 256;
const STEP_OFFSET_CAP = 32;
/** Einzelne Stufe: in dieser Zeit linear abgebaut (16 u → 160 u/s, 8 u → 80 u/s). */
const STEP_ISOLATED_TIME = 0.1;
/** Auf einer Treppe, aber (fast) stehend: Rest trotzdem zügig abbauen. */
const STEP_RATE_FLOOR = 60;
/** Aufgestauter Versatz (Treppeneinstieg, Schätzung noch zu niedrig) bleibt nie länger als ~so lange stehen. */
const STEP_MAX_LAG_TIME = 0.1;
/** Treppe: Abbaurate = das · mittlere Steigung · Speed — knapp über dem mittleren Anstieg, damit die Kamera gleichmäßig steigt statt zu ruckeln. */
const STAIR_RATE_GAIN = 1.15;
/** Liegt die vorige Stufe weiter als das zurück (Bodenstrecke), ist die neue eine einzelne Stufe. */
const STAIR_MAX_RUN = 64;
/** Gedächtnis der Treppen-Schätzung (Summen von Höhe und Lauflänge je Stufe). */
const STAIR_MEMORY = 0.7;

/** Vertikales FOV (Grad) aus horizontalem 4:3-FOV — Hor+ (unter 4:3: horizontal fix). */
export function verticalFovFromHorizontal43(horizontalDeg: number, aspect: number): number {
  const tanH = Math.tan((horizontalDeg * DEG) / 2);
  const tanV = aspect >= 4 / 3 ? tanH * 0.75 : tanH / aspect;
  return (2 * Math.atan(tanV)) / DEG;
}

/** Ziel des Speed-FOV-Kicks (horizontale Grad bei 4:3): 6° pro Verdopplung über runSpeed. */
export function speedFovKick(speed: number): number {
  const k = FOV_KICK_PER_DOUBLING * Math.log2(Math.max(speed, FOV_KICK_REF) / FOV_KICK_REF);
  return Math.min(FOV_KICK_MAX, k);
}

/** Einsinktiefe des Lande-Dips (u) aus der Aufprallgeschwindigkeit — weich gesättigt statt gekappt. */
export function landDipDepth(impact: number): number {
  const x = Math.max(0, (impact - 120) / 480);
  return DIP_MAX * Math.tanh(x / DIP_SOFT);
}

/** Gesamt-FOV-Offset: linear bis zum Knie, darüber weich zur Kappe (Speed + Pop + Surge). */
export function softCapFov(k: number): number {
  if (k <= FOV_TOTAL_KNEE) return k;
  const room = FOV_TOTAL_CAP - FOV_TOTAL_KNEE;
  return FOV_TOTAL_KNEE + room * Math.tanh((k - FOV_TOTAL_KNEE) / room);
}

export function makeCameraView(): MutableCameraView {
  return {
    eyePos: new Vector3(),
    eyeHeight: 64,
    groundNormal: new Vector3(0, 1, 0),
    vel: new Vector3(),
    speed: 0,
    onGround: true,
    ducked: false,
    stridePhase: 0,
    surfing: false,
    surfNormal: new Vector3(),
    sprinting: false,
    strafeInput: 0,
    sliding: false,
    tickAlpha: 1,
  };
}

/** CameraView aus einem (interpolierten) Snapshot füllen. `tickAlpha` = Interpolationsanteil des neuesten Ticks. */
export function cameraViewFromSnapshot(snap: PlayerSnapshot, sprinting: boolean, strafeInput: number, out: MutableCameraView, tickAlpha = 1): MutableCameraView {
  out.eyePos.set(snap.pos.x, snap.pos.y + snap.eyeHeight, snap.pos.z);
  out.eyeHeight = snap.eyeHeight;
  out.groundNormal.copy(snap.groundNormal);
  out.vel.copy(snap.vel);
  out.speed = snap.speed;
  out.onGround = snap.onGround;
  out.ducked = snap.ducked;
  out.stridePhase = snap.stridePhase;
  out.surfing = snap.surfing;
  out.surfNormal.copy(snap.surfNormal);
  out.sprinting = sprinting;
  out.strafeInput = strafeInput;
  out.sliding = snap.sliding;
  out.tickAlpha = tickAlpha;
  return out;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Exponentielles Annähern mit Zeitkonstante tau (bildratenunabhängig). */
function expApproach(v: number, target: number, tau: number, dt: number): number {
  if (tau <= 0) return target;
  return target + (v - target) * Math.exp(-dt / tau);
}

export class CameraRig {
  private readonly camera: PerspectiveCamera;
  private settings: CameraRigSettings = DEFAULT_CAMERA_SETTINGS;
  private aspect = 16 / 9;
  private lastFov = Number.NaN;
  private time = 0;

  // Movement-Kenngrößen (setMovement)
  private movement: MovementConfig = VELOCITY_DEFAULT;
  private tickDt = 1 / VELOCITY_DEFAULT.tickRate;
  private standEye = VELOCITY_DEFAULT.hull.standEye;
  private duckEye = VELOCITY_DEFAULT.hull.duckEye;

  // Zustand der Effekte (unskaliert; Einstellungen wirken erst beim Anwenden)
  private bobWeight = 0;
  private readonly dip = new CriticalSpring(DIP_OMEGA);
  private readonly kick = new CriticalSpring(DIP_OMEGA);
  private trauma = 0;
  /** Speed-FOV-Kick (geglättet), ohne Pop und Surge. */
  private fovKickCur = 0;
  /** Landung wartet einen Tick: Dip/Trauma erst, wenn kein perfekter Hop folgt. */
  private pendingLand = false;
  private pendingDip = 0;
  private pendingTrauma = 0;
  private pendingArmed = false;
  private pendingWait = 0;
  private popFast = 0;
  private popSlow = 0;
  // Bewegungs-Ableitungen (Carve-Roll, Surge) aus aufeinanderfolgenden Frames
  private motionValid = false;
  private prevVx = 0;
  private prevVz = 0;
  private prevSpeed = 0;
  private prevAir = false;
  /** Vorheriger Frame zählte für den Carve-Roll (Luft ohne Surf, oder Rutschen). */
  private prevCarve = false;
  /** Querbeschleunigung u/s², + = Rechtskurve (geglättet). */
  private aLat = 0;
  private gainRaw = 0;
  /** Speed-Gewinnrate in der Luft u/s² (geglättet, schnell fallend). */
  private gain = 0;
  private groundHold = 0;
  private surge = 0;
  // Roll-Anteile
  private roll = 0;
  private rollGround = 0;
  private surfW = 0;
  private surfLean = 0;
  private readonly surfN = new Vector3();
  private slideW = 0;
  // Lip-Step-Versatz: Rest (u), zuletzt dazugekommener Anteil, dessen Tick, Abbaurate (u/s).
  private ledgeRemain = 0;
  private ledgeDy = 0;
  private ledgeTick = 0;
  private ledgeRate = 0;
  /** Zählt Physik-Ticks (onTick) — trennt "Stufe im neuesten Tick" von "schon ganz sichtbar". */
  private tickSerial = 0;
  // Duck-Glättung
  private duckOffset = 0;
  private readonly fxOut: MutableFxState = {
    speedKick: 0, pop: 0, surge: 0, fovOffset: 0, roll: 0, dip: 0, shake: 0, rumble: 0, slideRumble: 0, ledgeOffset: 0, aLat: 0, gain: 0,
  };
  // Stufen-Glättung
  private stepOffset = 0;
  private readonly prevFeet = new Vector3();
  private readonly prevNormal = new Vector3(0, 1, 0);
  private hasPrev = false;
  private prevSettled = false;
  private prevStepFrame = false;
  /** Bodenstrecke seit der letzten erkannten Stufe. */
  private stairRun = Number.POSITIVE_INFINITY;
  /** Gleitende Summen von Stufenhöhe und Lauflänge → mittlere Treppensteigung. */
  private stairRise = 0;
  private stairLen = 0;
  /** Abbaurate einer einzelnen Stufe (beim Auftreten festgelegt → linear). */
  private isolatedRate = STEP_RATE_FLOOR;

  constructor(camera: PerspectiveCamera) {
    this.camera = camera;
    camera.rotation.order = 'YXZ';
    camera.near = CAMERA_NEAR;
    camera.far = CAMERA_FAR;
    this.aspect = camera.aspect || 16 / 9;
    this.applyFov(0);
  }

  /** Effekt-Anteile des letzten Frames (dasselbe Objekt bei jedem Aufruf). */
  get fxState(): CameraFxState {
    return this.fxOut;
  }

  setSettings(s: CameraRigSettings): void {
    this.settings = s;
    this.lastFov = Number.NaN;
    this.applyFov(this.fovKickCur * s.fovKick);
  }

  /**
   * Aktive Movement-Config: Tick-Rate (Perfekt-Hop-Erkennung), Luft-Cap
   * (Surge-Maßstab, Carve-Roll) und Augenhöhen (Duck-Glättung). Default VELOCITY.
   */
  setMovement(cfg: MovementConfig): void {
    this.movement = cfg;
    this.tickDt = 1 / Math.max(1, cfg.tickRate);
    this.standEye = cfg.hull.standEye;
    this.duckEye = cfg.hull.duckEye;
  }

  setAspect(aspect: number): void {
    if (!(aspect > 0)) return;
    this.aspect = aspect;
    this.camera.aspect = aspect;
    this.lastFov = Number.NaN;
    this.applyFov(this.fovKickCur * this.settings.fovKick);
  }

  /**
   * Einmal pro Physik-Tick (vor dessen Events). Nur der Lip-Step-Versatz braucht es: liegt die Stufe
   * im neuesten Tick, zeigt die Interpolation erst tickAlpha davon.
   */
  onTick(): void {
    this.tickSerial++;
  }

  onEvent(e: GameEvent): void {
    switch (e.type) {
      case 'ledge':
        // Lip-Step: die Füße springen in einem Tick bis ledgeStep hoch — wie eine Stufe glätten
        // (Versatz linear in 0.1 s), nie Yaw/Pitch. Der Vault (Tempo zurück) hat keinen Höhensprung.
        if (e.kind === 'step' && e.dy > 0) {
          this.ledgeRemain += e.dy;
          this.ledgeDy = e.dy;
          this.ledgeTick = this.tickSerial;
          this.ledgeRate = Math.max(this.ledgeRate, this.ledgeRemain / LEDGE_STEP_TIME);
        }
        break;
      case 'land': {
        // Jede Landung wartet einen Tick: folgt der perfekte Hop, findet sie für die
        // Kamera nie statt. Nicht nur bei jumpQueued — wer exakt im Folgetick frisch
        // drückt (Taste/Mausrad ohne Puffer), springt ebenso perfekt (fallen.md #54).
        this.pendingDip = Math.max(this.pendingDip, landDipDepth(e.impact));
        const trauma = e.impact > SHAKE_MIN_IMPACT ? Math.min(1, SHAKE_BASE_TRAUMA + ((1 - SHAKE_BASE_TRAUMA) * (e.impact - SHAKE_MIN_IMPACT)) / (SHAKE_FULL_IMPACT - SHAKE_MIN_IMPACT)) : 0;
        this.pendingTrauma = Math.max(this.pendingTrauma, trauma);
        this.pendingLand = true;
        this.pendingArmed = false;
        this.pendingWait = 0;
        break;
      }
      case 'jump':
        // Verlustfrei (clean = perfekt oder in der Lande-Gnade, Plan 007) lobt wie der perfekte Hop.
        if (e.clean) {
          // Guter Hop: Kamera bleibt leicht (kein Dip, kein Nicken), dafür der Pop.
          if (this.pendingLand) this.clearPending();
          // Rückfall (Landung schon nachgeholt, z. B. Framezeit-Schätzung daneben): ohne Positionssprung auslaufen lassen.
          else if (this.dip.v < 0 || this.dip.x < 0) this.dip.v = -DIP_OMEGA * this.dip.x;
          const amp = POP_DEG * (0.5 + 0.5 * MathUtils.clamp(e.gain / POP_GAIN_FULL, 0, 1)) * POP_NORM;
          this.popFast += amp;
          this.popSlow += amp;
        } else {
          this.flushPending();
          this.kick.v += JUMP_KICK_DEG * DIP_OMEGA * Math.E;
        }
        break;
      case 'respawn':
        this.reset();
        break;
      default:
        break;
    }
  }

  reset(): void {
    this.bobWeight = 0;
    this.dip.reset();
    this.kick.reset();
    this.trauma = 0;
    this.fovKickCur = 0;
    this.clearPending();
    this.popFast = 0;
    this.popSlow = 0;
    this.motionValid = false;
    this.aLat = 0;
    this.gainRaw = 0;
    this.gain = 0;
    this.groundHold = 0;
    this.surge = 0;
    this.roll = 0;
    this.rollGround = 0;
    this.surfW = 0;
    this.surfLean = 0;
    this.surfN.set(0, 0, 0);
    this.slideW = 0;
    this.ledgeRemain = 0;
    this.ledgeDy = 0;
    this.ledgeRate = 0;
    this.prevCarve = false;
    this.duckOffset = 0;
    this.stepOffset = 0;
    this.hasPrev = false;
    this.prevSettled = false;
    this.prevStepFrame = false;
    this.stairRun = Number.POSITIVE_INFINITY;
    this.stairRise = 0;
    this.stairLen = 0;
    this.isolatedRate = STEP_RATE_FLOOR;
  }

  update(frameDt: number, view: CameraView, yaw: number, pitch: number): void {
    const dt = Number.isFinite(frameDt) ? MathUtils.clamp(frameDt, 0, 0.1) : 0;
    const s = this.settings;
    const fx = s.motionFx ?? 1;
    this.time += dt;

    this.updateStepSmoothing(dt, view);
    this.updateDuckSmoothing(dt, view);
    this.updatePending(dt);

    // --- Head-Bob (Rutschen hat keine Schritte: ausblenden, sonst stünde der Bob auf einer festen Phase)
    this.bobWeight = expApproach(this.bobWeight, view.onGround && !view.sliding ? 1 : 0, BOB_FADE_TAU, dt);
    const speedFactor = MathUtils.clamp(view.speed / BOB_REF_SPEED, 0, BOB_MAX_FACTOR);
    const bobAmp = this.bobWeight * speedFactor * (view.ducked ? 0.5 : 1);
    const phase = view.stridePhase * Math.PI * 2;
    // Tiefster Punkt beim Auftreten (Phase 0 und 0.5), seitlich einmal pro Doppelschritt.
    const bobV = -0.5 * BOB_VERTICAL * bobAmp * Math.cos(2 * phase);
    const bobL = 0.5 * BOB_LATERAL * bobAmp * Math.sin(phase);
    const bobPitch = (BOB_PITCH_MAX / BOB_MAX_FACTOR) * bobAmp * Math.cos(2 * phase) * DEG;

    // --- Lande-Dip + Sprung-Kick (kritisch gedämpft, exakt integriert)
    this.dip.step(dt);
    this.kick.step(dt);
    const dip = Math.max(-DIP_MAX, this.dip.x);
    const nod = dip * DIP_NOD_PER_UNIT * DEG + this.kick.x * DEG;

    // --- Bewegung: Querbeschleunigung (Roll) und Gewinnrate (Surge)
    this.updateMotion(dt, view);

    // --- Roll (positiv = rechts neigen): Boden aus der Quergeschwindigkeit,
    // Luft aus der Kurve (nicht aus der Taste), Surf aus der Rampennormale.
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    const lateral = view.vel.x * rx + view.vel.z * rz;
    this.rollGround = expApproach(this.rollGround, ROLL_GROUND * MathUtils.clamp(lateral / 200, -1, 1), ROLL_GROUND_TAU, dt);
    const latFull = Math.max(1, this.movement.airSpeedCap / this.tickDt);
    const rollAir = ROLL_AIR * MathUtils.clamp(this.aLat / latFull, -1, 1);
    const surfing = view.surfing && view.surfNormal.lengthSq() > 0.5;
    if (surfing) this.surfN.copy(view.surfNormal);
    this.surfW = expApproach(this.surfW, surfing ? 1 : 0, SURF_FADE_TAU, dt);
    const n = this.surfN;
    // Winkel der Normale in der Rechts-Oben-Ebene: Rampe links (Normale zeigt nach rechts) → rechts neigen.
    const leanTarget = this.surfW > 1e-4 ? (SURF_LEAN_K * Math.atan2(n.x * rx + n.z * rz, n.y)) / DEG : 0;
    this.surfLean = expApproach(this.surfLean, leanTarget, SURF_LEAN_TAU, dt);
    const gw = this.bobWeight;
    this.roll = this.surfW * this.surfLean + (1 - this.surfW) * (gw * this.rollGround + (1 - gw) * rollAir);

    // --- Surf-Rumpeln (nur Translation, entlang Normale + etwas seitlich)
    const rumbleAmp =
      this.surfW > 1e-4 && view.speed > 1
        ? this.surfW * MathUtils.clamp(RUMBLE_MIN + (RUMBLE_MAX - RUMBLE_MIN) * Math.log2(view.speed / RUMBLE_REF_SPEED), 0, RUMBLE_MAX) * fx * s.screenShake
        : 0;
    const t = this.time;
    const ru = rumbleAmp * rumble(t, 0);
    const rl = RUMBLE_LATERAL * rumbleAmp * rumble(t, 1);

    // --- Rutsch-Rumpeln (nur Translation: senkrecht + etwas seitlich), wächst mit dem Tempo
    this.slideW = expApproach(this.slideW, view.sliding ? 1 : 0, SLIDE_FADE_TAU, dt);
    const slideAmp =
      this.slideW > 1e-4
        ? this.slideW * (SLIDE_RUMBLE_MIN + (SLIDE_RUMBLE_MAX - SLIDE_RUMBLE_MIN) * smoothstep(SLIDE_RUMBLE_FROM, SLIDE_RUMBLE_TO, view.speed)) * fx * s.screenShake
        : 0;
    const su = slideAmp * rumble(t, 2);
    const sl = RUMBLE_LATERAL * slideAmp * rumble(t, 3);

    // --- Lip-Step: Versatz = −(bereits sichtbarer Teil der Stufe), linear abgebaut.
    const ledge = this.updateLedge(dt, view.tickAlpha);

    // --- Screenshake (nur Translation + etwas Roll; Yaw/Pitch bleiben exakt der Blick)
    this.trauma = Math.max(0, this.trauma - SHAKE_DECAY * dt);
    const shake = this.trauma * s.screenShake;
    const shRoll = shake * SHAKE_ROLL_DEG * DEG * noise(t, 2, SHAKE_FREQ);
    const shX = shake * SHAKE_POS * noise(t, 3, SHAKE_FREQ);
    const shY = shake * SHAKE_POS * noise(t, 4, SHAKE_FREQ);

    // --- FOV: Speed (log) + Pop (Timing) + Surge (Strafe-Qualität), weich gekappt
    const kickTarget = speedFovKick(view.speed);
    this.fovKickCur = expApproach(this.fovKickCur, kickTarget, kickTarget > this.fovKickCur ? FOV_TAU_UP : FOV_TAU_DOWN, dt);
    const ea = Math.exp(-dt / POP_ATTACK);
    const ed = Math.exp(-dt / POP_DECAY);
    this.popFast = this.popFast * ea < 1e-5 ? 0 : this.popFast * ea;
    this.popSlow = this.popSlow * ed < 1e-5 ? 0 : this.popSlow * ed;
    const pop = Math.max(0, this.popSlow - this.popFast);
    const fovOffset = softCapFov(s.fovKick * (this.fovKickCur + fx * (pop + this.surge)));
    this.applyFov(fovOffset);

    const o = this.fxOut;
    o.speedKick = s.fovKick * this.fovKickCur;
    o.pop = s.fovKick * fx * pop;
    o.surge = s.fovKick * fx * this.surge;
    o.fovOffset = fovOffset;
    o.roll = this.roll * fx;
    o.dip = dip * fx;
    o.shake = shake * SHAKE_POS;
    o.rumble = rumbleAmp;
    o.slideRumble = slideAmp;
    o.ledgeOffset = ledge;
    o.aLat = this.aLat;
    o.gain = this.gain;

    // --- Anwenden: Blick 1:1, Effekte additiv und skaliert
    const hb = s.headBob;
    const lat = bobL * hb + shX + rl + sl;
    const cam = this.camera;
    cam.position.set(
      view.eyePos.x + rx * lat + n.x * ru,
      view.eyePos.y + bobV * hb + dip * fx + shY + n.y * ru + su + this.stepOffset + this.duckOffset + ledge,
      view.eyePos.z + rz * lat + n.z * ru,
    );
    cam.rotation.order = 'YXZ';
    cam.rotation.set(pitch + bobPitch * hb + nod * fx, yaw, -(this.roll * DEG * fx + shRoll), 'YXZ');
  }

  /**
   * Lip-Step-Versatz (≤ 0). Liegt die Stufe im neuesten Tick, zeigt die Interpolation erst
   * tickAlpha·dy davon — genau so viel wird ausgeglichen, danach linear in 0.1 s abgebaut.
   */
  private updateLedge(dt: number, tickAlpha: number): number {
    if (this.ledgeRemain <= 0) return 0;
    this.ledgeRemain = Math.max(0, this.ledgeRemain - this.ledgeRate * dt);
    if (this.ledgeRemain <= 0) {
      this.ledgeDy = 0;
      this.ledgeRate = 0;
      return 0;
    }
    const newest = this.tickSerial === this.ledgeTick;
    const a = MathUtils.clamp(Number.isFinite(tickAlpha) ? tickAlpha : 1, 0, 1);
    const visible = newest ? this.ledgeRemain - this.ledgeDy + a * this.ledgeDy : this.ledgeRemain;
    return -Math.min(this.ledgeRemain, Math.max(0, visible));
  }

  private applyDip(depth: number): void {
    if (depth <= 0.05) return;
    // Kritisch gedämpft: x(t) = v0·t·e^(−ωt), Spitze v0/(ω·e) bei t = 1/ω.
    this.dip.v -= depth * DIP_OMEGA * Math.E;
    const maxVel = DIP_MAX * DIP_OMEGA * Math.E;
    if (this.dip.v < -maxVel) this.dip.v = -maxVel;
  }

  private clearPending(): void {
    this.pendingLand = false;
    this.pendingDip = 0;
    this.pendingTrauma = 0;
    this.pendingArmed = false;
    this.pendingWait = 0;
  }

  private flushPending(): void {
    if (this.pendingDip > 0) this.applyDip(this.pendingDip);
    if (this.pendingTrauma > 0) this.trauma = Math.min(1, this.trauma + this.pendingTrauma);
    this.clearPending();
  }

  /**
   * Kein perfekter Hop nach der Landung: Dip/Shake nachholen, sobald sicher ein
   * weiterer Tick gelaufen ist (FixedLoop: acc ≥ 0 nach dem Land-Frame, also
   * tickt es spätestens, wenn danach eine Tick-Dauer Framezeit verstrichen ist).
   * Der Frame des Land-Ticks zählt nicht — seine Zeit lag vor dem Tick.
   * Kostet nicht-perfekte Landungen höchstens einen Frame (60 Hz) bzw. zwei (144 Hz).
   */
  private updatePending(dt: number): void {
    if (!this.pendingLand) return;
    if (!this.pendingArmed) {
      this.pendingArmed = true;
      return;
    }
    this.pendingWait += dt;
    if (this.pendingWait >= this.tickDt) this.flushPending();
  }

  /**
   * Querbeschleunigung aus zwei Frames der interpolierten Geschwindigkeit
   * ((v_prev × v).y / |v| / dt) und Speed-Gewinnrate aus dem Tick-Speed.
   * Beides nur zwischen zwei Luft-Frames; der Surge überlebt kurzen Bodenkontakt.
   */
  private updateMotion(dt: number, view: CameraView): void {
    if (dt <= 0) return;
    const vx = view.vel.x;
    const vz = view.vel.z;
    const sp = view.speed;
    const air = !view.onGround;
    // Carve-Roll: Luft ohne Surf, dazu das Lenken beim Rutschen (Bodenkontakt, aber keine Schritte).
    const carve = (air && !view.surfing) || view.sliding;
    let lat = 0;
    let feedGain = false;
    let inst = 0;
    if (air && !view.surfing) {
      this.groundHold = 0;
      if (this.motionValid && this.prevAir) {
        feedGain = true;
        inst = MathUtils.clamp((sp - this.prevSpeed) / dt, -GAIN_CLIP, GAIN_CLIP);
      }
    } else {
      this.groundHold += dt;
      if (this.groundHold > GAIN_GROUND_HOLD) feedGain = true; // inst = 0 → abbauen
    }
    if (carve && this.motionValid && this.prevCarve) {
      const h = Math.hypot(vx, vz);
      // Vorzeichen: + = Rechtskurve (von oben im Uhrzeigersinn, yaw nimmt ab).
      if (h > LAT_MIN_SPEED) lat = (this.prevVx * vz - this.prevVz * vx) / h / dt;
    }
    const latFull = Math.max(1, this.movement.airSpeedCap / this.tickDt);
    this.aLat = expApproach(this.aLat, MathUtils.clamp(lat, -latFull, latFull), LAT_TAU, dt);

    if (feedGain) {
      this.gainRaw = expApproach(this.gainRaw, inst, GAIN_DEALIAS_TAU, dt);
      this.gain = expApproach(this.gain, this.gainRaw, this.gainRaw > this.gain ? GAIN_TAU_UP : GAIN_TAU_DOWN, dt);
    }
    const cap = airSpeedCapAt(this.movement, sp);
    const vRef = Math.max(sp, FOV_KICK_REF);
    const gMax = (cap * cap) / (2 * vRef * this.tickDt);
    const eff = this.gain / gMax;
    const ramp = MathUtils.clamp((sp - 150) / 150, 0, 1);
    this.surge = SURGE_DEG * smoothstep(SURGE_EFF_LO, SURGE_EFF_HI, eff) * ramp;

    this.prevVx = vx;
    this.prevVz = vz;
    this.prevSpeed = sp;
    this.prevAir = air && !view.surfing;
    this.prevCarve = carve;
    this.motionValid = true;
  }

  /**
   * Ducken am Boden: PlayerMovement fährt die Augenhöhe linear (harte Ecken an
   * Start und Ende). Die Kamera zeigt den Anteil als smoothstep — Source
   * SimpleSpline. In der Luft nicht (Crouch-Jump: Welt-Auge bleibt exakt).
   */
  private updateDuckSmoothing(dt: number, view: CameraView): void {
    const range = this.standEye - this.duckEye;
    if (view.onGround && range > 0) {
      const f = MathUtils.clamp((view.eyeHeight - this.duckEye) / range, 0, 1);
      this.duckOffset = (f * f * (3 - 2 * f) - f) * range;
    } else {
      this.duckOffset = expApproach(this.duckOffset, 0, DUCK_AIR_TAU, dt);
    }
  }

  /**
   * Stufen-Glättung: Höhenänderung der Füße zwischen zwei Frames, die weder
   * die Bodenebene (Rampe) noch die Augenhöhe (Ducken) erklärt, ist eine
   * Stufe (StepMove/StayOnGround). Die wird im selben Frame voll
   * ausgeglichen — egal wie die Interpolation sie auf Frames verteilt — und
   * dann linear abgebaut, auf Treppen knapp schneller als die Treppe steigt.
   * Nur zwischen zwei Frames, die ganz zwischen Boden-Ticks liegen
   * (vel.y exakt 0): der Rest einer Landung oder eines Absprungs ist keine Stufe.
   */
  private updateStepSmoothing(dt: number, view: CameraView): void {
    const settled = view.onGround && Math.abs(view.vel.y) < 1e-3;
    const fx = view.eyePos.x;
    const fy = view.eyePos.y - view.eyeHeight;
    const fz = view.eyePos.z;

    // Erst den alten Versatz abbauen, dann eine neue Stufe voll ausgleichen → im Stufen-Frame kein Ruck.
    const isolated = this.stairRun > STAIR_MAX_RUN || this.stairLen <= 0;
    const rate = isolated
      ? this.isolatedRate
      : Math.max(STEP_RATE_FLOOR, (STAIR_RATE_GAIN * this.stairRise * view.speed) / this.stairLen);
    const decay = Math.max(rate, Math.abs(this.stepOffset) / STEP_MAX_LAG_TIME) * dt;
    this.stepOffset = Math.abs(this.stepOffset) <= decay ? 0 : this.stepOffset - Math.sign(this.stepOffset) * decay;

    let stepFrame = false;
    if (this.hasPrev && settled && this.prevSettled) {
      const dx = fx - this.prevFeet.x;
      const dz = fz - this.prevFeet.z;
      const dy = fy - this.prevFeet.y;
      const horiz = Math.hypot(dx, dz);
      if (horiz <= STEP_TELEPORT_HORIZ) {
        // Rampe: dy = −(n.x·dx + n.z·dz)/n.y — mit der Normale dieses oder des vorigen Frames (Übergänge).
        const n = view.groundNormal;
        const p = this.prevNormal;
        const e1 = n.y > 0.1 ? -(n.x * dx + n.z * dz) / n.y : 0;
        const e2 = p.y > 0.1 ? -(p.x * dx + p.z * dz) / p.y : 0;
        const r1 = dy - e1;
        const r2 = dy - e2;
        const residual = Math.abs(r1) < Math.abs(r2) ? r1 : r2;
        const step = Math.abs(residual);
        if (step > STEP_DEADZONE && step <= STEP_MAX_FRAME) {
          this.stepOffset = MathUtils.clamp(this.stepOffset - residual, -STEP_OFFSET_CAP, STEP_OFFSET_CAP);
          if (this.prevStepFrame) {
            // Fortsetzung: die Interpolation verteilt eine Stufe auf zwei Frames —
            // gleiche Stufe, Strecke dieses Frames zählt zur Treppe.
            if (this.stairLen > 0) {
              this.stairRise += step;
              this.stairLen += horiz;
            }
            this.isolatedRate = Math.max(this.isolatedRate, Math.abs(this.stepOffset) / STEP_ISOLATED_TIME);
            this.stairRun = 0;
          } else {
            // Neue Stufe. Lauflänge seit der vorigen; sie liegt irgendwo in diesem Frame → halbe Frame-Strecke.
            const run = this.stairRun + horiz * 0.5;
            if (run <= STAIR_MAX_RUN) {
              this.stairRise = this.stairRise * STAIR_MEMORY + step;
              this.stairLen = this.stairLen * STAIR_MEMORY + Math.max(run, 1);
            } else {
              this.stairRise = 0;
              this.stairLen = 0;
            }
            this.isolatedRate = Math.max(STEP_RATE_FLOOR, Math.abs(this.stepOffset) / STEP_ISOLATED_TIME);
            this.stairRun = horiz * 0.5;
          }
          stepFrame = true;
        } else {
          this.stairRun += horiz;
        }
      }
    }
    this.prevStepFrame = stepFrame;
    this.prevFeet.set(fx, fy, fz);
    this.prevNormal.copy(view.groundNormal);
    this.prevSettled = settled;
    this.hasPrev = true;
  }

  private applyFov(kick: number): void {
    const h = MathUtils.clamp(this.settings.fov + kick, 30, 170);
    const v = verticalFovFromHorizontal43(h, this.aspect);
    if (v !== this.lastFov) {
      this.lastFov = v;
      this.camera.fov = v;
      this.camera.aspect = this.aspect;
      this.camera.updateProjectionMatrix();
    }
  }
}

/** Kritisch gedämpfte Feder zur Ruhelage 0, exakt integriert für beliebiges dt. */
class CriticalSpring {
  x = 0;
  v = 0;
  constructor(private readonly omega: number) {}

  step(dt: number): void {
    if (dt <= 0) return;
    const w = this.omega;
    const e = Math.exp(-w * dt);
    const c = this.v + w * this.x;
    this.x = (this.x + c * dt) * e;
    this.v = (this.v - w * c * dt) * e;
    if (Math.abs(this.x) < 1e-6 && Math.abs(this.v) < 1e-5) this.reset();
  }

  reset(): void {
    this.x = 0;
    this.v = 0;
  }
}

/** Rumpeln −1..1: drei nahe Frequenzen (19/22.7/25.3 Hz) schweben gegeneinander → rau statt Sinus. */
function rumble(t: number, channel: number): number {
  const k = channel * 2.39;
  const w = t * 2 * Math.PI;
  return 0.45 * Math.sin(w * 19.1 + k) + 0.35 * Math.sin(w * 22.7 + k * 1.7 + 0.9) + 0.2 * Math.sin(w * 25.3 + k * 2.3 + 2.1);
}

/**
 * Glattes Pseudo-Rauschen −1..1 aus drei inkommensurablen Sinus-Anteilen je
 * Kanal. freq skaliert die Grundfrequenzen (1 → ~3.7/6/9.8 Hz).
 */
function noise(t: number, channel: number, freq: number): number {
  const k = channel * 1.618;
  const w = t * freq;
  return (
    0.55 * Math.sin(w * 23.1 + k * 3.7) +
    0.3 * Math.sin(w * 37.7 + k * 5.3 + 1.1) +
    0.15 * Math.sin(w * 61.3 + k * 2.9 + 2.3)
  );
}
