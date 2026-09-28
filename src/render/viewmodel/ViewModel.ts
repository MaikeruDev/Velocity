import { BoxGeometry, BufferAttribute, BufferGeometry, GLSL3, Group, Mesh, PerspectiveCamera, PlaneGeometry, Points, Scene, ShaderMaterial, Vector3 } from 'three';
import type { IUniform, Material, Object3D, Texture, WebGLRenderer } from 'three';
import type { EnvironmentDef } from '../../world/level/LevelFormat';
import { VM_ARM_BASE, VM_JOINT } from '../types';
import type { ViewModelFrame, ViewModelGlove, ViewModelItem } from '../types';
import { hexToRgb } from '../util';
import { capsuleGeometry, discGeometry, smoothBoxGeometry, tubeGeometry } from './vmGeometry';
import type { Ring } from './vmGeometry';
import { createLitMaterial, createOutlineMaterial, createVmLight } from './vmMaterials';
import type { VmLightUniforms } from './vmMaterials';
import { canLabelTexture, canLidTexture, cardBackTexture, cardFrontTexture, knifeBladeTexture, knifeHandleTexture } from './vmTextures';

/**
 * 3D-View-Hand (Plan 006): prozedural modellierte Low-Poly-Hand im Stil klassischer
 * PS1/PS2-Viewmodels — weißer Handschuh, weiche Graustufen, dicke dunkle Kontur (Inverted
 * Hull), pummelige Finger, Stulpe mit schwarzem Band. Eigene Szene + eigene Kamera mit
 * festem FOV; PS2Renderer zeichnet sie NACH der Welt ins selbe Low-Res-Target (Tiefe
 * geleert), damit Dithering/Quantisierung/Raster identisch sind.
 *
 * Koordinaten der Hand (Handgelenk-Raum): Ursprung Handgelenk, +y Richtung Finger,
 * −x Daumenseite, −z Handfläche. Einheiten ~1 cm. Der Renderer ist "dumm": Posen,
 * Bewegung und Tricks kommen fertig im ViewModelFrame (ui/hand).
 */

/** Vertikales FOV der Viewmodel-Kamera — entspricht viewmodel_fov 68 (4:3 horizontal, Source). */
export const VM_FOV = 54;
/** Abstand des Handgelenks zur Kamera (Hand-Einheiten). */
export const VM_DEPTH = 40;
const TAN_HALF_FOV = Math.tan((VM_FOV * Math.PI) / 360);

// ------------------------------------------------------------------ Maße der Hand

interface FingerSpec {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly r: number;
  readonly len: readonly [number, number, number];
  /** Ruhe-Spreizung (rad), damit die Finger in 0-Pose leicht fächern. */
  readonly splay: number;
}

const FINGERS: readonly FingerSpec[] = [
  { x: -3.15, y: 8.7, z: 0.2, r: 1.62, len: [3.2, 2.2, 1.9], splay: 0.07 },
  { x: -0.95, y: 9.1, z: 0.25, r: 1.66, len: [3.5, 2.4, 2.0], splay: 0.0 },
  { x: 1.25, y: 8.8, z: 0.2, r: 1.6, len: [3.3, 2.2, 1.9], splay: -0.06 },
  { x: 3.25, y: 8.0, z: 0.1, r: 1.45, len: [2.6, 1.8, 1.7], splay: -0.13 },
];

/** Daumen: Sattelgelenk, Ruhe-Ausrichtung (ZXY, rad) und Glieder. */
const THUMB = {
  x: -3.4,
  y: 2.4,
  z: -0.8,
  baseZ: 0.62,
  baseX: -0.3,
  baseY: -0.85,
  len: [3.3, 2.5, 2.1] as const,
  r: [1.85, 1.6, 1.48] as const,
};

const SEG_FINGER = 7;
const SEG_PALM = 10;
const SEG_CUFF = 12;

// Farben
const GLOVE = {
  classic: { glove: 0xeeeef2, cuff: 0xf7f7f7, band: 0x17161c, outline: 0x0d0c14, bandEmis: 0x000000, rim: 0.3 },
  neon: { glove: 0x2c2d48, cuff: 0x23243a, band: 0x3a0f36, outline: 0x33f0ff, bandEmis: 0xc43aa8, rim: 0.7 },
} as const;
const PROP_OUTLINE = 0x0d0c14;

// ------------------------------------------------------------------ Poof-Partikel

const POOF_N = 18;
const POOF_VERT = /* glsl */ `
uniform float uT;
uniform float uSize;
in vec3 aDir;
out float vK;
void main() {
  float e = 1.0 - (1.0 - uT) * (1.0 - uT);
  vec3 p = aDir * (0.6 + 4.2 * e * (0.6 + 0.4 * fract(aDir.x * 7.3 + aDir.y * 3.1)));
  p.y += 1.4 * uT;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  vK = fract(aDir.z * 5.7 + aDir.x * 2.3);
  gl_PointSize = max(1.0, floor(uSize * (1.0 - uT) * (0.6 + 0.8 * vK) + 0.5));
}
`;
const POOF_FRAG = /* glsl */ `
uniform vec3 uA;
uniform vec3 uB;
in float vK;
out vec4 fragColor;
void main() {
  fragColor = vec4(vK > 0.5 ? uA : uB, 1.0);
}
`;

interface Part {
  readonly lit: Mesh;
  readonly hull: Mesh;
}

export class ViewModel {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(VM_FOV, 16 / 9, 0.5, 400);
  private readonly light: VmLightUniforms = createVmLight();
  private readonly outlinePx: IUniform<number> = { value: 2 };
  private readonly propPx: IUniform<number> = { value: 1.5 };
  /** Messer ist schmal: dünnere Kontur, sonst ist es nur ein schwarzer Strich. */
  private readonly knifePx: IUniform<number> = { value: 1 };

  private readonly anchor = new Group();
  private readonly motion = new Group();
  private readonly arm = new Group();
  private readonly wrist = new Group();
  private readonly fingerRoot: Group[] = [];
  private readonly fingerPip: Group[] = [];
  private readonly fingerDip: Group[] = [];
  private readonly thumbRoot = new Group();
  private readonly thumbMcp = new Group();
  private readonly thumbIp = new Group();
  private readonly socket = new Group();
  /** Innerste Drehung des Gegenstands um die eigene y-Achse (Twirl, Karten-Spin). */
  private readonly spinner = new Group();

  // Materialien je Handschuh
  private readonly mats: Record<ViewModelGlove, { glove: ShaderMaterial; cuff: ShaderMaterial; band: ShaderMaterial; outline: ShaderMaterial }>;
  private readonly gloveParts: Part[] = [];
  private readonly cuffParts: Part[] = [];
  private readonly bandParts: Part[] = [];
  private glove: ViewModelGlove = 'classic';

  // Gegenstände (lazy)
  private can: { group: Group; tab: Group; hole: Mesh } | null = null;
  private card: { group: Group; vis: IUniform<number> } | null = null;
  private knife: { group: Group; blade: Group; bite: Group } | null = null;
  private readonly poof: Points;
  private readonly poofMat: ShaderMaterial;
  private readonly geometries: BufferGeometry[] = [];
  private readonly materials: Material[] = [];
  private readonly textures: Texture[] = [];
  private lines = 270;
  /**
   * Abstand des Handgelenks zur Kamera. Spiel: VM_DEPTH. Die Menü-Vorschau rückt näher
   * heran (größere Hand im kleinen Bild) — Perspektive und Kontur bleiben dieselben.
   */
  depth = VM_DEPTH;

  constructor() {
    this.scene.matrixWorldAutoUpdate = true;
    const L = this.light;
    const mk = (g: ViewModelGlove): { glove: ShaderMaterial; cuff: ShaderMaterial; band: ShaderMaterial; outline: ShaderMaterial } => {
      const c = GLOVE[g];
      return {
        glove: this.track(createLitMaterial(L, { color: c.glove, rim: c.rim, wrap: 0.3, ink: 0.22, inkColor: c.outline })),
        cuff: this.track(createLitMaterial(L, { color: c.cuff, rim: c.rim * 0.8, wrap: 0.3 })),
        band: this.track(createLitMaterial(L, { color: c.band, rim: 0.15, wrap: 0.5, emissive: c.bandEmis })),
        outline: this.track(createOutlineMaterial(L, c.outline, this.outlinePx)),
      };
    };
    this.mats = { classic: mk('classic'), neon: mk('neon') };

    this.scene.add(this.anchor);
    this.anchor.add(this.motion);
    this.motion.rotation.order = 'YXZ';
    this.motion.add(this.arm);
    this.arm.rotation.order = 'ZXY';
    this.arm.rotation.set(VM_ARM_BASE.pitch, VM_ARM_BASE.twist, VM_ARM_BASE.roll);
    this.arm.add(this.wrist);
    this.wrist.rotation.order = 'ZXY';
    this.buildSleeve();
    this.buildHand();
    this.wrist.add(this.socket);
    this.socket.add(this.spinner);

    this.poofMat = this.track(
      new ShaderMaterial({
        glslVersion: GLSL3,
        vertexShader: POOF_VERT,
        fragmentShader: POOF_FRAG,
        uniforms: { uT: { value: 0 }, uSize: { value: 3 }, uA: { value: new Vector3(1, 1, 1) }, uB: { value: new Vector3(0.22, 0.94, 1) } },
      }),
    );
    const pg = this.trackGeo(new BufferGeometry());
    const dirs = new Float32Array(POOF_N * 3);
    let seed = 7;
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < POOF_N; i++) {
      const a = rnd() * Math.PI * 2;
      const zz = rnd() * 2 - 1;
      const s = Math.sqrt(1 - zz * zz);
      dirs[i * 3] = Math.cos(a) * s;
      dirs[i * 3 + 1] = zz;
      dirs[i * 3 + 2] = Math.sin(a) * s;
    }
    pg.setAttribute('position', new BufferAttribute(new Float32Array(POOF_N * 3), 3));
    pg.setAttribute('aDir', new BufferAttribute(dirs, 3));
    this.poof = new Points(pg, this.poofMat);
    this.poof.frustumCulled = false;
    this.poof.visible = false;
    this.poof.renderOrder = 10;
    this.wrist.add(this.poof);
    this.setGlove('classic');
  }

  // ---------------------------------------------------------------- Aufbau

  private track<T extends Material>(m: T): T {
    this.materials.push(m);
    return m;
  }

  private trackGeo(g: BufferGeometry): BufferGeometry {
    this.geometries.push(g);
    return g;
  }

  /** Mesh + Kontur-Hülle aus derselben Geometrie. */
  private part(parent: Object3D, geo: BufferGeometry, mat: ShaderMaterial, outline: ShaderMaterial, list: Part[] | null, hullGeo?: BufferGeometry): Part {
    this.trackGeo(geo);
    if (hullGeo) this.trackGeo(hullGeo);
    const lit = new Mesh(geo, mat);
    const hull = new Mesh(hullGeo ?? geo, outline);
    lit.frustumCulled = false;
    hull.frustumCulled = false;
    parent.add(lit);
    parent.add(hull);
    const p = { lit, hull };
    list?.push(p);
    return p;
  }

  private buildSleeve(): void {
    const m = this.mats.classic;
    // Stulpe: etwas weiter als das Handgelenk, läuft aus dem Bild (Unterarm angeschnitten).
    const cuff: Ring[] = [
      { y: 0.6, rx: 3.55, rz: 2.9 },
      { y: 0.1, rx: 4.05, rz: 3.3 },
      { y: -2.5, rx: 4.2, rz: 3.45 },
      { y: -9, rx: 4.3, rz: 3.55 },
      { y: -40, rx: 4.9, rz: 4.1 },
    ];
    this.part(this.arm, tubeGeometry(cuff, SEG_CUFF, { poleStart: 0.75 }), m.cuff, m.outline, this.cuffParts);
    // Schwarzes Band direkt am Handgelenk (macht den Handschuh lesbar wie in den Referenzen).
    const band: Ring[] = [
      { y: 0.35, rx: 4.18, rz: 3.44 },
      { y: -0.2, rx: 4.3, rz: 3.55 },
      { y: -2.4, rx: 4.36, rz: 3.62 },
      { y: -2.8, rx: 4.26, rz: 3.52 },
    ];
    this.part(this.arm, tubeGeometry(band, SEG_CUFF, { poleStart: 0.5, poleEnd: -2.9 }), m.band, m.outline, this.bandParts);
  }

  private buildHand(): void {
    const m = this.mats.classic;
    // Handfläche: flacher, weicher Block von der Wurzel bis zu den Knöcheln.
    const palm: Ring[] = [
      { y: -0.9, rx: 3.0, rz: 2.2, cz: 0.1 },
      { y: 0.8, rx: 3.75, rz: 2.35, cz: 0.05 },
      { y: 3.8, rx: 4.45, rz: 2.4, cx: -0.1, cz: -0.1 },
      { y: 7.0, rx: 4.6, rz: 2.25, cz: -0.05 },
      { y: 8.9, rx: 4.4, rz: 1.95, cz: 0.05 },
    ];
    this.part(this.wrist, tubeGeometry(palm, SEG_PALM, { poleStart: -1.5, poleEnd: 10.1 }), m.glove, m.outline, this.gloveParts);

    for (const f of FINGERS) {
      const root = new Group();
      root.position.set(f.x, f.y, f.z);
      root.rotation.order = 'ZXY';
      this.wrist.add(root);
      const r0 = f.r;
      const r1 = f.r * 0.95;
      const r2 = f.r * 0.9;
      this.part(root, capsuleGeometry(f.len[0], r0, r1, SEG_FINGER, 0.92), m.glove, m.outline, this.gloveParts);
      const pip = new Group();
      pip.position.y = f.len[0];
      root.add(pip);
      this.part(pip, capsuleGeometry(f.len[1], r1, r2, SEG_FINGER, 0.92), m.glove, m.outline, this.gloveParts);
      const dip = new Group();
      dip.position.y = f.len[1];
      pip.add(dip);
      this.part(dip, capsuleGeometry(f.len[2], r2, r2 * 0.97, SEG_FINGER, 0.92), m.glove, m.outline, this.gloveParts);
      this.fingerRoot.push(root);
      this.fingerPip.push(pip);
      this.fingerDip.push(dip);
    }

    const t = THUMB;
    this.thumbRoot.position.set(t.x, t.y, t.z);
    this.thumbRoot.rotation.order = 'ZXY';
    this.wrist.add(this.thumbRoot);
    this.part(this.thumbRoot, capsuleGeometry(t.len[0], t.r[0], t.r[1], SEG_FINGER, 0.9), m.glove, m.outline, this.gloveParts);
    this.thumbMcp.position.y = t.len[0];
    this.thumbRoot.add(this.thumbMcp);
    this.part(this.thumbMcp, capsuleGeometry(t.len[1], t.r[1], t.r[2], SEG_FINGER, 0.9), m.glove, m.outline, this.gloveParts);
    this.thumbIp.position.y = t.len[1];
    this.thumbMcp.add(this.thumbIp);
    this.part(this.thumbIp, capsuleGeometry(t.len[2], t.r[2], t.r[2] * 0.92, SEG_FINGER, 0.9), m.glove, m.outline, this.gloveParts);
  }

  private ensureCan(): NonNullable<ViewModel['can']> {
    if (this.can) return this.can;
    const L = this.light;
    const label = canLabelTexture();
    const lidTex = canLidTexture();
    this.textures.push(label, lidTex);
    const outline = this.track(createOutlineMaterial(L, PROP_OUTLINE, this.propPx));
    const body = this.track(createLitMaterial(L, { color: 0xffffff, map: label, rim: 0.25, wrap: 0.45 }));
    const alu = this.track(createLitMaterial(L, { color: 0xffffff, map: lidTex, rim: 0.2, wrap: 0.4 }));
    const aluPlain = this.track(createLitMaterial(L, { color: 0xf4f6fa, rim: 0.2, wrap: 0.4 }));
    const dark = this.track(createLitMaterial(L, { color: 0x0e0f14, rim: 0, wrap: 0.2 }));
    const group = new Group();
    const H = 7.8;
    const rings: Ring[] = [
      { y: -H, rx: 2.95, rz: 2.95 },
      { y: -H + 0.5, rx: 3.55, rz: 3.55 },
      { y: H - 1.6, rx: 3.55, rz: 3.55 },
      { y: H - 0.45, rx: 3.0, rz: 3.0 },
      { y: H, rx: 2.92, rz: 2.92 },
    ];
    this.part(group, tubeGeometry(rings, 10, { poleStart: -H + 0.1, poleEnd: H - 0.35, uvByY: true }), body, outline, null);
    // Deckel mit Niete, Lasche und Trinköffnung — ÜBER der Kegelkappe des Körpers (Pol tief
    // genug), sonst deckt der Kegel die Öffnung zu (fallen.md).
    const lid = new Mesh(this.trackGeo(discGeometry(2.8, 10, H - 0.06)), alu);
    lid.frustumCulled = false;
    group.add(lid);
    const hole = new Mesh(this.trackGeo(discGeometry(1.0, 8, 0)), dark);
    hole.scale.set(1.15, 1, 0.85);
    hole.position.set(0, H - 0.02, 1.55);
    hole.visible = false;
    group.add(hole);
    const tab = new Group();
    // Drehpunkt an der Niete (Mitte), Lasche zeigt zur Öffnung hin (+z) und nach hinten (−z).
    tab.position.set(0, H - 0.02, 0.1);
    const tabMesh = new Mesh(this.trackGeo(new BoxGeometry(1.1, 0.14, 2.3)), aluPlain);
    tabMesh.position.set(0, 0.07, -0.85);
    tabMesh.frustumCulled = false;
    tab.add(tabMesh);
    group.add(tab);
    group.visible = false;
    this.spinner.add(group);
    this.can = { group, tab, hole };
    return this.can;
  }

  private ensureCard(): NonNullable<ViewModel['card']> {
    if (this.card) return this.card;
    const L = this.light;
    const front = cardFrontTexture();
    const back = cardBackTexture();
    this.textures.push(front, back);
    const vis: IUniform<number> = { value: 1 };
    const outline = this.track(createOutlineMaterial(L, PROP_OUTLINE, this.propPx));
    const fm = this.track(createLitMaterial(L, { color: 0xffffff, map: front, holo: true, rim: 0.15, wrap: 0.7 }));
    const bm = this.track(createLitMaterial(L, { color: 0xffffff, map: back, rim: 0.15, wrap: 0.7 }));
    const em = this.track(createLitMaterial(L, { color: 0xe8e8f0, rim: 0, wrap: 0.7 }));
    for (const m of [outline, fm, bm, em]) m.uniforms.uVis = vis;
    const W = 6.4;
    const H = 8.8;
    const D = 0.12;
    const group = new Group();
    const f = new Mesh(this.trackGeo(new PlaneGeometry(W, H)), fm);
    f.position.z = D / 2 + 0.001;
    const b = new Mesh(this.trackGeo(new PlaneGeometry(W, H)), bm);
    b.rotation.y = Math.PI;
    b.position.z = -D / 2 - 0.001;
    const edge = new Mesh(this.trackGeo(new BoxGeometry(W, H, D)), em);
    const hull = new Mesh(this.trackGeo(smoothBoxGeometry(W, H, D)), outline);
    for (const o of [f, b, edge, hull]) {
      o.frustumCulled = false;
      group.add(o);
    }
    group.visible = false;
    this.spinner.add(group);
    this.card = { group, vis };
    return this.card;
  }

  private ensureKnife(): NonNullable<ViewModel['knife']> {
    if (this.knife) return this.knife;
    const L = this.light;
    const ht = knifeHandleTexture();
    const bt = knifeBladeTexture();
    this.textures.push(ht, bt);
    const outline = this.track(createOutlineMaterial(L, PROP_OUTLINE, this.knifePx));
    const hm = this.track(createLitMaterial(L, { color: 0xffffff, map: ht, rim: 0.3, wrap: 0.5 }));
    const bm = this.track(createLitMaterial(L, { color: 0xffffff, map: bt, rim: 0.2, wrap: 0.35 }));
    const pinM = this.track(createLitMaterial(L, { color: 0xd8dce4, rim: 0, wrap: 0.4 }));
    const HL = 10.5;
    const HW = 1.25;
    const HD = 0.95;
    const PIN = 0.9;
    const handle = (parent: Group): void => {
      const g = new Group();
      g.position.set(0, -HL / 2 + 0.3, 0);
      parent.add(g);
      this.part(g, new BoxGeometry(HW, HL, HD), hm, outline, null, smoothBoxGeometry(HW, HL, HD));
      const pin = new Mesh(this.trackGeo(new BoxGeometry(0.4, 0.4, HD + 0.12)), pinM);
      pin.position.set(0, HL / 2 - 0.3, 0);
      g.add(pin);
    };
    const group = new Group();
    // Gehaltener Griff (safe) am Ursprung, Klinge dreht um seinen Stift.
    handle(group);
    const blade = new Group();
    blade.rotation.order = 'XYZ';
    group.add(blade);
    const bladeGeo = new BoxGeometry(1.5, 8.6, 0.18);
    bladeGeo.translate(PIN, 4.3 + 0.2, 0);
    const bladeHull = smoothBoxGeometry(1.5, 8.6, 0.18);
    bladeHull.translate(PIN, 4.3 + 0.2, 0);
    this.part(blade, bladeGeo, bm, outline, null, bladeHull);
    // Spitze: schräg abgeschnitten (kleiner gedrehter Block).
    const tipGeo = new BoxGeometry(0.95, 0.95, 0.16);
    tipGeo.rotateZ(Math.PI / 4);
    tipGeo.translate(PIN + 0.12, 8.95, 0);
    this.part(blade, tipGeo, bm, outline, null);
    const bite = new Group();
    bite.position.set(PIN * 2, 0, 0);
    blade.add(bite);
    handle(bite);
    group.visible = false;
    this.spinner.add(group);
    this.knife = { group, blade, bite };
    return this.knife;
  }

  // ---------------------------------------------------------------- API

  /** Licht aus der Level-Umgebung: entsättigt (weißer Handschuh bleibt weiß), Rim in Trim-Farbe. */
  setEnvironment(env: EnvironmentDef): void {
    const L = this.light;
    tintTowards(L.uAmbSky.value, 0.42, env.ambientSky, 0.28);
    tintTowards(L.uAmbGround.value, 0.2, env.ambientGround, 0.28);
    tintTowards(L.uKeyColor.value, 0.66, env.sunColor, 0.18);
    const [r, g, b] = hexToRgb(env.trimColor);
    L.uRimColor.value.set(r, g, b);
  }

  /** Grundhaltung des Unterarms überschreiben (Dev-Seite zum Tunen). */
  setArmBase(pitch: number, twist: number, roll: number): void {
    this.arm.rotation.set(pitch, twist, roll);
  }

  /** Low-Res-Auflösung: Kontur in Pixeln (Hand 2 px bei 224, 2.5 bei 270, 4 bei 448; Gegenstände dünner). */
  setResolution(w: number, h: number): void {
    this.light.uRes.value.set(Math.max(1, w), Math.max(1, h));
    this.lines = h;
    this.outlinePx.value = Math.max(1.5, Math.min(4, Math.round((h / 100) * 2) / 2));
    this.propPx.value = Math.max(1, Math.min(3.5, Math.round((h / 115) * 2) / 2));
    this.knifePx.value = Math.max(1, Math.round(h / 200));
    (this.poofMat.uniforms.uSize as IUniform<number>).value = Math.max(2, Math.round(h / 90));
    const aspect = w / Math.max(1, h);
    if (Math.abs(this.camera.aspect - aspect) > 1e-6) {
      this.camera.aspect = aspect;
      this.camera.updateProjectionMatrix();
    }
  }

  setTime(t: number): void {
    this.light.uTime.value = t;
  }

  setGlove(g: ViewModelGlove): void {
    this.glove = g;
    const m = this.mats[g];
    for (const p of this.gloveParts) {
      p.lit.material = m.glove;
      p.hull.material = m.outline;
    }
    for (const p of this.cuffParts) {
      p.lit.material = m.cuff;
      p.hull.material = m.outline;
    }
    for (const p of this.bandParts) {
      p.lit.material = m.band;
      p.hull.material = m.outline;
    }
  }

  /** Geometrie/Texturen anlegen und Shader kompilieren (außerhalb des Frame-Pfads). */
  prewarm(renderer: WebGLRenderer, item: ViewModelItem, glove: ViewModelGlove): void {
    this.setGlove(glove);
    if (item === 'can') this.ensureCan();
    else if (item === 'card') this.ensureCard();
    else if (item === 'knife') this.ensureKnife();
    const vis: Object3D[] = [];
    this.scene.traverse((o) => {
      if (!o.visible) {
        vis.push(o);
        o.visible = true;
      }
    });
    renderer.compile(this.scene, this.camera);
    for (const o of vis) o.visible = false;
    for (const t of this.textures) renderer.initTexture(t);
  }

  /** Frame übernehmen (keine Allokation). */
  apply(f: ViewModelFrame): void {
    if (f.glove !== this.glove) this.setGlove(f.glove);
    const hh = this.depth * TAN_HALF_FOV;
    this.anchor.position.set(f.x * 2 * hh, -f.y * 2 * hh, -this.depth + f.z);
    const sq = f.squash > 0.2 ? f.squash : 1;
    const wide = 1 + (1 - sq) * 0.6;
    this.anchor.scale.set(wide, sq, wide);
    this.motion.rotation.set(f.pitch, f.yaw, f.roll);
    const j = f.joints;
    this.wrist.rotation.set(-j[VM_JOINT.wristFlex], j[VM_JOINT.wristTwist], j[VM_JOINT.wristDev]);
    for (let i = 0; i < 4; i++) {
      const b = VM_JOINT.finger + i * 4;
      this.fingerRoot[i].rotation.set(-j[b + 1], 0, j[b] + FINGERS[i].splay);
      this.fingerPip[i].rotation.x = -j[b + 2];
      this.fingerDip[i].rotation.x = -j[b + 3];
    }
    this.thumbRoot.rotation.set(THUMB.baseX - j[VM_JOINT.thumbOpp], THUMB.baseY, THUMB.baseZ + j[VM_JOINT.thumbAbd]);
    this.thumbMcp.rotation.x = -j[VM_JOINT.thumbMcp];
    this.thumbIp.rotation.x = -j[VM_JOINT.thumbIp];

    // Gegenstand
    const item = f.item;
    const show = f.propVisible > 0.001;
    this.socket.position.set(f.propPos[0], f.propPos[1], f.propPos[2]);
    this.socket.rotation.set(f.propRot[0], f.propRot[1], f.propRot[2]);
    const s = f.propScale > 0.001 ? f.propScale : 0.001;
    this.socket.scale.set(s, s, s);
    this.spinner.rotation.y = f.propSpin;
    if (this.can) this.can.group.visible = false;
    if (this.card) this.card.group.visible = false;
    if (this.knife) this.knife.group.visible = false;
    if (item === 'can' && show) {
      const c = this.ensureCan();
      c.group.visible = true;
      // Lasche: Hebel um die Niete — das hintere Ende steigt (bis ~75°).
      c.tab.rotation.x = f.canTab * 1.3;
      c.hole.visible = f.canOpen;
    } else if (item === 'card' && show) {
      const c = this.ensureCard();
      c.group.visible = true;
      c.vis.value = f.propVisible;
    } else if (item === 'knife' && show) {
      const k = this.ensureKnife();
      k.group.visible = true;
      k.blade.rotation.z = f.knifeBlade;
      k.bite.rotation.z = f.knifeBite;
    }
    if (f.poof >= 0 && f.poof < 1) {
      this.poof.visible = true;
      this.poof.position.set(f.poofPos[0], f.poofPos[1], f.poofPos[2]);
      (this.poofMat.uniforms.uT as IUniform<number>).value = f.poof;
    } else this.poof.visible = false;
  }

  /** Nach der Welt ins aktuelle Render-Target: Tiefe leeren, Farbe behalten. */
  render(r: WebGLRenderer): void {
    const auto = r.autoClear;
    r.autoClear = false;
    r.clearDepth();
    r.render(this.scene, this.camera);
    r.autoClear = auto;
  }

  get lowResLines(): number {
    return this.lines;
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    for (const t of this.textures) t.dispose();
    this.geometries.length = 0;
    this.materials.length = 0;
    this.textures.length = 0;
  }
}

/** v = grau·(1−k) + Farbe (auf die Helligkeit von grau normiert)·k. */
function tintTowards(v: Vector3, grey: number, hex: string, k: number): void {
  const [r, g, b] = hexToRgb(hex);
  const lum = Math.max(0.05, 0.3 * r + 0.59 * g + 0.11 * b);
  const s = grey / lum;
  v.set(grey * (1 - k) + Math.min(1.2, r * s) * k, grey * (1 - k) + Math.min(1.2, g * s) * k, grey * (1 - k) + Math.min(1.2, b * s) * k);
}

