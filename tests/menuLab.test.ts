import { describe, expect, it } from 'vitest';
import { SettingsStore, sanitizeSettings } from '../src/engine/Settings';
import type { StorageLike } from '../src/engine/Settings';
import { DEFAULT_SETTINGS, MENU_STYLE_IDS } from '../src/engine/settingsTypes';
import { FRONT_DOOR_IDS } from '../src/ui/menuLab/types';
import { FRONT_DOOR_LOADERS, MENU_STYLES } from '../src/ui/menuLab/registry';
import { BeatClock, FALLBACK_BPM } from '../src/ui/menuLab/beatClock';
import { BPM } from '../src/audio/Music';

class MemoryStorage implements StorageLike {
  readonly data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

describe('Einstellung menuStyle (Plan 010)', () => {
  it('Default classic, alter Stand ohne Feld lädt mit classic', () => {
    expect(DEFAULT_SETTINGS.menuStyle).toBe('ps2');
    const { menuStyle: _drop, ...old } = DEFAULT_SETTINGS;
    expect(sanitizeSettings(old, DEFAULT_SETTINGS).menuStyle).toBe('ps2');
  });

  it('jede bekannte id bleibt, unbekannte/kaputte fallen auf base zurück', () => {
    for (const id of MENU_STYLE_IDS) expect(sanitizeSettings({ menuStyle: id }, DEFAULT_SETTINGS).menuStyle).toBe(id);
    expect(sanitizeSettings({ menuStyle: 'vaporwave' }, DEFAULT_SETTINGS).menuStyle).toBe('ps2');
    expect(sanitizeSettings({ menuStyle: 3 }, DEFAULT_SETTINGS).menuStyle).toBe('ps2');
    expect(sanitizeSettings({ menuStyle: 'nope' }, { ...DEFAULT_SETTINGS, menuStyle: 'rave' }).menuStyle).toBe('rave');
  });

  it('update speichert den Stil, ungültige Werte ändern nichts', () => {
    const st = new MemoryStorage();
    const store = new SettingsStore(st);
    store.update({ menuStyle: 'arcade' });
    expect(new SettingsStore(st).get().menuStyle).toBe('arcade');
    const raw: unknown = JSON.parse('{"menuStyle":"bogus"}');
    expect(sanitizeSettings(raw, store.get()).menuStyle).toBe('arcade');
  });
});

describe('Registry (Plan 010)', () => {
  it('jeder Stil außer classic hat einen Loader, jeder Stil eine Labor-Karte', () => {
    expect([...FRONT_DOOR_IDS].sort()).toEqual(MENU_STYLE_IDS.filter((id) => id !== 'classic').sort());
    expect(Object.keys(FRONT_DOOR_LOADERS).sort()).toEqual([...FRONT_DOOR_IDS].sort());
    expect(MENU_STYLES.map((s) => s.id)).toEqual([...MENU_STYLE_IDS]);
    for (const s of MENU_STYLES) {
      expect(s.name.length).toBeGreaterThan(0);
      expect(s.description.length).toBeGreaterThan(0);
    }
  });

  it('jedes Stil-Modul lädt ohne DOM und liefert eine Fabrik', async () => {
    // Fängt Stile, die beim Import schon document/window anfassen (das bricht Node-Werkzeuge und SSR-freie Tests).
    for (const id of FRONT_DOOR_IDS) {
      const factory = await FRONT_DOOR_LOADERS[id]();
      expect(typeof factory).toBe('function');
    }
  });
});

describe('BeatClock (Plan 010)', () => {
  it('Ersatz-Uhr läuft mit der Track-BPM, deterministisch', () => {
    expect(FALLBACK_BPM).toBe(BPM);
    const c = new BeatClock();
    const beatMs = 60000 / FALLBACK_BPM;
    const a = c.read(0);
    expect(a.live).toBe(false);
    expect(a.phase).toBe(0);
    expect(a.kick).toBeCloseTo(1, 6);
    const b = c.read(beatMs * 4.5);
    expect(b.bar).toBe(1);
    expect(b.phase).toBeCloseTo(0.5, 6);
    expect(b.barPhase).toBeCloseTo(0.125, 6);
    expect(b.kick).toBeLessThan(0.3);
  });

  it('mit entsperrter Musik kommen die echten Werte', () => {
    const c = new BeatClock();
    c.audio = {
      unlocked: true,
      unlock: () => Promise.resolve(),
      beat: () => ({ bpm: 132, beat: 9.25, beatPhase: 0.25, barPhase: 0.3125, kick: 0.4, energy: 0.8 }),
    };
    const b = c.read(0);
    expect(b.live).toBe(true);
    expect(b.bar).toBe(2);
    expect(b.energy).toBe(0.8);
  });
});
