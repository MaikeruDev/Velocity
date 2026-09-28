import { NearestFilter, PerspectiveCamera, RGBAFormat, UnsignedByteType, Vector3, WebGLRenderTarget } from 'three';
import type { Scene, WebGLRenderer } from 'three';
import type { ViewModelFrame } from './types';
import type { ViewModel } from './viewmodel/ViewModel';

/**
 * Selfie im Ziel (Plan 007, Handy Stufe 2, KI7): EIN zusätzlicher Welt-Durchgang aus der Kamera des
 * letzten Frames mit Yaw + π (die Handy-Frontkamera schaut zurück auf den Spieler) in w×h (96×54),
 * davor die Hand aus `vm` (zweiter Viewmodel-Durchgang, Peace-Zeichen — ViewHand.selfieFrame()).
 * Danach wie das Spielbild quantisiert: 5 Bit je Kanal mit 4×4-Bayer im Pixelraster (post.ts), auf der
 * CPU — 96×54 = 5184 Pixel. Außerhalb des Frame-Pfads, einmal im Ziel (Timer steht): hier darf
 * allokiert werden (Canvas, ImageData); Ziel-Target und Kamera werden wiederverwendet.
 */
export interface SelfieContext {
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  /** Kamera des letzten render() (null = noch kein Bild). */
  readonly camera: PerspectiveCamera | null;
  readonly viewModel: ViewModel;
}

/** Messwerte des letzten Selfies (Tools: genau 1 Welt- und 1 Viewmodel-Durchgang, Dauer). */
export interface SelfieStats {
  worldPasses: number;
  viewModelPasses: number;
  ms: number;
  width: number;
  height: number;
}

export const selfieStats: SelfieStats = { worldPasses: 0, viewModelPasses: 0, ms: 0, width: 0, height: 0 };

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const LEVELS = 31;
const UP = new Vector3(0, 1, 0);

let target: WebGLRenderTarget | null = null;
let pixels: Uint8Array | null = null;
const cam = new PerspectiveCamera();

function ensureTarget(w: number, h: number): WebGLRenderTarget {
  if (target && target.width === w && target.height === h) return target;
  target?.dispose();
  target = new WebGLRenderTarget(w, h, { minFilter: NearestFilter, magFilter: NearestFilter, generateMipmaps: false, depthBuffer: true, stencilBuffer: false, format: RGBAFormat, type: UnsignedByteType });
  pixels = new Uint8Array(w * h * 4);
  return target;
}

export function renderSelfie(ctx: SelfieContext, wRaw: number, hRaw: number, vm: ViewModelFrame): HTMLCanvasElement | null {
  const last = ctx.camera;
  if (!last || typeof document === 'undefined') return null;
  const w = Math.max(8, Math.min(512, Math.round(Number.isFinite(wRaw) ? wRaw : 96)));
  const h = Math.max(8, Math.min(512, Math.round(Number.isFinite(hRaw) ? hRaw : 54)));
  const t0 = performance.now();
  const r = ctx.renderer;
  const rt = ensureTarget(w, h);
  const buf = pixels;
  if (!buf) return null;
  // Rückansicht: gleiche Position, um die Welt-Hochachse um π gedreht (Blick zurück, Neigung bleibt).
  cam.copy(last, false);
  cam.rotateOnWorldAxis(UP, Math.PI);
  cam.aspect = w / h;
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);
  const prevTarget = r.getRenderTarget();
  r.setRenderTarget(rt);
  r.render(ctx.scene, cam);
  selfieStats.worldPasses = 1;
  // Zweiter Viewmodel-Durchgang in Selfie-Auflösung (Kontur in Low-Res-Pixeln), danach zurück.
  selfieStats.viewModelPasses = 0;
  const v = ctx.viewModel;
  if (vm.visible) {
    const pw = v.resolutionWidth;
    const ph = v.resolutionHeight;
    v.setResolution(w, h);
    v.apply(vm);
    v.render(r);
    v.setResolution(pw, ph);
    selfieStats.viewModelPasses = 1;
  }
  r.readRenderTargetPixels(rt, 0, 0, w, h, buf);
  r.setRenderTarget(prevTarget);
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const c2 = out.getContext('2d');
  if (!c2) return null;
  const img = c2.createImageData(w, h);
  const d = img.data;
  // GL liest von unten nach oben; quantisieren wie post.ts: floor(c·31 + bayer)/31.
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * w * 4;
    const dst = y * w * 4;
    for (let x = 0; x < w; x++) {
      const b = (BAYER4[(x & 3) + ((y & 3) << 2)] + 0.5) / 16;
      for (let k = 0; k < 3; k++) {
        const q = Math.min(LEVELS, Math.floor((buf[src + x * 4 + k] / 255) * LEVELS + b));
        d[dst + x * 4 + k] = Math.round((q / LEVELS) * 255);
      }
      d[dst + x * 4 + 3] = 255;
    }
  }
  c2.putImageData(img, 0, 0);
  selfieStats.ms = performance.now() - t0;
  selfieStats.width = w;
  selfieStats.height = h;
  return out;
}
