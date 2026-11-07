import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModuleRunner, type RunnableModule } from '../electron/moduleRunner';
import {
  buildCsp,
  faultArg,
  isAppUrl,
  isDevRun,
  isDisplayModeToggle,
  isExternalAllowed,
  mimeFor,
  resolveAppPath,
  sanitizeOrigin,
  type KeyInputLike,
} from '../electron/policy';
import { DisplaySleepGuard, isForeground, type PowerBlockerApi } from '../electron/power';
import { fatalMessage, isLoadFailure, isRendererCrash, RECOVERY_STABLE_MS, RendererRecovery } from '../electron/recovery';
import { SAVE_ASYNC_RETRY_MS, SAVE_SYNC_RETRY_MS, SaveStore, type SaveFileHandle, type SaveFs, type SaveTiming } from '../electron/save';

/** Plan 011 §2.1: Regeln der Electron-Hülle (ohne Electron, reine Funktionen). */
describe('Desktop-Protokoll app://velocity', () => {
  const root = resolve('dist');

  it('löst Pfade unter dist/ auf, "/" → index.html, Query zählt nicht', () => {
    expect(resolveAppPath(root, 'app://velocity/')).toBe(join(root, 'index.html'));
    expect(resolveAppPath(root, 'app://velocity/index.html?online=mock#x')).toBe(join(root, 'index.html'));
    expect(resolveAppPath(root, 'app://velocity/levels/index.json')).toBe(join(root, 'levels', 'index.json'));
    expect(resolveAppPath(root, 'app://velocity/assets/a%20b.js')).toBe(join(root, 'assets', 'a b.js'));
  });

  it('kein Ausbruch aus dist/, kein fremder Host/Scheme', () => {
    // %2e%2e ist für den URL-Parser ein Punkt-Segment: wird schon dort zu /package.json (bleibt in dist/, 404).
    expect(resolveAppPath(root, 'app://velocity/%2e%2e/package.json')).toBe(join(root, 'package.json'));
    expect(resolveAppPath(root, 'app://velocity/..%5c..%5cpackage.json')).toBeNull();
    expect(resolveAppPath(root, 'app://velocity/%2e%2e%2f%2e%2e%2fwindows')).toBeNull();
    expect(resolveAppPath(root, 'app://velocity/C:%5cWindows%5cwin.ini')).toBeNull();
    expect(resolveAppPath(root, 'app://velocity/index.html::$DATA')).toBeNull();
    expect(resolveAppPath(root, 'app://velocity/a%00b')).toBeNull();
    expect(resolveAppPath(root, 'app://velocity/%E0%A4%A')).toBeNull();
    expect(resolveAppPath(root, 'app://evil/index.html')).toBeNull();
    expect(resolveAppPath(root, 'file:///C:/Windows/win.ini')).toBeNull();
  });

  it('MIME je Endung', () => {
    expect(mimeFor('a.js')).toMatch(/^text\/javascript/);
    expect(mimeFor('a.JSON')).toMatch(/^application\/json/);
    expect(mimeFor('a.woff2')).toBe('font/woff2');
    expect(mimeFor('a.unknown')).toBe('application/octet-stream');
  });

  it('CSP: Skripte nur aus dem Paket, Supabase nur wenn bekannt', () => {
    const c = buildCsp('https://abc.supabase.co');
    expect(c).toContain("script-src 'self'");
    expect(c).not.toMatch(/script-src[^;]*unsafe/);
    expect(c).toContain("connect-src 'self' https://abc.supabase.co wss://abc.supabase.co");
    expect(buildCsp(null)).toContain("connect-src 'self';");
  });

  it('Navigation nur auf die eigene Origin bzw. den lokalen Dev-Server', () => {
    expect(isAppUrl('app://velocity/index.html', null)).toBe(true);
    expect(isAppUrl('app://velocity.evil/index.html', null)).toBe(false);
    expect(isAppUrl('https://example.com/', null)).toBe(false);
    expect(isAppUrl('http://localhost:5173/x', 'http://localhost:5173')).toBe(true);
    expect(isAppUrl('http://localhost:5174/x', 'http://localhost:5173')).toBe(false);
  });

  it('externe Links: nur https auf Discord und dem eigenen Supabase', () => {
    const sb = 'https://abc.supabase.co';
    expect(isExternalAllowed('https://discord.com/oauth2/authorize?x=1', sb)).toBe(true);
    expect(isExternalAllowed('https://cdn.discord.com/x', sb)).toBe(true);
    expect(isExternalAllowed('https://abc.supabase.co/auth/v1/authorize', sb)).toBe(true);
    expect(isExternalAllowed('https://evil.supabase.co/', sb)).toBe(false);
    expect(isExternalAllowed('https://discord.com.evil.io/', sb)).toBe(false);
    expect(isExternalAllowed('http://discord.com/', sb)).toBe(false);
    expect(isExternalAllowed('https://user:pw@discord.com/', sb)).toBe(false);
    expect(isExternalAllowed('file:///C:/x', sb)).toBe(false);
    expect(isExternalAllowed('javascript:alert(1)', sb)).toBe(false);
  });

  it('sanitizeOrigin nimmt nur https-Origins', () => {
    expect(sanitizeOrigin('https://abc.supabase.co/rest/v1')).toBe('https://abc.supabase.co');
    expect(sanitizeOrigin('http://abc.supabase.co')).toBeNull();
    expect(sanitizeOrigin('kaputt')).toBeNull();
    expect(sanitizeOrigin(undefined)).toBeNull();
  });
});

/** Spiegel-JSON wie aus src/platform/saveMirror.ts (v1, nur velocity.*). */
const saveJson = (v: string): string => JSON.stringify({ v: 1, at: 1, data: { 'velocity.best.v1': v } });

describe('Speicher-Spiegel im Hauptprozess (electron/save.ts, Review C5)', () => {
  it('ein laufendes async-Schreiben überschreibt keinen neueren writeSync-Stand', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'velocity-save-'));
    try {
      const store = new SaveStore(dir);
      const older = store.write(saveJson('alt'));
      // pagehide/Beenden: synchron, NACH dem Anstoß des async-Schreibens, aber bevor dessen rename lief.
      expect(store.writeSync(saveJson('neu'))).toBe(true);
      expect(await older).toBe(true); // überholt = gesichert (der neuere Stand liegt)
      await store.whenIdle();
      expect(readFileSync(join(dir, 'save', 'save.json'), 'utf8')).toBe(saveJson('neu'));
      expect(store.readSync()).toBe(saveJson('neu'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Fake-Dateisystem: Operationen protokolliert, rename prüft, ob die Quelle per fsync auf der Platte war. */
class FakeFs implements SaveFs {
  readonly files = new Map<string, string>();
  readonly ops: string[] = [];
  /** Fehlercodes der nächsten renames (z. B. EPERM: Defender hält save.json). */
  renameFails: string[] = [];
  /** Hält das nächste async-open an, bis `release()` gerufen wird. */
  private gate: Promise<void> | null = null;
  private releaseGate: (() => void) | null = null;
  private readonly open = new Map<number, { path: string; data: string; synced: boolean }>();
  private readonly durable = new Set<string>();
  private nextFd = 3;

  hold(): void {
    this.gate = new Promise((r) => (this.releaseGate = r));
  }
  release(): void {
    this.gate = null;
    this.releaseGate?.();
  }
  private name(p: string): string {
    return p.split(/[\\/]/).pop() ?? p;
  }
  private fd(fd: number): { path: string; data: string; synced: boolean } {
    const f = this.open.get(fd);
    if (!f) throw new Error(`fd ${fd} nicht offen`);
    return f;
  }
  mkdirSync(): unknown {
    return undefined;
  }
  readFileSync(path: string): string {
    const v = this.files.get(path);
    if (v === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return v;
  }
  openSync(path: string): number {
    const fd = this.nextFd++;
    this.open.set(fd, { path, data: '', synced: false });
    this.durable.delete(path);
    this.ops.push(`open ${this.name(path)}`);
    return fd;
  }
  writeSync(fd: number, data: string): number {
    const f = this.fd(fd);
    f.data += data;
    f.synced = false;
    this.ops.push(`write ${this.name(f.path)}`);
    return data.length;
  }
  fsyncSync(fd: number): void {
    const f = this.fd(fd);
    f.synced = true;
    this.ops.push(`fsync ${this.name(f.path)}`);
  }
  closeSync(fd: number): void {
    const f = this.fd(fd);
    this.open.delete(fd);
    this.files.set(f.path, f.data);
    if (f.synced) this.durable.add(f.path);
    this.ops.push(`close ${this.name(f.path)}`);
  }
  renameSync(from: string, to: string): void {
    const code = this.renameFails.shift();
    if (code) {
      this.ops.push(`rename ${code}`);
      throw Object.assign(new Error(code), { code });
    }
    const data = this.files.get(from);
    if (data === undefined) throw new Error(`rename: ${from} fehlt`);
    if (!this.durable.has(from)) throw new Error(`rename ohne fsync: ${this.name(from)}`);
    this.files.set(to, data);
    this.files.delete(from);
    this.ops.push(`rename ${this.name(from)}`);
  }
  async openAsync(path: string): Promise<SaveFileHandle> {
    if (this.gate) await this.gate;
    const fd = this.openSync(path);
    return {
      writeFile: async (data) => void this.writeSync(fd, data),
      sync: async () => this.fsyncSync(fd),
      close: async () => this.closeSync(fd),
    };
  }
}

class FakeTiming implements SaveTiming {
  readonly sleeps: number[] = [];
  readonly delays: number[] = [];
  sleepSync(ms: number): void {
    this.sleeps.push(ms);
  }
  delay(ms: number): Promise<void> {
    this.delays.push(ms);
    return Promise.resolve();
  }
}

const SAVE_FILE = join('u', 'save', 'save.json');
const saveRig = (): { fs: FakeFs; timing: FakeTiming; store: SaveStore } => {
  const fs = new FakeFs();
  const timing = new FakeTiming();
  return { fs, timing, store: new SaveStore('u', { fs, timing }) };
};

describe('Speicher-Spiegel im Hauptprozess mit Fake-fs (Review C5)', () => {
  it('fsync der tmp-Datei vor dem rename — synchron und asynchron', async () => {
    const { fs, store } = saveRig();
    expect(store.writeSync(saveJson('a'))).toBe(true);
    expect(fs.ops).toEqual(['open save.json.tmp', 'write save.json.tmp', 'fsync save.json.tmp', 'close save.json.tmp', 'rename save.json.tmp']);
    fs.ops.length = 0;
    await expect(store.write(saveJson('b'))).resolves.toBe(true);
    expect(fs.ops).toEqual(['open save.json.atmp', 'write save.json.atmp', 'fsync save.json.atmp', 'close save.json.atmp', 'rename save.json.atmp']);
    expect(fs.files.get(SAVE_FILE)).toBe(saveJson('b'));
  });

  it('EPERM/EBUSY/EACCES: neuer Versuch mit Backoff (async und sync)', async () => {
    const { fs, timing, store } = saveRig();
    fs.renameFails = ['EPERM', 'EBUSY', 'EACCES'];
    await expect(store.write(saveJson('a'))).resolves.toBe(true);
    expect(timing.delays).toEqual(SAVE_ASYNC_RETRY_MS.slice(0, 3));
    expect(fs.files.get(SAVE_FILE)).toBe(saveJson('a'));
    fs.renameFails = ['EBUSY'];
    expect(store.writeSync(saveJson('b'))).toBe(true);
    expect(timing.sleeps).toEqual(SAVE_SYNC_RETRY_MS.slice(0, 1));
    expect(fs.files.get(SAVE_FILE)).toBe(saveJson('b'));
    expect(store.pending).toBe(false);
  });

  it('neuester Stand gewinnt: ein älterer, noch laufender async-Auftrag wird übersprungen', async () => {
    const { fs, store } = saveRig();
    fs.hold();
    const a = store.write(saveJson('a'));
    await Promise.resolve();
    const b = store.write(saveJson('b'));
    fs.release();
    await expect(Promise.all([a, b])).resolves.toEqual([true, true]);
    await store.whenIdle();
    expect(fs.files.get(SAVE_FILE)).toBe(saveJson('b'));
    expect(fs.ops.filter((o) => o.startsWith('rename'))).toEqual(['rename save.json.atmp']);
  });

  it('writeSync während eines laufenden async-Auftrags: der ältere benennt nicht mehr um', async () => {
    const { fs, store } = saveRig();
    fs.hold();
    const a = store.write(saveJson('alt'));
    await Promise.resolve();
    expect(store.writeSync(saveJson('neu'))).toBe(true);
    fs.release();
    await expect(a).resolves.toBe(true);
    await store.whenIdle();
    expect(fs.files.get(SAVE_FILE)).toBe(saveJson('neu'));
    expect(fs.ops.filter((o) => o.startsWith('rename'))).toEqual(['rename save.json.tmp']);
  });

  it('Dauerfehler: false, Stand bleibt offen (readSync liefert ihn), flushPendingSync beim Beenden schreibt ihn', async () => {
    const { fs, store } = saveRig();
    fs.renameFails = Array.from({ length: SAVE_ASYNC_RETRY_MS.length + 1 }, () => 'EPERM');
    await expect(store.write(saveJson('a'))).resolves.toBe(false);
    expect(store.pending).toBe(true);
    expect(store.readSync()).toBe(saveJson('a'));
    expect(fs.files.has(SAVE_FILE)).toBe(false);
    expect(store.flushPendingSync()).toBe(true);
    expect(fs.files.get(SAVE_FILE)).toBe(saveJson('a'));
    expect(store.pending).toBe(false);
  });

  it('nicht vorübergehende Fehler (ENOSPC) ohne Wiederholung; Müll wird gar nicht erst geschrieben', async () => {
    const { fs, timing, store } = saveRig();
    fs.renameFails = ['ENOSPC'];
    expect(store.writeSync(saveJson('a'))).toBe(false);
    expect(timing.sleeps).toEqual([]);
    await store.whenIdle(); // der Hintergrund versucht den offenen Stand noch einmal
    expect(fs.files.get(SAVE_FILE)).toBe(saveJson('a'));
    const before = fs.ops.length;
    expect(store.writeSync('kein json')).toBe(false);
    await expect(store.write('[1,2]')).resolves.toBe(false);
    expect(fs.ops.length).toBe(before);
  });
});

describe('Dev-Modus, Kürzel, Fehler-Injektion (Review C1/C4/C7)', () => {
  it('--dev zählt nur unverpackt', () => {
    expect(isDevRun(['electron.exe', '.', '--dev'], false)).toBe(true);
    expect(isDevRun(['VELOCITY.exe', '--dev'], true)).toBe(false);
    expect(isDevRun(['electron.exe', '.'], false)).toBe(false);
  });

  it('Alt+Enter und F11 schalten den Anzeigemodus, sonst nichts', () => {
    const k = (p: Partial<KeyInputLike>): KeyInputLike => ({
      type: 'keyDown',
      key: 'Enter',
      alt: false,
      control: false,
      meta: false,
      shift: false,
      isAutoRepeat: false,
      ...p,
    });
    expect(isDisplayModeToggle(k({ alt: true }))).toBe(true);
    expect(isDisplayModeToggle(k({ key: 'F11' }))).toBe(true);
    expect(isDisplayModeToggle(k({}))).toBe(false); // Enter allein = Bestätigen im Menü
    expect(isDisplayModeToggle(k({ alt: true, isAutoRepeat: true }))).toBe(false);
    expect(isDisplayModeToggle(k({ alt: true, type: 'keyUp' }))).toBe(false);
    expect(isDisplayModeToggle(k({ alt: true, control: true }))).toBe(false);
    expect(isDisplayModeToggle(k({ key: 'F11', alt: true }))).toBe(false);
    expect(isDisplayModeToggle(k({ key: 'w', control: true }))).toBe(false);
  });

  it('Fehler-Injektion nur im Dev-Modus, nur bekannte Namen', () => {
    expect(faultArg(['x', '--fault=crash'], true)).toBe('crash');
    expect(faultArg(['x', '--fault=crash'], false)).toBeNull();
    expect(faultArg(['x', '--fault=boom'], true)).toBeNull();
    expect(faultArg(['x'], true)).toBeNull();
  });
});

describe('Renderer-Ausfälle (electron/recovery.ts, Review C4)', () => {
  it('einmal neu laden, der nächste Fehler kurz danach → aufgeben; nach stabiler Laufzeit wieder neu laden', () => {
    const r = new RendererRecovery();
    expect(r.next(1000)).toBe('reload');
    expect(r.next(2000)).toBe('fatal');
    const r2 = new RendererRecovery();
    expect(r2.next(0)).toBe('reload');
    expect(r2.next(RECOVERY_STABLE_MS + 1)).toBe('reload');
  });

  it('Gründe: clean-exit und abgebrochene Navigation zählen nicht', () => {
    expect(isRendererCrash('clean-exit')).toBe(false);
    for (const r of ['crashed', 'killed', 'oom', 'abnormal-exit', 'launch-failed']) expect(isRendererCrash(r)).toBe(true);
    expect(isLoadFailure(-102, true)).toBe(true);
    expect(isLoadFailure(-3, true)).toBe(false);
    expect(isLoadFailure(-102, false)).toBe(false);
    expect(fatalMessage('gone', 'crashed, Code 1')).toMatch(/abgestürzt \(crashed, Code 1\)\. Das Spiel wird beendet/);
  });
});

class FakeBlocker implements PowerBlockerApi {
  private next = 1;
  readonly live = new Set<number>();
  starts = 0;
  start(): number {
    this.starts++;
    const id = this.next++;
    this.live.add(id);
    return id;
  }
  stop(id: number): boolean {
    return this.live.delete(id);
  }
  isStarted(id: number): boolean {
    return this.live.has(id);
  }
}

describe('Bildschirm wach halten (electron/power.ts, Review C3)', () => {
  it('nur im Vordergrund aktiv, doppelte Ereignisse ändern nichts, dispose gibt frei', () => {
    const api = new FakeBlocker();
    const g = new DisplaySleepGuard(api);
    g.set(true);
    g.set(true);
    expect(api.starts).toBe(1);
    expect(g.active).toBe(true);
    g.set(false);
    g.set(false);
    expect(api.live.size).toBe(0);
    expect(g.blockerId).toBeNull();
    g.set(true);
    g.dispose();
    expect(api.live.size).toBe(0);
    expect(g.active).toBe(false);
  });

  it('Vordergrund = fokussiert, sichtbar, nicht minimiert', () => {
    const w = (focused: boolean, visible: boolean, minimized: boolean, destroyed = false): Parameters<typeof isForeground>[0] => ({
      isDestroyed: () => destroyed,
      isFocused: () => focused,
      isVisible: () => visible,
      isMinimized: () => minimized,
    });
    expect(isForeground(w(true, true, false))).toBe(true);
    expect(isForeground(w(false, true, false))).toBe(false);
    expect(isForeground(w(true, true, true))).toBe(false);
    expect(isForeground(w(true, false, false))).toBe(false);
    expect(isForeground(w(true, true, false, true))).toBe(false);
  });
});

describe('Modul-Hooks (electron/moduleRunner.ts, Review C6)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  type Mod = RunnableModule<string, { readonly log: string[] }>;
  const logs: string[] = [];
  const log = (m: string): void => void logs.push(m);

  it('ein werfendes setup hält die anderen nicht auf; ein hängendes nur bis zum GEMEINSAMEN Zeitlimit', async () => {
    vi.useFakeTimers();
    logs.length = 0;
    const ctx = { log: [] as string[] };
    const mods: Mod[] = [
      {
        name: 'wirft',
        setup: () => {
          throw new Error('kaputt');
        },
      },
      { name: 'haengt', setup: () => new Promise<void>(() => {}) },
      { name: 'haengt2', setup: () => new Promise<void>(() => {}) },
      { name: 'gut', setup: (c) => void c.log.push('gut') },
    ];
    const run = new ModuleRunner(mods, log);
    let done = false;
    const report = run.setup(ctx, 3000).then((r) => {
      done = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(2999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1); // zwei hängende Module: trotzdem nur EIN Zeitlimit
    await expect(report).resolves.toEqual({ failed: ['wirft'], late: ['haengt', 'haengt2'] });
    expect(ctx.log).toEqual(['gut']);
    expect(logs.some((l) => /wirft nicht geladen/.test(l))).toBe(true);
  });

  it('windowReady und dispose genau einmal, Fehler geloggt; Sync-Kanäle gesammelt', () => {
    logs.length = 0;
    const seen: string[] = [];
    const mods: Mod[] = [
      {
        name: 'a',
        syncChannels: ['vel:a'],
        setup: () => {},
        windowReady: (w) => void seen.push(`ready ${w}`),
        dispose: () => {
          throw new Error('dispose kaputt');
        },
      },
      { name: 'b', setup: () => {}, dispose: () => void seen.push('dispose b'), beforeReady: (i) => void seen.push(`before dev=${i.dev}`) },
    ];
    const run = new ModuleRunner(mods, log);
    run.beforeReady({ dev: false });
    run.windowReady('win');
    run.windowReady('win');
    run.dispose();
    run.dispose();
    expect(seen).toEqual(['before dev=false', 'ready win', 'dispose b']);
    expect(logs.filter((l) => /dispose fehlgeschlagen/.test(l))).toHaveLength(1);
    expect(run.syncChannels).toEqual(['vel:a']);
  });
});
