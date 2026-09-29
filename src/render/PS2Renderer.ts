import {
  Group,
  Mesh,
  NearestFilter,
  RGBAFormat,
  Scene,
  UnsignedByteType,
  WebGLRenderTarget,
  WebGLRenderer,
} from 'three';
import type { BufferGeometry, PerspectiveCamera, ShaderMaterial, Vector3 } from 'three';
import type { CompiledLevel } from '../world/level/compileLevel';
import type { MaterialId } from '../world/level/LevelFormat';
import { buildLevelMeshes } from './levelMesh';
import { computeLowRes } from './lowres';
import type { LowResLayout } from './lowres';
import { createSharedUniforms } from './materials/shared';
import type { SharedUniforms } from './materials/shared';
import { createGhostGeometry, createGhostMaterial } from './materials/ghostMaterial';
import { createTrimMaterial } from './materials/trimMaterial';
import { createWorldMaterial } from './materials/worldMaterial';
import { PostPass } from './post';
import { SkyLayers } from './sky';
import { TextureLibrary } from './textures';
import { buildTriggerGeometry, createTriggerMaterial } from './triggerVisuals';
import { applyGateOpen, buildGateGeometry, createGateMaterial } from './gateVisuals';
import { buildTrims } from './trims';
import { DEFAULT_RENDER_SETTINGS } from './types';
import type { RenderFx, RendererApi, RenderSettings, ViewModelFrame, ViewModelGlove, ViewModelItem } from './types';
import { renderSelfie } from './selfie';
import { ViewModel } from './viewmodel/ViewModel';
import { clamp01, setVecFromHex } from './util';
import { VoidGrid } from './voidGrid';

export interface RenderStats {
  /** Draw-Calls des Szenen-Passes (ohne den einen Post-Pass). */
  readonly sceneCalls: number;
  /** Draw-Calls des Viewmodel-Passes im letzten Frame (0 = keine Hand). Budget Plan 007: ≤ 50. */
  readonly viewModelCalls: number;
  /** Dreiecke des Viewmodel-Passes im letzten Frame. Budget Plan 007: ≤ 12 000. */
  readonly viewModelTriangles: number;
  readonly sceneTriangles: number;
  readonly levelTriangles: number;
  /** GPU-Ressourcen laut three.js (Leck-Kontrolle bei Level-Wechseln). */
  readonly geometries: number;
  readonly textures: number;
  readonly programs: number;
}

/** Zuletzt erzeugter Renderer — nur für das Debug-Handle (__vel.snapshot/renderStats). */
let active: PS2Renderer | null = null;

/** Debug/Tools: der laufende Renderer (null = keiner). Nicht im Spielcode benutzen. */
export function debugRenderer(): PS2Renderer | null {
  return active;
}

/** Tempostufe: Sekunden pro Stufe beim Hoch- bzw. Runterblenden der Trim-Farbe. */
const TIER_UP = 0.1;
const TIER_DOWN = 0.4;
/** Aufblitz beim Hochschalten; erneut erst, wenn die Stufe länger weg war (kein Flackern an der Schwelle). */
const TIER_FLASH = 0.12;
const TIER_MEMORY = 1.5;

/**
 * PS2-Pipeline (siehe .docs/rules/look.md):
 * Szene → Low-Res-RenderTarget (Nearest, Tiefe) → Post-Pass in den Canvas,
 * der selbst Low-Res groß ist und per CSS ganzzahlig hochskaliert wird.
 *
 * Lebenszyklus: new → resize() → setLevel() → pro Frame render() → dispose().
 * setSettings()/setHud()/resize()/setGhost() dürfen jederzeit aufgerufen werden.
 * `settings.lowLatency` wirkt nur im Konstruktor (Kontext-Attribute sind fest).
 */
export class PS2Renderer implements RendererApi {
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: WebGLRenderer;
  private readonly shared: SharedUniforms = createSharedUniforms();
  private readonly textures = new TextureLibrary();
  private readonly worldMaterials = new Map<MaterialId, ShaderMaterial>();
  private readonly trimMaterial: ShaderMaterial;
  private readonly triggerMaterial: ShaderMaterial;
  /** Tore einer Lektion (Plan 007): ein Mesh für alle, Auflösen über RenderFx.gateOpen. */
  private readonly gateMaterial: ShaderMaterial;
  private gateMesh: Mesh | null = null;
  private gateCount = 0;
  private readonly scene = new Scene();
  private readonly levelGroup = new Group();
  private readonly sky: SkyLayers;
  private readonly voidGrid: VoidGrid;
  private readonly post: PostPass;
  private readonly target: WebGLRenderTarget;
  private readonly ghost: Mesh;
  private readonly ghostMaterial: ShaderMaterial;
  /** View-Hand (Plan 006): eigene Szene/Kamera, nach der Welt ins selbe Target. */
  private readonly viewModel = new ViewModel();
  private lastVmCalls = 0;
  private lastVmTriangles = 0;
  /** HUD-Canvas (für das Foto ohne HUD) und Kamera des letzten Bildes (Selfie). */
  private hudCanvas: HTMLCanvasElement | null = null;
  private lastCamera: PerspectiveCamera | null = null;
  /** Niedrige Latenz aktiv (desynchronized-Kontext, beim Erzeugen festgelegt). */
  readonly lowLatency: boolean;
  private settings: RenderSettings = DEFAULT_RENDER_SETTINGS;
  // Zustand der Frame-Effekte (aus RenderFx abgeleitet, keine Allokation).
  private lastFxTime = Number.NaN;
  private tierSmooth = 0;
  private tierMemory = 0;
  private tierFlashT = TIER_FLASH;
  private prevKick = 0;
  private kickTime = -1e6;
  private cssWidth = 0;
  private cssHeight = 0;
  private layout: LowResLayout;
  private levelTriangles = 0;
  private lastCalls = 0;
  private lastTriangles = 0;
  private disposed = false;

  /** `settings`: Startwerte (fehlende Felder = Default); `lowLatency` wird nur hier gelesen. */
  constructor(canvas: HTMLCanvasElement, settings: Partial<RenderSettings> = {}) {
    this.canvas = canvas;
    const initial: RenderSettings = { ...DEFAULT_RENDER_SETTINGS, ...settings };
    // Niedrige Latenz: Kontext selbst anlegen, damit `desynchronized` gesetzt werden kann
    // (three.js reicht es nicht durch). Übrige Attribute wie im three-Pfad; alpha false
    // ist dort ohnehin der Clear-Modus — das Bild ist identisch (tools/shoot-render --fx r4).
    let context: WebGL2RenderingContext | undefined;
    if (initial.lowLatency === true) {
      context =
        canvas.getContext('webgl2', {
          desynchronized: true,
          antialias: false,
          alpha: false,
          depth: false,
          stencil: false,
          premultipliedAlpha: true,
          preserveDrawingBuffer: false,
          powerPreference: 'high-performance',
        }) ?? undefined;
    }
    this.lowLatency = context !== undefined;
    this.renderer = new WebGLRenderer({
      canvas,
      context,
      antialias: false,
      powerPreference: 'high-performance',
      alpha: false,
      depth: false,
      stencil: false,
    });
    this.renderer.setPixelRatio(1);
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.sortObjects = true;

    this.target = new WebGLRenderTarget(1, 1, {
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      generateMipmaps: false,
      depthBuffer: true,
      stencilBuffer: false,
      format: RGBAFormat,
      type: UnsignedByteType,
      samples: 0,
    });

    this.scene.matrixWorldAutoUpdate = true;
    this.scene.add(this.levelGroup);
    this.sky = new SkyLayers(this.scene, this.shared);
    this.voidGrid = new VoidGrid(this.scene, this.shared);
    this.trimMaterial = createTrimMaterial(this.shared);
    this.triggerMaterial = createTriggerMaterial(this.shared);
    this.gateMaterial = createGateMaterial(this.shared);
    this.post = new PostPass(this.target.texture);
    this.ghostMaterial = createGhostMaterial(this.shared);
    this.ghost = new Mesh(createGhostGeometry(), this.ghostMaterial);
    this.ghost.name = 'ghost';
    this.ghost.visible = false;
    // Nach den Trims, vor den Trigger-Säulen (die blenden additiv über alles).
    this.ghost.renderOrder = 2;
    this.scene.add(this.ghost);

    canvas.style.imageRendering = 'pixelated';
    canvas.style.position = 'fixed';
    canvas.style.display = 'block';

    const w = typeof window !== 'undefined' ? window.innerWidth : 960;
    const h = typeof window !== 'undefined' ? window.innerHeight : 540;
    this.settings = initial;
    this.layout = computeLowRes(w, h, this.settings.pixelHeight, 1);
    this.resize(w, h);
    this.setSettings(initial);
    active = this;
  }

  get lowResWidth(): number {
    return this.layout.lowW;
  }

  get lowResHeight(): number {
    return this.layout.lowH;
  }

  /** Seitenverhältnis des Low-Res-Bildes (lowW/lowH). render() setzt camera.aspect selbst darauf. */
  get aspect(): number {
    return this.layout.lowW / this.layout.lowH;
  }

  /** Ganzzahliger Faktor Low-Res-Pixel → Geräte-Pixel. */
  get pixelScale(): number {
    return this.layout.scale;
  }

  get stats(): RenderStats {
    const info = this.renderer.info;
    return {
      sceneCalls: this.lastCalls,
      viewModelCalls: this.lastVmCalls,
      viewModelTriangles: this.lastVmTriangles,
      sceneTriangles: this.lastTriangles,
      levelTriangles: this.levelTriangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs?.length ?? 0,
    };
  }

  setLevel(level: CompiledLevel): void {
    this.clearLevel();
    const env = level.def.environment;
    const s = this.shared;
    setVecFromHex(s.uFogColor.value, env.fogColor);
    s.uFogNear.value = env.fogNear;
    s.uFogFar.value = env.fogFar;
    s.uSunDir.value.set(...env.sunDir);
    if (s.uSunDir.value.lengthSq() < 1e-8) s.uSunDir.value.set(0, 1, 0);
    s.uSunDir.value.normalize();
    setVecFromHex(s.uSunColor.value, env.sunColor);
    setVecFromHex(s.uAmbSky.value, env.ambientSky);
    setVecFromHex(s.uAmbGround.value, env.ambientGround);
    setVecFromHex(s.uTrimBase.value, env.trimColor);
    setVecFromHex(s.uTrimAlt.value, env.trimColorAlt ?? env.trimColor);
    this.post.setStreakColor(env.trimColor);
    // Ghost in der Zweitfarbe, aufgehellt: hebt sich von den Trims der Route ab.
    const gc = this.ghostMaterial.uniforms.uGhostColor.value as Vector3;
    setVecFromHex(gc, env.trimColorAlt ?? env.trimColor)
      .multiplyScalar(0.75)
      .addScalar(0.25);
    this.ghost.visible = false;
    this.sky.setEnvironment(env);
    this.voidGrid.setEnvironment(env);
    this.viewModel.setEnvironment(env);

    const meshes = buildLevelMeshes(level);
    this.levelTriangles = meshes.triangleCount;
    for (const [mat, geometry] of meshes.byMaterial) {
      const mesh = new Mesh(geometry, this.worldMaterial(mat));
      mesh.matrixAutoUpdate = false;
      mesh.name = `world:${mat}`;
      this.levelGroup.add(mesh);
    }

    const trims = buildTrims(level);
    if (trims) {
      const mesh = new Mesh(trims, this.trimMaterial);
      mesh.matrixAutoUpdate = false;
      mesh.name = 'trims';
      // Nach der Welt zeichnen: polygonOffset gewinnt dann sicher gegen die Fläche darunter.
      mesh.renderOrder = 1;
      this.levelGroup.add(mesh);
    }

    const triggers = buildTriggerGeometry(level);
    if (triggers) {
      const mesh = new Mesh(triggers, this.triggerMaterial);
      mesh.matrixAutoUpdate = false;
      mesh.name = 'triggers';
      mesh.renderOrder = 5;
      this.levelGroup.add(mesh);
    }

    // Tore (Plan 007): nur in Lektionen — ohne Tore kein Mesh, das Bild bleibt pixelgleich.
    const gates = buildGateGeometry(level, env.trimColor);
    if (gates) {
      const mesh = new Mesh(gates, this.gateMaterial);
      mesh.matrixAutoUpdate = false;
      mesh.name = 'gates';
      // Nach den Trigger-Säulen: beide additiv, das Tor ist das Nähere.
      mesh.renderOrder = 6;
      this.levelGroup.add(mesh);
      this.gateMesh = mesh;
      this.gateCount = level.gates.length;
    }
  }

  setSettings(s: RenderSettings): void {
    const pixelChanged = s.pixelHeight !== this.settings.pixelHeight;
    this.settings = s;
    this.shared.uAffine.value = Math.max(0, Math.min(1, s.affine));
    this.shared.uSnap.value = Math.max(0, Math.min(1, s.vertexSnap));
    this.post.setSettings(s);
    if (pixelChanged) this.applyLayout();
  }

  resize(width: number, height: number): void {
    this.cssWidth = Math.max(1, width);
    this.cssHeight = Math.max(1, height);
    this.applyLayout();
  }

  setHud(canvas: HTMLCanvasElement | null): void {
    this.hudCanvas = canvas;
    this.post.setHud(canvas);
  }

  setGhost(pos: Vector3 | null, yaw: number): void {
    if (!pos) {
      this.ghost.visible = false;
      return;
    }
    this.ghost.position.copy(pos);
    this.ghost.rotation.set(0, yaw, 0);
    this.ghost.visible = true;
  }

  render(camera: PerspectiveCamera, fx: RenderFx): void {
    if (this.disposed) return;
    const aspect = this.aspect;
    if (Math.abs(camera.aspect - aspect) > 1e-6) {
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld();
    this.lastCamera = camera;

    const s = this.shared;
    s.uTime.value = fx.time;
    s.uKick.value = fx.kick;
    s.uEnergy.value = fx.energy;
    s.uPulse.value = 0.75 + 0.25 * fx.kick + 0.12 * fx.energy;
    this.updateFlow(fx);
    this.sky.update(camera);
    this.voidGrid.update(camera.far);
    this.post.update(fx);
    // Aufgelöste Tore gar nicht mehr zeichnen (kein leerer Draw-Call hinter jedem offenen Tor).
    if (this.gateMesh) this.gateMesh.visible = applyGateOpen(this.gateMaterial, fx.gateOpen, this.gateCount);

    const r = this.renderer;
    r.setRenderTarget(this.target);
    r.render(this.scene, camera);
    this.lastCalls = r.info.render.calls;
    this.lastTriangles = r.info.render.triangles;
    const vm = fx.viewModel;
    if (vm && vm.visible) {
      this.viewModel.setTime(fx.time);
      this.viewModel.setKick(fx.kick);
      this.viewModel.apply(vm);
      this.viewModel.render(r);
      this.lastVmCalls = r.info.render.calls;
      this.lastVmTriangles = r.info.render.triangles;
    } else {
      this.lastVmCalls = 0;
      this.lastVmTriangles = 0;
    }
    r.setRenderTarget(null);
    r.render(this.post.scene, this.post.camera);
  }

  prewarmViewModel(item: ViewModelItem, glove: ViewModelGlove): void {
    if (this.disposed) return;
    this.viewModel.prewarm(this.renderer, item, glove);
  }

  /**
   * Ziel-Foto (Plan 007 K7): Kopie des zuletzt gerenderten Low-Res-Bilds (Welt + Hand, gedithert),
   * OHNE HUD — auf w×h, Seitenverhältnis per Beschnitt (Mitte), Nearest. Außerhalb des Frame-Pfads:
   * der Post-Pass läuft einmal ohne HUD in den Canvas, wird sofort kopiert (gleicher Task, der
   * Zeichenpuffer ist noch gültig) und danach mit HUD wiederholt, damit der Frame unverändert bleibt.
   */
  snapshot(w: number, h: number): HTMLCanvasElement | null {
    if (this.disposed || this.lastCamera === null || typeof document === 'undefined') return null;
    const W = Math.max(1, Math.round(Number.isFinite(w) ? w : this.layout.lowW));
    const H = Math.max(1, Math.round(Number.isFinite(h) ? h : this.layout.lowH));
    const out = document.createElement('canvas');
    out.width = W;
    out.height = H;
    const ctx = out.getContext('2d');
    if (!ctx) return null;
    const r = this.renderer;
    const hud = this.hudCanvas;
    if (hud) this.post.setHud(null);
    r.setRenderTarget(null);
    r.render(this.post.scene, this.post.camera);
    const lw = this.layout.lowW;
    const lh = this.layout.lowH;
    const want = W / H;
    let sw = lw;
    let sh = lh;
    if (lw / lh > want) sw = Math.round(lh * want);
    else sh = Math.round(lw / want);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.canvas, Math.floor((lw - sw) / 2), Math.floor((lh - sh) / 2), sw, sh, 0, 0, W, H);
    if (hud) {
      this.post.setHud(hud);
      r.render(this.post.scene, this.post.camera);
    }
    return out;
  }

  /**
   * Selfie (Plan 007 KI7/I3): delegiert an render/selfie.ts — ein Welt- und ein Viewmodel-Durchgang aus der
   * Kamera des letzten render() (Rückansicht), 5 Bit + Bayer. Game ruft es im Ziel mit Handy (FinishResult.photo).
   */
  selfie(w: number, h: number, vm: ViewModelFrame): HTMLCanvasElement | null {
    if (this.disposed) return null;
    return renderSelfie({ renderer: this.renderer, scene: this.scene, camera: this.lastCamera, viewModel: this.viewModel }, w, h, vm);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (active === this) active = null;
    this.clearLevel();
    this.viewModel.dispose();
    for (const m of this.worldMaterials.values()) m.dispose();
    this.worldMaterials.clear();
    this.trimMaterial.dispose();
    this.triggerMaterial.dispose();
    this.gateMaterial.dispose();
    this.ghost.geometry.dispose();
    this.ghostMaterial.dispose();
    this.sky.dispose();
    this.voidGrid.dispose();
    this.post.dispose();
    this.textures.dispose();
    this.target.dispose();
    this.renderer.dispose();
  }

  // ---------- intern ----------

  /**
   * Flow-Uniforms aus RenderFx: Landewelle, weich übergeblendete Tempostufe mit
   * Aufblitz, Kick-Einsatz für die Gitter-Welle. Standbild/Zeitsprung (dt ≤ 0 oder
   * > 0.25 s) übernimmt die Stufe direkt — auch damit Test-Harnesses mit fester
   * Zeit reproduzierbar sind.
   */
  private updateFlow(fx: RenderFx): void {
    const s = this.shared;
    const dt = fx.time - this.lastFxTime;
    this.lastFxTime = fx.time;
    const live = dt > 0 && dt < 0.25;

    const power = fx.landPower ?? 0;
    if (power > 0 && fx.landPos) {
      s.uLandPos.value.copy(fx.landPos);
      s.uLandTime.value = fx.landTime ?? fx.time;
      s.uLandPower.value = clamp01(power);
    } else s.uLandPower.value = 0;

    const tier = Math.max(0, Math.min(3, fx.speedTier ?? 0));
    if (!live) {
      this.tierSmooth = tier;
      this.tierMemory = tier;
      this.tierFlashT = TIER_FLASH;
    } else {
      if (tier > this.tierSmooth) this.tierSmooth = Math.min(tier, this.tierSmooth + dt / TIER_UP);
      else this.tierSmooth = Math.max(tier, this.tierSmooth - dt / TIER_DOWN);
      if (tier > this.tierMemory + 0.5) this.tierFlashT = 0;
      this.tierMemory = Math.max(tier, this.tierMemory - dt / TIER_MEMORY);
      this.tierFlashT += dt;
    }
    s.uSpeedTier.value = this.tierSmooth;
    s.uTierFlash.value = Math.max(0, 1 - this.tierFlashT / TIER_FLASH);

    // Kick-Einsatz: die Hüllkurve springt beim Schlag hoch und fällt dann ab.
    if (fx.kick > this.prevKick + 0.15 && fx.kick > 0.3) this.kickTime = fx.time;
    this.prevKick = fx.kick;
    s.uKickAge.value = Math.max(0, fx.time - this.kickTime);
    s.uSpeed.value = clamp01(fx.speed01);
  }

  private worldMaterial(mat: MaterialId): ShaderMaterial {
    let m = this.worldMaterials.get(mat);
    if (!m) {
      m = createWorldMaterial(this.shared, this.textures.get(mat));
      m.name = `PS2World:${mat}`;
      this.worldMaterials.set(mat, m);
    }
    return m;
  }

  private clearLevel(): void {
    const geometries: BufferGeometry[] = [];
    for (const child of this.levelGroup.children) {
      if (child instanceof Mesh) geometries.push(child.geometry);
    }
    this.levelGroup.clear();
    for (const g of geometries) g.dispose();
    this.levelTriangles = 0;
    this.gateMesh = null;
    this.gateCount = 0;
  }

  private applyLayout(): void {
    if (this.cssWidth <= 0 || this.cssHeight <= 0) return;
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const l = computeLowRes(this.cssWidth, this.cssHeight, this.settings.pixelHeight, dpr);
    this.layout = l;
    this.renderer.setSize(l.lowW, l.lowH, false);
    this.target.setSize(l.lowW, l.lowH);
    this.shared.uRes.value.set(l.lowW, l.lowH);
    this.post.setResolution(l.lowW, l.lowH);
    this.viewModel.setResolution(l.lowW, l.lowH);
    const st = this.canvas.style;
    st.width = `${l.cssW}px`;
    st.height = `${l.cssH}px`;
    st.left = `${l.cssLeft}px`;
    st.top = `${l.cssTop}px`;
  }
}
