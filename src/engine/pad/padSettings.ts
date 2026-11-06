import type { StorageLike } from '../storage';
import { defaultStorage } from '../storage';
import type { GlyphStyle, PadBindAction, PadBinds, PadButtonCode, PadPresetId, PadSettings } from './types';
import { DEFAULT_PAD_SETTINGS, MAX_PAD_BINDS_PER_ACTION, PAD_BIND_ACTIONS, PAD_LIMITS, PAD_PRESETS, isBindablePadCode } from './types';

/**
 * Pad-Einstellungen in eigenem Speicher `velocity.pad.v1` (Plan 011 §2.2.4) — getrennt von GameSettings,
 * damit nichts davon im Modulgraphen des Verifier-Bundles landet.
 */

export const PAD_SETTINGS_KEY = 'velocity.pad.v1';
const VERSION = 1;

export type PadSettingsPatch = Partial<Omit<PadSettings, 'binds'>> & { readonly binds?: Partial<PadBinds> };

type PadListener = (next: PadSettings, prev: PadSettings) => void;

const GLYPHS: readonly GlyphStyle[] = ['auto', 'xbox', 'playstation'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown, lim: readonly [number, number], fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return v < lim[0] ? lim[0] : v > lim[1] ? lim[1] : v;
}

function codes(v: unknown, fallback: readonly PadButtonCode[]): readonly PadButtonCode[] {
  if (!Array.isArray(v)) return fallback;
  const out: PadButtonCode[] = [];
  for (const c of v) {
    if (typeof c === 'string' && isBindablePadCode(c) && !out.includes(c)) out.push(c);
    if (out.length >= MAX_PAD_BINDS_PER_ACTION) break;
  }
  return out;
}

function sanitizeBinds(v: unknown, base: PadBinds): PadBinds {
  if (!isRecord(v)) return base;
  const out: Record<PadBindAction, readonly PadButtonCode[]> = { ...base };
  for (const a of PAD_BIND_ACTIONS) out[a] = codes(v[a], base[a]);
  return out;
}

/** Alter/kaputter Stand → Defaults je Feld, Zahlen geklemmt, außen ≥ innen + 0.1. */
export function sanitizePadSettings(raw: unknown, base: PadSettings = DEFAULT_PAD_SETTINGS): PadSettings {
  if (!isRecord(raw)) return base;
  const inner = num(raw.deadzoneInner, PAD_LIMITS.deadzoneInner, base.deadzoneInner);
  const outer = Math.max(num(raw.deadzoneOuter, PAD_LIMITS.deadzoneOuter, base.deadzoneOuter), Math.min(1, inner + 0.1));
  const glyphs = typeof raw.glyphs === 'string' && (GLYPHS as readonly string[]).includes(raw.glyphs) ? (raw.glyphs as GlyphStyle) : base.glyphs;
  return {
    yawRate: num(raw.yawRate, PAD_LIMITS.yawRate, base.yawRate),
    pitchRate: num(raw.pitchRate, PAD_LIMITS.pitchRate, base.pitchRate),
    invertY: typeof raw.invertY === 'boolean' ? raw.invertY : base.invertY,
    deadzoneInner: inner,
    deadzoneOuter: outer,
    curve: num(raw.curve, PAD_LIMITS.curve, base.curve),
    boost: num(raw.boost, PAD_LIMITS.boost, base.boost),
    moveDeadzone: num(raw.moveDeadzone, PAD_LIMITS.moveDeadzone, base.moveDeadzone),
    diagonalBand: num(raw.diagonalBand, PAD_LIMITS.diagonalBand, base.diagonalBand),
    glyphs,
    binds: sanitizeBinds(raw.binds, base.binds),
  };
}

function bindsEqual(a: PadBinds, b: PadBinds): boolean {
  for (const k of PAD_BIND_ACTIONS) {
    const x = a[k];
    const y = b[k];
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  }
  return true;
}

export function padSettingsEqual(a: PadSettings, b: PadSettings): boolean {
  return (
    a.yawRate === b.yawRate &&
    a.pitchRate === b.pitchRate &&
    a.invertY === b.invertY &&
    a.deadzoneInner === b.deadzoneInner &&
    a.deadzoneOuter === b.deadzoneOuter &&
    a.curve === b.curve &&
    a.boost === b.boost &&
    a.moveDeadzone === b.moveDeadzone &&
    a.diagonalBand === b.diagonalBand &&
    a.glyphs === b.glyphs &&
    bindsEqual(a.binds, b.binds)
  );
}

/** Welches Preset entspricht der Belegung (null = eigene). */
export function padPresetOf(binds: PadBinds): PadPresetId | null {
  for (const id of Object.keys(PAD_PRESETS) as PadPresetId[]) if (bindsEqual(binds, PAD_PRESETS[id])) return id;
  return null;
}

export class PadSettingsStore {
  private readonly storage: StorageLike | null;
  private current: PadSettings;
  private readonly listeners = new Set<PadListener>();

  constructor(storage: StorageLike | null = defaultStorage()) {
    this.storage = storage;
    let raw: unknown = null;
    try {
      const s = storage?.getItem(PAD_SETTINGS_KEY) ?? null;
      raw = s !== null ? (JSON.parse(s) as unknown) : null;
    } catch {
      raw = null;
    }
    // Andere Version → Defaults (es gibt erst v1; künftige Migrationen hier).
    this.current = isRecord(raw) && raw.v === VERSION ? sanitizePadSettings(raw) : DEFAULT_PAD_SETTINGS;
  }

  get(): PadSettings {
    return this.current;
  }

  update(patch: PadSettingsPatch): PadSettings {
    const prev = this.current;
    const next = sanitizePadSettings({ ...prev, ...patch, binds: { ...prev.binds, ...(patch.binds ?? {}) } }, prev);
    if (padSettingsEqual(prev, next)) return prev;
    this.current = next;
    this.save();
    for (const fn of this.listeners) fn(next, prev);
    return next;
  }

  applyPreset(id: PadPresetId): PadSettings {
    return this.update({ binds: PAD_PRESETS[id] });
  }

  reset(): PadSettings {
    return this.update(DEFAULT_PAD_SETTINGS);
  }

  subscribe(fn: PadListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private save(): void {
    try {
      this.storage?.setItem(PAD_SETTINGS_KEY, JSON.stringify({ v: VERSION, ...this.current }));
    } catch {
      // Speicher voll/gesperrt: Einstellung gilt für diese Sitzung.
    }
  }
}
