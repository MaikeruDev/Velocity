import type { LevelMedals } from '../world/level/LevelFormat';
import type { GloveId, HeldItemId } from './settingsTypes';
import { medalAtLeast, medalFor } from '../ui/medals';
import type { MedalId } from '../ui/medals';
import type { SettingsPatch, StorageLike } from './Settings';
import { defaultStorage } from './Settings';

/**
 * Freischaltungen (Plan 005, Zuordnung neu in Plan 006): Kosmetik für die View-Hand,
 * verdient über Medaillen.
 *
 * Persistiert in 'velocity.unlocks.v1', ABER abgeleitet aus den Bestzeiten: wer die
 * Medaille schon hat (Bestzeit ≤ Grenze), bekommt die Freischaltung bei jedem Start
 * wieder — ein gelöschter/kaputter Unlock-Stand kostet nichts. Der Store merkt sich
 * zusätzlich das Datum der Freischaltung (und hält Freischaltungen, falls sich eine
 * Medaillen-Grenze durch ein Level-Retuning verschärft — verdient ist verdient).
 * Sandbox zählt nie: nur Level aus UNLOCKS.
 *
 * Zuordnung (Plan 006): L1-Gold → Neon-Handschuh, L1-VELOCITY → Sammelkarte,
 * L2-VELOCITY → Dose, beide VELOCITY → Butterfly-Messer.
 * Migration von Format v1 (Plan 005: Neon = L1-VELOCITY): wer den Neon-Handschuh hatte,
 * behält ihn und bekommt die Karte (er hatte ja L1-VELOCITY); Neon + Dose → auch das Messer.
 *
 * Admin-Menü (Format v3): Freischaltungen lassen sich von Hand setzen und entfernen. Die
 * Ableitung fügt nur hinzu, entfernt nie — von Hand gesetzte bleiben also von selbst. Von
 * Hand GESPERRTE merkt sich der Store in einer eigenen Menge `locked`, die die Ableitung
 * überspringt. Warum nur diese eine Menge und keine volle Override-Tabelle: "an" ist schon
 * der Normalzustand eines Eintrags in `unlocked`; nur "aus trotz Medaille" braucht einen
 * Merker. Die Sperre hebt nur eine bewusste Admin-Aktion wieder auf (Schalter an, "Alles
 * freischalten", Medaille für das betroffene Level setzen) — ein echter Lauf nicht, sonst
 * käme eine absichtlich gesperrte Kosmetik beim nächsten Ziel ungefragt zurück.
 */

export type UnlockId = 'glove.neon' | 'item.card' | 'item.can' | 'item.knife';

export interface UnlockRequirement {
  readonly levelId: string;
  readonly medal: MedalId;
}

export interface UnlockDef {
  readonly id: UnlockId;
  /** Anzeigename (Ergebnis "FREIGESCHALTET: …", Kosmetik-Menü). */
  readonly name: string;
  /** Alle Bedingungen müssen erfüllt sein. */
  readonly requires: readonly UnlockRequirement[];
}

export const UNLOCKS: readonly UnlockDef[] = [
  { id: 'glove.neon', name: 'Neon-Handschuh', requires: [{ levelId: 'level1', medal: 'gold' }] },
  { id: 'item.card', name: 'Sammelkarte', requires: [{ levelId: 'level1', medal: 'velocity' }] },
  { id: 'item.can', name: 'Dose', requires: [{ levelId: 'level2', medal: 'velocity' }] },
  {
    id: 'item.knife',
    name: 'Butterfly-Messer',
    requires: [
      { levelId: 'level1', medal: 'velocity' },
      { levelId: 'level2', medal: 'velocity' },
    ],
  },
];

export const UNLOCKS_KEY = 'velocity.unlocks.v1';
const VERSION = 3;

/** Welche Freischaltung eine Kosmetik braucht (null = immer frei). */
export function gloveUnlock(g: GloveId): UnlockId | null {
  return g === 'neon' ? 'glove.neon' : null;
}

export function itemUnlock(i: HeldItemId): UnlockId | null {
  return i === 'can' ? 'item.can' : i === 'card' ? 'item.card' : i === 'knife' ? 'item.knife' : null;
}

/** Einstellung, die eine frische Freischaltung sofort anlegt ("das ist der Belohnungsmoment"). */
export function unlockPatch(id: UnlockId): SettingsPatch {
  switch (id) {
    case 'glove.neon':
      return { glove: 'neon' };
    case 'item.card':
      return { heldItem: 'card' };
    case 'item.can':
      return { heldItem: 'can' };
    case 'item.knife':
      return { heldItem: 'knife' };
  }
}

export function unlockDef(id: UnlockId): UnlockDef {
  const d = UNLOCKS.find((u) => u.id === id);
  if (!d) throw new Error(`Unbekannte Freischaltung ${id}`);
  return d;
}

/** Level mit Medaillen (Index-Eintrag oder LevelFile). */
export interface MedalSource {
  readonly id: string;
  readonly medals?: LevelMedals | null;
}

/** Aus Bestzeiten + Medaillen: alle verdienten Freischaltungen (reine Funktion, testbar). */
export function deriveUnlocks(levels: readonly MedalSource[], best: (levelId: string) => number | null): UnlockId[] {
  const out: UnlockId[] = [];
  for (const u of UNLOCKS) {
    const ok = u.requires.every((r) => {
      const lv = levels.find((l) => l.id === r.levelId);
      return lv?.medals ? medalAtLeast(medalFor(best(r.levelId), lv.medals), r.medal) : false;
    });
    if (ok) out.push(u.id);
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isUnlockId(v: unknown): v is UnlockId {
  return UNLOCKS.some((u) => u.id === v);
}

/**
 * Gespeicherten Stand lesen; unbekannte Versionen/IDs fallen weg (die Ableitung holt sie zurück).
 * v1 (Plan 005) wird migriert: Neon hieß dort L1-VELOCITY → zusätzlich Karte; Neon + Dose
 * (= beide VELOCITY) → zusätzlich Messer. Das Datum übernehmen die neuen Einträge vom Neon.
 * v2 hat keine Sperr-Menge → leer (nichts war von Hand gesperrt).
 */
export function parseUnlocks(raw: unknown): Map<UnlockId, string> {
  const out = new Map<UnlockId, string>();
  if (!isKnownVersion(raw)) return out;
  const u = raw.unlocked;
  if (!isRecord(u)) return out;
  for (const [id, date] of Object.entries(u)) {
    if (isUnlockId(id)) out.set(id, typeof date === 'string' ? date : '');
  }
  if (raw.v === 1) {
    const neon = out.get('glove.neon');
    if (neon !== undefined) {
      if (!out.has('item.card')) out.set('item.card', neon);
      if (out.has('item.can') && !out.has('item.knife')) out.set('item.knife', neon);
    }
  }
  return out;
}

/** Von Hand gesperrte Freischaltungen (erst ab v3; ältere Stände: keine). */
export function parseLocked(raw: unknown): Set<UnlockId> {
  const out = new Set<UnlockId>();
  if (!isKnownVersion(raw) || raw.v !== VERSION || !Array.isArray(raw.locked)) return out;
  for (const id of raw.locked) if (isUnlockId(id)) out.add(id);
  return out;
}

function isKnownVersion(raw: unknown): raw is Record<string, unknown> {
  return isRecord(raw) && (raw.v === VERSION || raw.v === 2 || raw.v === 1);
}

/** Gespeichertes Format älter als das aktuelle (dann beim Laden neu schreiben). */
function isOldVersion(raw: unknown): boolean {
  return isRecord(raw) && (raw.v === 1 || raw.v === 2);
}

export class UnlockStore {
  private readonly storage: StorageLike | null;
  private readonly items: Map<UnlockId, string>;
  /** Von Hand gesperrt (Admin-Menü) — die Ableitung aus Bestzeiten lässt diese aus. */
  private readonly locked: Set<UnlockId>;
  private readonly listeners = new Set<() => void>();

  constructor(storage: StorageLike | null = defaultStorage()) {
    this.storage = storage;
    let raw: unknown = null;
    try {
      const s = storage?.getItem(UNLOCKS_KEY) ?? null;
      raw = s === null ? null : JSON.parse(s);
    } catch {
      raw = null;
    }
    this.items = parseUnlocks(raw);
    this.locked = parseLocked(raw);
    // Widerspruch in einem handeditierten Stand: frei gewinnt (die Sperre ist nur ein Merker).
    for (const id of this.items.keys()) this.locked.delete(id);
    if (isOldVersion(raw)) this.save();
  }

  has(id: UnlockId): boolean {
    return this.items.has(id);
  }

  /** Von Hand gesperrt (Admin)? Dann holt die Ableitung sie nicht zurück. */
  isLocked(id: UnlockId): boolean {
    return this.locked.has(id);
  }

  /** Freigeschaltet am (ISO), null = nicht. */
  date(id: UnlockId): string | null {
    return this.items.get(id) ?? null;
  }

  list(): UnlockId[] {
    return UNLOCKS.filter((u) => this.items.has(u.id)).map((u) => u.id);
  }

  /**
   * Verdiente Freischaltungen nachtragen (Levelliste geladen, Lauf beendet). Nur hinzufügen,
   * nie entfernen; von Hand gesperrte bleiben gesperrt.
   * Gibt nur die NEUEN zurück — das Ergebnis zeigt sie groß an.
   */
  sync(levels: readonly MedalSource[], best: (levelId: string) => number | null): UnlockId[] {
    const fresh: UnlockId[] = [];
    for (const id of deriveUnlocks(levels, best)) if (!this.locked.has(id) && this.grant(id)) fresh.push(id);
    return fresh;
  }

  /**
   * Admin: Medaille eines Levels wurde gesetzt — alles, was dadurch verdient ist und an diesem
   * Level hängt, freischalten, auch wenn es vorher von Hand gesperrt war (die Medaille ist die
   * jüngere, bewusste Entscheidung). Zurück: neu freigeschaltete.
   */
  grantEarnedFor(levelId: string, levels: readonly MedalSource[], best: (levelId: string) => number | null): UnlockId[] {
    const fresh: UnlockId[] = [];
    for (const id of deriveUnlocks(levels, best)) {
      if (!unlockDef(id).requires.some((r) => r.levelId === levelId)) continue;
      this.locked.delete(id);
      if (this.grant(id)) fresh.push(id);
    }
    this.save();
    return fresh;
  }

  /** true = neu freigeschaltet. Hebt eine Handsperre NICHT auf (dafür set/unlockAll). */
  grant(id: UnlockId): boolean {
    if (this.items.has(id) || this.locked.has(id)) return false;
    this.items.set(id, new Date().toISOString());
    this.save();
    return true;
  }

  /** Admin-Schalter: an = frei (Sperre weg), aus = entfernen und gegen die Ableitung sperren. */
  set(id: UnlockId, on: boolean): void {
    if (on) {
      this.locked.delete(id);
      if (!this.items.has(id)) this.items.set(id, new Date().toISOString());
    } else {
      this.items.delete(id);
      this.locked.add(id);
    }
    this.save();
  }

  unlockAll(): void {
    for (const u of UNLOCKS) {
      this.locked.delete(u.id);
      if (!this.items.has(u.id)) this.items.set(u.id, new Date().toISOString());
    }
    this.save();
  }

  /** Alles sperren (Admin/Debug) — dauerhaft gegen die Ableitung, bis zur nächsten Admin-Freischaltung. */
  reset(): void {
    this.items.clear();
    for (const u of UNLOCKS) this.locked.add(u.id);
    this.save();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  private save(): void {
    if (this.storage) {
      const unlocked: Record<string, string> = {};
      for (const [id, d] of this.items) unlocked[id] = d;
      const locked = UNLOCKS.filter((u) => this.locked.has(u.id)).map((u) => u.id);
      try {
        this.storage.setItem(UNLOCKS_KEY, JSON.stringify({ v: VERSION, unlocked, locked }));
      } catch {
        // Quota/Privatmodus: gilt für diese Sitzung, die Ableitung holt Verdientes beim nächsten Start zurück.
      }
    }
    this.notify();
  }
}
