import { FixedLoop } from '../../engine/Loop';
import { InputManager } from '../../engine/Input';
import { BestTimes, SettingsStore } from '../../engine/Settings';
import { UnlockStore } from '../../engine/Unlocks';
import type { StorageLike } from '../../engine/Settings';
import { VELOCITY_DEFAULT, MOVEMENT_PRESETS, withMovement } from '../../player/MovementConfig';
import type { LevelIndexEntry } from '../../world/level/LevelFormat';
import type { PlayerInput } from '../../player/types';
import { pixelFont } from '../BitmapFont';
import { Hud } from '../Hud';
import { Menu } from '../Menu';
import { TuningPanel } from '../TuningPanel';
import type { LockStatus } from '../Menu';
import type { FinishResult, MenuScreen } from '../types';
import { paintFakeScene } from './fakeScene';
import { FakeRun, FAKE_RUN_LENGTH } from './fakeRun';

/**
 * UI-Preview (dev/ui.html): HUD mit Fake-Lauf auf 480×270, ganzzahlig
 * hochskaliert wie im Spiel, darüber die HTML-Menüs. Tasten 1–7 schalten um.
 * URL: ?view=hud|title|pause|settings|controls|finish|tuning&t=9.3&freeze=1&res=270
 */

type View = 'hud' | MenuScreen | 'tuning';
const VIEWS: readonly View[] = ['hud', 'title', 'pause', 'settings', 'controls', 'finish', 'tuning'];

function isView(v: string | null): v is View {
  return v !== null && (VIEWS as readonly string[]).includes(v);
}

/** Preview schreibt nichts in den echten localStorage des Spiels. */
class MemoryStorage implements StorageLike {
  private readonly m = new Map<string, string>();
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

const params = new URLSearchParams(location.search);
const pixelHeight = Number(params.get('res') ?? '270');
const LOW_H = [240, 270, 360, 448].includes(pixelHeight) ? pixelHeight : 270;
const LOW_W = Math.round((LOW_H * 16) / 9);

const stage = byId('stage');
const sceneCanvas = byId('scene');
const menuRoot = byId('menu-root');
const bar = byId('bar');
if (!(sceneCanvas instanceof HTMLCanvasElement)) throw new Error('scene canvas fehlt');
const sceneCtx = sceneCanvas.getContext('2d');
if (!sceneCtx) throw new Error('2D fehlt');
sceneCanvas.width = LOW_W;
sceneCanvas.height = LOW_H;

const settings = new SettingsStore(new MemoryStorage());
const bestStore = new MemoryStorage();
const best = new BestTimes(bestStore);
best.submit('sandbox', 17.84, [5.62, 10.31, 15.9]);
best.submit('neonhafen', 42.17, [12.4, 27.9]);

const hud = new Hud();
hud.resize(LOW_W, LOW_H);
hud.canvas.id = 'hud';
stage.appendChild(hud.canvas);

const menu = new Menu(menuRoot, settings, best, new UnlockStore(new MemoryStorage()));
const levels: LevelIndexEntry[] = [
  { id: 'sandbox', name: 'Sandbox', subtitle: 'Testgelände für Entwickler', file: 'sandbox.json' },
  { id: 'neonhafen', name: 'Neonhafen', subtitle: 'Erste Sprünge über dem Hafenbecken', file: 'neonhafen.json' },
  { id: 'glaskanal', name: 'Glaskanal', subtitle: 'Surf durch die Nacht — nur für Mutige', file: 'glaskanal.json' },
];
menu.setLevels(levels);

const tuning = new TuningPanel(settings, withMovement(VELOCITY_DEFAULT, {}));
tuning.onChange((c) => console.info('[preview] Movement-Config', c.airAccelerate, c.tickRate, c === MOVEMENT_PRESETS.cs2));

const input = new InputManager(stage, () => settings.get());
input.onNotice((n) => {
  log.push(`notice:${n}`);
  hud.onInputNotice(n);
});

const run = new FakeRun();
let view: View = 'hud';
let frozen = params.get('freeze') === '1';

const finishResult: FinishResult = {
  levelId: 'sandbox',
  levelName: 'Sandbox',
  time: 17.0,
  previousBest: 17.84,
  isBest: true,
  parTime: 30,
  splits: [5.2, 10.0, 15.4],
  bestSplits: [5.62, 10.31, 15.9],
  hasNext: true,
  topSpeed: 1120,
};

function setView(v: View): void {
  view = v;
  tuning.hide();
  // HUD nur im Spiel und in der Pause — unter Titel/Einstellungen/Ergebnis würde er durchscheinen.
  hud.visible = v === 'hud' || v === 'tuning' || v === 'pause';
  switch (v) {
    case 'hud':
      menu.hide();
      break;
    case 'title':
      menu.showTitle();
      break;
    case 'pause':
      menu.showPause();
      break;
    case 'settings':
      menu.showSettings();
      break;
    case 'controls':
      menu.showControls();
      break;
    case 'finish':
      menu.showFinish(finishResult);
      break;
    case 'tuning':
      menu.hide();
      tuning.show();
      break;
  }
  for (const b of bar.querySelectorAll('button')) b.classList.toggle('on', b.dataset.view === v);
  // HUD sofort mit dem neuen Pausenzustand füttern (dt 0 = nur Daten), auch wenn eingefroren.
  hud.update(0, run.data({ paused: isPausedView(v), showSpeedometer: settings.get().showSpeedometer }));
}

function isPausedView(v: View): boolean {
  return v === 'pause' || v === 'settings' || v === 'controls' || v === 'finish';
}

/** Fake-Lauf deterministisch bis Zeitpunkt t simulieren (60-Hz-Schritte wie ein echter Frame-Takt). */
function simulateTo(t: number): void {
  run.reset();
  hud.clear();
  const step = 1 / 60;
  while (run.t + step <= t + 1e-9) frame(step);
}

function frame(dt: number): void {
  const paused = isPausedView(view);
  for (const e of run.advance(dt)) hud.onEvent(e);
  hud.update(dt, run.data({ paused, showSpeedometer: settings.get().showSpeedometer }));
  if (run.t > FAKE_RUN_LENGTH) {
    run.reset();
  }
}

// FixedLoop auch hier benutzen — die Preview ist gleichzeitig ein Rauchtest für den Loop.
const loop = new FixedLoop({
  tickRate: 60,
  onTick: (dt) => {
    if (!frozen) frame(dt);
  },
  onFrame: (_alpha, _frameDt, now) => {
    for (const a of input.consumeActions()) {
      log.push(`action:${a}`);
      if (menu.visible && menu.handleAction(a)) continue;
      if (a === 'toggleTuning') setView(tuning.visible ? 'hud' : 'tuning');
      // Kein exitLock() nötig: InputManager gibt die Maus bei Esc selbst frei (auch mit Keyboard Lock).
      if (a === 'pause' && view === 'hud') setView('pause');
    }
    paintFakeScene(sceneCtx, LOW_W, LOW_H, frozen ? 0 : now);
    hud.draw();
  },
});

/** Ereignis-Protokoll für Playwright-Checks. */
const log: string[] = [];
let lastLockResult: boolean | null = null;

/** Wie die echte Integration: aus der User-Geste heraus sofort den Lock anfordern. */
function lockFromGesture(): Promise<boolean> {
  const p = input.requestLock();
  menu.trackLock(p, () => input.lockError);
  return p.then((ok) => {
    lastLockResult = ok;
    log.push(`lock:${ok}`);
    return ok;
  });
}

menu.on('play', ({ levelId }) => {
  log.push(`menu:play:${levelId}`);
  void lockFromGesture();
  simulateTo(0);
  setView('hud');
});
menu.on('resume', () => {
  log.push('menu:resume');
  // Wie die Integration: Pause bleibt stehen, bis der Lock wirklich da ist — sonst sähe
  // niemand den Hinweis aus trackLock, wenn der Browser ablehnt.
  void lockFromGesture().then((ok) => {
    if (ok && view === 'pause') setView('hud');
  });
});
menu.on('restart', () => {
  log.push('menu:restart');
  void lockFromGesture();
  simulateTo(0);
  setView('hud');
});
menu.on('toTitle', () => {
  log.push('menu:toTitle');
  setView('title');
});
menu.on('nextLevel', () => {
  log.push('menu:nextLevel');
  void lockFromGesture();
  simulateTo(0);
  setView('hud');
});
menu.on('fullscreen', () => void input.toggleFullscreen());
input.onLockChange((locked) => log.push(`lockchange:${locked}`));
stage.addEventListener('click', () => {
  if (view === 'hud' && !input.locked) void lockFromGesture();
});

// Steuerleiste
for (const [i, v] of VIEWS.entries()) {
  const b = document.createElement('button');
  b.textContent = `${i + 1} ${v}`;
  b.dataset.view = v;
  b.addEventListener('click', () => setView(v));
  bar.appendChild(b);
}
window.addEventListener('keydown', (e) => {
  const n = Number(e.key);
  if (Number.isInteger(n) && n >= 1 && n <= VIEWS.length) setView(VIEWS[n - 1]);
});
// [hidden] verliert gegen display:flex aus dem Stylesheet — daher direkt per Style.
if (params.get('bar') === '0') bar.style.display = 'none';

function layout(): void {
  // Ganzzahlige Skalierung wie im Spiel: jedes Low-Res-Pixel = N×N Bildschirmpixel.
  const k = Math.max(1, Math.floor(Math.min(innerWidth / LOW_W, innerHeight / LOW_H)));
  const w = LOW_W * k;
  const hgt = LOW_H * k;
  stage.style.width = `${w}px`;
  stage.style.height = `${hgt}px`;
  stage.style.left = `${Math.floor((innerWidth - w) / 2)}px`;
  stage.style.top = `${Math.floor((innerHeight - hgt) / 2)}px`;
}
window.addEventListener('resize', layout);
layout();

const startT = Number(params.get('t') ?? '0');
simulateTo(Number.isFinite(startT) ? startT : 0);
const initialView = params.get('view');
setView(isView(initialView) ? initialView : 'hud');
loop.start();

interface UiProbe {
  readonly view: string;
  readonly menuScreen: string | null;
  readonly locked: boolean;
  readonly rawInput: boolean;
  readonly lastLockResult: boolean | null;
  readonly yawDeg: number;
  readonly pitchDeg: number;
  readonly log: readonly string[];
  readonly settings: ReturnType<SettingsStore['get']>;
  readonly tuningVisible: boolean;
  readonly ctrlCrouch: boolean;
  readonly lockPending: boolean;
  readonly selectedLevel: string | null;
}

/** Messung für den Font-Check: Text über Vollfläche zeichnen und Pixel zurücklesen. */
interface TextProbe {
  readonly text: string;
  readonly alpha: number;
  readonly scale: number;
  readonly outline: boolean;
  readonly shadow: boolean;
  readonly color: string;
  readonly bg: string;
}

interface UiPreviewHandle {
  setView(v: string): void;
  simulateTo(t: number): void;
  freeze(on: boolean): void;
  /** Einen Frame zeichnen (nach setView/simulateTo, falls eingefroren). */
  draw(): void;
  probe(): UiProbe;
  /** Eine Tick-Eingabe ziehen (wie die Engine in onTick). */
  tick(i: number, n: number): PlayerInput;
  /** Text mit Stil auf Hintergrund zeichnen, RGBA-Pixel (Zeilen × Spalten) und Breite zurück. */
  probeText(o: TextProbe): { readonly w: number; readonly h: number; readonly px: number[] };
  /** Lock-Rückmeldung im Menü setzen (Screenshots/Checks). */
  lockStatus(st: LockStatus): void;
  /** Eingabe-Hinweis im HUD auslösen (Screenshots). */
  notice(): void;
  /** Messung: ms pro hud.draw() (ohne Szene) und ms für einen kalten Stil (n Zeichen, Skala). */
  bench(frames: number, bakeScale: number): { readonly drawMs: number; readonly coldMs: number; readonly warmMs: number; readonly prewarmMs: number };
  ready: boolean;
}

declare global {
  interface Window {
    __ui?: UiPreviewHandle;
  }
}

window.__ui = {
  setView: (v) => {
    if (isView(v)) setView(v);
  },
  simulateTo,
  freeze: (on) => {
    frozen = on;
  },
  draw: () => {
    paintFakeScene(sceneCtx, LOW_W, LOW_H, 0);
    hud.draw();
  },
  probe: () => ({
    view,
    menuScreen: menu.screen,
    locked: input.locked,
    rawInput: input.rawInput,
    lastLockResult,
    yawDeg: (input.yaw * 180) / Math.PI,
    pitchDeg: (input.pitch * 180) / Math.PI,
    log: [...log],
    settings: settings.get(),
    tuningVisible: tuning.visible,
    ctrlCrouch: input.ctrlCrouch,
    lockPending: input.lockPending,
    selectedLevel: menu.selectedLevelId,
  }),
  tick: (i, n) => {
    // Kopie: tickInput liefert ein wiederverwendetes Objekt.
    const t = input.tickInput(i, n);
    return { ...t };
  },
  probeText: (o) => {
    const size = pixelFont.measure(o.text, o.scale);
    const w = size.width + 24;
    const h = 11 * o.scale + 24;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('2D fehlt');
    ctx.fillStyle = o.bg;
    ctx.fillRect(0, 0, w, h);
    pixelFont.drawText(ctx, o.text, 12, 12 + 2 * o.scale, {
      scale: o.scale,
      color: o.color,
      outline: o.outline,
      shadow: o.shadow,
      alpha: o.alpha,
    });
    return { w, h, px: Array.from(ctx.getImageData(0, 0, w, h).data) };
  },
  lockStatus: (st) => menu.setLockStatus(st),
  notice: () => hud.onInputNotice('ctrlCrouchNeedsFullscreen'),
  bench: (frames, bakeScale) => {
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) hud.draw();
    const drawMs = (performance.now() - t0) / frames;
    const c = document.createElement('canvas');
    c.width = 400;
    c.height = 120;
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('2D fehlt');
    // Eindeutige Farbe → garantiert kalter Stil.
    const color = `#${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')}`;
    const style = { scale: bakeScale, color, outline: true, shadow: true, shadowOffset: bakeScale } as const;
    const t1 = performance.now();
    pixelFont.drawText(ctx, '1234567890', 4, 20, style);
    const coldMs = performance.now() - t1;
    const t2 = performance.now();
    pixelFont.drawText(ctx, '1234567890', 4, 20, style);
    const warmMs = performance.now() - t2;
    // Vorbacken der Speedometer-Palette bei einer noch nicht benutzten Auflösung (Skala 4).
    const t3 = performance.now();
    new Hud().resize(854, 480);
    const prewarmMs = performance.now() - t3;
    return { drawMs, coldMs, warmMs, prewarmMs };
  },
  ready: true,
};

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} fehlt`);
  return el;
}
