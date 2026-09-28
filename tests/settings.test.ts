import { describe, expect, it } from 'vitest';
import { BEST_KEY, BestTimes, SETTINGS_KEY, SettingsStore, movementConfigFor, sanitizeSettings } from '../src/engine/Settings';
import { CS2_CLASSIC, VELOCITY_DEFAULT } from '../src/player/MovementConfig';
import type { StorageLike } from '../src/engine/Settings';
import { DEFAULT_SETTINGS, GLOVE_IDS, HELD_ITEM_IDS } from '../src/engine/settingsTypes';
import type { GameSettings } from '../src/engine/settingsTypes';

class MemoryStorage implements StorageLike {
  readonly data = new Map<string, string>();
  writes = 0;
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.writes++;
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

class BrokenStorage implements StorageLike {
  getItem(): string | null {
    throw new Error('SecurityError');
  }
  setItem(): void {
    throw new Error('QuotaExceededError');
  }
  removeItem(): void {
    throw new Error('SecurityError');
  }
}

describe('SettingsStore', () => {
  it('liefert Defaults bei leerem Speicher', () => {
    const store = new SettingsStore(new MemoryStorage());
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
  });

  it('merged gespeicherte Teilwerte tief mit den Defaults', () => {
    const mem = new MemoryStorage();
    mem.setItem(SETTINGS_KEY, JSON.stringify({ sensitivity: 1.25, render: { dither: false } }));
    const s = new SettingsStore(mem).get();
    expect(s.sensitivity).toBe(1.25);
    expect(s.render.dither).toBe(false);
    expect(s.render.pixelHeight).toBe(DEFAULT_SETTINGS.render.pixelHeight);
    expect(s.fov).toBe(DEFAULT_SETTINGS.fov);
  });

  it('verwirft kaputtes JSON und falsche Typen, klemmt Zahlen', () => {
    const mem = new MemoryStorage();
    mem.setItem(SETTINGS_KEY, '{nicht json');
    expect(new SettingsStore(mem).get()).toEqual(DEFAULT_SETTINGS);

    const s = sanitizeSettings(
      {
        sensitivity: 'schnell',
        fov: 500,
        masterVolume: -3,
        autoHop: 'ja',
        movementPreset: 'quake',
        render: { pixelHeight: 1080, colorBits: 5.6, chromatic: Number.NaN },
      },
      DEFAULT_SETTINGS,
    );
    expect(s.sensitivity).toBe(DEFAULT_SETTINGS.sensitivity);
    expect(s.fov).toBe(130);
    expect(s.masterVolume).toBe(0);
    expect(s.autoHop).toBe(DEFAULT_SETTINGS.autoHop);
    expect(s.movementPreset).toBe(DEFAULT_SETTINGS.movementPreset);
    expect(s.render.pixelHeight).toBe(DEFAULT_SETTINGS.render.pixelHeight);
    expect(s.render.colorBits).toBe(6);
    expect(s.render.chromatic).toBe(DEFAULT_SETTINGS.render.chromatic);
  });

  it('update merged render tief, speichert und benachrichtigt mit next/prev', () => {
    const mem = new MemoryStorage();
    const store = new SettingsStore(mem);
    const seen: [GameSettings, GameSettings][] = [];
    const off = store.subscribe((n, p) => seen.push([n, p]));
    store.update({ render: { scanlines: 0.9 } });
    expect(store.get().render.scanlines).toBe(0.9);
    expect(store.get().render.dither).toBe(DEFAULT_SETTINGS.render.dither);
    expect(seen.length).toBe(1);
    expect(seen[0][1].render.scanlines).toBe(DEFAULT_SETTINGS.render.scanlines);
    const stored: unknown = JSON.parse(mem.getItem(SETTINGS_KEY) ?? 'null');
    expect(stored).toEqual(store.get());

    // Keine Änderung → kein Event, kein Schreiben.
    const writes = mem.writes;
    store.update({ render: { scanlines: 0.9 } });
    expect(seen.length).toBe(1);
    expect(mem.writes).toBe(writes);

    off();
    store.update({ fov: 100 });
    expect(seen.length).toBe(1);
    expect(new SettingsStore(mem).get().fov).toBe(100);
  });

  it('ungültiges Update behält den bisherigen Wert', () => {
    const store = new SettingsStore(new MemoryStorage());
    store.update({ sensitivity: 3 });
    store.update({ sensitivity: Number.NaN });
    expect(store.get().sensitivity).toBe(3);
    store.update({ movementPreset: 'cs2' });
    expect(store.get().movementPreset).toBe('cs2');
  });

  it('reset stellt Defaults her', () => {
    const store = new SettingsStore(new MemoryStorage());
    store.update({ fov: 110, render: { dither: false } });
    store.reset();
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
  });

  it('überlebt werfenden oder fehlenden Storage', () => {
    for (const storage of [new BrokenStorage(), null]) {
      const store = new SettingsStore(storage);
      expect(store.get()).toEqual(DEFAULT_SETTINGS);
      expect(() => store.update({ fov: 95 })).not.toThrow();
      expect(store.get().fov).toBe(95);
    }
  });
});

describe('Neue Einstellungen (Plan 003, U6)', () => {
  it('Defaults: Auto-Sprint, Strafe-Assist, Showkeys, Hinweise, Vollbild an; Feedback 1; Standard-Belegung', () => {
    const s = new SettingsStore(new MemoryStorage()).get();
    expect(s.autoSprint).toBe(true);
    expect(s.strafeAssist).toBe(true);
    expect(s.showKeys).toBe(true);
    expect(s.showHints).toBe(true);
    expect(s.fullscreenOnStart).toBe(true);
    expect(s.motionFx).toBe(1);
    expect(s.keybinds).toEqual({ jump: ['Space'], crouch: ['KeyC', 'ControlLeft'], sprint: ['ShiftLeft'], demo: ['KeyH'] });
  });

  it('alter gespeicherter Stand ohne die neuen Felder lädt ohne Fehler und behält seine Werte', () => {
    const mem = new MemoryStorage();
    // Stand vor Plan 003: keine keybinds, kein autoSprint/motionFx/showKeys/showHints/fullscreenOnStart/strafeAssist.
    const old = {
      sensitivity: 1.1,
      mYaw: 0.022,
      invertY: true,
      fov: 100,
      masterVolume: 0.5,
      musicVolume: 0.6,
      sfxVolume: 0.7,
      autoHop: false,
      movementPreset: 'cs2',
      headBob: 0,
      screenShake: 0.4,
      fovKick: 0.3,
      showSpeedometer: false,
      render: { pixelHeight: 360, dither: false, colorBits: 5, affine: 0.5, vertexSnap: 0.5, chromatic: 0.2, scanlines: 0.1 },
    };
    mem.setItem(SETTINGS_KEY, JSON.stringify(old));
    const s = new SettingsStore(mem).get();
    expect(s.sensitivity).toBe(1.1);
    expect(s.invertY).toBe(true);
    expect(s.autoHop).toBe(false);
    expect(s.headBob).toBe(0);
    expect(s.showSpeedometer).toBe(false);
    expect(s.render.pixelHeight).toBe(360);
    expect(s.autoSprint).toBe(DEFAULT_SETTINGS.autoSprint);
    expect(s.motionFx).toBe(DEFAULT_SETTINGS.motionFx);
    expect(s.keybinds).toEqual(DEFAULT_SETTINGS.keybinds);
    expect(s.showHints).toBe(true);
  });

  it('Round-Trip: Belegung mit Maustaste und neue Schalter überleben Speichern und Laden', () => {
    const mem = new MemoryStorage();
    const store = new SettingsStore(mem);
    store.update({ keybinds: { jump: ['Space', 'Mouse4'] }, autoSprint: false, motionFx: 0.25, showKeys: false, fullscreenOnStart: false });
    // Teil-Update der Belegung behält die anderen Aktionen.
    expect(store.get().keybinds.crouch).toEqual(DEFAULT_SETTINGS.keybinds.crouch);
    const again = new SettingsStore(mem).get();
    expect(again.keybinds.jump).toEqual(['Space', 'Mouse4']);
    expect(again.autoSprint).toBe(false);
    expect(again.motionFx).toBe(0.25);
    expect(again.showKeys).toBe(false);
    expect(again.fullscreenOnStart).toBe(false);
    expect(again).toEqual(store.get());
  });

  it('Belegung wird bereinigt: reservierte/unbekannte Codes raus, keine Doppelten, höchstens zwei', () => {
    const s = sanitizeSettings(
      {
        keybinds: {
          jump: ['Space', 'Space', 'KeyR', 'Mouse1', 'F5', 42, 'Mouse5', 'KeyE'],
          crouch: 'KeyC',
          sprint: [],
        },
      },
      DEFAULT_SETTINGS,
    );
    expect(s.keybinds.jump).toEqual(['Space', 'Mouse5']);
    expect(s.keybinds.crouch).toEqual(DEFAULT_SETTINGS.keybinds.crouch);
    expect(s.keybinds.sprint).toEqual([]);
  });
});

describe('BestTimes', () => {
  it('erste Zeit ist Bestzeit, schlechtere nicht, bessere schon', () => {
    const mem = new MemoryStorage();
    const best = new BestTimes(mem);
    expect(best.get('a')).toBeNull();
    expect(best.submit('a', 31.5, [10, 20])).toEqual({ best: true, previous: null });
    expect(best.submit('a', 33, [11, 21])).toEqual({ best: false, previous: 31.5 });
    expect(best.submit('a', 31.5, [9, 19])).toEqual({ best: false, previous: 31.5 });
    expect(best.submit('a', 30.25, [9.5, 19.5])).toEqual({ best: true, previous: 31.5 });
    expect(best.get('a')).toBe(30.25);
    expect(best.getSplits('a')).toEqual([9.5, 19.5]);
  });

  it('persistiert über Instanzen und trennt Level', () => {
    const mem = new MemoryStorage();
    new BestTimes(mem).submit('a', 12, []);
    new BestTimes(mem).submit('b', 50, [25]);
    const again = new BestTimes(mem);
    expect(again.get('a')).toBe(12);
    expect(again.get('b')).toBe(50);
    expect(again.getSplits('a')).toEqual([]);
    expect(again.getSplits('zzz')).toBeNull();
  });

  it('ignoriert ungültige Zeiten und kaputte Einträge', () => {
    const mem = new MemoryStorage();
    mem.setItem(BEST_KEY, JSON.stringify({ a: { time: -1 }, b: 'x', c: { time: 20, splits: [5, 'x', -2, 10] } }));
    const best = new BestTimes(mem);
    expect(best.get('a')).toBeNull();
    expect(best.get('b')).toBeNull();
    expect(best.getSplits('c')).toEqual([5, 10]);
    expect(best.submit('c', Number.NaN, [])).toEqual({ best: false, previous: 20 });
    expect(best.submit('c', 0, [])).toEqual({ best: false, previous: 20 });
  });

  it('funktioniert ohne Storage im Speicher', () => {
    const best = new BestTimes(new BrokenStorage());
    expect(best.submit('x', 10, [])).toEqual({ best: true, previous: null });
    expect(best.get('x')).toBe(10);
  });
});

describe('movementConfigFor', () => {
  it('Preset als Basis, Auto-Hop aus den Settings', () => {
    const c = movementConfigFor({ ...DEFAULT_SETTINGS, movementPreset: 'cs2', autoHop: true });
    expect(c.tickRate).toBe(CS2_CLASSIC.tickRate);
    expect(c.airAccelerate).toBe(CS2_CLASSIC.airAccelerate);
    expect(c.autoHop).toBe(true);
    expect(movementConfigFor({ ...DEFAULT_SETTINGS, autoHop: false }).autoHop).toBe(false);
  });
});

describe('Strafe-Assist folgt dem Preset (Runde 2)', () => {
  it('Wechsel auf CS2 schaltet aus, zurück auf velocity an; Movement-Config folgt', () => {
    const store = new SettingsStore(new MemoryStorage());
    expect(store.get().strafeAssist).toBe(true);
    store.update({ movementPreset: 'cs2' });
    expect(store.get().strafeAssist).toBe(false);
    expect(movementConfigFor(store.get()).strafeAssist).toBe(false);
    store.update({ movementPreset: 'velocity' });
    expect(store.get().strafeAssist).toBe(true);
    expect(movementConfigFor(store.get()).strafeAssist).toBe(true);
  });

  it('danach frei umschaltbar; ausdrücklicher Wert im selben Update gewinnt; gleiches Preset ändert nichts', () => {
    const store = new SettingsStore(new MemoryStorage());
    store.update({ movementPreset: 'cs2' });
    store.update({ strafeAssist: true });
    expect(store.get().strafeAssist).toBe(true);
    store.update({ movementPreset: 'cs2' }); // kein Wechsel → Spielerwahl bleibt
    expect(store.get().strafeAssist).toBe(true);
    store.update({ movementPreset: 'velocity', strafeAssist: false });
    expect(store.get().strafeAssist).toBe(false);
  });

  it('alter Stand mit CS2 ohne strafeAssist-Feld lädt mit Assist aus; gespeicherter Wert gewinnt', () => {
    const mem = new MemoryStorage();
    mem.setItem(SETTINGS_KEY, JSON.stringify({ movementPreset: 'cs2' }));
    expect(new SettingsStore(mem).get().strafeAssist).toBe(false);
    mem.setItem(SETTINGS_KEY, JSON.stringify({ movementPreset: 'cs2', strafeAssist: true }));
    expect(new SettingsStore(mem).get().strafeAssist).toBe(true);
    mem.setItem(SETTINGS_KEY, JSON.stringify({ movementPreset: 'velocity' }));
    expect(new SettingsStore(mem).get().strafeAssist).toBe(true);
  });
});

describe('View-Hand (Plan 004)', () => {
  it('showHand: Default an, alter Stand ohne Feld lädt mit an, aus überlebt den Reload', () => {
    expect(DEFAULT_SETTINGS.showHand).toBe(true);
    const mem = new MemoryStorage();
    mem.setItem(SETTINGS_KEY, JSON.stringify({ sensitivity: 1.5, ghost: false, showKeys: false }));
    const old = new SettingsStore(mem).get();
    expect(old.showHand).toBe(true);
    expect(old.ghost).toBe(false);
    const store = new SettingsStore(mem);
    store.update({ showHand: false });
    expect(new SettingsStore(mem).get().showHand).toBe(false);
    // Kaputter Wert fällt auf den bisherigen zurück.
    mem.setItem(SETTINGS_KEY, JSON.stringify({ showHand: 'ja' }));
    expect(new SettingsStore(mem).get().showHand).toBe(true);
  });
});

describe('Plan 007: Luftlenkung, Vorführungs-Taste, Kosmetik v2', () => {
  it('Defaults: Luftlenkung an, Vorführung auf H', () => {
    expect(DEFAULT_SETTINGS.airControl).toBe(true);
    expect(DEFAULT_SETTINGS.keybinds.demo).toEqual(['KeyH']);
  });

  it('alter Stand (vor Plan 007, ohne airControl und ohne demo-Belegung) lädt mit an und H, behält alles andere', () => {
    const mem = new MemoryStorage();
    const old = {
      sensitivity: 2.4,
      autoHop: true,
      strafeAssist: true,
      movementPreset: 'velocity',
      showHand: false,
      glove: 'neon',
      heldItem: 'knife',
      keybinds: { jump: ['Space', 'Mouse4'], crouch: ['KeyC'], sprint: ['ShiftLeft'] },
    };
    mem.setItem(SETTINGS_KEY, JSON.stringify(old));
    const s = new SettingsStore(mem).get();
    expect(s.airControl).toBe(true);
    expect(s.keybinds.demo).toEqual(['KeyH']);
    expect(s.keybinds.jump).toEqual(['Space', 'Mouse4']);
    expect(s.sensitivity).toBe(2.4);
    expect(s.showHand).toBe(false);
    expect(s.glove).toBe('neon');
    expect(s.heldItem).toBe('knife');
  });

  it('H schon anders belegt: Vorführung bekommt H nicht dazu (ein Code, eine Aktion)', () => {
    const s = sanitizeSettings({ keybinds: { jump: ['Space', 'KeyH'] } }, DEFAULT_SETTINGS);
    expect(s.keybinds.jump).toEqual(['Space', 'KeyH']);
    expect(s.keybinds.demo).toEqual([]);
    const own = sanitizeSettings({ keybinds: { demo: ['KeyG', 'Mouse5'] } }, DEFAULT_SETTINGS);
    expect(own.keybinds.demo).toEqual(['KeyG', 'Mouse5']);
  });

  it('CS2-Preset schaltet Luftlenkung aus, velocity wieder an; ausdrücklicher Wert gewinnt; alter CS2-Stand lädt aus', () => {
    const store = new SettingsStore(new MemoryStorage());
    store.update({ movementPreset: 'cs2' });
    expect(store.get().airControl).toBe(false);
    expect(movementConfigFor(store.get()).airControl).toBe(0);
    store.update({ movementPreset: 'velocity' });
    expect(store.get().airControl).toBe(true);
    store.update({ movementPreset: 'cs2', airControl: true });
    expect(store.get().airControl).toBe(true);
    const mem = new MemoryStorage();
    mem.setItem(SETTINGS_KEY, JSON.stringify({ movementPreset: 'cs2' }));
    expect(new SettingsStore(mem).get().airControl).toBe(false);
    mem.setItem(SETTINGS_KEY, JSON.stringify({ movementPreset: 'velocity', airControl: false }));
    expect(new SettingsStore(mem).get().airControl).toBe(false);
  });

  it('movementConfigFor: Einstellung aus → airControl 0, an → Wert des Presets (CS2 hat keine)', () => {
    expect(movementConfigFor(DEFAULT_SETTINGS).airControl).toBe(VELOCITY_DEFAULT.airControl);
    expect(VELOCITY_DEFAULT.airControl).toBeGreaterThan(0);
    expect(movementConfigFor({ ...DEFAULT_SETTINGS, airControl: false }).airControl).toBe(0);
    expect(movementConfigFor({ ...DEFAULT_SETTINGS, movementPreset: 'cs2', airControl: true }).airControl).toBe(0);
    // Sonst unverändert gegenüber dem Preset (Phase 0: nur das neue Feld).
    const { airControl: _a, ...rest } = movementConfigFor({ ...DEFAULT_SETTINGS, airControl: false });
    const { airControl: _b, ...base } = VELOCITY_DEFAULT;
    expect(rest).toEqual(base);
  });

  it('Round-Trip aller 6 Hände × 10 Gegenstände; unbekannte fallen auf den Standard', () => {
    expect(GLOVE_IDS).toHaveLength(6);
    expect(HELD_ITEM_IDS).toHaveLength(10);
    for (const glove of GLOVE_IDS) {
      for (const heldItem of HELD_ITEM_IDS) {
        const mem = new MemoryStorage();
        new SettingsStore(mem).update({ glove, heldItem });
        const s = new SettingsStore(mem).get();
        expect([s.glove, s.heldItem]).toEqual([glove, heldItem]);
      }
    }
    const mem = new MemoryStorage();
    mem.setItem(SETTINGS_KEY, JSON.stringify({ glove: 'pfote', heldItem: 'bumerang' }));
    const s = new SettingsStore(mem).get();
    expect([s.glove, s.heldItem]).toEqual(['classic', 'none']);
  });
});
