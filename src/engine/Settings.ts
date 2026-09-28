import type { BindAction, GameSettings, GloveId, HeldItemId, KeyBinds } from './settingsTypes';
import { DEFAULT_SETTINGS, GLOVE_IDS, HELD_ITEM_IDS, MAX_BINDS_PER_ACTION } from './settingsTypes';
import { isBindableCode } from './InputState';
import type { RenderSettings } from '../render/types';
import { MOVEMENT_PRESETS, withMovement } from '../player/MovementConfig';
import type { MovementConfig, MovementPresetId } from '../player/MovementConfig';

/**
 * Persistenz für Einstellungen und Bestzeiten. localStorage kann fehlen oder
 * werfen (Privatmodus, gesperrte Cookies, Quota) — dann läuft alles im Speicher
 * weiter, nur eben nicht über den Reload hinaus.
 */

/** Minimaler Storage-Ausschnitt — Tests geben ein Map-basiertes Fake hinein. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const SETTINGS_KEY = 'velocity.settings.v1';
export const BEST_KEY = 'velocity.best.v1';

/** Erlaubte Pixelhöhen (RenderSettings.pixelHeight). */
export const PIXEL_HEIGHTS: readonly number[] = [224, 240, 270, 360, 448];

/** Teil-Update: `render` und `keybinds` dürfen ebenfalls teilweise sein. */
export type SettingsPatch = {
  readonly [K in keyof GameSettings]?: K extends 'render'
    ? Partial<RenderSettings>
    : K extends 'keybinds'
      ? Partial<Record<BindAction, readonly string[]>>
      : GameSettings[K];
};

type SettingsListener = (next: GameSettings, prev: GameSettings) => void;

/** Wertebereiche — Menü und Tuning-Panel nutzen dieselben Grenzen. */
export const SETTING_RANGES = {
  sensitivity: { min: 0.05, max: 20 },
  mYaw: { min: 0.001, max: 0.1 },
  fov: { min: 60, max: 130 },
  volume: { min: 0, max: 1 },
  effect: { min: 0, max: 1 },
  colorBits: { min: 2, max: 8 },
} as const;

export function defaultStorage(): StorageLike | null {
  try {
    const s = globalThis.localStorage;
    return s ?? null;
  } catch {
    return null;
  }
}

export class SettingsStore {
  private readonly storage: StorageLike | null;
  private current: GameSettings;
  private readonly listeners = new Set<SettingsListener>();

  constructor(storage: StorageLike | null = defaultStorage()) {
    this.storage = storage;
    this.current = sanitizeSettings(readJson(storage, SETTINGS_KEY), DEFAULT_SETTINGS);
  }

  get(): GameSettings {
    return this.current;
  }

  /** Tief mergen, validieren, speichern, Abonnenten benachrichtigen. Ungültige Werte fallen auf den bisherigen Wert zurück. */
  update(patch: SettingsPatch): GameSettings {
    const prev = this.current;
    // Preset-Wechsel ohne ausdrücklichen Assist-Wert: der Strafe-Assist folgt dem Preset
    // (CS2 aus, velocity an). Hier statt im Menü, damit auch das F1-Panel es bekommt.
    // Bewusst kein "vom Spieler gesetzt"-Merker: der Preset-Wechsel IST die Spielerwahl,
    // der Schalter steht direkt darüber. Bei zwei Presets mit gegensätzlichem Default wäre
    // "Abweichung behalten" ohnehin identisch mit "Default des neuen Presets".
    const presetChange = patch.movementPreset !== undefined && patch.movementPreset !== prev.movementPreset && isPresetId(patch.movementPreset);
    const presetAssist =
      presetChange && patch.strafeAssist === undefined ? { strafeAssist: MOVEMENT_PRESETS[patch.movementPreset].strafeAssist } : {};
    // Luftlenkung genauso (Plan 007): CS2 schaltet sie aus, velocity wieder an.
    const presetAir =
      presetChange && patch.airControl === undefined ? { airControl: MOVEMENT_PRESETS[patch.movementPreset].airControl > 0 } : {};
    const merged = {
      ...prev,
      ...patch,
      ...presetAssist,
      ...presetAir,
      render: { ...prev.render, ...(patch.render ?? {}) },
      keybinds: { ...prev.keybinds, ...(patch.keybinds ?? {}) },
    };
    const next = sanitizeSettings(merged, prev);
    if (settingsEqual(prev, next)) return prev;
    this.current = next;
    writeJson(this.storage, SETTINGS_KEY, next);
    for (const fn of this.listeners) fn(next, prev);
    return next;
  }

  /** Alles auf Werkseinstellung. */
  reset(): GameSettings {
    return this.update(DEFAULT_SETTINGS);
  }

  /** Wird nur bei echten Änderungen gerufen (nicht sofort beim Abonnieren). */
  subscribe(fn: SettingsListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

/**
 * Movement-Config aus den Spieler-Einstellungen: Preset als Basis, Auto-Hop und
 * Strafe-Assist aus den Settings (Spielerwahl schlägt Preset). Luftlenkung: die Einstellung kann
 * sie nur abschalten (0); an gilt der Wert des Presets (CS2 hat keine). Einzige Stelle
 * dieser Regel — Engine und TuningPanel benutzen beide diese Funktion.
 */
export function movementConfigFor(s: GameSettings): MovementConfig {
  const base = MOVEMENT_PRESETS[s.movementPreset];
  return withMovement(base, { autoHop: s.autoHop, strafeAssist: s.strafeAssist, airControl: s.airControl ? base.airControl : 0 });
}

// ------------------------------------------------------------------ Bestzeiten

interface BestEntry {
  readonly time: number;
  /** Kumulierte Checkpoint-Zeiten des Bestlaufs (s ab Start). */
  readonly splits: readonly number[];
  /** ISO-Datum des Laufs. */
  readonly date: string;
}

export interface SubmitResult {
  readonly best: boolean;
  readonly previous: number | null;
}

export class BestTimes {
  private readonly storage: StorageLike | null;
  private entries: Map<string, BestEntry>;

  constructor(storage: StorageLike | null = defaultStorage()) {
    this.storage = storage;
    this.entries = parseBest(readJson(storage, BEST_KEY));
  }

  get(levelId: string): number | null {
    return this.entries.get(levelId)?.time ?? null;
  }

  getSplits(levelId: string): readonly number[] | null {
    return this.entries.get(levelId)?.splits ?? null;
  }

  /** Lauf einreichen. Neue Bestzeit nur bei echter Verbesserung (Gleichstand zählt nicht). */
  submit(levelId: string, time: number, splits: readonly number[]): SubmitResult {
    const previous = this.get(levelId);
    if (!isValidTime(time)) return { best: false, previous };
    if (previous !== null && time >= previous) return { best: false, previous };
    this.entries.set(levelId, {
      time,
      splits: splits.filter(isValidTime),
      date: new Date().toISOString(),
    });
    this.save();
    return { best: true, previous };
  }

  /**
   * Admin-Menü: Bestzeit hart setzen, auch schlechter als die bisherige. Ohne Zwischenzeiten —
   * es gab keinen Lauf, gegen den man Checkpoints vergleichen könnte. false = ungültige Zeit.
   */
  set(levelId: string, time: number): boolean {
    if (!isValidTime(time)) return false;
    this.entries.set(levelId, { time, splits: [], date: new Date().toISOString() });
    this.save();
    return true;
  }

  /** Bestzeit eines Levels löschen (oder alle, ohne Argument). */
  clear(levelId?: string): void {
    if (levelId === undefined) this.entries.clear();
    else this.entries.delete(levelId);
    this.save();
  }

  private save(): void {
    const obj: Record<string, BestEntry> = {};
    for (const [id, e] of this.entries) obj[id] = e;
    writeJson(this.storage, BEST_KEY, obj);
  }
}

// ------------------------------------------------------------------ Validierung

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isValidTime(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 360000;
}

function num(v: unknown, fallback: number, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return v < min ? min : v > max ? max : v;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  // find statt includes + Cast: liefert den Wert gleich mit dem engen Typ.
  return allowed.find((a) => a === v) ?? fallback;
}

function isPresetId(v: unknown): v is MovementPresetId {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(MOVEMENT_PRESETS, v);
}

/**
 * Tastenliste einer Aktion: nur belegbare Codes, ohne Doppelte, höchstens
 * MAX_BINDS_PER_ACTION. Eine leere Liste ist gültig (Aktion unbelegt).
 */
function bindList(v: unknown, fallback: readonly string[]): readonly string[] {
  if (!Array.isArray(v)) return fallback;
  const out: string[] = [];
  for (const c of v) {
    if (out.length >= MAX_BINDS_PER_ACTION) break;
    if (typeof c === 'string' && isBindableCode(c) && !out.includes(c)) out.push(c);
  }
  return out;
}

function sanitizeKeybinds(raw: unknown, base: KeyBinds): KeyBinds {
  const o = isRecord(raw) ? raw : {};
  return {
    jump: bindList(o.jump, base.jump),
    crouch: bindList(o.crouch, base.crouch),
    sprint: bindList(o.sprint, base.sprint),
    demo: demoBinds(bindList(o.demo, base.demo), o, base),
  };
}

/**
 * Vorführung (Plan 007) ist ein Druck, kein gehaltener Knopf — dieselbe Taste darf nicht zugleich
 * springen/ducken/sprinten. Kollidiert der Default H mit einer alten Belegung, bleibt H dort.
 */
function demoBinds(list: readonly string[], o: Record<string, unknown>, base: KeyBinds): readonly string[] {
  const used = new Set<string>([...bindList(o.jump, base.jump), ...bindList(o.crouch, base.crouch), ...bindList(o.sprint, base.sprint)]);
  return list.filter((c) => !used.has(c));
}

/**
 * Beliebige (auch kaputte) Daten → gültige GameSettings. Fehlende oder
 * ungültige Felder übernehmen `base`, Zahlen werden in ihren Bereich geklemmt.
 * Das ist zugleich die Migration: ältere Stände ohne neue Felder bekommen deren Default.
 */
export function sanitizeSettings(raw: unknown, base: GameSettings): GameSettings {
  const o = isRecord(raw) ? raw : {};
  const r = isRecord(o.render) ? o.render : {};
  const br = base.render;
  const V = SETTING_RANGES.volume;
  const E = SETTING_RANGES.effect;
  const pixelHeight =
    typeof r.pixelHeight === 'number' && PIXEL_HEIGHTS.includes(r.pixelHeight) ? r.pixelHeight : br.pixelHeight;
  return {
    sensitivity: num(o.sensitivity, base.sensitivity, SETTING_RANGES.sensitivity.min, SETTING_RANGES.sensitivity.max),
    mYaw: num(o.mYaw, base.mYaw, SETTING_RANGES.mYaw.min, SETTING_RANGES.mYaw.max),
    invertY: bool(o.invertY, base.invertY),
    fov: num(o.fov, base.fov, SETTING_RANGES.fov.min, SETTING_RANGES.fov.max),
    masterVolume: num(o.masterVolume, base.masterVolume, V.min, V.max),
    musicVolume: num(o.musicVolume, base.musicVolume, V.min, V.max),
    sfxVolume: num(o.sfxVolume, base.sfxVolume, V.min, V.max),
    autoHop: bool(o.autoHop, base.autoHop),
    autoSprint: bool(o.autoSprint, base.autoSprint),
    // Fehlt der Wert (alter Stand), folgt er dem gespeicherten Preset — "CS2 Klassik" lädt nie mit Assist.
    strafeAssist: bool(
      o.strafeAssist,
      isPresetId(o.movementPreset) && o.movementPreset !== base.movementPreset ? MOVEMENT_PRESETS[o.movementPreset].strafeAssist : base.strafeAssist,
    ),
    // Fehlt in Ständen vor Plan 007 → folgt dem gespeicherten Preset wie strafeAssist (CS2: aus).
    airControl: bool(
      o.airControl,
      isPresetId(o.movementPreset) && o.movementPreset !== base.movementPreset ? MOVEMENT_PRESETS[o.movementPreset].airControl > 0 : base.airControl,
    ),
    movementPreset: isPresetId(o.movementPreset) ? o.movementPreset : base.movementPreset,
    headBob: num(o.headBob, base.headBob, E.min, E.max),
    motionFx: num(o.motionFx, base.motionFx, E.min, E.max),
    screenShake: num(o.screenShake, base.screenShake, E.min, E.max),
    fovKick: num(o.fovKick, base.fovKick, E.min, E.max),
    showSpeedometer: bool(o.showSpeedometer, base.showSpeedometer),
    showKeys: bool(o.showKeys, base.showKeys),
    showHints: bool(o.showHints, base.showHints),
    // Fehlt in Ständen vor Plan 004 → Default (an).
    showHand: bool(o.showHand, base.showHand),
    // Fehlen in Ständen vor Plan 005 → Standard-Handschuh, leere Hand.
    glove: oneOf<GloveId>(o.glove, GLOVE_IDS, base.glove),
    heldItem: oneOf<HeldItemId>(o.heldItem, HELD_ITEM_IDS, base.heldItem),
    ghost: bool(o.ghost, base.ghost),
    fullscreenOnStart: bool(o.fullscreenOnStart, base.fullscreenOnStart),
    keybinds: sanitizeKeybinds(o.keybinds, base.keybinds),
    render: {
      pixelHeight,
      dither: bool(r.dither, br.dither),
      colorBits: Math.round(num(r.colorBits, br.colorBits, SETTING_RANGES.colorBits.min, SETTING_RANGES.colorBits.max)),
      affine: num(r.affine, br.affine, E.min, E.max),
      vertexSnap: num(r.vertexSnap, br.vertexSnap, E.min, E.max),
      chromatic: num(r.chromatic, br.chromatic, E.min, E.max),
      scanlines: num(r.scanlines, br.scanlines, E.min, E.max),
      speedLines: num(r.speedLines, br.speedLines ?? 1, E.min, E.max),
      lowLatency: bool(r.lowLatency, br.lowLatency ?? false),
    },
  };
}

function settingsEqual(a: GameSettings, b: GameSettings): boolean {
  // Objekte aus Zahlen/Booleans/Strings(-Listen) — JSON-Vergleich ist exakt und billig genug für UI-Updates.
  return JSON.stringify(a) === JSON.stringify(b);
}

function parseBest(raw: unknown): Map<string, BestEntry> {
  const out = new Map<string, BestEntry>();
  if (!isRecord(raw)) return out;
  for (const [id, v] of Object.entries(raw)) {
    if (!isRecord(v) || !isValidTime(v.time)) continue;
    const splits = Array.isArray(v.splits) ? v.splits.filter(isValidTime) : [];
    const date = typeof v.date === 'string' ? v.date : '';
    out.set(id, { time: v.time, splits, date });
  }
  return out;
}

function readJson(storage: StorageLike | null, key: string): unknown {
  if (!storage) return null;
  try {
    const s = storage.getItem(key);
    return s === null ? null : JSON.parse(s);
  } catch {
    return null;
  }
}

function writeJson(storage: StorageLike | null, key: string, value: unknown): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota/Privatmodus: Einstellungen gelten trotzdem für diese Sitzung.
  }
}
