/**
 * Level-Dateiformat (public/levels/*.json).
 *
 * Einheiten: Source-Units (1 u ≈ 1 Zoll). Y ist oben (Three.js-Konvention),
 * nicht Z wie in Hammer. Ein Standard-Spieler ist 32 u breit und 72 u hoch,
 * springt 57 u hoch und läuft 250 u/s.
 *
 * Levels werden nicht von Hand geschrieben, sondern von `tools/levels/*.ts`
 * erzeugt (`npm run levels:build`). Das JSON ist trotzdem lesbar und
 * handeditierbar — es ist die einzige Wahrheit, die das Spiel lädt.
 */

export type Vec3Tuple = readonly [number, number, number];
export type Vec2Tuple = readonly [number, number];

/**
 * Oberflächen-Materialien. Der Renderer wählt daraus Textur, Grundfarbe und
 * ob die Oberkante eine Neon-Trim bekommt. Physikalisch sind alle gleich —
 * Surfen entsteht allein aus der Flächenneigung (normal.y < 0.7).
 */
export type MaterialId =
  | 'floor' // begehbare Plattform, helles Beton/Fliesen-Raster
  | 'wall' // Seitenflächen, Säulen, Blöcke
  | 'metal' // Stahlplatten, Industrie
  | 'surf' // Surf-Rampen (steile Flächen), gut lesbar gestreift
  | 'accent' // farbige Paneele zur Orientierung
  | 'hazard' // Warnstreifen (Kanten, Gefahren)
  | 'duck' // Crouch-Kante: Piktogramm "↑C" und Chevrons nach oben (Brush-Tint = Trim-Farbe)
  | 'light' // Leuchtkörper: ganz selbstleuchtend in Brush-Tint (z. B. Stufen-Lichter am L2-Ausfahrt-Tor)
  /**
   * Leuchtende Bodenmarkierung (Chevrons): nur die Oberseite wird gezeichnet,
   * flach, kantenscharf und selbstleuchtend über die Trim-Pipeline, Farbe = tint.
   * Die Oberseite muss ein Parallelogramm sein und auf der Fläche darunter liegen;
   * immer collide:false. Der Validator prüft beides.
   */
  | 'marking'
  | 'start' // Startplattform
  | 'checkpoint' // Checkpoint-Plattform
  | 'finish' // Zielplattform
  | 'dark'; // Deko / Silhouetten ohne Detail

interface BrushCommon {
  readonly mat: MaterialId;
  /** Farbmultiplikator als Hex, z. B. "#ff4fd8". Default: Materialfarbe. */
  readonly tint?: string;
  /** Neon-Trim an den Kanten begehbarer Oberseiten. Default: true bei begehbaren Flächen. */
  readonly trim?: boolean;
  /** false = nur Deko, keine Kollision. Default: true. */
  readonly collide?: boolean;
  /**
   * Zweites, dunkleres Leuchtband (trimColorAlt) an der Unterkante der Seitenflächen:
   * macht schwebende Körper im Dunkeln als Volumen lesbar (L2: Ring). Default: false.
   */
  readonly underTrim?: boolean;
  /**
   * false = unsichtbarer Clip: kollidiert, wird aber nicht gerendert und
   * bekommt keine Trims (Source "clip"-Brush, z. B. eine Rampe über einer
   * Treppe, damit man sie im Hop nicht als Wand trifft). Default: true.
   */
  readonly visible?: boolean;
  /** Rotation um die Y-Achse in Grad (gegen den Uhrzeigersinn von oben gesehen, wie three.js rotation.y). */
  readonly rotY?: number;
  /** Drehpunkt für rotY. Default: Mittelpunkt der Bounding-Box des Primitivs. */
  readonly pivot?: Vec3Tuple;
  /** Freier Name fürs Debugging / Validator-Ausgaben. */
  readonly tag?: string;
}

/** Achsparalleler Quader. */
export interface BoxDef extends BrushCommon {
  readonly type: 'box';
  readonly min: Vec3Tuple;
  readonly max: Vec3Tuple;
}

/**
 * Rampe: füllt die AABB [min,max], Oberseite steigt linear in Richtung `rise`
 * von `lowY` (Default min.y, also Keilspitze) bis max.y an.
 */
export interface WedgeDef extends BrushCommon {
  readonly type: 'wedge';
  readonly min: Vec3Tuple;
  readonly max: Vec3Tuple;
  readonly rise: '+x' | '-x' | '+z' | '-z';
  readonly lowY?: number;
}

/**
 * Prisma: konvexes 2D-Profil, entlang `axis` von `from` bis `to` extrudiert.
 * Profilpunkte sind [a, y]; a ist die horizontale Koordinate quer zur Achse
 * (bei axis 'z' ist a = x, bei axis 'x' ist a = z). Klassische Surf-Rampe:
 * Dreiecksprofil mit zwei steilen Flanken.
 */
export interface PrismDef extends BrushCommon {
  readonly type: 'prism';
  readonly axis: 'x' | 'z';
  readonly from: number;
  readonly to: number;
  readonly profile: readonly Vec2Tuple[];
}

/** Beliebige konvexe Hülle aus Punkten (≥ 4, nicht koplanar). */
export interface HullDef extends BrushCommon {
  readonly type: 'hull';
  readonly points: readonly Vec3Tuple[];
}

export type BrushDef = BoxDef | WedgeDef | PrismDef | HullDef;

export type TriggerKind = 'start' | 'checkpoint' | 'finish' | 'kill';

export interface TriggerDef {
  readonly kind: TriggerKind;
  readonly min: Vec3Tuple;
  readonly max: Vec3Tuple;
  /** Bei checkpoint: Reihenfolge ab 1. Respawn-Punkt ist `spawn` falls gesetzt, sonst Trigger-Mitte (Boden). */
  readonly order?: number;
  readonly spawn?: { readonly pos: Vec3Tuple; readonly yaw: number };
  readonly tag?: string;
}

export interface EnvironmentDef {
  /** Himmel oben / am Horizont / unter dem Horizont (Hex). */
  readonly skyTop: string;
  readonly skyHorizon: string;
  readonly skyBottom: string;
  readonly fogColor: string;
  /** Linearer Vertex-Fog in Units. */
  readonly fogNear: number;
  readonly fogFar: number;
  /** Richtung ZUR Sonne (wird normalisiert). */
  readonly sunDir: Vec3Tuple;
  readonly sunColor: string;
  readonly ambientSky: string;
  readonly ambientGround: string;
  /** Farbe der Neon-Trims und des Void-Grids; pulsiert mit der Kick. */
  readonly trimColor: string;
  readonly trimColorAlt?: string;
  /** Y-Höhe des leuchtenden Grids tief unten (reine Optik). */
  readonly voidY: number;
}

/**
 * Ideallinie für Bots (Level-Validierung, Sim) — kein Gameplay-Element.
 * Der Bot steuert Knoten für Knoten an. `pos` sind die Füße (Hull-Unterkante).
 */
export interface RouteNode {
  readonly pos: Vec3Tuple;
  /** An diesem Knoten abspringen, Flug bis zum nächsten Knoten. In Ketten ist jeder Landepunkt zugleich Absprung. */
  readonly jump?: boolean;
  /** Crouch-Jump nötig (in der Luft ducken: Füße +18 u). */
  readonly crouch?: boolean;
  /** Planungstempo an diesem Knoten (horizontal, u/s); Lücken ab hier sind darauf ausgelegt. */
  readonly minSpeed?: number;
  /**
   * Knoten an einer Surf-Flanke (kein Boden). Aufeinanderfolgende Surf-Knoten
   * auf lückenlos anschließenden Rampen bilden einen Surf-Abschnitt.
   */
  readonly surf?: boolean;
  /** Luftknoten ohne Boden (Abrollen, Launch, Überflug) — kein Surf. */
  readonly air?: boolean;
  /**
   * Präzisionsziel: die Landung hier verlangt Tempokontrolle (zu schnell →
   * bremsen). Der Validator nimmt den Sprung auf diesen Knoten vom
   * Überschieß-Band aus.
   */
  readonly precision?: boolean;
  /** Freitext fürs Debugging / Reports — ohne Bedeutung für Bots und Validator. */
  readonly note?: string;
}

export interface LevelFile {
  readonly version: 1;
  readonly id: string;
  readonly name: string;
  readonly subtitle?: string;
  /** Spawn an der Fußposition (Hull-Unterkante). yaw in Grad, 0 = Blick nach -Z. */
  readonly spawn: { readonly pos: Vec3Tuple; readonly yaw: number };
  /** Unterhalb dieser Höhe (Füße) → Respawn am letzten Checkpoint. */
  readonly killY: number;
  /** Musik-Tonart/Stimmung als Hinweis für die Audio-Engine. */
  readonly music?: { readonly root?: string; readonly bpm?: number };
  readonly environment: EnvironmentDef;
  readonly brushes: readonly BrushDef[];
  readonly triggers: readonly TriggerDef[];
  /**
   * Par in Sekunden (ganze Sekunden, = Bronze aufgerundet) für die Ergebnis-Anzeige.
   * Gemessen wie der RunState-Timer: ab Verlassen der Startzone bis ins Ziel.
   */
  readonly parTime?: number;
  /** Medaillen-Zeiten (s), gemessen wie parTime; siehe LevelMedals. */
  readonly medals?: LevelMedals;
  /** Ideallinie für Bots, siehe RouteNode. */
  readonly route?: readonly RouteNode[];
}

/**
 * Medaillen-Zeiten in Sekunden (bronze > silver > gold > velocity ≥ author),
 * aus Bot-Läufen gemessen (tools/levels/build.ts) und wie der RunState-Timer
 * gezählt: ab Verlassen der Startzone bis zur Berührung des Ziels, Tode inklusive.
 * Bronze = 3°-Hand × 1.05, Silber = 2°-Hand × 1.05, Gold = perfekter Bot × 1.10,
 * velocity = perfekter Bot × 1.05 (Top-Medaille "VELOCITY", schaltet Kosmetik frei,
 * Begründung in level-design.md Regel 10), author = perfekter Bot (Entwickler-Zeit,
 * keine Medaille — nur Referenz im Ergebnis).
 */
export interface LevelMedals {
  readonly bronze: number;
  readonly silver: number;
  readonly gold: number;
  readonly velocity: number;
  readonly author: number;
}

/** public/levels/index.json — Reihenfolge = Levelauswahl. */
export interface LevelIndexEntry {
  readonly id: string;
  readonly name: string;
  readonly subtitle?: string;
  /** Pfad der Level-Datei, relativ zu index.json (z. B. "level1.json"). */
  readonly file: string;
  /** Kopie von LevelFile.medals (build.ts) — die Titel-Liste zeigt Medaillen, ohne Level zu laden. */
  readonly medals?: LevelMedals;
}
