import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSteamModule, hasDebugAccess, STEAM_IPC, STEAM_READY_TIMEOUT_MS, steamMode, type SteamContext, type SteamWindowLike } from '../electron/steam';
import { createFakeSteamworks, type FakeSteamworks } from '../electron/steamFake';
import { parseIndex, parseTrainingIndex } from '../src/engine/Game';
import type { StorageLike } from '../src/engine/storage';
import type { DesktopBridge, DesktopSteamBridge, DesktopSteamStatus } from '../src/platform/bridgeTypes';
import { detectPlatform } from '../src/platform/index';
import type { LiveProgress } from '../src/platform/live';
import { installSteam, levelLabel, presenceFor, SteamLink, type SteamGame, type SteamTimers } from '../src/platform/steam';
import type { PlatformSteamSession } from '../src/platform/types';
import { WEB_PLATFORM } from '../src/platform/web';
import { adminTimeFor } from '../src/ui/medals';

/** Plan 011 Schritte 4.1–4.4: Steamworks-Gerüst — Hauptprozess mit Fake-steamworks, Renderer ohne DOM. */

// ---------------------------------------------------------------- Hauptprozess (electron/steam.ts)

class FakeCtx implements SteamContext {
  readonly handlers = new Map<string, (...args: unknown[]) => unknown>();
  readonly sync = new Map<string, (...args: unknown[]) => unknown>();
  readonly sent: [string, unknown[]][] = [];
  readonly win: SteamWindowLike = { isDestroyed: () => false, webContents: { send: (ch, ...a) => void this.sent.push([ch, a]) } };
  constructor(readonly dev = false) {}
  mainWindow(): SteamWindowLike | null {
    return this.win;
  }
  handle(channel: string, fn: (event: unknown, ...args: unknown[]) => unknown): void {
    this.handlers.set(channel, (...a) => fn({}, ...a));
  }
  handleSync(channel: string, fn: (event: unknown, ...args: unknown[]) => unknown): void {
    this.sync.set(channel, (...a) => fn({}, ...a));
  }
  call(channel: string, ...args: unknown[]): unknown {
    const h = this.handlers.get(channel);
    if (!h) throw new Error(`kein Handler ${channel}`);
    return h(...args);
  }
}

interface Rig {
  readonly mod: ReturnType<typeof createSteamModule>;
  readonly ctx: FakeCtx;
  readonly logs: string[];
  readonly loads: number;
  readonly fake: FakeSteamworks | null;
}

/** Modul wie die Hülle es benutzt: beforeReady → setup → (windowReady). `load` = Ersatz für require('steamworks.js'). */
function rig(argv: string[], opts: { load?: () => unknown; env?: Record<string, string>; dev?: boolean; window?: boolean } = {}): Rig {
  const logs: string[] = [];
  let loads = 0;
  let fake: FakeSteamworks | null = null;
  const mod = createSteamModule({
    argv: ['electron.exe', '.', ...argv],
    env: opts.env ?? {},
    load: () => {
      loads++;
      if (opts.load) return opts.load();
      fake = createFakeSteamworks();
      return fake;
    },
    log: (m) => logs.push(m),
    defer: (fn) => fn(),
    fake: (fail) => {
      fake = createFakeSteamworks({ failInit: fail });
      return fake;
    },
  });
  // Wie die Hülle: derselbe Dev-Modus für beforeReady (Steam-Modus) und setup (Achievements).
  const dev = opts.dev ?? argv.includes('--dev');
  const ctx = new FakeCtx(dev);
  mod.beforeReady?.({ dev });
  mod.setup(ctx);
  if (opts.window !== false) mod.windowReady();
  return {
    mod,
    ctx,
    logs,
    get loads() {
      return loads;
    },
    get fake() {
      return fake;
    },
  };
}

const calls = (f: FakeSteamworks | null, fn: string): unknown[][] => (f ? f.calls.filter((c) => c.fn === fn).map((c) => [...c.args]) : []);

describe('electron/steam — Flag, Laden, init', () => {
  it('Modus: nur mit --steam/VELOCITY_STEAM=1; Fake nur mit --dev, sonst gesperrt (nie das echte Modul)', () => {
    expect(steamMode(['x'], {})).toBe('off');
    expect(steamMode(['x', '--steam'], {})).toBe('real');
    expect(steamMode(['x'], { VELOCITY_STEAM: '1' })).toBe('real');
    expect(steamMode(['x'], { VELOCITY_STEAM: '0' })).toBe('off');
    expect(steamMode(['x', '--steam', '--steam-fake'], {})).toBe('blocked');
    expect(steamMode(['x', '--steam', '--steam-fake', '--dev'], {})).toBe('fake');
    expect(steamMode(['x', '--steam', '--steam-fake=fail', '--dev'], {})).toBe('fake-fail');
  });

  it('--dev im Paket wirkungslos: der Fake bleibt gesperrt (Review C1)', () => {
    // dev = !app.isPackaged && --dev (electron/policy isDevRun) — im Paket ist --dev nur eine Steam-Startoption.
    expect(steamMode(['x', '--steam', '--steam-fake', '--dev'], {}, false)).toBe('blocked');
    expect(steamMode(['x', '--steam', '--steam-fake'], {}, true)).toBe('fake');
  });

  it('Debug-Zugang erkannt (Playwright/CDP/Inspector)', () => {
    expect(hasDebugAccess(['--remote-debugging-port=9351'])).toBe(true);
    expect(hasDebugAccess(['--remote-debugging-pipe'])).toBe(true);
    expect(hasDebugAccess(['--inspect=0'])).toBe(true);
    expect(hasDebugAccess(['--inspect-brk'])).toBe(true);
    expect(hasDebugAccess(['--dev', '--steam', '--remote-allow-origins=*', '--inspector'])).toBe(false);
  });

  it('ohne Flag: steamworks.js wird nie geladen, kein Log, kein Bridge-Feld', async () => {
    const r = rig([]);
    expect(r.loads).toBe(0);
    expect(r.logs).toEqual([]);
    expect(r.ctx.sync.get(STEAM_IPC.requested)?.()).toBe(false);
    await expect(r.ctx.call(STEAM_IPC.ready)).resolves.toEqual({ active: false, appId: null, achievements: false });
  });

  it('Binding fehlt (DLL/Modul): genau EIN Log-Eintrag, keine Overlay-Schalter, Spiel ohne Steam', async () => {
    const r = rig(['--steam'], { load: () => {
      throw new Error("Cannot find module 'steamworks.js'");
    } });
    expect(r.loads).toBe(1);
    expect(r.logs).toHaveLength(1);
    expect(r.logs[0]).toMatch(/Steam nicht verfügbar \(laden/);
    expect(r.ctx.sync.get(STEAM_IPC.requested)?.()).toBe(false);
    await expect(r.ctx.call(STEAM_IPC.ready)).resolves.toEqual({ active: false, appId: null, achievements: false });
  });

  it('kein Steam-Client (init wirft): ein Log-Eintrag, Status inaktiv; Overlay-Schalter nur wegen des Flags', async () => {
    let fake: FakeSteamworks | null = null;
    const r = rig(['--steam'], {
      load: () => {
        fake = createFakeSteamworks({ failInit: true });
        return fake;
      },
    });
    expect(calls(fake, 'electronEnableSteamOverlay')).toHaveLength(1);
    expect(calls(fake, 'init')).toEqual([[480]]);
    expect(r.logs).toHaveLength(1);
    expect(r.logs[0]).toMatch(/Steam nicht verfügbar \(init: Steam is not running/);
    await expect(r.ctx.call(STEAM_IPC.ready)).resolves.toEqual({ active: false, appId: null, achievements: false });
    expect(r.ctx.call(STEAM_IPC.achievement, 'ACH_WIN_ONE_GAME')).toBe(false);
  });

  it('init(480) erst NACH dem ersten Bild (windowReady), nie in beforeReady/setup — ready() wartet darauf', async () => {
    const r = rig(['--steam'], { window: false });
    expect(calls(r.fake, 'electronEnableSteamOverlay')).toHaveLength(1);
    expect(calls(r.fake, 'init')).toEqual([]);
    expect(r.ctx.sync.get(STEAM_IPC.requested)?.()).toBe(true);
    const ready = r.ctx.call(STEAM_IPC.ready) as Promise<DesktopSteamStatus>;
    r.mod.windowReady();
    await expect(ready).resolves.toEqual({ active: true, appId: 480, achievements: true });
    expect(calls(r.fake, 'init')).toEqual([[480]]);
    expect(r.logs).toHaveLength(1);
    expect(r.logs[0]).toMatch(/Steam aktiv: App 480, Achievements an/);
  });

  it('ready() ohne Fenster: nach STEAM_READY_TIMEOUT_MS inaktiv statt ewig zu warten', async () => {
    vi.useFakeTimers();
    try {
      const r = rig(['--steam'], { window: false });
      const ready = r.ctx.call(STEAM_IPC.ready) as Promise<DesktopSteamStatus>;
      await vi.advanceTimersByTimeAsync(STEAM_READY_TIMEOUT_MS + 1);
      await expect(ready).resolves.toEqual({ active: false, appId: null, achievements: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('--steam-fake ohne --dev: gesperrt, das echte Modul wird NICHT ersatzweise geladen', () => {
    const r = rig(['--steam', '--steam-fake'], { dev: false });
    expect(r.mod.mode).toBe('blocked');
    expect(r.loads).toBe(0);
    expect(r.logs).toHaveLength(1);
    expect(r.ctx.sync.get(STEAM_IPC.requested)?.()).toBe(false);
  });

  it('--dev --steam --steam-fake: Fake statt steamworks.js', () => {
    const r = rig(['--dev', '--steam', '--steam-fake']);
    expect(r.loads).toBe(0);
    expect(r.mod.mode).toBe('fake');
    expect(r.mod.status().active).toBe(true);
    expect(calls(r.fake, 'init')).toEqual([[480]]);
  });
});

describe('electron/steam — Achievements, Rich Presence, Overlay', () => {
  it('480: nur Spacewar-IDs; ungültige Namen abgelehnt', () => {
    const r = rig(['--steam']);
    expect(r.ctx.call(STEAM_IPC.achievement, 'ACH_WIN_ONE_GAME')).toBe(true);
    expect(r.ctx.call(STEAM_IPC.achievement, 'L1_GOLD')).toBe(false);
    expect(r.ctx.call(STEAM_IPC.achievement, 'ACH WIN')).toBe(false);
    expect(r.ctx.call(STEAM_IPC.achievement, 42)).toBe(false);
    expect(calls(r.fake, 'achievement.activate')).toEqual([['ACH_WIN_ONE_GAME']]);
  });

  it('mit --dev oder Debug-Zugang komplett aus (kein activate), Rich Presence bleibt', async () => {
    for (const argv of [['--steam', '--dev'], ['--steam', '--remote-debugging-port=9351'], ['--steam', '--inspect=0']]) {
      const r = rig(argv);
      await expect(r.ctx.call(STEAM_IPC.ready)).resolves.toEqual({ active: true, appId: 480, achievements: false });
      expect(r.ctx.call(STEAM_IPC.achievement, 'ACH_WIN_ONE_GAME')).toBe(false);
      expect(calls(r.fake, 'achievement.activate')).toEqual([]);
      expect(r.ctx.call(STEAM_IPC.presence, 'status', 'Menü')).toBe(true);
      expect(r.logs[0]).toMatch(/Achievements aus/);
    }
  });

  it('Rich Presence: Key/Value geprüft (Länge, Steuerzeichen), null löscht', () => {
    const r = rig(['--steam']);
    expect(r.ctx.call(STEAM_IPC.presence, 'status', 'L2 SCHLEIFE')).toBe(true);
    expect(r.ctx.call(STEAM_IPC.presence, 'level', null)).toBe(true);
    expect(r.ctx.call(STEAM_IPC.presence, 'Status', 'x')).toBe(false);
    expect(r.ctx.call(STEAM_IPC.presence, 'status', 'a\nb')).toBe(false);
    expect(r.ctx.call(STEAM_IPC.presence, 'status', 'ü'.repeat(128))).toBe(false); // 256 Byte UTF-8
    expect(r.ctx.call(STEAM_IPC.presence, 'status', 7)).toBe(false);
    expect(calls(r.fake, 'localplayer.setRichPresence')).toEqual([['status', 'L2 SCHLEIFE'], ['level', null]]);
  });

  it('GameOverlayActivated (falls das Binding es meldet) → Renderer; dispose meldet ab, auch ohne setup', () => {
    const r = rig(['--steam']);
    r.fake?.overlay(true);
    r.fake?.overlay(false);
    expect(r.ctx.sent).toEqual([[STEAM_IPC.overlay, [true]], [STEAM_IPC.overlay, [false]]]);
    r.mod.dispose?.();
    r.fake?.overlay(true);
    expect(r.ctx.sent).toHaveLength(2);
    // Zweitinstanz: dispose ohne beforeReady/setup wirft nicht.
    const second = createSteamModule({ argv: ['x', '--steam'], env: {}, load: () => null, log: () => {} });
    expect(() => second.dispose?.()).not.toThrow();
  });

  it('steamworks.js 0.4.0 ohne GameOverlayActivated: kein Register, Log sagt es', () => {
    const r = rig(['--steam'], {
      load: () => {
        const f = createFakeSteamworks();
        return { ...f, SteamCallback: { PersonaStateChange: 0 } };
      },
    });
    expect(r.mod.status().active).toBe(true);
    expect(r.logs[0]).toMatch(/Overlay-Ereignis nein/);
  });
});

// ---------------------------------------------------------------- Renderer (src/platform/steam.ts)

const LEVELS = parseIndex(JSON.parse(readFileSync('public/levels/index.json', 'utf8')));
const LESSONS = parseTrainingIndex(JSON.parse(readFileSync('public/levels/training/index.json', 'utf8')));

class FakeGame implements SteamGame {
  state = 'title';
  currentLevelId = '';
  currentLevel: { readonly def: { readonly name: string } } | null = null;
  lessonSession: object | null = null;
  ghostRace: { readonly levelId: string } | null = null;
  onLiveProgress: ((e: LiveProgress) => void) | null = null;
  pauses = 0;
  levelIds(): readonly string[] {
    return LEVELS.map((l) => l.id);
  }
  lessonList(): readonly { readonly id: string; readonly short: string }[] {
    return LESSONS;
  }
  pause(): void {
    this.pauses++;
  }
  play(id: string, name: string): void {
    this.state = 'playing';
    this.currentLevelId = id;
    this.currentLevel = { def: { name } };
  }
}

class FakeSession implements PlatformSteamSession {
  readonly presence: [string, string | null][] = [];
  readonly unlocked: string[] = [];
  private overlayCb: ((a: boolean) => void) | null = null;
  constructor(
    readonly appId = 480,
    readonly achievements = true,
  ) {}
  unlockAchievement(n: string): Promise<boolean> {
    this.unlocked.push(n);
    return Promise.resolve(true);
  }
  setPresence(k: string, v: string | null): Promise<boolean> {
    this.presence.push([k, v]);
    return Promise.resolve(true);
  }
  onOverlay(cb: (a: boolean) => void): () => void {
    this.overlayCb = cb;
    return () => {
      this.overlayCb = null;
    };
  }
  overlay(a: boolean): void {
    this.overlayCb?.(a);
  }
}

class ManualTimers implements SteamTimers {
  fn: (() => void) | null = null;
  every(fn: () => void): () => void {
    this.fn = fn;
    return () => {
      this.fn = null;
    };
  }
  tick(): void {
    this.fn?.();
  }
}

class Mem implements StorageLike {
  readonly m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
}

describe('platform/steam — Rich Presence', () => {
  it('Menü / L2 SCHLEIFE / Training T3 / Gegen Ghost', () => {
    const base = { levelName: null, levelNumber: 0, lesson: null, race: false };
    expect(presenceFor({ ...base, state: 'title', levelId: 'level1' })).toEqual({ mode: 'menu', status: 'Menü', level: null });
    expect(presenceFor({ ...base, state: 'playing', levelId: 'level2', levelName: '02 SCHLEIFE', levelNumber: 2 })).toEqual({
      mode: 'level',
      status: 'L2 SCHLEIFE',
      level: 'level2',
    });
    expect(presenceFor({ ...base, state: 'paused', levelId: 't3', lesson: 'T3' })).toEqual({ mode: 'training', status: 'Training T3', level: 't3' });
    expect(presenceFor({ ...base, state: 'playing', levelId: 'level2', levelName: '02 SCHLEIFE', levelNumber: 2, race: true }).status).toBe('Gegen Ghost · L2 SCHLEIFE');
    expect(levelLabel('SANDBOX', 0)).toBe('SANDBOX');
  });

  it('nur Geändertes senden, Laden überspringen; Overlay auf → Pause', () => {
    const game = new FakeGame();
    const steam = new FakeSession();
    const timers = new ManualTimers();
    const link = new SteamLink(steam, game, false, { storage: new Mem(), timers });
    expect(steam.presence).toEqual([['status', 'Menü'], ['mode', 'menu'], ['level', null]]);
    timers.tick();
    expect(steam.presence).toHaveLength(3);
    game.play('level2', '02 SCHLEIFE');
    game.state = 'loading';
    timers.tick();
    expect(steam.presence).toHaveLength(3);
    game.state = 'playing';
    timers.tick();
    expect(steam.presence.slice(3)).toEqual([['status', 'L2 SCHLEIFE'], ['mode', 'level'], ['level', 'level2']]);
    game.state = 'paused';
    timers.tick();
    expect(steam.presence).toHaveLength(6);
    game.ghostRace = { levelId: 'level2' };
    timers.tick();
    expect(steam.presence.slice(6)).toEqual([['status', 'Gegen Ghost · L2 SCHLEIFE'], ['mode', 'ghost']]);
    game.ghostRace = null;
    game.play('t3', 'AIR-STRAFE');
    game.lessonSession = {};
    timers.tick();
    expect(link.presence).toEqual({ mode: 'training', status: 'Training T3', level: 't3' });
    steam.overlay(false);
    expect(game.pauses).toBe(0);
    steam.overlay(true);
    expect(game.pauses).toBe(1);
    link.dispose();
    steam.overlay(true);
    expect(game.pauses).toBe(1);
    expect(game.onLiveProgress).toBeNull();
  });
});

describe('platform/steam — Achievements am Spiel', () => {
  const goldL1: LiveProgress = {
    kind: 'finish',
    levelId: 'level1',
    time: adminTimeFor('gold', LEVELS[0].medals ?? { bronze: 1, silver: 1, gold: 1, velocity: 1, author: 1 }),
    clean: true,
    levels: LEVELS,
    lessons: LESSONS,
  };

  it('Live-Ziel → Steam (480 über die Test-Tabelle)', async () => {
    const game = new FakeGame();
    const steam = new FakeSession();
    const link = new SteamLink(steam, game, false, { storage: new Mem(), timers: new ManualTimers() });
    game.onLiveProgress?.(goldL1);
    game.onLiveProgress?.({ ...goldL1, clean: false });
    await link.tracker?.settled();
    expect(steam.unlocked).toEqual(['ACH_WIN_ONE_GAME', 'ACH_WIN_100_GAMES']);
  });

  it('komplett aus mit --dev bzw. wenn der Hauptprozess Achievements sperrt (Debug-Zugang)', () => {
    for (const [dev, allowed] of [[true, true], [false, false]] as const) {
      const game = new FakeGame();
      const steam = new FakeSession(480, allowed);
      const mem = new Mem();
      const link = new SteamLink(steam, game, dev, { storage: mem, timers: new ManualTimers() });
      expect(link.tracker).toBeNull();
      expect(game.onLiveProgress).toBeNull();
      expect(mem.m.size).toBe(0);
      expect(steam.presence.length).toBeGreaterThan(0); // Presence bleibt
    }
  });

  it('installSteam: Web/ohne Steam/init gescheitert → null, sonst verbunden', async () => {
    expect(await installSteam(WEB_PLATFORM, new FakeGame())).toBeNull();
    const failed = { ...WEB_PLATFORM, kind: 'desktop' as const, steam: { ready: () => Promise.resolve(null) } };
    expect(await installSteam(failed, new FakeGame())).toBeNull();
    const ok = { ...WEB_PLATFORM, kind: 'desktop' as const, steam: { ready: () => Promise.resolve(new FakeSession()) } };
    const link = await installSteam(ok, new FakeGame(), { storage: new Mem(), timers: new ManualTimers() });
    expect(link).toBeInstanceOf(SteamLink);
    link?.dispose();
  });
});

// ---------------------------------------------------------------- Desktop-Adapter (src/platform/desktop.ts)

describe('Desktop-Adapter: caps.steam folgt dem init', () => {
  const base = (): DesktopBridge => ({
    version: 1,
    versions: { electron: '45.2.3', chrome: '156' },
    dev: false,
    quit: () => {},
    window: { getMode: () => Promise.resolve('fullscreen'), setMode: (m) => Promise.resolve(m) },
    openExternal: () => Promise.resolve(true),
    saveMirror: { readSync: () => null, write: () => Promise.resolve(true), writeSync: () => true },
  });
  const steamBridge = (st: DesktopSteamStatus): DesktopSteamBridge => ({
    ready: () => Promise.resolve(st),
    achievement: () => Promise.resolve(true),
    presence: () => Promise.resolve(true),
    onOverlay: () => () => {},
  });

  afterEach(() => vi.restoreAllMocks());

  it('ohne Steam-Feld: steam null, caps.steam false', () => {
    const p = detectPlatform({ velocityDesktop: base() });
    expect(p.steam).toBeNull();
    expect(p.caps.steam).toBe(false);
  });

  it('init ok → caps.steam true; init gescheitert → bleibt false, ready() null', async () => {
    const ok = detectPlatform({ velocityDesktop: { ...base(), steam: steamBridge({ active: true, appId: 480, achievements: true }) } });
    expect(ok.caps.steam).toBe(false);
    const s = await ok.steam?.ready();
    expect(s?.appId).toBe(480);
    expect(ok.caps.steam).toBe(true);
    const off = detectPlatform({ velocityDesktop: { ...base(), steam: steamBridge({ active: false, appId: null, achievements: false }) } });
    expect(await off.steam?.ready()).toBeNull();
    expect(off.caps.steam).toBe(false);
  });

  it('unvollständiges Steam-Feld → ohne Steam', () => {
    const broken = { ...base(), steam: { ready: () => Promise.resolve({ active: true, appId: 480, achievements: true }) } };
    expect(detectPlatform({ velocityDesktop: broken }).steam).toBeNull();
  });
});
