// Stil 'hub' — die Szene: Dach mit Neon-Kanten über der Stadt, Stationen im Ring, Portale je Level.
// Alles Statische landet in EINER Geometrie (ein Draw Call); bewegte Kleinteile (Medaillen, Ausweis, Zahnrad) eigene Meshes.
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Box3,
  Mesh,
  NearestFilter,
  NoColorSpace,
  Object3D,
  PlaneGeometry,
  Points,
  Scene,
  Vector3,
} from 'three';
import type { Material, ShaderMaterial, Texture } from 'three';
import type { FrontDoorContext } from '../types';
import { EMIT, MODE, MeshBuilder, NO_GROUP } from './builder';
import { buildStations, localToWorld, stationColor } from './layout';
import type { Station } from './layout';
import {
  createLitMaterial,
  createPortalMaterial,
  createSignMaterial,
  createSkyMaterial,
  createSparkMaterial,
  createStarMaterial,
} from './materials';
import { MAX_LIGHTS } from './materials';
import type { HubUniforms } from './materials';
import { hex, levelTheme, MEDAL_RGB, mix, mul, PAL } from './theme';
import type { Rgb } from './theme';

/** Kleiner deterministischer Zufall (gleiche Stadt bei jedem Mount). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Text als harte Pixel (Alpha geschwellt) — Silkscreen bei Vielfachen von 8 px, dann Nearest in der Welt. */
export interface TextTex {
  readonly tex: CanvasTexture;
  readonly aspect: number;
  redraw(): void;
}

export function textTexture(text: string, px: number, bold = true): TextTex {
  const canvas = document.createElement('canvas');
  const g = canvas.getContext('2d', { willReadFrequently: true });
  const font = `${bold ? 700 : 400} ${px}px Silkscreen, monospace`;
  const measure = (): number => {
    if (!g) return px * text.length;
    g.font = font;
    return Math.ceil(g.measureText(text).width);
  };
  const pad = px / 4;
  const w = Math.max(8, measure() + pad * 2);
  const h = Math.ceil(px * 1.25 + pad);
  canvas.width = w;
  canvas.height = h;
  const tex = new CanvasTexture(canvas);
  tex.magFilter = NearestFilter;
  tex.minFilter = NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = NoColorSpace;
  const redraw = (): void => {
    if (!g) return;
    g.clearRect(0, 0, w, h);
    g.font = font;
    g.textBaseline = 'alphabetic';
    g.textAlign = 'center';
    g.fillStyle = '#ffffff';
    g.fillText(text, Math.round(w / 2), Math.round(pad / 2 + px));
    const img = g.getImageData(0, 0, w, h);
    const d = img.data;
    for (let i = 3; i < d.length; i += 4) d[i] = d[i] >= 110 ? 255 : 0;
    g.putImageData(img, 0, 0);
    tex.needsUpdate = true;
  };
  redraw();
  return { tex, aspect: w / h, redraw };
}

/** Logo (hochaufgelöstes PNG) klein und hart gerastert für die Plakatwand. */
export function logoTexture(img: HTMLImageElement): CanvasTexture {
  const w = 320;
  const h = Math.round((w * img.naturalHeight) / Math.max(1, img.naturalWidth));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  if (g) {
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, w, h);
    const data = g.getImageData(0, 0, w, h);
    const d = data.data;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3];
      if (a < 120) d[i + 3] = 0;
      else {
        // Vormultiplizierte Ränder aufhellen, sonst dunkle Säume.
        const k = 255 / a;
        d[i] = Math.min(255, d[i] * k);
        d[i + 1] = Math.min(255, d[i + 1] * k);
        d[i + 2] = Math.min(255, d[i + 2] * k);
        d[i + 3] = 255;
      }
    }
    g.putImageData(data, 0, 0);
  }
  const tex = new CanvasTexture(canvas);
  tex.magFilter = NearestFilter;
  tex.minFilter = NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = NoColorSpace;
  return tex;
}

/** Ein bewegtes Kleinteil (dreht/schwebt im Frame). */
interface Spinner {
  readonly obj: Object3D;
  readonly speed: number;
  readonly bobY: number;
  readonly baseY: number;
  readonly phase: number;
  /** >0: pendelt um phase (±sway rad) statt ganz zu drehen. */
  readonly sway: number;
}

/** Plakatwand HINTER dem Hub (keine Station schaut dorthin) — der Anflug startet mit Blick darauf. */
const BILLBOARD = { x: 0, y: 24, z: 86, w: 40 };

export class HubWorld {
  readonly scene = new Scene();
  readonly stations: Station[];
  /** Picking-Boxen je Station (Weltkoordinaten). */
  readonly pick: Box3[] = [];
  /** Anker des DOM-Schilds je Station (Welt). */
  readonly tagAnchor: Vector3[] = [];
  readonly portalMats: ShaderMaterial[] = [];
  readonly signMats: (ShaderMaterial | null)[] = [];
  /** Lauflicht-Pfeile zum gewählten Portal (dreht um die Mitte). */
  readonly chevrons = new Object3D();
  readonly billboardTarget = new Vector3(BILLBOARD.x, BILLBOARD.y, BILLBOARD.z);
  private readonly spinners: Spinner[] = [];
  private readonly geos: BufferGeometry[] = [];
  private readonly mats: Material[] = [];
  private readonly texs: Texture[] = [];
  private readonly texts: TextTex[] = [];
  private readonly lit: ShaderMaterial;
  private readonly sky: ShaderMaterial;
  private billboard: Mesh | null = null;
  private readonly billboardGroup = new Object3D();
  private readonly u: HubUniforms;
  /** Grundstärke je Licht (Index = Station), −1 = kein Licht. */
  readonly lightBase: number[] = [];

  constructor(u: HubUniforms, ctx: FrontDoorContext) {
    this.u = u;
    this.stations = buildStations(ctx.levels);
    this.lit = this.keepMat(createLitMaterial(u));
    this.sky = this.keepMat(createSkyMaterial(u));

    // Himmel: Vollbild-Dreieck zuerst (renderOrder), ohne Tiefe.
    const skyGeo = this.keepGeo(new BufferGeometry());
    skyGeo.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    const skyMesh = new Mesh(skyGeo, this.sky);
    skyMesh.frustumCulled = false;
    skyMesh.renderOrder = -10;
    this.scene.add(skyMesh);
    this.addStars();

    const b = new MeshBuilder();
    this.buildRoof(b);
    this.buildCity(b);
    this.buildBillboardFrame(b);
    for (let i = 0; i < this.stations.length; i++) {
      const st = this.stations[i];
      b.group = i;
      b.setFrame(Math.sin(st.angle) * st.radius, 0, -Math.cos(st.angle) * st.radius, st.angle);
      this.signMats.push(null);
      switch (st.kind) {
        case 'portal':
          this.buildPortal(b, st, i, ctx);
          break;
        case 'training':
          this.buildTraining(b);
          break;
        case 'locker':
          this.buildLocker(b);
          break;
        case 'profile':
          this.buildKiosk(b, st, ctx);
          break;
        case 'trophy':
          this.buildTrophies(b, ctx);
          break;
        case 'setup':
          this.buildWorkbench(b, st);
          break;
        case 'lab':
          this.buildLabDoor(b);
          break;
      }
      this.pick.push(this.stationBox(st));
      const a = new Vector3();
      localToWorld(st, 0, st.tagY, 0.2, a);
      this.tagAnchor.push(a);
    }
    b.resetFrame();
    b.group = NO_GROUP;
    this.placeLights(ctx);
    const mesh = new Mesh(this.keepGeo(b.build()), this.lit);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    this.buildChevrons();
    this.addSparks();
    this.scene.matrixWorldAutoUpdate = true;
  }

  private placeLights(ctx: FrontDoorContext): void {
    const p = { x: 0, y: 0, z: 0 };
    const lp = this.u.uLPos.value;
    const lc = this.u.uLCol.value;
    for (let i = 0; i < MAX_LIGHTS; i++) {
      lp[i].set(0, -100, 0, 1);
      lc[i].set(0, 0, 0, 0);
    }
    const n = Math.min(this.stations.length, MAX_LIGHTS - 1);
    for (let i = 0; i < n; i++) {
      const st = this.stations[i];
      const portal = st.kind === 'portal';
      localToWorld(st, 0, portal ? 1.3 : 1.2, portal ? 0.9 : 1.1, p);
      const c = stationColor(st, ctx);
      lp[i].set(p.x, p.y, p.z, portal ? 5.2 : 4.6);
      lc[i].set(c[0], c[1], c[2], 0);
      this.lightBase[i] = portal ? 1.2 : 0.9;
    }
    // Startplatte in der Mitte: schwaches Grün.
    lp[MAX_LIGHTS - 1].set(0, 0.6, 0, 3.2);
    lc[MAX_LIGHTS - 1].set(PAL.green[0], PAL.green[1], PAL.green[2], 0.35);
  }

  /** Lichtstärke je Station (Fokus heller, pulst mit der Kick). */
  setLight(i: number, glow: number, pulse: number): void {
    if (i >= MAX_LIGHTS - 1 || this.lightBase[i] === undefined) return;
    this.u.uLCol.value[i].w = this.lightBase[i] * (0.45 + 0.75 * glow) * pulse;
  }

  get skyMaterial(): ShaderMaterial {
    return this.sky;
  }

  private keepGeo<T extends BufferGeometry>(g: T): T {
    this.geos.push(g);
    return g;
  }
  private keepMat<T extends Material>(m: T): T {
    this.mats.push(m);
    return m;
  }

  // ------------------------------------------------------------------ Umgebung

  private addStars(): void {
    const r = rng(7);
    const n = 420;
    const pos = new Float32Array(n * 3);
    const br = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const az = r() * Math.PI * 2;
      const el = 0.06 + Math.pow(r(), 0.8) * 1.4;
      const c = Math.cos(el);
      pos[i * 3] = Math.sin(az) * c;
      pos[i * 3 + 1] = Math.sin(el);
      pos[i * 3 + 2] = Math.cos(az) * c;
      br[i] = 0.2 + r() * 0.8;
    }
    const g = this.keepGeo(new BufferGeometry());
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('aB', new BufferAttribute(br, 1));
    const p = new Points(g, this.keepMat(createStarMaterial(this.u)));
    p.frustumCulled = false;
    p.renderOrder = -9;
    this.scene.add(p);
  }

  private addSparks(): void {
    const r = rng(11);
    const n = 150;
    const seed = new Float32Array(n * 4);
    const col = new Float32Array(n * 3);
    const cols: Rgb[] = [PAL.cyan, PAL.magenta, PAL.gold, PAL.white];
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2;
      const rad = 1.5 + Math.sqrt(r()) * 13;
      seed[i * 4] = Math.sin(a) * rad;
      seed[i * 4 + 1] = r() * 9;
      seed[i * 4 + 2] = -Math.cos(a) * rad;
      seed[i * 4 + 3] = 0.12 + r() * 0.35;
      const c = cols[Math.floor(r() * 3.3) % cols.length];
      const k = 0.55 + r() * 0.5;
      col[i * 3] = c[0] * k;
      col[i * 3 + 1] = c[1] * k;
      col[i * 3 + 2] = c[2] * k;
    }
    const g = this.keepGeo(new BufferGeometry());
    // position nur für three (Bounding); die echte Lage rechnet der Shader aus aSeed.
    g.setAttribute('position', new BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('aSeed', new BufferAttribute(seed, 4));
    g.setAttribute('aColor', new BufferAttribute(col, 3));
    const p = new Points(g, this.keepMat(createSparkMaterial(this.u)));
    p.frustumCulled = false;
    this.scene.add(p);
  }

  private buildRoof(b: MeshBuilder): void {
    b.group = NO_GROUP;
    b.resetFrame();
    // Boden in Ringen (Vertex-Licht/Fog brauchen Stützstellen).
    const rings = [0, 1.7, 4, 7, 10, 12.4, 13.6];
    for (let i = 0; i < rings.length - 1; i++) b.ring(0, 0, 0, rings[i], rings[i + 1], 64, PAL.floor, EMIT.lit, MODE.floor);
    // Startplatte in der Mitte (Startgrün wie im Level).
    b.prism(0, 0, 0, 0.1, 1.55, 1.55, 24, mul(PAL.dark, 1.2), EMIT.lit, MODE.plain, true);
    b.ring(0, 0, 0.105, 1.3, 1.5, 48, PAL.green, EMIT.pulse);
    b.ring(0, 0, 0.105, 0.5, 0.58, 32, mul(PAL.green, 0.8), EMIT.glow);
    // Bordstein + Brüstung mit Neon-Oberkante.
    b.prism(0, 0, 0, 0.18, 13.95, 13.95, 72, PAL.wall, EMIT.lit, MODE.plain, false);
    b.ring(0, 0, 0.18, 13.6, 13.95, 72, mul(PAL.wall, 0.9));
    b.ring(0, 0, 0.185, 13.6, 13.68, 72, PAL.cyan, EMIT.pulse);
    b.prism(0, 0, 0.18, 1.05, 14.35, 14.35, 72, mul(PAL.wall, 0.8), EMIT.lit, MODE.plain, false);
    b.ring(0, 0, 1.05, 13.95, 14.35, 72, mul(PAL.wall, 1.1));
    b.ring(0, 0, 1.055, 14.0, 14.12, 72, PAL.magenta, EMIT.pulse);
    // Innenseite der Brüstung (Normale zur Mitte) — das Prisma oben zeigt nur nach außen.
    for (let i = 0; i < 72; i++) {
      const a0 = (i / 72) * Math.PI * 2;
      const a1 = ((i + 1) / 72) * Math.PI * 2;
      const r = 13.95;
      b.quad(
        Math.sin(a0) * r, 0.18, -Math.cos(a0) * r,
        Math.sin(a1) * r, 0.18, -Math.cos(a1) * r,
        Math.sin(a1) * r, 1.05, -Math.cos(a1) * r,
        Math.sin(a0) * r, 1.05, -Math.cos(a0) * r,
        mul(PAL.wall, 0.75),
      );
    }
    // Fassade des eigenen Turms nach unten (sieht man im Anflug).
    b.prism(0, 0, -70, 0.18, 14.4, 14.4, 24, PAL.city, EMIT.lit, MODE.windows, false);
    // Dach-Kram zwischen den Stationen: Lüftungskästen, Mast mit Blinklicht, Lichterkette.
    const r = rng(23);
    for (let i = 0; i < 9; i++) {
      const a = Math.PI * 0.72 + (i / 8) * Math.PI * 0.56;
      const rad = 11.5 + r() * 1.4;
      b.setFrame(Math.sin(a) * rad, 0, -Math.cos(a) * rad, a);
      const w = 1 + r() * 1.2;
      const hh = 0.6 + r() * 0.9;
      b.box(0, hh / 2, 0, w, hh, 0.9 + r() * 0.6, mix(PAL.metal, PAL.wall, 0.5));
      b.box(0, hh + 0.04, 0, w * 0.7, 0.08, 0.5, mul(PAL.steel, 0.8));
      if (i % 3 === 1) b.box(0, hh * 0.5, 0.5, w * 0.6, 0.06, 0.02, PAL.cyan, EMIT.glow, MODE.flicker);
    }
    b.resetFrame();
    // Antennenmast hinten (Gegenrichtung zu den Portalen).
    b.setFrame(-3, 0, 12.4, Math.PI);
    b.box(0, 4, 0, 0.18, 8, 0.18, PAL.steel);
    b.box(0, 6, 0, 1.4, 0.08, 0.08, PAL.steel);
    b.box(0, 7.2, 0, 0.9, 0.08, 0.08, PAL.steel);
    b.box(0, 8.1, 0, 0.22, 0.22, 0.22, PAL.red, EMIT.pulse, MODE.flicker);
    b.resetFrame();
    this.buildStringLights(b);
  }

  /** Lichterketten zwischen Masten hinter den Stationen — warm, pulst mit der Kick. */
  private buildStringLights(b: MeshBuilder): void {
    const poles: number[] = [];
    for (let i = 0; i <= 12; i++) poles.push(-Math.PI * 0.82 + (i / 12) * Math.PI * 1.64);
    const rad = 14.7;
    const top = 4.6;
    const cols: Rgb[] = [PAL.gold, PAL.magenta, PAL.cyan, PAL.orange];
    let k = 0;
    for (let i = 0; i < poles.length; i++) {
      const a = poles[i];
      b.setFrame(Math.sin(a) * rad, 0, -Math.cos(a) * rad, a);
      b.box(0, top / 2, 0, 0.09, top, 0.09, mul(PAL.steel, 0.7));
      b.resetFrame();
      if (i === poles.length - 1) break;
      const a1 = poles[i + 1];
      const n = 9;
      for (let j = 1; j < n; j++) {
        const t = j / n;
        const aa = a + (a1 - a) * t;
        const sag = Math.sin(t * Math.PI) * 0.7;
        const x = Math.sin(aa) * rad;
        const z = -Math.cos(aa) * rad;
        const c = cols[k++ % cols.length];
        b.box(x, top - sag, z, 0.09, 0.11, 0.09, c, EMIT.pulse);
      }
      // Kabel: dünne dunkle Stücke zwischen den Birnen.
      for (let j = 0; j < n; j++) {
        const t0 = j / n;
        const t1 = (j + 1) / n;
        const p0a = a + (a1 - a) * t0;
        const p1a = a + (a1 - a) * t1;
        const y0 = top - Math.sin(t0 * Math.PI) * 0.7;
        const y1 = top - Math.sin(t1 * Math.PI) * 0.7;
        const x0 = Math.sin(p0a) * rad, z0 = -Math.cos(p0a) * rad;
        const x1 = Math.sin(p1a) * rad, z1 = -Math.cos(p1a) * rad;
        b.quad(x0, y0 - 0.015, z0, x1, y1 - 0.015, z1, x1, y1 + 0.015, z1, x0, y0 + 0.015, z0, PAL.dark);
      }
    }
  }

  private buildCity(b: MeshBuilder): void {
    b.group = NO_GROUP;
    const r = rng(1234);
    for (let i = 0; i < 230; i++) {
      const a = r() * Math.PI * 2;
      const rad = 42 + Math.pow(r(), 0.7) * 185;
      // Vorn (Portal-Richtung) etwas lichter, damit die Plakatwand frei steht.
      const front = Math.abs(Math.atan2(Math.sin(a - Math.PI), Math.cos(a - Math.PI))) < 0.3 && rad < 110;
      if (front) continue;
      const w = 6 + r() * 14;
      const d = 6 + r() * 14;
      // Viele Dächer über der Brüstung: die Skyline steht hinter den Portalen (sonst nur leerer Himmel).
      // Gestaffelt: nah knapp über der Brüstung, fern hoch (der Fog macht sie zu Silhouetten vor dem Abendrot).
      const top = rad < 75 ? -26 + Math.pow(r(), 1.5) * 30 : rad < 130 ? -22 + Math.pow(r(), 1.5) * 46 : -16 + Math.pow(r(), 1.5) * 62;
      const yaw = a + (r() - 0.5) * 0.4;
      b.setFrame(Math.sin(a) * rad, 0, -Math.cos(a) * rad, yaw);
      const base = -90;
      const tone = mix(PAL.city, PAL.wall, r() * 0.35);
      b.box(0, (top + base) / 2, 0, w, top - base, d, tone, EMIT.lit, MODE.windows, 63 & ~8);
      // Dachkante leuchtet bei manchen (lesbare Silhouette gegen den Himmel).
      if (r() < 0.35) {
        const c = r() < 0.5 ? PAL.magenta : PAL.cyan;
        b.box(0, top + 0.15, d / 2, w, 0.3, 0.3, c, EMIT.glow, MODE.plain, 63);
      }
      if (r() < 0.25) {
        b.box(0, top + 2.5, 0, 0.4, 5, 0.4, PAL.steel);
        b.box(0, top + 5.2, 0, 0.7, 0.7, 0.7, PAL.red, EMIT.glow, MODE.flicker);
      }
    }
    b.resetFrame();
  }

  private buildBillboardFrame(main: MeshBuilder): void {
    let b = main;
    const { x, y, z, w } = BILLBOARD;
    const h = w / 3;
    const yaw = Math.atan2(x, -z);
    b.group = NO_GROUP;
    b.setFrame(x, 0, z, yaw);
    // Turm unter der Wand + Gerüst.
    b.box(0, (y - h / 2 - 2 - 90) / 2, -3, 26, y - h / 2 - 2 + 90, 18, mix(PAL.city, PAL.wall, 0.2), EMIT.lit, MODE.windows, 63 & ~8);
    b.resetFrame();
    // Die Wand selbst nur im Anflug zeigen: von den Stationen aus läge sie angeschnitten am Bildrand (Lab/Ausweis, 32:9).
    const f = new MeshBuilder();
    f.setFrame(x, 0, z, yaw);
    b = f;
    b.box(0, y - h / 2 - 1.2, -1, w + 4, 1.6, 3, PAL.dark);
    for (let i = -2; i <= 2; i++) b.box((i * w) / 4.4, y - h / 2 - 0.2, -1.2, 0.6, 1.8, 0.6, PAL.steel);
    b.box(0, y, -1.6, w + 2, h + 2, 0.8, mul(PAL.dark, 0.6));
    // Rahmen: Cyan oben/unten, Magenta seitlich.
    b.box(0, y + h / 2 + 0.9, -1.1, w + 2.4, 0.4, 0.4, PAL.cyan, EMIT.pulse);
    b.box(0, y - h / 2 - 0.9, -1.1, w + 2.4, 0.4, 0.4, PAL.cyan, EMIT.pulse);
    b.box(-w / 2 - 1.1, y, -1.1, 0.4, h + 2.2, 0.4, PAL.magenta, EMIT.pulse);
    b.box(w / 2 + 1.1, y, -1.1, 0.4, h + 2.2, 0.4, PAL.magenta, EMIT.pulse);
    // Strahler unten.
    for (let i = -1; i <= 1; i++) b.box((i * w) / 3, y - h / 2 - 1.9, 0.4, 0.9, 0.5, 0.9, PAL.gold, EMIT.glow);
    const fm = new Mesh(this.keepGeo(f.build()), this.lit);
    fm.frustumCulled = false;
    this.billboardGroup.add(fm);
    this.scene.add(this.billboardGroup);
  }

  setBillboardVisible(v: boolean): void {
    this.billboardGroup.visible = v;
  }

  /** Logo auf die Plakatwand (sobald das PNG geladen ist). */
  setLogo(tex: CanvasTexture, aspect: number): void {
    if (this.billboard) return;
    const { x, y, z, w } = BILLBOARD;
    const g = this.keepGeo(new PlaneGeometry(w, w / aspect));
    const m = this.keepMat(createSignMaterial(this.u, tex, { color: PAL.white, tint: 0, flicker: 3.7 }));
    m.uniforms.uGlow.value = 0.75;
    const mesh = new Mesh(g, m);
    mesh.position.set(x, y, z);
    mesh.rotation.y = -Math.atan2(x, -z);
    this.billboardGroup.add(mesh);
    this.billboard = mesh;
  }

  // ------------------------------------------------------------------ Stationen

  private stationBox(st: Station): Box3 {
    const box = new Box3();
    const p = { x: 0, y: 0, z: 0 };
    const hw = st.kind === 'portal' ? 1.45 : 1.7;
    const top = st.kind === 'portal' ? 4.2 : 3.2;
    for (const x of [-hw, hw]) for (const y of [0, top]) for (const z of [-1, 1.1]) {
      localToWorld(st, x, y, z, p);
      box.expandByPoint(new Vector3(p.x, p.y, p.z));
    }
    return box;
  }

  private sign(text: string, px: number, height: number, st: Station, x: number, y: number, z: number, color: Rgb, flicker: number): ShaderMaterial {
    const t = textTexture(text, px);
    this.texts.push(t);
    this.texs.push(t.tex);
    const g = this.keepGeo(new PlaneGeometry(height * t.aspect, height));
    const m = this.keepMat(createSignMaterial(this.u, t.tex, { color, tint: 1, flicker }));
    const mesh = new Mesh(g, m);
    const p = { x: 0, y: 0, z: 0 };
    localToWorld(st, x, y, z, p);
    mesh.position.set(p.x, p.y, p.z);
    mesh.rotation.y = -st.angle;
    this.scene.add(mesh);
    return m;
  }

  private spin(obj: Object3D, speed: number, bob: number, phase: number): void {
    this.scene.add(obj);
    this.spinners.push({ obj, speed, bobY: bob, baseY: obj.position.y, phase, sway: 0 });
  }

  private buildPortal(b: MeshBuilder, st: Station, gi: number, ctx: FrontDoorContext): void {
    const lv = ctx.levels[st.level];
    const th = levelTheme(lv.id, st.level);
    const wall = mix(PAL.wall, th.skyHorizon, 0.12);
    // Sockel mit Stufe + Trim.
    b.box(0, 0.12, 0, 3.0, 0.24, 1.5, mul(PAL.dark, 1.3));
    b.box(0, 0.245, 0.74, 3.0, 0.04, 0.04, th.trim, EMIT.pulse);
    b.box(0, 0.06, 1.0, 2.2, 0.12, 0.5, mul(PAL.dark, 1.15));
    b.box(0, 0.125, 1.25, 2.2, 0.03, 0.03, mul(th.trim, 0.8), EMIT.glow);
    // Säulen.
    for (const s of [-1, 1]) {
      b.box(s * 1.17, 1.77, 0, 0.44, 3.06, 0.56, wall);
      b.box(s * 0.965, 1.77, 0.29, 0.05, 3.0, 0.03, th.trim, EMIT.pulse);
      b.box(s * 1.385, 1.77, 0.29, 0.03, 3.0, 0.03, th.trimAlt, EMIT.glow);
      // Kabel/Rippen auf der Säule.
      for (let k = 0; k < 4; k++) b.box(s * 1.17, 0.7 + k * 0.7, 0.29, 0.3, 0.06, 0.02, mul(wall, 0.6));
      // Lämpchen außen.
      b.box(s * 1.44, 3.0, 0, 0.06, 0.18, 0.18, th.trimAlt, EMIT.pulse, MODE.flicker);
    }
    // Sturz mit Nummernfeld.
    b.box(0, 3.55, 0, 2.8, 0.5, 0.6, wall);
    b.box(0, 3.29, 0.3, 1.9, 0.03, 0.03, th.trim, EMIT.pulse);
    b.box(0, 3.81, 0.3, 2.8, 0.03, 0.03, th.trimAlt, EMIT.glow);
    b.box(0, 3.55, 0.29, 1.2, 0.4, 0.02, mul(PAL.dark, 0.7));
    // Krone: schräge Kappe.
    b.box(0, 3.86, 0, 2.2, 0.12, 0.44, mul(wall, 0.8));
    b.box(0, 3.95, 0, 1.0, 0.08, 0.3, mul(wall, 0.7));
    // Leuchtende Schwelle auf dem Boden.
    b.box(0, 0.006, 1.2, 1.7, 0.012, 0.08, mul(th.trim, 0.7), EMIT.pulse);
    // Portal-Fläche (eigene Shader-Fläche).
    const pw = 1.88;
    const ph = 3.0;
    const g = this.keepGeo(new PlaneGeometry(pw, ph));
    const m = this.keepMat(createPortalMaterial(this.u, th, pw / ph, st.level * 0.37));
    const mesh = new Mesh(g, m);
    const p = { x: 0, y: 0, z: 0 };
    localToWorld(st, 0, 0.24 + ph / 2, 0.02, p);
    mesh.position.set(p.x, p.y, p.z);
    mesh.rotation.y = -st.angle;
    this.scene.add(mesh);
    this.portalMats.push(m);
    // Nummer auf dem Sturz.
    this.signMats[gi] = this.sign(lv.num, 32, 0.34, st, 0, 3.55, 0.31, th.trim, 0);
    // Medaille schwebt über der Krone.
    if (lv.medal) {
      const coin = new MeshBuilder();
      coin.group = gi;
      const c = MEDAL_RGB[lv.medal];
      coin.prism(0, 0, -0.035, 0.035, 0.2, 0.2, 12, c, EMIT.glow, MODE.plain, true);
      coin.prism(0, 0, -0.045, 0.045, 0.12, 0.12, 12, mul(c, 0.7), EMIT.glow, MODE.plain, true);
      const cm = new Mesh(this.keepGeo(coin.build()), this.lit);
      cm.rotation.x = Math.PI / 2;
      const pivot = new Object3D();
      pivot.add(cm);
      localToWorld(st, 0, 4.32, 0, p);
      pivot.position.set(p.x, p.y, p.z);
      this.spin(pivot, 1.3, 0.05, st.level);
    }
  }

  private buildTraining(b: MeshBuilder): void {
    const green = PAL.green;
    // Boden-Pad mit Startlinie.
    b.box(0, 0.03, 0.2, 3.6, 0.06, 2.4, mul(PAL.dark, 1.25));
    b.box(0, 0.065, 1.38, 3.6, 0.02, 0.04, green, EMIT.pulse);
    b.box(0, 0.065, -0.98, 3.6, 0.02, 0.04, mul(green, 0.6), EMIT.glow);
    // Treppe aus schwebenden Blöcken (Bhop-Kette) mit Neon-Oberkanten.
    const steps = [
      [-1.35, 0.45, 0.6],
      [-0.45, 0.85, 0.1],
      [0.45, 1.25, -0.25],
    ];
    for (const [x, y, z] of steps) {
      b.box(x, y - 0.1, z, 0.72, 0.2, 0.72, mix(PAL.wall, hex('#3a4a9a'), 0.5));
      b.box(x, y + 0.005, z + 0.36, 0.72, 0.03, 0.03, green, EMIT.pulse);
      b.box(x, y + 0.005, z - 0.36, 0.72, 0.03, 0.03, mul(green, 0.7), EMIT.glow);
      b.box(x - 0.36, y + 0.005, z, 0.03, 0.03, 0.72, mul(green, 0.85), EMIT.glow);
      b.box(x + 0.36, y + 0.005, z, 0.03, 0.03, 0.72, mul(green, 0.85), EMIT.glow);
      b.box(x, (y - 0.2) / 2, z, 0.08, y - 0.2, 0.08, mul(PAL.steel, 0.6));
    }
    // Surf-Rampe rechts (Keil, blau wie L3): zwei schräge Flanken.
    const rx = 1.3, ry0 = 0.06, ry1 = 1.05, rz0 = -1.0, rz1 = 0.9;
    const blue = hex('#2a3cff');
    b.quad(rx - 0.55, ry0, rz1, rx, ry1, rz1, rx, ry1, rz0, rx - 0.55, ry0, rz0, blue);
    b.quad(rx, ry1, rz1, rx + 0.55, ry0, rz1, rx + 0.55, ry0, rz0, rx, ry1, rz0, mul(blue, 0.7));
    b.quad(rx - 0.55, ry0, rz1, rx + 0.55, ry0, rz1, rx, ry1, rz1, rx, ry1, rz1, mul(blue, 0.55));
    b.box(rx, ry1 + 0.01, (rz0 + rz1) / 2, 0.03, 0.03, rz1 - rz0, PAL.cyan, EMIT.pulse);
    // Sprungbogen als Punktspur (zeigt den Hop von Block zu Block).
    for (let i = 0; i < 3; i++) {
      const [x0, y0, z0] = i === 0 ? [-1.7, 0.08, 1.0] : steps[i - 1];
      const [x1, y1, z1] = steps[i];
      for (let k = 1; k < 6; k++) {
        const t = k / 6;
        const x = x0 + (x1 - x0) * t;
        const z = z0 + (z1 - z0) * t;
        const y = y0 + (y1 - y0) * t + Math.sin(t * Math.PI) * 0.45 + 0.12;
        b.box(x, y, z, 0.05, 0.05, 0.05, PAL.gold, EMIT.pulse);
      }
    }
    // Terminal links vorn.
    b.box(-1.55, 0.55, -0.6, 0.5, 1.1, 0.4, PAL.metal);
    b.box(-1.55, 1.18, -0.55, 0.56, 0.36, 0.5, mul(PAL.metal, 0.8));
    b.box(-1.55, 1.18, -0.29, 0.44, 0.26, 0.02, mul(green, 0.9), EMIT.glow, MODE.screen);
  }

  private buildLocker(b: MeshBuilder): void {
    const metal = mix(PAL.metal, hex('#3a3f7a'), 0.4);
    b.box(0, 0.06, 0.1, 3.2, 0.12, 1.6, mul(PAL.dark, 1.2));
    for (let i = -1; i <= 1; i++) {
      const x = i * 0.82;
      // Mittlerer Spind ohne Front (offen), sonst verdeckt der Quader das Innere.
      b.box(x, 1.17, -0.4, 0.78, 2.1, 0.6, metal, EMIT.lit, MODE.plain, i === 0 ? 63 & ~16 : 63);
      b.box(x, 2.24, -0.4, 0.8, 0.04, 0.62, mul(PAL.steel, 0.9));
      if (i === 0) continue;
      // Tür: Lüftungsschlitze, Griff, Nummernfeld.
      for (let k = 0; k < 4; k++) b.box(x, 1.95 - k * 0.07, -0.09, 0.4, 0.03, 0.02, mul(PAL.dark, 0.8));
      b.box(x + 0.28, 1.2, -0.08, 0.04, 0.2, 0.04, PAL.steel);
      b.box(x, 1.6, -0.09, 0.16, 0.1, 0.02, i < 0 ? PAL.cyan : PAL.gold, EMIT.glow);
    }
    // Mittlerer Spind offen: Innen leuchtet Magenta, darin hängt der Handschuh des Spiels.
    b.box(0, 1.17, -0.68, 0.7, 2.0, 0.02, mul(PAL.magenta, 0.55), EMIT.glow);
    b.box(-0.37, 1.17, -0.4, 0.02, 2.0, 0.56, mul(PAL.magenta, 0.3), EMIT.glow);
    b.box(0.37, 1.17, -0.4, 0.02, 2.0, 0.56, mul(PAL.magenta, 0.3), EMIT.glow);
    b.box(0, 2.05, -0.4, 0.66, 0.03, 0.03, PAL.steel);
    const white = hex('#e8e6f4');
    // Handschuh (Faust nach unten, weiß mit schwarzem Band, wie das Viewmodel).
    b.box(0, 1.92, -0.4, 0.03, 0.12, 0.03, PAL.steel);
    b.box(0, 1.72, -0.42, 0.24, 0.26, 0.12, white);
    b.box(0, 1.56, -0.42, 0.26, 0.07, 0.13, hex('#101018'));
    b.box(0, 1.38, -0.42, 0.28, 0.28, 0.16, white);
    for (let k = 0; k < 4; k++) b.box(-0.105 + k * 0.07, 1.18, -0.36, 0.06, 0.16, 0.08, white);
    b.box(0.17, 1.36, -0.36, 0.08, 0.16, 0.08, white);
    // Tür des mittleren Spinds steht offen (rechts angeschlagen, zeigt zur Kamera).
    b.box(0.38 + 0.02, 1.17, -0.1 + 0.36, 0.04, 2.0, 0.7, mul(metal, 0.85));
    b.box(0.4, 1.17, 0.22, 0.05, 1.9, 0.02, PAL.magenta, EMIT.pulse, MODE.flicker);
    // Bank davor.
    b.box(0, 0.42, 0.75, 2.4, 0.08, 0.42, mix(PAL.wall, PAL.orange, 0.25));
    for (const s of [-1, 1]) b.box(s * 1.05, 0.2, 0.75, 0.08, 0.36, 0.34, PAL.steel);
  }

  private buildKiosk(b: MeshBuilder, st: Station, ctx: FrontDoorContext): void {
    const acc = ctx.account;
    const blurple = hex('#5865f2');
    const accent = acc.dev ? PAL.gold : PAL.magenta;
    b.box(0, 0.06, 0.1, 2.6, 0.12, 1.8, mul(PAL.dark, 1.2));
    // Säule mit schrägem Bildschirm.
    b.box(0, 0.62, -0.3, 0.8, 1.24, 0.6, PAL.metal);
    b.box(0, 1.37, -0.38, 0.9, 0.3, 0.7, mul(PAL.metal, 0.85));
    b.box(0, 1.37, -0.02, 0.72, 0.2, 0.02, PAL.cyan, EMIT.glow, MODE.screen);
    b.box(0, 0.9, 0.0, 0.5, 0.06, 0.02, accent, EMIT.pulse);
    // Kartenschlitz + Status-LED (grün angemeldet, Blurple: Login möglich, grau offline).
    b.box(0, 0.62, 0.0, 0.34, 0.04, 0.02, PAL.dark);
    const led = acc.signedIn ? PAL.green : acc.loginRequired ? blurple : mul(PAL.steel, 0.6);
    b.box(0.3, 0.62, 0.0, 0.06, 0.06, 0.02, led, EMIT.pulse);
    // Seitenstelen mit Neon.
    for (const s of [-1, 1]) {
      b.box(s * 1.05, 1.3, -0.5, 0.12, 2.6, 0.12, mul(PAL.steel, 0.8));
      b.box(s * 1.05, 1.3, -0.43, 0.04, 2.5, 0.02, accent, EMIT.pulse, MODE.flicker);
    }
    // Schwebender Ausweis (dreht sich langsam).
    const card = new MeshBuilder();
    const gi = this.stations.indexOf(st);
    card.group = gi;
    card.box(0, 0, 0, 0.86, 0.54, 0.02, hex('#e9e4ff'), EMIT.glow);
    card.box(0, 0.2, 0.012, 0.86, 0.12, 0.005, accent, EMIT.glow);
    card.box(-0.24, -0.05, 0.012, 0.26, 0.3, 0.005, acc.signedIn ? blurple : mul(PAL.steel, 0.8), EMIT.glow);
    for (let k = 0; k < 3; k++) card.box(0.16, 0.04 - k * 0.09, 0.012, 0.38 - k * 0.08, 0.04, 0.005, mul(PAL.dark, 1.6), EMIT.glow);
    card.box(0, 0, -0.012, 0.86, 0.54, 0.005, mul(accent, 0.8), EMIT.glow);
    const cm = new Mesh(this.keepGeo(card.build()), this.lit);
    const p = { x: 0, y: 0, z: 0 };
    localToWorld(st, 0, 2.25, -0.1, p);
    cm.position.set(p.x, p.y, p.z);
    cm.rotation.y = -st.angle;
    // Pendelt nur (Vorderseite bleibt lesbar zur Kamera).
    this.scene.add(cm);
    this.spinners.push({ obj: cm, speed: 0.7, bobY: 0.06, baseY: cm.position.y, phase: -st.angle, sway: 0.45 });
  }

  private buildTrophies(b: MeshBuilder, ctx: FrontDoorContext): void {
    // Wand mit Rahmen, Rang-Bildschirm oben, Regal mit einem Pokal je Level.
    b.box(0, 1.5, -0.55, 3.7, 3.0, 0.2, mix(PAL.wall, PAL.dark, 0.3));
    b.box(0, 3.02, -0.44, 3.7, 0.04, 0.04, PAL.cyan, EMIT.pulse);
    b.box(0, 0.02, -0.44, 3.7, 0.04, 0.04, PAL.cyan, EMIT.glow);
    for (const s of [-1, 1]) b.box(s * 1.85, 1.5, -0.44, 0.04, 3.0, 0.04, PAL.magenta, EMIT.glow);
    // Rang-Bildschirm: Balken absteigend (Bestenliste als Grafik).
    b.box(0, 2.35, -0.44, 2.6, 0.92, 0.04, mul(PAL.dark, 0.6));
    const bars: Rgb[] = [PAL.gold, PAL.steel, MEDAL_RGB.bronze, PAL.cyan, PAL.cyan];
    for (let k = 0; k < 5; k++) {
      const len = 2.2 - k * 0.32;
      b.box(-1.1 + len / 2, 2.68 - k * 0.16, -0.41, len, 0.09, 0.01, mul(bars[k], k < 3 ? 0.95 : 0.55), EMIT.glow, MODE.screen);
    }
    // Regal.
    b.box(0, 1.05, -0.3, 3.3, 0.07, 0.5, mul(PAL.steel, 0.75));
    b.box(0, 1.01, -0.05, 3.3, 0.03, 0.02, PAL.gold, EMIT.glow);
    const n = Math.max(1, ctx.levels.length);
    for (let i = 0; i < ctx.levels.length; i++) {
      const lv = ctx.levels[i];
      const x = -1.25 + (2.5 * (i + 0.5)) / n;
      const have = lv.medal !== null;
      const c: Rgb = lv.medal ? MEDAL_RGB[lv.medal] : mul(PAL.steel, 0.45);
      const em = have ? EMIT.glow : EMIT.lit;
      b.prism(x, -0.3, 1.09, 1.16, 0.13, 0.11, 8, mul(PAL.dark, 1.5));
      b.prism(x, -0.3, 1.16, 1.3, 0.04, 0.04, 6, c, em);
      b.prism(x, -0.3, 1.3, 1.56, 0.06, 0.15, 8, c, em, MODE.plain, false);
      b.prism(x, -0.3, 1.56, 1.6, 0.15, 0.15, 8, mul(c, 0.8), em);
      // Henkel.
      for (const s of [-1, 1]) b.box(x + s * 0.17, 1.46, -0.3, 0.04, 0.12, 0.04, c, em);
    }
    b.box(0, 0.06, 0.25, 3.4, 0.12, 1.2, mul(PAL.dark, 1.2));
  }

  private buildWorkbench(b: MeshBuilder, st: Station): void {
    const wood = mix(PAL.wall, PAL.orange, 0.22);
    // Tisch.
    b.box(0, 0.92, -0.2, 2.8, 0.08, 1.0, wood);
    b.box(0, 0.88, 0.31, 2.8, 0.02, 0.02, PAL.cyan, EMIT.glow);
    for (const sx of [-1.3, 1.3]) for (const sz of [-0.6, 0.2]) b.box(sx, 0.44, sz, 0.08, 0.88, 0.08, PAL.steel);
    // Röhrenmonitor.
    b.box(-0.35, 1.33, -0.35, 0.86, 0.7, 0.62, mix(PAL.metal, PAL.white, 0.2));
    b.box(-0.35, 1.33, -0.03, 0.7, 0.54, 0.02, hex('#1a3a5a'));
    b.box(-0.35, 1.33, -0.01, 0.62, 0.46, 0.02, mul(PAL.green, 0.75), EMIT.glow, MODE.screen);
    b.box(-0.35, 0.99, -0.3, 0.4, 0.06, 0.3, mix(PAL.metal, PAL.white, 0.15));
    // Tastatur mit leuchtenden Tasten (WASD in Magenta).
    b.box(-0.3, 0.985, 0.08, 0.9, 0.05, 0.28, mul(PAL.metal, 0.9));
    for (let r = 0; r < 3; r++) for (let k = 0; k < 9; k++) {
      const wasd = (r === 0 && k === 2) || (r === 1 && k >= 1 && k <= 3);
      b.box(-0.68 + k * 0.095, 1.02, 0.0 + r * 0.08, 0.07, 0.02, 0.06, wasd ? PAL.magenta : mul(PAL.steel, 0.7), wasd ? EMIT.pulse : EMIT.lit);
    }
    // Schreibtischlampe.
    b.box(0.95, 1.0, -0.4, 0.3, 0.06, 0.3, PAL.steel);
    b.box(0.95, 1.35, -0.4, 0.05, 0.7, 0.05, PAL.steel);
    b.prism(0.95, -0.25, 1.48, 1.7, 0.18, 0.06, 6, mul(PAL.gold, 0.85), EMIT.lit);
    b.box(0.95, 1.47, -0.25, 0.22, 0.02, 0.22, PAL.gold, EMIT.glow);
    // Lichtkegel auf dem Tisch.
    b.box(0.95, 0.965, -0.2, 0.5, 0.005, 0.5, mul(PAL.gold, 0.45), EMIT.glow);
    // Wand-Tafel mit Werkzeug.
    b.box(0, 2.0, -0.78, 2.8, 1.5, 0.06, mul(PAL.wall, 0.85));
    for (let k = 0; k < 18; k++) b.box(-1.3 + (k % 9) * 0.32, 1.45 + Math.floor(k / 9) * 1.1, -0.74, 0.03, 0.03, 0.02, mul(PAL.dark, 0.8));
    b.box(-0.9, 2.1, -0.73, 0.06, 0.6, 0.03, PAL.steel);
    b.box(-0.9, 2.42, -0.73, 0.22, 0.1, 0.03, PAL.steel);
    b.box(-0.55, 2.05, -0.73, 0.05, 0.5, 0.03, PAL.red);
    // Zahnrad dreht sich (eigenes Mesh).
    const gear = new MeshBuilder();
    gear.group = this.stations.indexOf(st);
    gear.prism(0, 0, -0.04, 0.04, 0.28, 0.28, 10, PAL.cyan, EMIT.glow);
    gear.prism(0, 0, -0.05, 0.05, 0.1, 0.1, 8, mul(PAL.dark, 1.5));
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      gear.box(Math.sin(a) * 0.32, 0, Math.cos(a) * 0.32, 0.12, 0.08, 0.12, PAL.cyan, EMIT.glow);
    }
    const gm = new Mesh(this.keepGeo(gear.build()), this.lit);
    gm.rotation.x = Math.PI / 2;
    const pivot = new Object3D();
    const holder = new Object3D();
    holder.add(gm);
    pivot.add(holder);
    const p = { x: 0, y: 0, z: 0 };
    localToWorld(st, 0.55, 2.15, -0.66, p);
    pivot.position.set(p.x, p.y, p.z);
    pivot.rotation.y = -st.angle;
    this.scene.add(pivot);
    // Dreht um die eigene Achse (z der Wand): holder.rotation.z im Frame.
    this.spinners.push({ obj: holder, speed: -0.5, bobY: 0, baseY: 0, phase: -1, sway: 0 });
  }

  private buildLabDoor(b: MeshBuilder): void {
    // Wandstück mit Stahltür, Warnstreifen, rote Lampe, Tastenfeld, Sicherungskasten (Admin).
    b.box(0, 1.5, -0.4, 3.2, 3.0, 0.4, mix(PAL.wall, PAL.dark, 0.2));
    b.box(0, 3.02, -0.18, 3.2, 0.04, 0.04, PAL.magenta, EMIT.glow);
    b.box(0, 1.1, -0.19, 1.3, 2.25, 0.04, PAL.dark, EMIT.lit, MODE.hazard);
    b.box(0, 1.05, -0.16, 1.0, 2.05, 0.06, mix(PAL.metal, PAL.steel, 0.3));
    b.box(0, 1.6, -0.12, 0.5, 0.3, 0.02, hex('#0b1a2a'));
    b.box(0, 1.6, -0.11, 0.42, 0.22, 0.02, mul(PAL.cyan, 0.7), EMIT.glow, MODE.screen);
    b.box(0.38, 1.0, -0.12, 0.08, 0.2, 0.05, PAL.steel);
    b.prism(0, -0.3, 2.32, 2.48, 0.12, 0.1, 8, PAL.red, EMIT.pulse, MODE.flicker);
    // Tastenfeld.
    b.box(0.85, 1.25, -0.18, 0.22, 0.32, 0.04, PAL.metal);
    for (let k = 0; k < 6; k++) b.box(0.8 + (k % 2) * 0.1, 1.32 - Math.floor(k / 2) * 0.08, -0.155, 0.06, 0.05, 0.01, k === 5 ? PAL.green : mul(PAL.steel, 0.7), k === 5 ? EMIT.pulse : EMIT.lit);
    // Sicherungskasten (Admin) unten links.
    b.box(-1.1, 0.75, -0.16, 0.55, 0.7, 0.08, mul(PAL.metal, 0.8));
    b.box(-1.1, 0.75, -0.115, 0.4, 0.04, 0.01, PAL.gold, EMIT.glow);
    for (let k = 0; k < 3; k++) b.box(-1.22 + k * 0.12, 0.62, -0.115, 0.06, 0.12, 0.01, k === 1 ? PAL.red : PAL.steel, k === 1 ? EMIT.glow : EMIT.lit);
    // Kabel zur Tür.
    b.box(-0.75, 2.6, -0.17, 0.9, 0.05, 0.05, PAL.dark);
    b.box(0, 0.06, 0.3, 3.2, 0.12, 1.2, mul(PAL.dark, 1.2));
  }

  private buildChevrons(): void {
    const b = new MeshBuilder();
    // Pfeile im lokalen Raum: Mitte → Portal (−z). Lauflicht über MODE 6 (Radius).
    for (let i = 0; i < 4; i++) {
      const z = -3.6 - i * 1.1;
      const w = 0.8;
      const k = 0.16;
      const c = PAL.green;
      // Ein Pfeil "^" aus zwei schrägen Balken (flach auf dem Boden).
      b.quad(-w, 0.012, z + 0.4, -w + k * 1.6, 0.012, z + 0.4, 0.0 + k * 0.6, 0.012, z - 0.05, -k * 0.6, 0.012, z - 0.05, c, EMIT.pulse, 6);
      b.quad(w - k * 1.6, 0.012, z + 0.4, w, 0.012, z + 0.4, k * 0.6, 0.012, z - 0.05, -k * 0.6 + 0.0, 0.012, z - 0.05, c, EMIT.pulse, 6);
    }
    const m = new Mesh(this.keepGeo(b.build()), this.lit);
    m.frustumCulled = false;
    this.chevrons.add(m);
    this.scene.add(this.chevrons);
  }

  /** Bewegte Kleinteile + Sonnen-/Himmelsuniforms je Frame. Keine Allokation. */
  tick(t: number, motion: boolean): void {
    for (const s of this.spinners) {
      if (s.phase < 0) {
        s.obj.rotation.z = motion ? t * s.speed : 0;
        continue;
      }
      if (s.sway > 0) s.obj.rotation.y = s.phase + (motion ? Math.sin(t * s.speed) * s.sway : 0);
      else s.obj.rotation.y = motion ? t * s.speed + s.phase : s.phase;
      s.obj.position.y = s.baseY + (motion ? Math.sin(t * 1.4 + s.phase) * s.bobY : 0);
    }
  }

  /** Station-Schild/Portal-Hervorhebung (0..1 je Station). */
  setGlow(i: number, v: number): void {
    const st = this.stations[i];
    if (st.kind === 'portal') {
      const m = this.portalMats[st.level];
      if (m) m.uniforms.uActive.value = v;
    }
    const s = this.signMats[i];
    if (s) s.uniforms.uGlow.value = v;
  }

  /** Text-Texturen neu rastern (nach dem Laden der Schrift). */
  redrawText(): void {
    for (const t of this.texts) t.redraw();
  }

  /** Liegt ein Lauf-Licht auf dem Boden? Winkel der Pfeile setzen. */
  setChevronAngle(a: number): void {
    this.chevrons.rotation.y = -a;
  }

  dispose(): void {
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    for (const t of this.texs) t.dispose();
    this.scene.clear();
  }
}

