import { describe, expect, it } from 'vitest';
import type { DesktopBridge, DesktopSaveMirror } from '../src/platform/bridgeTypes';
import { detectPlatform, isDesktopBridge } from '../src/platform/index';
import { hookStorageWrites, parseSave, restoreSave, SaveMirror, serializeSave, type MirrorStorage, type MirrorTimers } from '../src/platform/saveMirror';

/** Plan 011 §2.2/§2.7: Plattform-Erkennung und Speicher-Spiegel (DOM-frei). */

class MemStorage implements MirrorStorage {
  readonly m = new Map<string, string>();
  get length(): number {
    return this.m.size;
  }
  key(i: number): string | null {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
}

class FakeMirror implements DesktopSaveMirror {
  file: string | null = null;
  asyncWrites = 0;
  syncWrites = 0;
  readSync(): string | null {
    return this.file;
  }
  write(json: string): Promise<boolean> {
    this.asyncWrites++;
    this.file = json;
    return Promise.resolve(true);
  }
  writeSync(json: string): boolean {
    this.syncWrites++;
    this.file = json;
    return true;
  }
}

/** Manuelle Timer: run() feuert alles Ausstehende. */
class FakeTimers implements MirrorTimers {
  private next = 1;
  readonly pending = new Map<number, () => void>();
  set(fn: () => void): unknown {
    const id = this.next++;
    this.pending.set(id, fn);
    return id;
  }
  clear(h: unknown): void {
    this.pending.delete(h as number);
  }
  run(): void {
    const fns = [...this.pending.values()];
    this.pending.clear();
    for (const f of fns) f();
  }
}

const fakeBridge = (): DesktopBridge => ({
  version: 1,
  versions: { electron: '45.2.3', chrome: '156' },
  dev: false,
  quit: () => {},
  window: { getMode: () => Promise.resolve('fullscreen'), setMode: (m) => Promise.resolve(m) },
  openExternal: () => Promise.resolve(true),
  saveMirror: new FakeMirror(),
});

describe('platform()', () => {
  it('ohne Bridge → web, alles aus', () => {
    const p = detectPlatform(undefined);
    expect(p.kind).toBe('web');
    expect(p.caps).toEqual({ quit: false, displayMode: false, saveMirror: false, steam: false });
    expect(p.window).toBeNull();
    expect(p.saveMirror).toBeNull();
    expect(() => p.quit()).not.toThrow();
  });

  it('mit Bridge → desktop, fremdes Objekt → web', () => {
    const p = detectPlatform({ velocityDesktop: fakeBridge() });
    expect(p.kind).toBe('desktop');
    expect(p.caps.quit && p.caps.displayMode && p.caps.saveMirror).toBe(true);
    expect(p.versions?.electron).toBe('45.2.3');
    expect(isDesktopBridge({ version: 2, quit: () => {} })).toBe(false);
    expect(detectPlatform({ velocityDesktop: { foo: 1 } }).kind).toBe('web');
  });
});

describe('Speicher-Spiegel', () => {
  it('nur velocity.*-Schlüssel, sortiert; parse verwirft Fremdes', () => {
    const s = new MemStorage();
    s.setItem('velocity.b', '2');
    s.setItem('sb-x-auth-token', 'geheim');
    s.setItem('velocity.a', '1');
    const json = serializeSave(s, 5);
    expect(json).toBe('{"v":1,"at":5,"data":{"velocity.a":"1","velocity.b":"2"}}');
    expect([...(parseSave(json) ?? [])]).toEqual([['velocity.a', '1'], ['velocity.b', '2']]);
    expect(parseSave('{"v":1,"data":{"evil":"1","velocity.x":3,"velocity.y":"ok"}}')).toEqual(new Map([['velocity.y', 'ok']]));
    expect(parseSave('kaputt')).toBeNull();
    expect(parseSave('{"v":2,"data":{}}')).toBeNull();
    expect(parseSave(null)).toBeNull();
  });

  it('Einspielen nur in einen leeren Spielstand', () => {
    const m = new FakeMirror();
    m.file = '{"v":1,"at":1,"data":{"velocity.best.v1":"{}","velocity.unlocks.v1":"x"}}';
    const empty = new MemStorage();
    empty.setItem('sb-token', 't'); // fremde Schlüssel zählen nicht als Spielstand
    expect(restoreSave(empty, m)).toBe(2);
    expect(empty.getItem('velocity.unlocks.v1')).toBe('x');
    const full = new MemStorage();
    full.setItem('velocity.best.v1', 'neuer');
    expect(restoreSave(full, m)).toBe(0);
    expect(full.getItem('velocity.best.v1')).toBe('neuer');
  });

  it('entprellt asynchron, flush synchron, unveränderter Stand schreibt nicht', async () => {
    const s = new MemStorage();
    const m = new FakeMirror();
    const t = new FakeTimers();
    const sm = new SaveMirror(s, m, 2000, t);
    s.setItem('velocity.a', '1');
    sm.markDirty();
    sm.markDirty();
    expect(t.pending.size).toBe(1);
    t.run();
    await Promise.resolve();
    expect(m.asyncWrites).toBe(1);
    expect(parseSave(m.file)?.get('velocity.a')).toBe('1');
    sm.markDirty(); // ohne Änderung
    t.run();
    await Promise.resolve();
    expect(m.asyncWrites).toBe(1);
    s.setItem('velocity.a', '2');
    sm.markDirty();
    expect(sm.flush()).toBe(true);
    expect(m.syncWrites).toBe(1);
    expect(t.pending.size).toBe(0);
    expect(parseSave(m.file)?.get('velocity.a')).toBe('2');
  });

  it('Prototyp-Hook meldet nur velocity.* auf dem Ziel-Speicher', () => {
    class P extends MemStorage {}
    const local = new P();
    const session = new P();
    let n = 0;
    const off = hookStorageWrites(P.prototype as unknown as Parameters<typeof hookStorageWrites>[0], local, () => n++);
    local.setItem('velocity.a', '1');
    local.setItem('fremd', '1');
    session.setItem('velocity.a', '1');
    local.removeItem('velocity.a');
    local.clear();
    expect(n).toBe(3);
    expect(local.getItem('fremd')).toBeNull();
    off();
    local.setItem('velocity.b', '1');
    expect(n).toBe(3);
  });
});
