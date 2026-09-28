import type { RenderSettings } from '../render/types';
import { DEFAULT_RENDER_SETTINGS } from '../render/types';
import type { MovementPresetId } from '../player/MovementConfig';

/** Frei belegbare Aktionen. WASD bleiben fest (physische Codes, AZERTY bekommt ZQSD von selbst). */
export type BindAction = 'jump' | 'crouch' | 'sprint';

export const BIND_ACTIONS: readonly BindAction[] = ['jump', 'crouch', 'sprint'];

/** Höchstens so viele Tasten je Aktion (Primär + Zweitbelegung). */
export const MAX_BINDS_PER_ACTION = 2;

/**
 * Tastenbelegung: KeyboardEvent.code oder Maustaste als 'Mouse1'…'Mouse5'
 * (CS-Zählung: 1 links, 2 rechts, 3 Mitte, 4 zurück, 5 vor). Das Mausrad
 * springt immer (beide Richtungen) und ist nicht belegbar.
 */
export type KeyBinds = { readonly [A in BindAction]: readonly string[] };

export const DEFAULT_KEYBINDS: KeyBinds = {
  jump: ['Space'],
  crouch: ['KeyC', 'ControlLeft'],
  sprint: ['ShiftLeft'],
};

/** Handschuh der View-Hand (Kosmetik, Plan 005). 'neon' wird über engine/Unlocks freigeschaltet. */
export type GloveId = 'classic' | 'neon';
export const GLOVE_IDS: readonly GloveId[] = ['classic', 'neon'];

/** Gegenstand in der View-Hand (Kosmetik, Plan 005/006). Alles außer 'none' über engine/Unlocks. */
export type HeldItemId = 'none' | 'card' | 'can' | 'knife';
export const HELD_ITEM_IDS: readonly HeldItemId[] = ['none', 'card', 'can', 'knife'];

/**
 * Spieler-Einstellungen (persistiert in localStorage durch engine/Settings.ts).
 * Maus-Empfindlichkeit wie in CS: Grad pro Count = sensitivity × m_yaw.
 */
export interface GameSettings {
  readonly sensitivity: number;
  /** CS-Konstante 0.022 °/Count. Nur für Leute, die ihre CS-Sens 1:1 übernehmen wollen. */
  readonly mYaw: number;
  readonly invertY: boolean;
  /** Horizontales FOV in Grad bei 4:3 (CS-Konvention, 90). Breitbild bekommt Hor+. */
  readonly fov: number;
  readonly masterVolume: number;
  readonly musicVolume: number;
  readonly sfxVolume: number;
  readonly autoHop: boolean;
  /**
   * Boden-Wunschtempo immer Sprint; die Sprint-Taste (Shift) läuft dann langsamer
   * (runSpeed). Aus = klassisch: Shift halten = Sprint.
   */
  readonly autoSprint: boolean;
  /** In der Luft zählt W nicht, solange A/D gedrückt ist (MovementConfig.strafeAssist, Verdrahtung in Game). */
  readonly strafeAssist: boolean;
  readonly movementPreset: MovementPresetId;
  /** 0..1 Stärke der Kamera-Effekte. headBob = nur Laufen (Bob), motionFx = Landung, Pop, Roll, Surge, Surf-Lean. */
  readonly headBob: number;
  readonly motionFx: number;
  readonly screenShake: number;
  readonly fovKick: number;
  readonly showSpeedometer: boolean;
  /** Showkeys + Strafe-Spiegel unten links im HUD. */
  readonly showKeys: boolean;
  /** Hinweise im Moment (Crouch-Kante, Surf, Strafe) — jeder nur, bis die Handlung einmal gelingt. */
  readonly showHints: boolean;
  /**
   * Cartoon-Handschuh unten rechts (View-Hand, Plan 004). Bewegt sich nur mit motionFx —
   * bei 0 steht sie still in ihrer Pose.
   */
  readonly showHand: boolean;
  /**
   * Kosmetik (Plan 005): gewählter Handschuh und Gegenstand. Die Wahl bleibt gespeichert,
   * auch wenn die Freischaltung fehlt — Game/Menü zeigen dann den Standard (engine/Unlocks).
   */
  readonly glove: GloveId;
  readonly heldItem: HeldItemId;
  /** Ghost der Bestzeit fährt mit, HUD zeigt den Abstand an Checkpoints (Plan 003, S7). */
  readonly ghost: boolean;
  /** Start/Weiter/Nochmal gehen ins Vollbild mit Keyboard Lock (Strg duckt, Strg+W bleibt im Spiel). */
  readonly fullscreenOnStart: boolean;
  readonly keybinds: KeyBinds;
  readonly render: RenderSettings;
}

export const DEFAULT_SETTINGS: GameSettings = {
  sensitivity: 2.0,
  mYaw: 0.022,
  invertY: false,
  fov: 90,
  masterVolume: 0.8,
  musicVolume: 0.8,
  sfxVolume: 0.8,
  autoHop: true,
  autoSprint: true,
  strafeAssist: true,
  movementPreset: 'velocity',
  headBob: 1,
  motionFx: 1,
  screenShake: 1,
  fovKick: 1,
  showSpeedometer: true,
  showKeys: true,
  showHints: true,
  showHand: true,
  glove: 'classic',
  heldItem: 'none',
  ghost: true,
  fullscreenOnStart: true,
  keybinds: DEFAULT_KEYBINDS,
  render: DEFAULT_RENDER_SETTINGS,
};
