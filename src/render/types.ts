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
  /**
   * Tore einer Lektion (Plan 007): 0..1 je Tor in CompiledLevel.gates-Reihenfolge (0 = zu, 1 = offen
   * und aufgelöst). Nur gelesen. Fehlt = alle zu (bzw. keine Tore).
   */
  readonly gateOpen?: Float32Array;
}

export interface RendererApi {
  readonly canvas: HTMLCanvasElement;
  /** Aktuelle Low-Res-Auflösung (für den HUD-Canvas, der 1:1 darüber gelegt wird). */
  readonly lowResWidth: number;
  readonly lowResHeight: number;
  /** Seitenverhältnis des Low-Res-Bildes (lowResWidth / lowResHeight) — für CameraRig.setAspect. render() setzt camera.aspect ohnehin selbst. */
  readonly aspect: number;
  /** Level setzen; baut auch die Tor-Visuals aus level.gates (Plan 007, ab Phase 2 — leer ohne Lektion). */
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
  /**
   * Ziel-Foto (Plan 007, Handy Stufe 1): Kopie des zuletzt gerenderten Low-Res-Bilds, auf w×h
   * skaliert (Nearest). Außerhalb des Frame-Pfads aufrufen (einmal im Ziel). null = nicht verfügbar.
   */
  snapshot(w: number, h: number): HTMLCanvasElement | null;
  /**
   * Selfie (Plan 007, Handy Stufe 2): EIN zusätzlicher Welt-Durchgang aus der Kamera des letzten
   * render() mit Yaw + π in w×h (z. B. 96×54), davor die Hand aus `vm` (zweiter Viewmodel-Durchgang).
   * Außerhalb des Frame-Pfads, einmal im Ziel (Timer steht). null = nicht verfügbar.
   */
  selfie(w: number, h: number, vm: ViewModelFrame): HTMLCanvasElement | null;
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

/** Finger im Rig: Wurzel im Handgelenk-Raum, Radius des Grundglieds, drei Gliedlängen, Ruhe-Spreizung (rad). */
export interface VmFingerRig {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly r: number;
  readonly len: readonly [number, number, number];
  readonly splay: number;
}

/** Daumen: Sattelgelenk (Wurzel), Ruhe-Ausrichtung (rad), drei Glieder mit Radius. */
export interface VmThumbRig {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly baseX: number;
  readonly baseY: number;
  readonly baseZ: number;
  readonly len: readonly [number, number, number];
  readonly r: readonly [number, number, number];
}

/**
 * Maße des Hand-Rigs (Plan 007, aus ViewModel.ts in den Vertrag verschoben): die UI rechnet damit
 * Vorwärtskinematik (Schnur-Anker, Knöchel, Fingerspitzen im Handgelenk-Raum), der Renderer baut
 * daraus die Hand. Konvention wie ViewModel.apply (Euler-Reihenfolge ZXY): Finger f = Gruppe an
 * (x, y, z) mit rotation (−j[mcp], 0, j[spread] + splay), Mittel-/Endglied um x um −j[pip]/−j[dip],
 * jeweils um die vorige Gliedlänge entlang +y versetzt; Daumen-Wurzel rotation
 * (baseX − j[thumbOpp], baseY, baseZ + j[thumbAbd]), Glieder um x um −j[thumbMcp]/−j[thumbIp].
 * Fingerglieder verjüngen sich (Radius × 1 / 0.95 / 0.9). Skins mit eigener Geometrie hängen an
 * denselben Gliedern.
 */
export const VM_RIG: { readonly fingers: readonly VmFingerRig[]; readonly thumb: VmThumbRig } = {
  fingers: [
    { x: -3.15, y: 8.7, z: 0.2, r: 1.62, len: [3.2, 2.2, 1.9], splay: 0.07 },
    { x: -0.95, y: 9.1, z: 0.25, r: 1.66, len: [3.5, 2.4, 2.0], splay: 0.0 },
    { x: 1.25, y: 8.8, z: 0.2, r: 1.6, len: [3.3, 2.2, 1.9], splay: -0.06 },
    { x: 3.25, y: 8.0, z: 0.1, r: 1.45, len: [2.6, 1.8, 1.7], splay: -0.13 },
  ],
  thumb: { x: -3.4, y: 2.4, z: -0.8, baseZ: 0.62, baseX: -0.3, baseY: -0.85, len: [3.3, 2.5, 2.1], r: [1.85, 1.6, 1.48] },
};

/**
 * Hand-Skin (Plan 005/007), gleiche Werte wie GloveId in den Settings. Skins ohne Umsetzung zeichnet
 * der Renderer als 'classic'.
 */
export type ViewModelGlove = 'classic' | 'neon' | 'gold' | 'robot' | 'skeleton' | 'cat';
/** Gegenstand (Plan 006/007), gleiche Werte wie HeldItemId. Gegenstände ohne Umsetzung = 'none'. */
export type ViewModelItem = 'none' | 'can' | 'card' | 'knife' | 'yoyo' | 'spinner' | 'coin' | 'lighter' | 'kendama' | 'phone';

/** Punkte der Schnur (Jo-Jo, Kendama) in ViewModelFrame.stringPts. */
export const VM_STRING_POINTS = 9;

/**
 * Kanäle von ViewModelFrame.propParam je Gegenstand (Plan 007). Andere Gegenstände nutzen keine.
 *   spinner: Winkel (rad), Unschärfe 0..1, Nabe (−1 zurück / 0 / +1 vorn)
 *   coin:    Seite (0 Kopf, 1 Zahl)
 *   lighter: Deckel 0..1, Flamme 0..1, Windneigung −1..1, Rad-Winkel (rad)
 *   phone:   Modus (VM_PHONE_MODE), Wert (u/s bzw. s), Scroll-Versatz, Blitz 0..1
 */
export const VM_PARAM = {
  spinner: { angle: 0, blur: 1, hub: 2 },
  coin: { side: 0 },
  lighter: { lid: 0, flame: 1, wind: 2, wheel: 3 },
  phone: { mode: 0, value: 1, scroll: 2, flash: 3 },
} as const;

/** Anzeige des Handys (propParam[VM_PARAM.phone.mode]). */
export const VM_PHONE_MODE = { feed: 0, speedo: 1, split: 2, camera: 3, photo: 4 } as const;

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
  /**
   * Zweiter Körper im Handgelenk-Raum (Plan 007: Jo-Jo, Kendama-Kugel …): Mitte, Euler XYZ (rad),
   * Drehung um die eigene Achse, Sichtbarkeit 0..1 (0 = kein zweiter Körper).
   */
  readonly subPos: Float32Array;
  readonly subRot: Float32Array;
  subSpin: number;
  subVisible: number;
  /** Schnur: VM_STRING_POINTS Punkte (xyz) im Handgelenk-Raum, Punkt 0 = Finger/Griff; stringCount 0 = keine. */
  readonly stringPts: Float32Array;
  stringCount: number;
  /** Gegenstands-Kanäle, Bedeutung je Gegenstand in VM_PARAM. */
  readonly propParam: Float32Array;
  /** Skin-Effekt 0..1 (Katze: Krallen, Roboter: LED, Skelett: Klappern …), 0 = Ruhe. */
  skinFx: number;
}

export function createViewModelFrame(): ViewModelFrame {
  // Kommazahl-Felder mit Double-Startwert anlegen und danach neutral setzen: mit Smi-Start (0, 1, -1) boxte
  // Chrome jede spätere Zuweisung einer Kommazahl (alloc-probe --warmup 150: ViewHand.writeFrame 0.5–0.7 KiB/s).
  const f: ViewModelFrame = {
    visible: false,
    glove: 'classic',
    x: 0.3,
    y: 0.35,
    z: 0.5,
    pitch: 0.5,
    yaw: 0.5,
    roll: 0.5,
    squash: 0.5,
    joints: new Float32Array(VM_JOINT_COUNT),
    item: 'none',
    propPos: new Float32Array(3),
    propRot: new Float32Array(3),
    propSpin: 0.5,
    propVisible: 0.5,
    propScale: 0.5,
    canTab: 0.5,
    canOpen: false,
    knifeBlade: Math.PI,
    knifeBite: -Math.PI,
    poof: -0.5,
    poofPos: new Float32Array(3),
    subPos: new Float32Array(3),
    subRot: new Float32Array(3),
    subSpin: 0.5,
    subVisible: 0.5,
    stringPts: new Float32Array(VM_STRING_POINTS * 3),
    stringCount: 0,
    propParam: new Float32Array(4),
    skinFx: 0.5,
  };
  f.z = 0;
  f.pitch = 0;
  f.yaw = 0;
  f.roll = 0;
  f.squash = 1;
  f.propSpin = 0;
  f.propVisible = 1;
  f.propScale = 1;
  f.canTab = 0;
  f.poof = -1;
  f.subSpin = 0;
  f.subVisible = 0;
  f.skinFx = 0;
  return f;
}
