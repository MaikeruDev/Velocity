/**
 * Die 3D-Welt der PS2-Front-Door: EIN WebGLRenderer, Low-Res-Target (≤ 270 Zeilen), eigener Post-Pass
 * (5 Bit + Bayer), ganzzahlig per CSS hochskaliert (pixelated).
 *
 * Zwei Szenen:
 *  - Hintergrund (driftende Kamera): Himmel, spiegelnder Void-Boden mit Gitter, Kristall-Türme aus Glas mit
 *    Leucht-Trims an den Kronen, aufsteigende Datenpartikel.
 *  - Vordergrund (feste Kamera): die Menü-Objekte. Sie hängen an DOM-Ankern (Bildschirm-Px → Strahl in die Tiefe),
 *    damit Layout und Mausziele im DOM bleiben und das 3D-Objekt exakt in seinem Knopf sitzt. Level-Discs laufen
 *    stattdessen auf einer Umlaufbahn um einen Anker.
 *
 * Kein Frame-Pfad alloziert: Temporäre Vektoren sind Felder, Uniform-Objekte werden nur beschrieben.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CylinderGeometry,
  DoubleSide,
  InstancedBufferAttribute,
  InstancedMesh,
  LinearSRGBColorSpace,
  Matrix4,
  Mesh,
  NearestFilter,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  Raycaster,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import { Object3D } from 'three';
import type { Intersection } from 'three';
import { computeLowRes } from '../../../render/lowres';
import { cardGeometry, coneGeometry, discGeometry, GEAR_PAIR, gearGeometry, gemGeometry, quadGeometry, rgb, trophyGeometry } from './models';
import type { Rgb } from './models';
import {
  DUST_FRAG,
  DUST_VERT,
  GLASS_FRAG,
  GLASS_VERT,
  GRID_FRAG,
  GRID_VERT,
  HALO_FRAG,
  HALO_VERT,
  LIT_FRAG,
  LIT_VERT,
  LOGO_FRAG,
  LOGO_VERT,
  POST_FRAG,
  POST_VERT,
  SKY_FRAG,
  SKY_VERT,
  TRIM_VERT,
} from './shaders';

export type FgKind = 'disc' | 'cone' | 'card' | 'trophy' | 'gem' | 'gear';

/** Ein Vordergrund-Objekt (Menüpunkt, Speicherstand-Symbol, Level-Disc). */
export interface FgObj {
  readonly kind: FgKind;
  /** Transformations-Knoten (bei Zahnrädern eine Gruppe aus zwei Rädern). */
  readonly node: Object3D;
  /** Haupt-Mesh (Raycast, Halo-Größe). */
  readonly mesh: Mesh;
  /** Unterteile, die sich gegeneinander drehen (Zahnrad-Paar). */
  readonly parts: readonly Mesh[];
  readonly mat: ShaderMaterial;
  /** Anker in CSS-Px relativ zum Front-Door-Root: Mitte + Kantenlänge. */
  ax: number;
  ay: number;
  size: number;
  /** Sichtbar in der aktuellen Ansicht. */
  shown: boolean;
  /** Gewählt (Ziel), sel = geglättet 0..1. */
  selected: boolean;
  sel: number;
  /** Erscheinen 0..1 (Ansichtswechsel). */
  pop: number;
  spin: number;
  /** Umlaufbahn statt Anker (Level-Discs in der Disc-Ansicht). */
  ring: boolean;
  /** Platz auf der Bahn (0..n-1). */
  slot: number;
  /** Abgedunkelt ohne Auswahl (Hauptmenü ja, Memory-Card-Raster etwas weniger). */
  dimIdle: number;
  /** Pendeln statt voller Drehung (Profil-Karte: nie hochkant/Rückseite zeigen). */
  sway: boolean;
}

/** Ziel der Disc-Umlaufbahn (CSS-Px). */
export interface RingSpec {
  cx: number;
  cy: number;
  radius: number;
  /** Ziel-Drehung in Plätzen (Index der vorderen Disc). */
  target: number;
  count: number;
}

const LEVEL_LABELS: readonly (readonly [Rgb, Rgb])[] = [
  [rgb('#24c8ff'), rgb('#ff3fd0')],
  [rgb('#ff3fd0'), rgb('#ffd84a')],
  [rgb('#ff7a5a'), rgb('#3dffd6')],
  [rgb('#ffcc3a'), rgb('#7a3cff')],
  [rgb('#5dff9a'), rgb('#33f0ff')],
  [rgb('#a63bff'), rgb('#ff7a5a')],
];

/** Farbe einer Level-Disc (auch fürs DOM, z. B. Etikett-Streifen). */
export function levelColor(i: number): string {
  const c = LEVEL_LABELS[i % LEVEL_LABELS.length][0];
  const h = (v: number): string => Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`;
}

/** Tiefe der Anker-Ebene im Vordergrund (Welt-Einheiten) und Kamera-FOV. */
const FG_DEPTH = 10;
const FG_FOV = 30;
const TAN_HALF = Math.tan(((FG_FOV / 2) * Math.PI) / 180);

/** Boot-Zeitplan (s). */
export const BOOT_LEN = 3.7;

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** 4×4-Bayer wie im Post-Shader (0..1), für die CPU-Quantisierung der Symbole. */
function bayerAt(x: number, y: number): number {
  const a = x & 1, b = y & 1, c = (x >> 1) & 1, d = (y >> 1) & 1;
  return (8 * ((a + b) & 1) + 4 * b + 2 * ((c + d) & 1) + d + 0.5) / 16;
}

/** Deterministischer Zufall (Turm-Feld soll bei jedem Mount gleich aussehen). */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Ps2Scene {
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: WebGLRenderer;
  private rt: WebGLRenderTarget;
  private readonly bg = new Scene();
  private readonly fg = new Scene();
  private readonly post = new Scene();
  private readonly bgCam = new PerspectiveCamera(58, 16 / 9, 0.5, 400);
  private readonly fgCam = new PerspectiveCamera(FG_FOV, 16 / 9, 0.5, 60);
  private readonly postCam = new PerspectiveCamera();
  private readonly geos: BufferGeometry[] = [];
  private readonly mats: ShaderMaterial[] = [];
  private readonly textures: CanvasTexture[] = [];

  private readonly skyU = { uHorizon: { value: 0.45 }, uCold: { value: 0 } };
  private readonly gridU = { uRing: { value: 100 }, uFade: { value: 1 } };
  private readonly glassU = { uRise: { value: 1 }, uTime: { value: 0 }, uMirror: { value: 1 }, uDim: { value: 1 } };
  private readonly glassMirrorU = { uRise: this.glassU.uRise, uTime: this.glassU.uTime, uMirror: { value: -1 }, uDim: { value: 0.32 } };
  private readonly trimU = { uRise: this.glassU.uRise, uKick: { value: 0 }, uMirror: { value: 1 }, uDim: { value: 1 } };
  private readonly trimMirrorU = { uRise: this.glassU.uRise, uKick: this.trimU.uKick, uMirror: { value: -1 }, uDim: { value: 0.3 } };
  private readonly dustU = { uTime: { value: 0 }, uFade: { value: 1 } };
  private readonly haloU = { uColor: { value: new Vector3(0.2, 0.75, 1.0) }, uPower: { value: 0 }, uRays: { value: 0.3 } };
  private readonly logoU = { tLogo: { value: null as CanvasTexture | null }, uReveal: { value: 0 }, uFlash: { value: 0 } };
  private readonly postU = { tScene: { value: null as WebGLRenderTarget['texture'] | null }, uFade: { value: 1 }, uRes: { value: new Vector2(1, 1) } };

  private readonly halo: Mesh;
  private readonly logo: Mesh;
  private logoImg: HTMLImageElement | null = null;
  private logoW = 0;
  readonly objs: FgObj[] = [];
  readonly ring: RingSpec = { cx: 0, cy: 0, radius: 100, target: 0, count: 1 };
  private ringPos = 0;
  private haloSel = 0;
  private haloX = 0;
  private haloY = 0;
  private haloZ = -FG_DEPTH;
  private haloS = 1;

  // Layout (CSS-Px des Roots + Low-Res)
  private cssW = 1;
  private cssH = 1;
  private canvasLeft = 0;
  private canvasTop = 0;
  private canvasCssW = 1;
  private canvasCssH = 1;
  scale = 1;
  lowW = 1;
  lowH = 1;

  private readonly tmpV = new Vector3();
  private readonly tmpM = new Matrix4();
  private readonly ray = new Raycaster();
  private readonly ndc = new Vector2();
  private readonly hits: Intersection<Object3D>[] = [];
  private readonly lookAt = new Vector3(0, 5, -40);

  /** Ruhezustand: keine Dauer-Animation (Objekte stehen in schöner Pose). */
  reducedMotion = false;
  /** Kamera-/Turm-Zustand der Boot-Sequenz (s seit Start, ≥ BOOT_LEN = fertig). */
  bootT = BOOT_LEN;
  /** Fokus fürs Halo (null = kein Halo). */
  focus: FgObj | null = null;
  focusColor: Rgb = [0.2, 0.75, 1.0];

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'ps2-canvas';
    this.renderer = new WebGLRenderer({ canvas: this.canvas, antialias: false, alpha: false, depth: true, stencil: false, powerPreference: 'low-power' });
    this.renderer.outputColorSpace = LinearSRGBColorSpace;
    this.renderer.setPixelRatio(1);
    this.renderer.autoClear = false;
    this.rt = this.makeTarget(1, 1);
    this.postU.tScene.value = this.rt.texture;

    this.buildBackground();
    this.halo = new Mesh(this.track(quadGeometry()), this.material(HALO_VERT, HALO_FRAG, this.haloU, true));
    this.halo.frustumCulled = false;
    this.halo.renderOrder = -1;
    this.fg.add(this.halo);
    this.logo = new Mesh(this.track(quadGeometry()), this.material(LOGO_VERT, LOGO_FRAG, this.logoU, false));
    this.logo.visible = false;
    this.logo.frustumCulled = false;
    this.fg.add(this.logo);

    const tri = new BufferGeometry();
    tri.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.track(tri);
    const postMesh = new Mesh(tri, this.material(POST_VERT, POST_FRAG, this.postU, false));
    postMesh.frustumCulled = false;
    this.post.add(postMesh);
  }

  private makeTarget(w: number, h: number): WebGLRenderTarget {
    return new WebGLRenderTarget(w, h, { minFilter: NearestFilter, magFilter: NearestFilter, format: RGBAFormat, depthBuffer: true, generateMipmaps: false });
  }

  private track<T extends BufferGeometry>(g: T): T {
    this.geos.push(g);
    return g;
  }

  private material(vertexShader: string, fragmentShader: string, uniforms: Record<string, { value: unknown }>, additive: boolean): ShaderMaterial {
    const m = new ShaderMaterial({ vertexShader, fragmentShader, uniforms, side: DoubleSide });
    if (additive) {
      m.blending = AdditiveBlending;
      m.transparent = true;
      m.depthWrite = false;
    }
    this.mats.push(m);
    return m;
  }

  // ------------------------------------------------------------ Hintergrund

  private buildBackground(): void {
    const sky = new Mesh(this.skyTri(), this.material(SKY_VERT, SKY_FRAG, this.skyU, false));
    sky.frustumCulled = false;
    sky.renderOrder = -10;
    (sky.material as ShaderMaterial).depthWrite = false;
    this.bg.add(sky);

    // Boden: nur Gitterlinien (additiv) über dem dunklen Himmel → darunter sieht man die Spiegelung der Türme.
    const floorG = this.track(new PlaneGeometry(400, 400, 1, 1));
    floorG.rotateX(-Math.PI / 2);
    const floorM = this.material(GRID_VERT, GRID_FRAG, this.gridU, true);
    const floor = new Mesh(floorG, floorM);
    floor.renderOrder = 2;
    this.bg.add(floor);

    // Türme: sechseckige Glas-Prismen, Feld mit freier Mitte hinter den Menüpunkten.
    const rnd = mulberry(0x5eed2002);
    const count = 84;
    const prism = this.track(new CylinderGeometry(1, 1, 1, 6, 1, false));
    prism.translate(0, 0.5, 0);
    const crown = this.track(new CylinderGeometry(1.04, 1.04, 0.06, 6, 1, true));
    const palette: readonly Rgb[] = [rgb('#3a6cff'), rgb('#7a3cff'), rgb('#24c8ff'), rgb('#b23cff'), rgb('#ff3fd0')];
    const trimPal: readonly Rgb[] = [rgb('#33f0ff'), rgb('#33f0ff'), rgb('#ff3fd0'), rgb('#ffd84a')];
    const glassCol = new Float32Array(count * 3);
    const trimCol = new Float32Array(count * 3);
    const glass = new InstancedMesh(prism, this.material(GLASS_VERT, GLASS_FRAG, this.glassU, true), count);
    const glassMirror = new InstancedMesh(prism, this.material(GLASS_VERT, GLASS_FRAG, this.glassMirrorU, true), count);
    const trims = new InstancedMesh(crown, this.material(TRIM_VERT, LIT_FRAG, this.trimU, true), count);
    const trimsMirror = new InstancedMesh(crown, this.material(TRIM_VERT, LIT_FRAG, this.trimMirrorU, true), count);
    const m = this.tmpM;
    for (let i = 0; i < count; i++) {
      let x = 0;
      let z = 0;
      // Mitte (|x| klein, nah) frei lassen: dort stehen die Menüpunkte
      for (let tries = 0; tries < 20; tries++) {
        x = (rnd() * 2 - 1) * 100;
        z = -22 - rnd() * 100;
        if (Math.abs(x) > 14 + (z + 120) * 0.16 || z < -75) break;
      }
      const far = Math.min(1, (-z - 8) / 100);
      const r = 0.7 + rnd() * 1.6 + far * 1.2;
      const h = 2 + rnd() * rnd() * 22 + far * 6;
      m.makeScale(r, h, r);
      m.setPosition(x, 0, z);
      glass.setMatrixAt(i, m);
      glassMirror.setMatrixAt(i, m);
      m.makeScale(r, 1, r);
      m.setPosition(x, h, z);
      trims.setMatrixAt(i, m);
      trimsMirror.setMatrixAt(i, m);
      const c = palette[Math.floor(rnd() * palette.length)];
      const t = trimPal[Math.floor(rnd() * trimPal.length)];
      glassCol.set(c, i * 3);
      trimCol.set(t, i * 3);
    }
    prism.setAttribute('aColor', new InstancedBufferAttribute(glassCol, 3));
    crown.setAttribute('aColor', new InstancedBufferAttribute(trimCol, 3));
    for (const im of [glass, glassMirror, trims, trimsMirror]) {
      im.frustumCulled = false;
      im.instanceMatrix.needsUpdate = true;
    }
    glassMirror.renderOrder = 0;
    trimsMirror.renderOrder = 0;
    glass.renderOrder = 3;
    trims.renderOrder = 4;
    this.bg.add(glassMirror, trimsMirror, glass, trims);

    // Datenpartikel
    const n = 420;
    const pos = new Float32Array(n * 3);
    const seed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (rnd() * 2 - 1) * 70;
      pos[i * 3 + 1] = rnd() * 22;
      pos[i * 3 + 2] = -4 - rnd() * 90;
      seed[i] = rnd();
    }
    const dustG = this.track(new BufferGeometry());
    dustG.setAttribute('position', new BufferAttribute(pos, 3));
    dustG.setAttribute('aSeed', new BufferAttribute(seed, 1));
    const dust = new Points(dustG, this.material(DUST_VERT, DUST_FRAG, this.dustU, true));
    dust.frustumCulled = false;
    dust.renderOrder = 5;
    this.bg.add(dust);
  }

  private skyTri(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    return this.track(g);
  }

  // ------------------------------------------------------------ Vordergrund-Objekte

  /** Objekt anlegen (beim Aufbau einer Ansicht; nicht im Frame-Pfad). */
  /** colors: Etikett + Akzent einer Disc (Level-Theme), sonst die Ersatzfarben je variant. */
  addObj(kind: FgKind, variant = 0, colors?: readonly [Rgb, Rgb]): FgObj {
    let g: BufferGeometry;
    let g2: BufferGeometry | null = null;
    let spec = 0.25;
    let rim: Rgb = [0.25, 0.35, 0.6];
    switch (kind) {
      case 'disc': {
        const l = colors ?? LEVEL_LABELS[variant % LEVEL_LABELS.length];
        g = discGeometry(l[0], l[1]);
        spec = 0.6;
        break;
      }
      case 'cone':
        g = coneGeometry();
        break;
      case 'card':
        g = cardGeometry();
        spec = 0.4;
        break;
      case 'trophy':
        g = trophyGeometry();
        spec = 1.1;
        rim = [0.5, 0.3, 0.1];
        break;
      case 'gem':
        g = gemGeometry();
        spec = 1.2;
        rim = [0.6, 0.2, 0.6];
        break;
      case 'gear':
        g = gearGeometry(GEAR_PAIR.big);
        g2 = gearGeometry(GEAR_PAIR.small, 'brass');
        spec = 1.0;
        rim = [0.2, 0.4, 0.7];
        break;
    }
    this.track(g);
    if (g2) this.track(g2);
    const uniforms = { uDim: { value: 1 }, uGlow: { value: 0 }, uSpec: { value: spec }, uTime: { value: 0 }, uRim: { value: new Vector3(rim[0], rim[1], rim[2]) } };
    const mat = this.material(LIT_VERT, LIT_FRAG, uniforms, false);
    const mesh = new Mesh(g, mat);
    mesh.frustumCulled = false;
    let node: Object3D = mesh;
    const parts: Mesh[] = [];
    if (g2) {
      // Zahnrad-Paar: großes Rad + kleines, das gegenläufig eingreift (eigene Achsen in der Gruppe)
      node = new Object3D();
      const small = new Mesh(g2, mat);
      small.frustumCulled = false;
      mesh.position.set(GEAR_PAIR.bigAt[0], GEAR_PAIR.bigAt[1], 0);
      small.position.set(GEAR_PAIR.smallAt[0], GEAR_PAIR.smallAt[1], 0.02);
      node.add(mesh, small);
      parts.push(mesh, small);
    }
    node.visible = false;
    this.fg.add(node);
    const o: FgObj = { kind, node, mesh, parts, mat, ax: 0, ay: 0, size: 0, shown: false, selected: false, sel: 0, pop: 0, spin: variant * 1.7, ring: false, slot: 0, dimIdle: 0.5, sway: false };
    this.objs.push(o);
    return o;
  }

  /** Objekt entfernen (Level-Liste geändert). */
  removeObj(o: FgObj): void {
    const i = this.objs.indexOf(o);
    if (i >= 0) this.objs.splice(i, 1);
    this.fg.remove(o.node);
    for (const m of o.parts.length > 0 ? o.parts : [o.mesh]) {
      m.geometry.dispose();
      const gi = this.geos.indexOf(m.geometry);
      if (gi >= 0) this.geos.splice(gi, 1);
    }
    o.mat.dispose();
    const mi = this.mats.indexOf(o.mat);
    if (mi >= 0) this.mats.splice(mi, 1);
  }

  /** Sofort an Ziel springen (Ansichtswechsel mit reducedMotion, Rückkehr). */
  snap(): void {
    for (const o of this.objs) {
      o.sel = o.selected ? 1 : 0;
      o.pop = o.shown ? 1 : 0;
    }
    this.ringPos = this.ring.target;
    this.haloSel = this.focus ? 1 : 0;
  }

  /** Ansicht frisch: Objekte poppen neu auf. */
  restartPop(): void {
    for (const o of this.objs) o.pop = 0;
  }

  // ------------------------------------------------------------ Logo (Boot)

  setLogoImage(img: HTMLImageElement): void {
    this.logoImg = img;
    this.logoW = 0;
    this.updateLogoTexture();
  }

  /** Logo auf die Low-Res-Zielgröße vorverkleinern (hochwertig, einmal), dann Nearest — kein Mipmap-Matsch. */
  private updateLogoTexture(): void {
    const img = this.logoImg;
    if (!img || !img.complete || img.naturalWidth === 0) return;
    const w = Math.max(32, Math.round(Math.min(this.lowW * 0.62, this.lowH * 2.1)));
    if (w === this.logoW) return;
    this.logoW = w;
    const h = Math.round((w * img.naturalHeight) / img.naturalWidth);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    if (!g) return;
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, w, h);
    const old = this.logoU.tLogo.value;
    if (old) {
      old.dispose();
      this.textures.splice(this.textures.indexOf(old), 1);
    }
    const t = new CanvasTexture(c);
    t.minFilter = NearestFilter;
    t.magFilter = NearestFilter;
    t.generateMipmaps = false;
    this.textures.push(t);
    this.logoU.tLogo.value = t;
  }

  // ------------------------------------------------------------ Layout

  /** Root-Größe (CSS-Px) → Low-Res-Raster (≤ 270 Zeilen, ganzzahlig). */
  layout(cssW: number, cssH: number, dpr: number): void {
    const l = computeLowRes(cssW, cssH, 270, dpr);
    this.cssW = cssW;
    this.cssH = cssH;
    this.canvasLeft = l.cssLeft;
    this.canvasTop = l.cssTop;
    this.canvasCssW = l.cssW;
    this.canvasCssH = l.cssH;
    this.scale = l.scale;
    if (l.lowW !== this.lowW || l.lowH !== this.lowH) {
      this.lowW = l.lowW;
      this.lowH = l.lowH;
      this.renderer.setSize(l.lowW, l.lowH, false);
      this.rt.setSize(l.lowW, l.lowH);
      this.postU.uRes.value.set(l.lowW, l.lowH);
    }
    const s = this.canvas.style;
    s.width = `${l.cssW}px`;
    s.height = `${l.cssH}px`;
    s.left = `${l.cssLeft}px`;
    s.top = `${l.cssTop}px`;
    const aspect = l.lowW / l.lowH;
    this.bgCam.aspect = aspect;
    this.bgCam.updateProjectionMatrix();
    this.fgCam.aspect = aspect;
    this.fgCam.updateProjectionMatrix();
    this.updateLogoTexture();
  }

  /** CSS-Px (Root) → Welt auf dem Strahl der Vordergrund-Kamera in Tiefe d. */
  private toWorld(px: number, py: number, d: number, out: Vector3): Vector3 {
    const nx = ((px - this.canvasLeft) / this.canvasCssW) * 2 - 1;
    const ny = 1 - ((py - this.canvasTop) / this.canvasCssH) * 2;
    return out.set(nx * TAN_HALF * this.fgCam.aspect * d, ny * TAN_HALF * d, -d);
  }

  /** CSS-Px → Welt-Länge in Tiefe d. */
  private pxToWorld(px: number, d: number): number {
    return (px / this.canvasCssH) * 2 * TAN_HALF * d;
  }

  /** Klick auf eine Disc der Umlaufbahn → Platz (slot), sonst −1. */
  pickRing(clientX: number, clientY: number, rootRect: DOMRect): number {
    this.ndc.set(((clientX - rootRect.left - this.canvasLeft) / this.canvasCssW) * 2 - 1, 1 - ((clientY - rootRect.top - this.canvasTop) / this.canvasCssH) * 2);
    this.ray.setFromCamera(this.ndc, this.fgCam);
    let best = -1;
    let bestD = Infinity;
    for (const o of this.objs) {
      if (!o.ring || !o.shown || !o.node.visible) continue;
      this.hits.length = 0;
      o.mesh.raycast(this.ray, this.hits);
      for (const h of this.hits) {
        if (h.distance < bestD) {
          bestD = h.distance;
          best = o.slot;
        }
      }
    }
    this.hits.length = 0;
    return best;
  }

  // ------------------------------------------------------------ Frame

  /**
   * bar/barPhase aus dem Takt: Pulse laufen bewusst nur EINMAL je Takt (weich, lang) bzw. der Boden-Ring alle zwei
   * Takte — pro Beat war das Nutzer-Feedback "zu hektisch".
   */
  frame(time: number, dt: number, bar: number, barPhase: number): void {
    const motion = this.reducedMotion ? 0 : 1;
    const k = this.reducedMotion ? 1 : 1 - Math.exp(-dt * 10);
    const kp = this.reducedMotion ? 1 : 1 - Math.exp(-dt * 7);
    const bt = this.bootT;
    // Takt-Hülle: kurzer weicher Anstieg, langes Ausklingen über den ganzen Takt
    const swell = motion * smooth(0, 0.12, barPhase) * Math.exp(-barPhase * 2.6);

    // Boot: Abblende, Türme wachsen, Kamera-Kran, Logo
    const rise = 0.02 + 0.98 * (1 - Math.pow(1 - smooth(0.15, 2.4, bt), 2));
    this.glassU.uRise.value = rise;
    this.postU.uFade.value = smooth(0.2, 1.5, bt);
    this.glassU.uTime.value = time * motion;
    this.dustU.uTime.value = time * motion + 30;
    this.dustU.uFade.value = smooth(0.8, 2.2, bt);
    this.trimU.uKick.value = swell * 0.5;

    // Boden-Ring: alle zwei Takte einer, läuft langsam 90 u weit und verblasst (GRID_FRAG blendet über uRing aus)
    const ringP = ((((bar % 2) + 2) % 2) + barPhase) / 2;
    this.gridU.uRing.value = motion > 0 ? ringP * 90 : 400;

    const crane = 1 - Math.pow(1 - smooth(0, 3.2, bt), 3);
    const c = this.bgCam;
    c.position.set(Math.sin(time * 0.05) * 6 * motion, 1.2 + crane * 3.4 + Math.sin(time * 0.08) * 0.5 * motion, 4 + crane * 12);
    this.lookAt.set(Math.sin(time * 0.03) * 4 * motion, 2 + crane * 4.5, -40);
    c.lookAt(this.lookAt);
    // Horizont auf dem Schirm (Punkt weit voraus auf Kamerahöhe)
    this.tmpV.set(c.position.x, c.position.y, -600).project(c);
    this.skyU.uHorizon.value = this.tmpV.y * 0.5 + 0.5;
    // Kaltstart: der Himmel beginnt in Konsolen-Blau und kippt mit dem Logo ins Neon-Violett
    this.skyU.uCold.value = 1 - smooth(1.2, 2.4, bt);

    // Logo
    const lg = this.logo;
    const reveal = smooth(1.35, 2.2, bt) * (1 - smooth(3.15, 3.5, bt));
    lg.visible = bt < BOOT_LEN && reveal > 0.001 && this.logoU.tLogo.value !== null;
    if (lg.visible) {
      const d = FG_DEPTH;
      const wPx = (this.logoW * this.canvasCssW) / this.lowW;
      const tex = this.logoU.tLogo.value;
      const aspect = tex ? (tex.image as HTMLCanvasElement).height / (tex.image as HTMLCanvasElement).width : 0.333;
      this.toWorld(this.cssW / 2, this.cssH * 0.44, d, lg.position);
      const ws = this.pxToWorld(wPx, d);
      lg.scale.set(ws, ws * aspect, 1);
      this.logoU.uReveal.value = reveal;
      this.logoU.uFlash.value = Math.max(0, 1 - Math.abs(bt - 2.25) * 5) * 0.5;
    }

    // Vordergrund-Objekte
    const r = this.ring;
    if (r.count > 0) {
      // kürzester Weg auf dem Kreis
      let diff = r.target - this.ringPos;
      diff -= Math.round(diff / r.count) * r.count;
      this.ringPos += diff * kp;
    }
    const ringC = this.tmpV;
    const ringD = FG_DEPTH + 2;
    const booting = bt < BOOT_LEN;
    for (const o of this.objs) {
      const m = o.node;
      if (!o.shown || booting) {
        o.pop = 0;
        m.visible = false;
        continue;
      }
      m.visible = true;
      o.sel += ((o.selected ? 1 : 0) - o.sel) * k;
      o.pop += (1 - o.pop) * kp;
      const s = o.sel;
      o.spin += dt * (0.35 + 2.2 * s) * motion;
      const u = o.mat.uniforms;
      u.uTime.value = time * motion;
      const pulse = 0.8 + 0.2 * swell;
      u.uGlow.value = s * pulse;
      u.uDim.value = 1 - (1 - s) * o.dimIdle;
      const popS = 0.2 + 0.8 * o.pop;
      if (o.ring) {
        const n = Math.max(1, r.count);
        const th = ((o.slot - this.ringPos) / n) * Math.PI * 2;
        this.toWorld(r.cx, r.cy, ringD, ringC);
        const R = this.pxToWorld(r.radius, ringD);
        const front = Math.cos(th);
        m.position.set(ringC.x + Math.sin(th) * R, ringC.y - front * R * 0.16 + R * 0.04, ringC.z + front * R * 0.55);
        const sz = this.pxToWorld(r.radius * 0.95, ringD) * (1 + 0.12 * s) * popS;
        m.scale.setScalar(sz);
        // vordere Disc zeigt das Etikett, hintere stehen hochkant auf der Bahn
        m.rotation.set(0.5 + front * 0.65 + Math.sin(time * 0.9) * 0.06 * motion * s, o.spin, Math.sin(th) * 0.25, 'XYZ');
        continue;
      }
      const d = FG_DEPTH - s * 1.2;
      this.toWorld(o.ax, o.ay, d, m.position);
      m.position.y += Math.sin(time * 1.8 + o.spin * 0.1) * this.pxToWorld(o.size * 0.03, d) * s * motion;
      const sz = this.pxToWorld(o.size, d) * (1 + 0.22 * s) * popS;
      m.scale.setScalar(sz);
      const wob = Math.sin(time * 1.1) * 0.08 * motion;
      switch (o.kind) {
        case 'disc':
          m.rotation.set(1.05 + wob, o.spin, 0.18, 'XYZ');
          break;
        case 'gear': {
          m.rotation.set(0.28 + wob, -0.42 + Math.sin(time * 0.5) * 0.2 * motion, 0, 'XYZ');
          // gegenläufig, Übersetzung = Zähnezahl; Phase so, dass Zahn in Lücke greift
          const a = o.spin * 0.5;
          o.parts[0].rotation.z = a;
          o.parts[1].rotation.z = -a * GEAR_PAIR.ratio + GEAR_PAIR.phase;
          break;
        }
        case 'card':
          m.rotation.set(0.12 + wob, o.sway ? -0.35 + Math.sin(time * 0.9) * 0.45 * motion : o.spin + 0.5, 0.06, 'XYZ');
          break;
        default:
          m.rotation.set(0.22 + wob, o.spin + 0.6, 0, 'XYZ');
      }
    }

    // Halo hinter dem Fokus
    const f = this.focus;
    // Im Boot kein Fokus-Halo (die Objekte sind noch versteckt, ihre Transformation ungültig)
    const fOn = f !== null && f.shown && !booting;
    this.haloSel += ((fOn ? 1 : 0) - this.haloSel) * k;
    if (fOn && f) {
      this.haloX = f.node.position.x;
      this.haloY = f.node.position.y;
      this.haloZ = f.node.position.z - f.node.scale.x * 0.8;
      this.haloS = f.node.scale.x * 3.2;
      this.haloU.uColor.value.set(this.focusColor[0], this.focusColor[1], this.focusColor[2]);
    }
    if (lg.visible) {
      this.haloX = lg.position.x;
      this.haloY = lg.position.y;
      this.haloZ = lg.position.z - 0.5;
      this.haloS = lg.scale.x * 1.3;
      this.haloU.uColor.value.set(0.7, 0.2, 0.9);
    }
    this.haloU.uRays.value = lg.visible ? 1 : 0.25;
    const hp = lg.visible ? reveal * 0.55 : this.haloSel * (0.4 + 0.1 * swell);
    this.halo.visible = hp > 0.01;
    this.halo.position.set(this.haloX, this.haloY, this.haloZ);
    this.halo.scale.set(this.haloS, this.haloS, 1);
    this.haloU.uPower.value = hp;

    // Zeichnen: Hintergrund → Tiefe leeren → Vordergrund → Post auf den Schirm
    const rd = this.renderer;
    rd.setRenderTarget(this.rt);
    rd.setClearColor(0x000000, 1);
    rd.clear(true, true, false);
    rd.render(this.bg, this.bgCam);
    rd.clearDepth();
    rd.render(this.fg, this.fgCam);
    rd.setRenderTarget(null);
    rd.render(this.post, this.postCam);
  }

  // ------------------------------------------------------------ Standbild + Symbole für die Bestands-Screens

  /** Layout des Canvas (CSS-Px) — das Standbild liegt in den anderen Screens exakt so wie hier. */
  get canvasRect(): { readonly x: number; readonly y: number; readonly w: number; readonly h: number } {
    return { x: this.canvasLeft, y: this.canvasTop, w: this.canvasCssW, h: this.canvasCssH };
  }

  /**
   * Nur die Welt (ohne Menü-Objekte, Halo, Logo) einmal zeichnen und als PNG holen. Im selben Task wie das
   * Zeichnen gelesen → kein preserveDrawingBuffer nötig. Nicht im Frame-Pfad (nur beim Abbau).
   */
  snapshotBackdrop(): string {
    this.bootT = BOOT_LEN;
    const rd = this.renderer;
    rd.setRenderTarget(this.rt);
    rd.setClearColor(0x000000, 1);
    rd.clear(true, true, false);
    rd.render(this.bg, this.bgCam);
    rd.setRenderTarget(null);
    this.postU.uFade.value = 1;
    rd.render(this.post, this.postCam);
    return this.canvas.toDataURL('image/png');
  }

  /**
   * Ein Objekt freigestellt als kleines Pixel-Symbol (px × px Low-Res, 5 Bit + Bayer wie der Post-Pass,
   * Alpha hart). Eigene Kamera, eigenes Ziel; die Objekte stehen in ihrer schönsten Pose.
   */
  renderIcon(o: FgObj, px: number): string {
    const rt = this.makeTarget(px, px);
    const cam = new PerspectiveCamera(FG_FOV, 1, 0.5, 60);
    const saved = this.fg.children.map((c) => c.visible);
    for (const c of this.fg.children) c.visible = false;
    const n = o.node;
    n.visible = true;
    n.position.set(0, 0, -FG_DEPTH);
    n.scale.setScalar(2 * TAN_HALF * FG_DEPTH * 0.84);
    switch (o.kind) {
      case 'disc':
        n.rotation.set(0.95, 0.5, 0.18, 'XYZ');
        break;
      case 'gear':
        n.rotation.set(0.28, -0.42, 0, 'XYZ');
        o.parts[0].rotation.z = 0.2;
        o.parts[1].rotation.z = -0.2 * GEAR_PAIR.ratio + GEAR_PAIR.phase;
        break;
      case 'card':
        n.rotation.set(0.12, -0.45, 0.06, 'XYZ');
        break;
      case 'trophy':
        // Vorderseite ins Schlüssellicht (oben links), sonst wirkt das Gold braun
        n.rotation.set(0.3, -0.35, 0, 'XYZ');
        break;
      default:
        n.rotation.set(0.22, 0.7, 0, 'XYZ');
    }
    const u = o.mat.uniforms;
    u.uDim.value = 1;
    // etwas Rim-Licht wie die Auswahl: freigestellte Symbole brauchen eine helle Kante gegen dunkle Panels
    u.uGlow.value = 0.6;
    const rd = this.renderer;
    rd.setRenderTarget(rt);
    rd.setClearColor(0x000000, 0);
    rd.clear(true, true, false);
    rd.render(this.fg, cam);
    rd.setRenderTarget(null);
    const buf = new Uint8Array(px * px * 4);
    rd.readRenderTargetPixels(rt, 0, 0, px, px, buf);
    rt.dispose();
    this.fg.children.forEach((c, i) => {
      c.visible = saved[i];
    });
    const c = document.createElement('canvas');
    c.width = px;
    c.height = px;
    const g = c.getContext('2d');
    if (!g) return '';
    const img = g.createImageData(px, px);
    for (let y = 0; y < px; y++) {
      for (let x = 0; x < px; x++) {
        const src = ((px - 1 - y) * px + x) * 4; // GL liest von unten
        const dst = (y * px + x) * 4;
        const b = bayerAt(x, y);
        for (let k = 0; k < 3; k++) img.data[dst + k] = Math.min(255, Math.floor((buf[src + k] / 255) * 31 + b) * (255 / 31));
        img.data[dst + 3] = buf[src + 3] > 127 ? 255 : 0;
      }
    }
    g.putImageData(img, 0, 0);
    return c.toDataURL('image/png');
  }

  dispose(): void {
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    for (const t of this.textures) t.dispose();
    this.rt.dispose();
    this.objs.length = 0;
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.logoImg = null;
  }
}
