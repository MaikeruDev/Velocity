import { afterEach, describe, expect, it } from 'vitest';
import { menuSound, resetMenuSound, setMenuSoundSink, type MenuSoundKind } from '../src/ui/menuSound';
import { PAD_SETTINGS_KEY, PadSettingsStore } from '../src/engine/pad/padSettings';
import { DEFAULT_PAD_SETTINGS } from '../src/engine/pad/types';

function memStorage(init: Record<string, string>): { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void } {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
}

describe('Menü-Klänge: Entprellung', () => {
  afterEach(() => {
    setMenuSoundSink(null);
    resetMenuSound();
  });

  it('Enter = Aktion + nativer Klick → ein confirm; Fokus des neuen Screens direkt danach → kein move', () => {
    const heard: MenuSoundKind[] = [];
    setMenuSoundSink((k) => heard.push(k));
    menuSound('confirm', 1000);
    menuSound('confirm', 1005);
    menuSound('move', 1020);
    expect(heard).toEqual(['confirm']);
    menuSound('move', 1200);
    menuSound('move', 1210); // Doppelmeldung (Fokus + Hover)
    menuSound('move', 1260);
    menuSound('back', 1300);
    expect(heard).toEqual(['confirm', 'move', 'move', 'back']);
  });

  it('ohne Senke still', () => {
    expect(() => menuSound('back', 0)).not.toThrow();
  });
});

describe('Pad-Kamera: alte Defaults werden migriert', () => {
  it('unverändert 420/220 gespeichert → neue Defaults; eigener Wert bleibt', () => {
    const old = new PadSettingsStore(memStorage({ [PAD_SETTINGS_KEY]: JSON.stringify({ v: 1, yawRate: 420, pitchRate: 220 }) }));
    expect(old.get().yawRate).toBe(DEFAULT_PAD_SETTINGS.yawRate);
    expect(old.get().pitchRate).toBe(DEFAULT_PAD_SETTINGS.pitchRate);
    expect(DEFAULT_PAD_SETTINGS.yawRate).toBeLessThan(420);
    const own = new PadSettingsStore(memStorage({ [PAD_SETTINGS_KEY]: JSON.stringify({ v: 1, yawRate: 460, pitchRate: 220 }) }));
    expect(own.get().yawRate).toBe(460);
    expect(own.get().pitchRate).toBe(220);
  });
});
