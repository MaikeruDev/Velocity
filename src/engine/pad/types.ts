/**
 * Vertrag Controller (Plan 011 §3): Pad-Knöpfe, Belegung, Einstellungen, Eingabegerät.
 * Bewusst NICHT in settingsTypes/KeyBinds — sonst hinge der Pad-Stand am Verifier-Bundle (fallen.md #210, #214).
 * Nur Typen und Konstanten, DOM-frei.
 */

import { DEFAULT_LOOK_CURVE } from './stickCurve';

/**
 * Pad-Knöpfe als Pseudo-Codes im selben held-Set wie Tastatur und Maus (Plan 011 §2.2.3).
 * Index in PAD_BUTTONS = Gamepad "standard" Mapping (W3C), Namen in Xbox-Lage.
 */
export type PadButtonCode =
  | 'PadA'
  | 'PadB'
  | 'PadX'
  | 'PadY'
  | 'PadLB'
  | 'PadRB'
  | 'PadLT'
  | 'PadRT'
  | 'PadView'
  | 'PadMenu'
  | 'PadL3'
  | 'PadR3'
  | 'PadUp'
  | 'PadDown'
  | 'PadLeft'
  | 'PadRight'
  | 'PadHome';

export const PAD_BUTTONS: readonly PadButtonCode[] = [
  'PadA',
  'PadB',
  'PadX',
  'PadY',
  'PadLB',
  'PadRB',
  'PadLT',
  'PadRT',
  'PadView',
  'PadMenu',
  'PadL3',
  'PadR3',
  'PadUp',
  'PadDown',
  'PadLeft',
  'PadRight',
  'PadHome',
];

/** Home/Guide gehört dem System (Steam, Xbox-Leiste) — nie belegbar. */
export function isBindablePadCode(code: string): code is PadButtonCode {
  return code !== 'PadHome' && (PAD_BUTTONS as readonly string[]).includes(code);
}

/** Belegbare Pad-Aktionen: gehaltene Knöpfe (jump/crouch/sprint) und Spiel-Aktionen. */
export type PadBindAction = 'jump' | 'crouch' | 'sprint' | 'respawn' | 'demo' | 'restart' | 'pause';

export const PAD_BIND_ACTIONS: readonly PadBindAction[] = ['jump', 'crouch', 'sprint', 'respawn', 'demo', 'restart', 'pause'];

export type PadBinds = { readonly [K in PadBindAction]: readonly PadButtonCode[] };

/** Höchstens so viele Knöpfe je Aktion (Bumper + Gesichtstaste, plus Reserve). */
export const MAX_PAD_BINDS_PER_ACTION = 3;

export type PadPresetId = 'bumper' | 'classic';

/**
 * "Bumper-Sprung" (Default, §2.2.5): Sprung auf der Schulter, damit der Daumen am Kamera-Stick bleibt.
 * A/B bleiben für Einsteiger mitbelegt. Neustart = View GEHALTEN (PAD_RESTART_HOLD), sonst kostet ein
 * versehentlicher Druck den Lauf.
 * Sprint (mit Auto-Sprint: "Langsamer") auf LT, L3 bleibt frei (Review A9): wer den digitalen Bewegungs-Stick hart
 * drückt, klickte L3 mit → 320 → 250 u/s, Rutschen (ab 280) ging nicht. LT ist in beiden Presets und im Menü frei.
 */
export const PAD_PRESETS: { readonly [K in PadPresetId]: PadBinds } = {
  bumper: {
    jump: ['PadLB', 'PadA'],
    crouch: ['PadRB', 'PadB'],
    sprint: ['PadLT'],
    respawn: ['PadY'],
    demo: ['PadX'],
    restart: ['PadView'],
    pause: ['PadMenu'],
  },
  classic: {
    jump: ['PadA'],
    crouch: ['PadB'],
    sprint: ['PadLT'],
    respawn: ['PadY'],
    demo: ['PadX'],
    restart: ['PadView'],
    pause: ['PadMenu'],
  },
};

/** Zuletzt benutztes Eingabegerät (Prompts/Glyphen). 'generic' zeigt Xbox-Beschriftung. */
export type InputDevice = 'keyboard' | 'xbox' | 'playstation' | 'generic';

/** Einstellung "Tasten-Symbole": schlägt die Erkennung (Steam Input meldet oft ein emuliertes Xbox-Pad). */
export type GlyphStyle = 'auto' | 'xbox' | 'playstation';

/** Aktionen mit Tasten-Hinweis im HUD/Menü (InputManager.promptLabel). */
export type PromptAction =
  | 'jump'
  | 'crouch'
  | 'sprint'
  | 'respawn'
  | 'restart'
  | 'demo'
  | 'pause'
  | 'confirm'
  | 'back'
  | 'tabPrev'
  | 'tabNext';

export const PROMPT_ACTIONS: readonly PromptAction[] = [
  'jump',
  'crouch',
  'sprint',
  'respawn',
  'restart',
  'demo',
  'pause',
  'confirm',
  'back',
  'tabPrev',
  'tabNext',
];

/**
 * Default-Höchst-Drehrate des Kamera-Sticks (°/s bei voller Auslenkung, ohne Boost). Quelle ist der
 * Sim-Beleg in stickCurve.DEFAULT_LOOK_CURVE (Plan 011 S1a, movement-tuning.md "Controller") — dort ändern.
 */
export const PAD_DEFAULT_YAW_RATE_DEG = DEFAULT_LOOK_CURVE.maxYawRate;
/** Vertikal langsamer: Zielen nach oben/unten braucht Feinheit, keine Strafe-Rate. */
export const PAD_DEFAULT_PITCH_RATE_DEG = DEFAULT_LOOK_CURVE.maxPitchRate;

/** Neustart-Knopf so lange halten (s). */
export const PAD_RESTART_HOLD = 0.4;
/** Belegungs-Aufnahme: ohne Druck nach so langer Zeit abbrechen (s) — ein Pad hat kein Esc. */
export const PAD_CAPTURE_TIMEOUT = 5;
/** Belegungs-Aufnahme: B so lange halten = abbrechen (kurz gedrückt belegt B). */
export const PAD_CAPTURE_CANCEL_HOLD = 0.6;
/** Trigger digital mit Hysterese (§2.2.3): an ab ≥ ON, aus erst ≤ OFF. */
export const PAD_TRIGGER_ON = 0.6;
export const PAD_TRIGGER_OFF = 0.4;

export interface PadSettings {
  /** Höchst-Drehrate horizontal / vertikal (°/s) — "Kamera-Empfindlichkeit". */
  readonly yawRate: number;
  readonly pitchRate: number;
  readonly invertY: boolean;
  /** Radiale Deadzone des Kamera-Sticks (Betrag 0…1). */
  readonly deadzoneInner: number;
  readonly deadzoneOuter: number;
  /** Exponent der Antwortkurve (1 = linear). */
  readonly curve: number;
  /** Dreh-Boost am Rand (+Anteil der Grundrate, 0 = aus). */
  readonly boost: number;
  /** Bewegungs-Stick: ab diesem Betrag zählt er als Richtung (digital, §2.2.1). */
  readonly moveDeadzone: number;
  /** Winkelbreite der Diagonalen (°) für die 8-Richtungs-Abbildung. */
  readonly diagonalBand: number;
  readonly glyphs: GlyphStyle;
  readonly binds: PadBinds;
}

export const DEFAULT_PAD_SETTINGS: PadSettings = {
  yawRate: PAD_DEFAULT_YAW_RATE_DEG,
  pitchRate: PAD_DEFAULT_PITCH_RATE_DEG,
  invertY: false,
  deadzoneInner: DEFAULT_LOOK_CURVE.inner,
  deadzoneOuter: DEFAULT_LOOK_CURVE.outer,
  curve: DEFAULT_LOOK_CURVE.exponent,
  boost: DEFAULT_LOOK_CURVE.boost,
  moveDeadzone: 0.3,
  diagonalBand: 30,
  glyphs: 'auto',
  binds: PAD_PRESETS.bumper,
};

/** Grenzen für sanitizePadSettings und das Menü (S1c). */
export const PAD_LIMITS = {
  yawRate: [180, 900],
  pitchRate: [30, 900],
  deadzoneInner: [0, 0.5],
  deadzoneOuter: [0.5, 1],
  curve: [1, 3.5],
  boost: [0, 1.5],
  moveDeadzone: [0.1, 0.9],
  diagonalBand: [10, 80],
} as const satisfies Readonly<Record<string, readonly [number, number]>>;
