import { PerspectiveCamera, Vector3 } from 'three';
import { compileLevel, loadLevel } from '../../world/level/compileLevel';
import type { CompiledLevel } from '../../world/level/compileLevel';
import { materialGallery } from './materialGallery';
import { PS2Renderer } from '../PS2Renderer';
import type { RenderStats } from '../PS2Renderer';
import { DEFAULT_RENDER_SETTINGS } from '../types';
import type { RenderFx, RenderSettings } from '../types';

/**
 * Dev-Vorschau des Renderers ohne Spiel: dev/render.html?level=sandbox&pos=0,64,200&yaw=0&pitch=-5
 *
 * Query:
 *   level, pos=x,y,z (Augenposition), yaw/pitch (Grad, three-Konvention: yaw 0 = −Z),
 *   fly=1 (langsamer Flug entlang yaw), speed (speed01), t (feste Zeit → reproduzierbar),
 *   kick (fest), energy, flash, fade, ph (pixelHeight), bits, dither=0, affine, snap, ca, scan,
 *   hud=1 (Test-HUD), fov (horizontal bei 4:3, Default 90).
 * Setzt window.__renderReady nach dem ersten Frame, window.__renderStats laufend,
 * window.__renderBench(n) misst ms/Frame mit GPU-Sync.
 */

declare global {
  interface Window {
    __renderReady?: boolean;
    __renderError?: string;
    __renderStats?: RenderStats & { lowW: number; lowH: number; scale: number };
    __renderBench?: (frames: number) => number;
    /** Einstellungen live ändern (Test für setSettings, z. B. pixelHeight). */
    __renderSet?: (patch: Partial<RenderSettings>) => void;
    /** Level n-mal neu setzen (Leck-Test für setLevel/dispose). */
    __renderReload?: (times: number) => Promise<void>;
    /** Dauer von renderer.setLevel (Tesselierung, Trims, AO) in ms. */
    __renderLoadMs?: number;
    /** Zweite Instanz bauen, rendern, entsorgen — prüft den kompletten Lebenszyklus. */
    __renderDisposeTest?: () => boolean;
    /** Kamera setzen, synchron rendern und prüfen, ob eine Weltkante als durchgehende Linie im Bild steht. */
    __renderEdgeCoverage?: (probe: EdgeProbe) => EdgeCoverage;
  }
}

/** Abfrage für __renderEdgeCoverage (Trim-Lesbarkeit, tools/shoot-render.mjs --trim-sweep). */
export interface EdgeProbe {
  readonly pos: readonly [number, number, number];
  readonly yaw: number;
  readonly pitch: number;
  readonly a: readonly [number, number, number];
  readonly b: readonly [number, number, number];
  /** Erwartete Trim-Farbe (Hex); Treffer = Farbton ähnlich und hell genug. */
  readonly color: string;
  /** Zeilen ober-/unterhalb der projizierten Kante, die durchsucht werden. */
  readonly rows?: number;
  /** Spalten an beiden Enden, die ausgelassen werden (Ecken, Snapping). */
  readonly margin?: number;
  /** Fehlende Spalten mit Pixelwerten zurückgeben (Fehlersuche). */
  readonly debug?: boolean;
}

export interface EdgeCoverage {
  readonly columns: number;
  readonly hits: number;
  /** Längste Folge fehlender Spalten. */
  readonly maxGap: number;
  /** Anzahl der Spalten, in denen die Linie mehr als eine Zeile dick ist (bei steilen Kanten: Zeilen/Spalten vertauscht). */
  readonly thick: number;
  /** Nur mit debug: je fehlender Spalte "s@c: r,g,b | …" über die durchsuchten Pixel. */
  readonly misses?: string[];
}

const q = new URLSearchParams(location.search);
const num = (key: string, def: number): number => {
  const v = q.get(key);
  if (v === null || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};
const vec = (key: string, def: [number, number, number]): [number, number, number] => {
  const v = q.get(key);
  if (!v) return def;
  const parts = v.split(',').map(Number);
  return parts.length === 3 && parts.every(Number.isFinite) ? [parts[0], parts[1], parts[2]] : def;
};

const DEG = Math.PI / 180;

async function main(): Promise<void> {
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  const renderer = new PS2Renderer(canvas);

  const settings: RenderSettings = {
    ...DEFAULT_RENDER_SETTINGS,
    pixelHeight: num('ph', DEFAULT_RENDER_SETTINGS.pixelHeight),
    colorBits: num('bits', DEFAULT_RENDER_SETTINGS.colorBits),
    dither: q.get('dither') !== '0',
    affine: num('affine', DEFAULT_RENDER_SETTINGS.affine),
    vertexSnap: num('snap', DEFAULT_RENDER_SETTINGS.vertexSnap),
    chromatic: num('ca', DEFAULT_RENDER_SETTINGS.chromatic),
    scanlines: num('scan', DEFAULT_RENDER_SETTINGS.scanlines),
  };
  renderer.setSettings(settings);
  renderer.resize(window.innerWidth, window.innerHeight);
  window.addEventListener('resize', () => renderer.resize(window.innerWidth, window.innerHeight));

  const levelId = q.get('level') ?? 'sandbox';
  const load = async (): Promise<CompiledLevel> =>
    levelId === '__materials' ? compileLevel(materialGallery()) : loadLevel(`/levels/${levelId}.json`);
  const level = await load();
  const tLoad = performance.now();
  renderer.setLevel(level);
  window.__renderLoadMs = performance.now() - tLoad;

  // Hor+: vertikales FOV aus 90° horizontal bei 4:3.
  const hfov = num('fov', 90);
  const vfov = (2 * Math.atan(Math.tan((hfov * DEG) / 2) * 0.75)) / DEG;
  const camera = new PerspectiveCamera(vfov, renderer.aspect, 2, 40000);
  const sp = level.spawnPos;
  const start = vec('pos', [sp.x, sp.y + 64, sp.z]);
  const yaw = num('yaw', level.spawnYaw) * DEG;
  const pitch = num('pitch', 0) * DEG;
  camera.position.set(start[0], start[1], start[2]);
  camera.rotation.set(pitch, yaw, 0, 'YXZ');

  let hud: HTMLCanvasElement | null = null;
  let hudCtx: CanvasRenderingContext2D | null = null;
  if (q.get('hud') === '1') {
    hud = document.createElement('canvas');
    hudCtx = hud.getContext('2d');
    renderer.setHud(hud);
  }

  const fixedTime = q.get('t');
  const fly = q.get('fly') === '1';
  const speed01 = num('speed', 0);
  const kickFixed = q.get('kick');
  const energy = num('energy', 0.5);
  const flashColor: [number, number, number] = [1, 0.85, 0.3];
  const fx = {
    time: 0,
    speed01,
    kick: 0,
    energy,
    flash: num('flash', 0),
    flashColor,
    fade: num('fade', 0),
  };
  const t0 = performance.now();

  const drawHud = (): void => {
    if (!hud || !hudCtx) return;
    if (hud.width !== renderer.lowResWidth || hud.height !== renderer.lowResHeight) {
      hud.width = renderer.lowResWidth;
      hud.height = renderer.lowResHeight;
    }
    const c = hudCtx;
    c.clearRect(0, 0, hud.width, hud.height);
    c.fillStyle = 'rgba(10,6,24,0.6)';
    c.fillRect(hud.width / 2 - 40, hud.height - 30, 80, 18);
    c.fillStyle = '#ffffff';
    c.fillRect(Math.floor(hud.width / 2), Math.floor(hud.height / 2) - 3, 1, 7);
    c.fillRect(Math.floor(hud.width / 2) - 3, Math.floor(hud.height / 2), 7, 1);
    c.fillStyle = '#33f0ff';
    c.font = '10px monospace';
    c.fillText(`${Math.round(250 + speed01 * 850)} u/s`, hud.width / 2 - 26, hud.height - 17);
  };

  const frame = (): void => {
    const now = (performance.now() - t0) / 1000;
    fx.time = fixedTime !== null ? Number(fixedTime) : now;
    const beat = (fx.time * 132) / 60;
    const phase = beat - Math.floor(beat);
    fx.kick = kickFixed !== null ? Number(kickFixed) : Math.exp(-phase * 7);
    if (fly && fixedTime === null) {
      const d = 180 * now;
      camera.position.set(start[0] - Math.sin(yaw) * d, start[1], start[2] - Math.cos(yaw) * d);
    }
    drawHud();
    const rfx: RenderFx = fx;
    renderer.render(camera, rfx);
    window.__renderStats = {
      ...renderer.stats,
      lowW: renderer.lowResWidth,
      lowH: renderer.lowResHeight,
      scale: renderer.pixelScale,
    };
    if (!window.__renderReady) {
      // Erst nach einem zweiten rAF gilt der Frame als sicher präsentiert.
      requestAnimationFrame(() => {
        window.__renderReady = true;
      });
    }
    requestAnimationFrame(frame);
  };

  window.__renderBench = (frames: number): number => {
    const gl = canvas.getContext('webgl2');
    const px = new Uint8Array(4);
    const tStart = performance.now();
    for (let i = 0; i < frames; i++) {
      fx.time += 1 / 144;
      renderer.render(camera, fx);
      // readPixels erzwingt, dass die GPU wirklich fertig ist (gl.finish ist in Chrome kein Sync).
      gl?.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    }
    return (performance.now() - tStart) / frames;
  };

  let current = settings;
  window.__renderSet = (patch: Partial<RenderSettings>): void => {
    current = { ...current, ...patch };
    renderer.setSettings(current);
  };
  window.__renderReload = async (times: number): Promise<void> => {
    for (let i = 0; i < times; i++) {
      renderer.setLevel(await load());
      renderer.render(camera, fx);
    }
  };

  const probeGl = canvas.getContext('webgl2');
  const probeVec = new Vector3();
  let probePx = new Uint8Array(0);
  window.__renderEdgeCoverage = (probe: EdgeProbe): EdgeCoverage => {
    camera.position.set(probe.pos[0], probe.pos[1], probe.pos[2]);
    camera.rotation.set(probe.pitch * DEG, probe.yaw * DEG, 0, 'YXZ');
    renderer.render(camera, fx);
    const w = renderer.lowResWidth;
    const h = renderer.lowResHeight;
    if (probePx.length !== w * h * 4) probePx = new Uint8Array(w * h * 4);
    // Direkt nach render(): der Drawing-Buffer ist bis zum Compositing gültig.
    probeGl?.readPixels(0, 0, w, h, probeGl.RGBA, probeGl.UNSIGNED_BYTE, probePx);
    const toPx = (p: readonly [number, number, number]): [number, number] => {
      probeVec.set(p[0], p[1], p[2]).project(camera);
      return [(probeVec.x * 0.5 + 0.5) * w, (probeVec.y * 0.5 + 0.5) * h];
    };
    const [ax, ay] = toPx(probe.a);
    const [bx, by] = toPx(probe.b);
    const n = probe.color.replace('#', '');
    const cr = Number.parseInt(n.slice(0, 2), 16) / 255;
    const cg = Number.parseInt(n.slice(2, 4), 16) / 255;
    const cb = Number.parseInt(n.slice(4, 6), 16) / 255;
    const cl = Math.hypot(cr, cg, cb);
    const rows = probe.rows ?? 3;
    const margin = probe.margin ?? 2;
    // Entlang der Hauptachse der projizierten Kante laufen, quer dazu ±rows suchen.
    const steep = Math.abs(by - ay) > Math.abs(bx - ax);
    const a0 = steep ? ay : ax;
    const a1 = steep ? by : bx;
    const b0 = steep ? ax : ay;
    const b1 = steep ? bx : by;
    const limitMain = steep ? h : w;
    const limitCross = steep ? w : h;
    const s0 = Math.ceil(Math.min(a0, a1)) + margin;
    const s1 = Math.floor(Math.max(a0, a1)) - margin;
    let columns = 0;
    let hits = 0;
    let gap = 0;
    let maxGap = 0;
    let thick = 0;
    const misses: string[] = [];
    for (let s = Math.max(0, s0); s <= Math.min(limitMain - 1, s1); s++) {
      const t = Math.abs(a1 - a0) < 1e-6 ? 0 : (s + 0.5 - a0) / (a1 - a0);
      const cc = Math.floor(b0 + (b1 - b0) * t);
      let found = 0;
      let dump = '';
      for (let k = cc - rows; k <= cc + rows; k++) {
        if (k < 0 || k >= limitCross) continue;
        const x = steep ? k : s;
        const y = steep ? s : k;
        const i = (y * w + x) * 4;
        const r = probePx[i] / 255;
        const g = probePx[i + 1] / 255;
        const b = probePx[i + 2] / 255;
        const l = Math.hypot(r, g, b);
        if (probe.debug) dump += `${k}:${probePx[i]},${probePx[i + 1]},${probePx[i + 2]} `;
        // Farbton (Kosinus) statt Abstand: Puls, Kern-Weiß und Fog ändern die Helligkeit.
        // Reines Weiß zählt mit: Kern-Weiß plus additive Trigger-Säule sättigen dort.
        const white = r > 0.94 && g > 0.94 && b > 0.94;
        if (white || (l > 0.45 * cl && (r * cr + g * cg + b * cb) / (l * cl) > 0.965)) found++;
      }
      columns++;
      if (found > 0) {
        hits++;
        gap = 0;
        if (found > 1) thick++;
      } else {
        gap++;
        maxGap = Math.max(maxGap, gap);
        if (probe.debug) misses.push(`${s}@${cc.toFixed(0)} ${dump}`);
      }
    }
    return probe.debug ? { columns, hits, maxGap, thick, misses } : { columns, hits, maxGap, thick };
  };

  window.__renderDisposeTest = (): boolean => {
    const c = document.createElement('canvas');
    const r2 = new PS2Renderer(c);
    r2.setHud(document.createElement('canvas'));
    r2.setLevel(level);
    r2.render(camera, fx);
    r2.dispose();
    r2.render(camera, fx); // nach dispose: stiller No-Op
    return true;
  };

  requestAnimationFrame(frame);
}

main().catch((e: unknown) => {
  window.__renderError = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
  console.error(e);
});
