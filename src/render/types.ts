import type { PerspectiveCamera, Vector3 } from 'three';
import type { CompiledLevel } from '../world/level/compileLevel';

export interface RenderSettings {
  /**
   * Gewünschte Zeilenzahl des Low-Res-Targets: 224 | 240 | 270 | 360 | 448. Obergrenze —
   * das Raster ist ganzzahlig skaliert, die echte Zahl liefert `effectiveLines()` (render/lowres).
   */
  readonly pixelHeight: number;
  /** Geordnetes Dithering + Farbquantisierung. */
  readonly dither: boolean;
  /** Bits pro Farbkanal bei der Quantisierung (PS2 16-Bit-Framebuffer ≈ 5). */
  readonly colorBits: number;
  /** 0..1 Anteil affiner (nicht perspektivisch korrekter) Texturkoordinaten. */
  readonly affine: number;
  /** 0..1 Vertex-Snapping auf das Low-Res-Pixelraster. */
  readonly vertexSnap: number;
  /** 0..1 chromatische Aberration (wird zusätzlich mit Speed skaliert). */
  readonly chromatic: number;
  /** 0..1 Scanlines: jede 2. Zeile bis 16 % dunkler (Default 0.25 → 4 %, gut eine 5-Bit-Stufe). */
  readonly scanlines: number;
  /** 0..1 Stärke der Speed-Streifen am Bildrand (fehlt = 1). 0 für empfindliche Spieler. */
  readonly speedLines?: number;
  /**
   * Niedrige Latenz: WebGL2-Kontext mit `desynchronized` (kann reißen). Fehlt = aus.
   * Kontext-Attribute sind fest — wirkt nur beim Erzeugen des Renderers
   * (`new PS2Renderer(canvas, settings)`), setSettings ändert es nicht mehr.
   */
  readonly lowLatency?: boolean;
}

export const DEFAULT_RENDER_SETTINGS: RenderSettings = {
  pixelHeight: 270,
  dither: true,
  colorBits: 5,
  affine: 0.35,
  vertexSnap: 0.5,
  chromatic: 0.5,
  scanlines: 0.25,
  speedLines: 1,
  lowLatency: false,
};

/** Pro Frame vom Spiel an den Renderer. Alle optionalen Felder: fehlt = neutral (Bild wie ohne). */
export interface RenderFx {
  /** Sekunden seit Start. */
  readonly time: number;
  /** 0..1: 0 bei ≤ Laufgeschwindigkeit, 1 bei sehr hohem Tempo (~1100 u/s). */
  readonly speed01: number;
  /** 0..1 Kick-Hüllkurve aus der Audio-Engine (Neon-Puls). */
  readonly kick: number;
  /** 0..1 Musik-Energie. */
  readonly energy: number;
  /** 0..1 Bildschirm-Blitz (Checkpoint, Ziel). */
  readonly flash: number;
  /** RGB 0..1 */
  readonly flashColor: readonly [number, number, number];
  /** 0..1 Abblende nach Schwarz (Respawn). */
  readonly fade: number;
  /**
   * Lichtwelle über die Trims nach einem guten Hop: Ursprung (Füße beim Absprung),
   * Startzeit im Takt von `time` und Stärke 0..1. Die Welle läuft mit ~3600 u/s
   * und ist nach 0.3 s abgeklungen (~1000 u). Das Objekt wird nur gelesen (kopiert), nie gehalten.
   */
  readonly landPos?: Vector3;
  readonly landTime?: number;
  readonly landPower?: number;
  /**
   * Tempostufe 0..3 (HUD-Meilensteine 500/750/1000): Trims in Level-Trim-Farbe werden
   * stufig heißer (Kante → weiß, Seitenband → Zweitfarbe), kurzer Aufblitz beim
   * Hochschalten. Der Renderer blendet selbst weich über (~0.1 s hoch, ~0.4 s runter)
   * und blitzt nicht erneut, wenn die Stufe nur kurz weg war — Game darf ganze Zahlen
   * liefern, sollte an den Schwellen aber Hysterese haben (z. B. runter erst 60 u/s tiefer).
   */
  readonly speedTier?: number;
  /**
   * View-Hand (Plan 006): wird nach der Welt ins selbe Low-Res-Target gerendert (Tiefe
   * vorher geleert, eigene Kamera mit festem FOV) — Dithering, Quantisierung, Fade und
   * Blitz treffen sie wie die Welt. Nur gelesen, nie gehalten. Fehlt/unsichtbar = keine Hand.
   */
  readonly viewModel?: ViewModelFrame;
}

export interface RendererApi {
  readonly canvas: HTMLCanvasElement;
  /** Aktuelle Low-Res-Auflösung (für den HUD-Canvas, der 1:1 darüber gelegt wird). */
  readonly lowResWidth: number;
  readonly lowResHeight: number;
  /** Seitenverhältnis des Low-Res-Bildes (lowResWidth / lowResHeight) — für CameraRig.setAspect. render() setzt camera.aspect ohnehin selbst. */
  readonly aspect: number;
  setLevel(level: CompiledLevel): void;
  setSettings(s: RenderSettings): void;
  /** Fenstergröße in CSS-Pixeln. */
  resize(width: number, height: number): void;
  /** HUD-Canvas in Low-Res-Größe; wird im finalen Pass mit composited (gleiches Pixelraster). */
  setHud(canvas: HTMLCanvasElement | null): void;
  /**
   * Ghost der Bestzeit: Spieler-Hull (32×72, Füße bei `pos`) als Neon-Hologramm mit
   * Dither-Alpha, `yaw` in Radiant (three-Konvention, 0 = −Z). `null` blendet ihn aus.
   * Kopiert `pos` (keine Referenz halten, keine Allokation). Nah an der Kamera blendet
   * er sich selbst aus, damit er beim Überholen nicht die Sicht verdeckt.
   */
  setGhost(pos: Vector3 | null, yaw: number): void;
  /**
   * Viewmodel-Pass vorbereiten (Plan 006): Geometrie/Texturen der Gegenstände anlegen und
   * Shader kompilieren, damit der erste Wurf im Lauf nicht ruckelt. Außerhalb des Frame-Pfads
   * aufrufen (Levelstart, Kosmetik-Wechsel). Ohne Aufruf passiert es lazy beim ersten Zeichnen.
   */
  prewarmViewModel(item: ViewModelItem, glove: ViewModelGlove): void;
  render(camera: PerspectiveCamera, fx: RenderFx): void;
  dispose(): void;
}

// ---------------------------------------------------------------- Viewmodel (Plan 006)

/**
 * Gelenk-Layout der 3D-View-Hand (rechte Hand). Winkel in Radiant, 0 = gestreckte
 * Grundhaltung des Modells. Beugen (mcp/pip/dip, Daumen mcp/ip) positiv = zur Handfläche.
 * Finger f (0 Zeige-, 1 Mittel-, 2 Ring-, 3 kleiner Finger): Basis VM_FINGER + 4·f,
 * dann +0 Spreizen (positiv = Richtung Daumen), +1 Grundgelenk, +2 Mittelgelenk, +3 Endgelenk.
 */
export const VM_JOINT = {
  /** Handgelenk: Beugen (positiv = Handfläche nach innen), Seitneigung (positiv = Richtung Daumen), Drehen um den Unterarm. */
  wristFlex: 0,
  wristDev: 1,
  wristTwist: 2,
  /** Daumen: Abspreizen aus der Handebene, Opposition (über die Handfläche), Grund- und Endgelenk. */
  thumbAbd: 3,
  thumbOpp: 4,
  thumbMcp: 5,
  thumbIp: 6,
  finger: 7,
} as const;
export const VM_JOINT_COUNT = 23;

/**
 * Grundhaltung des Unterarms (rad, Euler ZXY: twist um die Unterarmachse, dann pitch, dann
 * roll in der Bildebene): Finger ins Bild nach links, Daumen oben, Handrücken rechts — wie die
 * Referenzbilder. Renderer und UI (Trick-Richtungen "oben im Bild", "zur Kamera") teilen sie.
 */
export const VM_ARM_BASE = { pitch: -0.855, twist: 2.05, roll: 0.8 } as const;

export type ViewModelGlove = 'classic' | 'neon';
export type ViewModelItem = 'none' | 'can' | 'card' | 'knife';

/**
 * Zustand der View-Hand für EINEN Frame (Plan 006). Die UI (ui/hand) füllt ein einmal
 * angelegtes Objekt in place, der Renderer liest es nur in render() (hält keine Werte).
 * Längen in Hand-Einheiten (~1 cm, Modell-Maßstab), Winkel in Radiant außer x/y.
 */
export interface ViewModelFrame {
  visible: boolean;
  glove: ViewModelGlove;
  /**
   * Handgelenk-Anker relativ zur Bildmitte in Bildhöhen (x rechts, y unten; 0.5 = Unterkante).
   * Die UI rechnet den 16:9-Safe-Frame ein — der Renderer platziert nur.
   */
  x: number;
  y: number;
  /** Zusätzlich zur Kamera hin (Hand-Einheiten), z. B. beim Trinken. */
  z: number;
  /** Drehung des Unterarms (rad) um die Bildachsen: pitch (x), yaw (y), roll (z, positiv = gegen den Uhrzeigersinn). */
  pitch: number;
  yaw: number;
  roll: number;
  /** Vertikaler Squash/Stretch (1 = neutral). */
  squash: number;
  /** VM_JOINT_COUNT Gelenkwinkel (rad). */
  readonly joints: Float32Array;
  item: ViewModelItem;
  /**
   * Gegenstand im Handgelenk-Raum (x −Daumen, y Finger, z Handrücken): Mitte (Dose, Karte) bzw.
   * Drehstift (Messer), Euler XYZ (rad), Sichtbarkeit 0..1 (Dither-Auflösen), Skalierung.
   */
  readonly propPos: Float32Array;
  readonly propRot: Float32Array;
  /** Drehung um die eigene Längsachse (y des Gegenstands), innerhalb von propRot: Twirl, Karten-Spin. */
  propSpin: number;
  propVisible: number;
  propScale: number;
  /** Dose: Lasche 0 = anliegend, 1 = hochgezogen; offen = Trinköffnung sichtbar. */
  canTab: number;
  canOpen: boolean;
  /**
   * Butterfly: Klinge relativ zum gehaltenen Griff (0 = offen, π = zu), zweiter Griff relativ
   * zur Klinge — beide Griffe liegen zusammen, wenn knifeBite = −knifeBlade (offen wie zu).
   */
  knifeBlade: number;
  knifeBite: number;
  /** Zauber-"Poof": Phase 0..1, < 0 = aus; Ort im Handflächen-Raum. */
  poof: number;
  readonly poofPos: Float32Array;
}

export function createViewModelFrame(): ViewModelFrame {
  return {
    visible: false,
    glove: 'classic',
    x: 0.3,
    y: 0.35,
    z: 0,
    pitch: 0,
    yaw: 0,
    roll: 0,
    squash: 1,
    joints: new Float32Array(VM_JOINT_COUNT),
    item: 'none',
    propPos: new Float32Array(3),
    propRot: new Float32Array(3),
    propSpin: 0,
    propVisible: 1,
    propScale: 1,
    canTab: 0,
    canOpen: false,
    knifeBlade: Math.PI,
    knifeBite: -Math.PI,
    poof: -1,
    poofPos: new Float32Array(3),
  };
}
