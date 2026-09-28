import type { LevelMedals, StageRank } from '../world/level/LevelFormat';
import type { LessonStars } from '../engine/trainingTypes';
import type { MedalId } from './medals';

/** Pro Frame vom Spiel an das HUD. */
export interface HudData {
  /** Horizontale Geschwindigkeit, u/s. */
  readonly speed: number;
  readonly hopChain: number;
  /** 0..1 */
  readonly strafeSync: number;
  readonly onGround: boolean;
  readonly surfing: boolean;
  /** Laufzeit in s; null = Timer noch nicht gestartet. */
  readonly runTime: number | null;
  /** Timer läuft (Start-Zone verlassen, Ziel noch nicht erreicht). */
  readonly running: boolean;
  /** index = zuletzt erreichter Checkpoint (0 = keiner), total = Anzahl im Level (0 = Level ohne CPs). */
  readonly checkpoint: { readonly index: number; readonly total: number };
  readonly levelName: string;
  /** Untertitel fürs Level-Intro (optional). */
  readonly levelSubtitle?: string | null;
  readonly bestTime: number | null;
  readonly showSpeedometer: boolean;
  /** Showkeys + Strafe-Spiegel unten links (Einstellung showKeys). */
  readonly showKeys: boolean;
  readonly keys: HudKeys;
  readonly paused: boolean;
  /**
   * Abstand zum Ghost der Bestzeit am zuletzt erreichten Checkpoint bzw. im Ziel (s,
   * negativ = vor dem Ghost). null/fehlt = kein Ghost oder noch kein Checkpoint.
   */
  readonly ghostDiff?: number | null;
  /**
   * Der Ghost liegt im Bild hinter dem Speedometer-Block (Game projiziert ihn) —
   * das HUD blendet den Block dann weich auf 30 % ab. Fehlt = false.
   */
  readonly ghostOverHud?: boolean;
  /**
   * Nächste noch nicht erreichte Medaille (aus der Bestzeit, Plan 005) — HUD zeigt sie klein
   * in der Timer-Zeile. null/fehlt = keine Medaillen oder alles geholt. Game setzt ein neues
   * Objekt nur beim Levelstart und im Ziel (nicht pro Frame).
   */
  readonly nextMedal?: { readonly id: MedalId; readonly limit: number } | null;
  /**
   * Lektionskarte im Trainingsmodus (Plan 007) an der Stelle des Timers. null/fehlt = keine Lektion
   * (normales Level). Dasselbe Objekt in jedem Frame (TrainingSessionApi.hud).
   */
  readonly lesson?: LessonHud | null;
}

/**
 * Lektionskarte (Plan 007). Texte ändern sich nur beim Stufenwechsel, Zahlen sind Ganzzahlen
 * (count/goal: Hops, Landungen, Zonen; bei surfHold Zehntelsekunden).
 */
export interface LessonHud {
  readonly lessonTitle: string;
  readonly stageTitle: string;
  /** Aufgabentext, ≤ 2 Zeilen à ≤ 40 Zeichen ("\n" trennt). */
  readonly text: string;
  readonly count: number;
  readonly goal: number;
  /** pips = einzelne Punkte (kleine Ziele), bar = Balken (Tempo, Zeit). */
  readonly style: 'pips' | 'bar';
  readonly rank: StageRank;
  /** Stufe ab 0 und Anzahl Stufen der Lektion. */
  readonly stageIndex: number;
  readonly stageTotal: number;
  /** Vorführung läuft (Taste H). */
  readonly demo: boolean;
}

/**
 * Tasten und Blick des letzten Ticks-Blocks für Showkeys und Strafe-Spiegel.
 * Game füllt ein wiederverwendetes Objekt (keine Allokation pro Frame).
 */
export interface HudKeys {
  /** −1..1 wie PlayerInput (W = +1, D = +1). */
  readonly forward: number;
  readonly side: number;
  readonly jump: boolean;
  readonly crouch: boolean;
  /**
   * Blick-Drehrate dieses Frames in °/s, ganzzahlig gerundet; > 0 = nach links (yaw steigt).
   * Ganzzahlen bleiben in V8 Smis — Gleitkomma-Felder erzeugen in nicht optimiertem Code bei jedem Lesen eine Box.
   */
  readonly turnDeg: number;
  /** In der Luft (nicht surfend). */
  readonly inAir: boolean;
  /**
   * Strafe-Spiegel: 1 = A/D passt zur Mausrichtung und brachte Gewinn,
   * −1 = Taste gegen die Maus, 0 = neutral (Boden, keine Drehung, Surf).
   */
  readonly strafe: number;
  /** So lange (ms, ganzzahlig) wird W in der Luft zusammen mit A/D gehalten; 0 = nicht. */
  readonly forwardInAirMs: number;
  /**
   * Zielband der Drehrate (°/s) am Drehbalken, nur in Lektionen (Plan 007, TrainingSessionApi.turnBand).
   * null/fehlt = kein Band.
   */
  readonly turnBand?: { readonly lo: number; readonly hi: number } | null;
}

/** Lesbarer Zustand der Raw-Maus (InputManager.rawStatus) für die Einstellungen. */
export type RawMouseStatus = 'unknown' | 'active' | 'unavailable';

/** Ergebnis eines Laufs für den Ergebnis-Bildschirm. */
export interface FinishResult {
  readonly levelId: string;
  readonly levelName: string;
  /** Zeit dieses Laufs, s. */
  readonly time: number;
  /** Bestzeit vor diesem Lauf (null = erster Abschluss). */
  readonly previousBest: number | null;
  /** Dieser Lauf ist neue Bestzeit. */
  readonly isBest: boolean;
  /** Entwickler-Zeit (LevelFile.parTime). */
  readonly parTime: number | null;
  /** Kumulierte Checkpoint-Zeiten dieses Laufs. */
  readonly splits: readonly number[];
  /** Kumulierte Checkpoint-Zeiten der Bestzeit VOR diesem Lauf (zum Vergleich). */
  readonly bestSplits: readonly number[] | null;
  /** Gibt es ein nächstes Level? (Enter / Button) */
  readonly hasNext: boolean;
  /** Höchstgeschwindigkeit im Lauf, u/s (optional). */
  readonly topSpeed?: number;
  /** Medaillen-Zeiten des Levels (LevelFile.medals), null/fehlt = keine. */
  readonly medals?: LevelMedals | null;
  /** Mit diesem Lauf neu freigeschaltete Kosmetik (Anzeigenamen, Plan 005) — groß im Ergebnis. */
  readonly unlocked?: readonly string[];
  /** Ziel-Foto des Handys (Plan 007, RendererApi.snapshot/selfie) — Polaroid im Ergebnis. Fehlt = keins. */
  readonly photo?: HTMLCanvasElement;
}

/** Ergebnis einer Lektion (Plan 007) für den Bildschirm 'lessonDone'. */
export interface LessonResult {
  readonly lessonId: string;
  readonly name: string;
  readonly stars: LessonStars;
  readonly stages: readonly { readonly id: string; readonly title: string; readonly rank: StageRank; readonly done: boolean }[];
  /** Nächste Lektion (TrainingIndexEntry.id), null = letzte. */
  readonly nextLessonId: string | null;
  /** Mit dieser Lektion neu freigeschaltete Kosmetik (Anzeigenamen). */
  readonly unlocked: readonly string[];
}

export interface MenuEvents {
  /** Level starten — kommt direkt aus einem Klick/Enter (User-Geste für Pointer Lock + Audio-Unlock). */
  play: { readonly levelId: string };
  /** Aus der Pause weiter — ebenfalls User-Geste. */
  resume: void;
  restart: void;
  toTitle: void;
  nextLevel: void;
  /** Vollbild umschalten (InputManager.toggleFullscreen, User-Geste). */
  fullscreen: void;
  /**
   * Admin-Menü hat die Bestzeit eines Levels gesetzt oder gelöscht (BestTimes ist schon
   * geschrieben). Game löscht den Ghost des Levels (gehört nicht mehr zur Bestzeit) und
   * frischt Bestzeit/Nächstes Ziel auf, falls es das laufende Level ist.
   */
  adminBest: { readonly levelId: string };
  /** Vorführung der aktuellen Stufe starten (Pause-Menü einer Lektion, Plan 007). */
  demo: void;
  /** Aktuelle Stufe überspringen (Pause-Menü/Admin einer Lektion, Plan 007). */
  skipStage: void;
}

export type MenuEventName = keyof MenuEvents;

export type MenuScreen = 'title' | 'pause' | 'settings' | 'controls' | 'finish' | 'cosmetics' | 'admin' | 'training' | 'lessonDone';
