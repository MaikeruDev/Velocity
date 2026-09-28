import { BufferAttribute, BufferGeometry, GLSL3, Group, Line, Mesh, PerspectiveCamera, Points, Scene, ShaderMaterial, Vector3 } from 'three';
import type { IUniform, Material, Object3D, Texture, WebGLRenderer } from 'three';
import type { EnvironmentDef } from '../../world/level/LevelFormat';
import { VM_ARM_BASE, VM_JOINT, VM_RIG, VM_STRING_POINTS } from '../types';
import type { ViewModelFrame, ViewModelGlove, ViewModelItem } from '../types';
import { hexToRgb } from '../util';
import { ITEM_REGISTRY } from './items';
import { SKIN_REGISTRY } from './skins';
import { GloveSkin } from './skins/glove';
import type { ItemView, Part, SkinFrameFx, SkinView, VmBuildCtx, VmRig } from './vmBuild';
import { ScalarUniform, createVmLight, setHexVec } from './vmMaterials';
import type { VmLightUniforms } from './vmMaterials';

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
 *
 * Plan 007 (Kosmetik v2): Das ViewModel hält nur noch das Rig (VM_RIG), den Dreh-Sockel des
 * Gegenstands, einen zweiten Körper (sub) mit Schnur und den Zauber-Poof. Hand-Skins kommen aus
 * skins/ (Material-Varianten der Handschuh-Geometrie oder eigene Geometrie je Rig-Slot),
 * Gegenstände aus items/ — beide lazy, nie im Frame-Pfad gebaut (prewarm).
 */

/** Vertikales FOV der Viewmodel-Kamera — entspricht viewmodel_fov 68 (4:3 horizontal, Source). */
export const VM_FOV = 54;
/** Abstand des Handgelenks zur Kamera (Hand-Einheiten). */
export const VM_DEPTH = 40;
const TAN_HALF_FOV = Math.tan((VM_FOV * Math.PI) / 360);

const FINGERS = VM_RIG.fingers;
const THUMB = VM_RIG.thumb;

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

const LINE_VERT = /* glsl */ `
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const LINE_FRAG = /* glsl */ `
uniform vec3 uColor;
out vec4 fragColor;
void main() {
  fragColor = vec4(uColor, 1.0);
}
`;

export class ViewModel {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(VM_FOV, 16 / 9, 0.5, 400);
  private readonly light: VmLightUniforms = createVmLight();
  private readonly outlinePx: IUniform<number> = { value: 2 };
  private readonly propPx: IUniform<number> = { value: 1.5 };
  /** Messer ist schmal: dünnere Kontur, sonst ist es nur ein schwarzer Strich. */
  private readonly knifePx: IUniform<number> = { value: 1 };
  /** Größe der Pixel-Partikel (Poof, Funkeln). */
  private readonly pointPx: IUniform<number> = { value: 3 };

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
  /** Gelenk-Gruppen für Skins und Tools (fk.test vergleicht die UI-FK damit). */
  readonly rig: VmRig;

  private readonly ctx: VmBuildCtx;
  private readonly gloveSkin: GloveSkin;
  private readonly skins = new Map<ViewModelGlove, SkinView>();
  private activeSkin: SkinView;
  private glove: ViewModelGlove = 'classic';
  private readonly skinFx: SkinFrameFx = { kick: 0 };

  // Gegenstände (lazy)
  private readonly items = new Map<ViewModelItem, ItemView>();
  /** Dieselben Views als Array: der Frame-Pfad iteriert ohne Map-Iterator (keine Allokation). */
  private readonly itemList: ItemView[] = [];
  /** Zweiter Körper (Plan 007) und Schnur — erst angelegt, wenn ein Gegenstand sie hat. */
  private subSocket: Group | null = null;
  private subSpin: Group | null = null;
  private string: { line: Line; pos: BufferAttribute; color: Vector3 } | null = null;
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
    this.ctx = {
      light: this.light,
      handPx: this.outlinePx,
      propPx: this.propPx,
      thinPx: this.knifePx,
      pointPx: this.pointPx,
      track: (m) => this.track(m),
      trackGeo: (g) => this.trackGeo(g),
      trackTex: (t) => {
        this.textures.push(t);
        return t;
      },
      part: (parent, geo, mat, outline, list, hullGeo) => this.part(parent, geo, mat, outline, list, hullGeo),
    };

    this.scene.add(this.anchor);
    this.anchor.add(this.motion);
    this.motion.rotation.order = 'YXZ';
    this.motion.add(this.arm);
    this.arm.rotation.order = 'ZXY';
    this.arm.rotation.set(VM_ARM_BASE.pitch, VM_ARM_BASE.twist, VM_ARM_BASE.roll);
    this.arm.add(this.wrist);
    this.wrist.rotation.order = 'ZXY';
    // Rig (VM_RIG): Finger-Ketten und Daumen — Skins hängen ihre Geometrie hier ein.
    const fingers: [Group, Group, Group][] = [];
    for (const f of FINGERS) {
      const root = new Group();
      root.position.set(f.x, f.y, f.z);
      root.rotation.order = 'ZXY';
      this.wrist.add(root);
      const pip = new Group();
      pip.position.y = f.len[0];
      root.add(pip);
      const dip = new Group();
      dip.position.y = f.len[1];
      pip.add(dip);
      this.fingerRoot.push(root);
      this.fingerPip.push(pip);
      this.fingerDip.push(dip);
      fingers.push([root, pip, dip]);
    }
    const t = THUMB;
    this.thumbRoot.position.set(t.x, t.y, t.z);
    this.thumbRoot.rotation.order = 'ZXY';
    this.wrist.add(this.thumbRoot);
    this.thumbMcp.position.y = t.len[0];
    this.thumbRoot.add(this.thumbMcp);
    this.thumbIp.position.y = t.len[1];
    this.thumbMcp.add(this.thumbIp);
    this.rig = { arm: this.arm, wrist: this.wrist, fingers, thumb: [this.thumbRoot, this.thumbMcp, this.thumbIp] };

    // Handschuh (classic/neon sofort, Gold lazy) — gleiche Material-/Mesh-Reihenfolge wie Plan 006.
    this.gloveSkin = new GloveSkin(this.ctx, this.rig);
    this.activeSkin = this.gloveSkin;
    this.wrist.add(this.socket);
    this.socket.add(this.spinner);

    this.poofMat = this.track(
      new ShaderMaterial({
        glslVersion: GLSL3,
        vertexShader: POOF_VERT,
        fragmentShader: POOF_FRAG,
        uniforms: { uT: new ScalarUniform(0), uSize: this.pointPx, uA: { value: new Vector3(1, 1, 1) }, uB: { value: new Vector3(0.22, 0.94, 1) } },
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

  private ensureSkin(g: ViewModelGlove): SkinView {
    const def = SKIN_REGISTRY[g];
    if (!def || 'material' in def) return this.gloveSkin;
    let s = this.skins.get(g);
    if (!s) {
      s = def.build(this.ctx, this.rig);
      this.skins.set(g, s);
    }
    return s;
  }

  private ensureItem(item: ViewModelItem): ItemView | null {
    const have = this.items.get(item);
    if (have) return have;
    const build = ITEM_REGISTRY[item];
    if (!build) return null;
    const v = build(this.ctx);
    this.spinner.add(v.group);
    if (v.sub) {
      const s = this.ensureSub();
      v.sub.visible = false;
      s.add(v.sub);
    }
    if (v.stringColor !== undefined) this.ensureString();
    this.items.set(item, v);
    this.itemList.push(v);
    return v;
  }

  private ensureSub(): Group {
    if (this.subSpin) return this.subSpin;
    const socket = new Group();
    const spin = new Group();
    socket.add(spin);
    this.wrist.add(socket);
    this.subSocket = socket;
    this.subSpin = spin;
    return spin;
  }

  private ensureString(): void {
    if (this.string) return;
    const pos = new BufferAttribute(new Float32Array(VM_STRING_POINTS * 3), 3);
    const g = this.trackGeo(new BufferGeometry());
    g.setAttribute('position', pos);
    const color = new Vector3(1, 1, 1);
    const mat = this.track(new ShaderMaterial({ glslVersion: GLSL3, vertexShader: LINE_VERT, fragmentShader: LINE_FRAG, uniforms: { uColor: { value: color } } }));
    const line = new Line(g, mat);
    line.frustumCulled = false;
    line.visible = false;
    this.wrist.add(line);
    this.string = { line, pos, color };
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
    this.pointPx.value = Math.max(2, Math.round(h / 90));
    const aspect = w / Math.max(1, h);
    if (Math.abs(this.camera.aspect - aspect) > 1e-6) {
      this.camera.aspect = aspect;
      this.camera.updateProjectionMatrix();
    }
  }

  setTime(t: number): void {
    this.light.uTime.value = t;
  }

  /** Kick-Hüllkurve der Musik (Roboter-LED); 0 = keine Musik. */
  setKick(k: number): void {
    this.skinFx.kick = Number.isFinite(k) ? k : 0;
  }

  setGlove(g: ViewModelGlove): void {
    this.glove = g;
    const def = SKIN_REGISTRY[g];
    const next = this.ensureSkin(g);
    if (next !== this.activeSkin) this.activeSkin.setVisible(false);
    // Skins ohne Umsetzung zeichnen als 'classic' (Vertrag render/types).
    if (next === this.gloveSkin) this.gloveSkin.setMaterial(def && 'material' in def ? def.material : 'classic');
    next.setVisible(true);
    this.activeSkin = next;
  }

  /** Geometrie/Texturen anlegen und Shader kompilieren (außerhalb des Frame-Pfads). */
  prewarm(renderer: WebGLRenderer, item: ViewModelItem, glove: ViewModelGlove): void {
    this.setGlove(glove);
    this.ensureItem(item);
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

  /**
   * Frame übernehmen (keine Allokation). Bewusst in kleine Methoden geteilt: in EINER großen
   * Methode inlinet V8 die three-Setter (Vector3/Euler.set) nicht mehr und boxt jedes Double-
   * Argument als HeapNumber — gemessen 16 KiB/s Dauer-Müll (inbox/cosmetics.md).
   */
  apply(f: ViewModelFrame): void {
    if (f.glove !== this.glove) this.setGlove(f.glove);
    this.applyRig(f);
    this.activeSkin.apply(f, this.skinFx);
    const view = this.applyItem(f);
    this.applySub(view, f);
    this.applyPoof(f, view);
  }

  /** Hand: Anker, Bewegung, Handgelenk, Finger, Daumen (wie Plan 006). */
  private applyRig(f: ViewModelFrame): void {
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
  }

  /** Gegenstand: Dreh-Sockel, sichtbare View (lazy gebaut) und ihre Kanäle. */
  private applyItem(f: ViewModelFrame): ItemView | null {
    const show = f.propVisible > 0.001;
    this.socket.position.set(f.propPos[0], f.propPos[1], f.propPos[2]);
    this.socket.rotation.set(f.propRot[0], f.propRot[1], f.propRot[2]);
    const s = f.propScale > 0.001 ? f.propScale : 0.001;
    this.socket.scale.set(s, s, s);
    this.spinner.rotation.y = f.propSpin;
    const list = this.itemList;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      v.group.visible = false;
      if (v.sub) v.sub.visible = false;
    }
    // Erst beim ersten Zeigen bauen (wie vor Plan 007) — prewarm macht es vorher.
    const view = show ? this.ensureItem(f.item) : (this.items.get(f.item) ?? null);
    if (view && show) {
      view.group.visible = true;
      view.apply(f);
    }
    return view;
  }

  /** Zauber-Poof (Karte). Gegenstände mit eigenen Partikeln (ownPoof) zeichnen f.poof selbst. */
  private applyPoof(f: ViewModelFrame, view: ItemView | null): void {
    if (f.poof >= 0 && f.poof < 1 && !(view && view.ownPoof)) {
      this.poof.visible = true;
      this.poof.position.set(f.poofPos[0], f.poofPos[1], f.poofPos[2]);
      (this.poofMat.uniforms.uT as IUniform<number>).value = f.poof;
    } else this.poof.visible = false;
  }

  /** Zweiter Körper und Schnur (nur Gegenstände, die sie haben). */
  private applySub(view: ItemView | null, f: ViewModelFrame): void {
    const sub = view?.sub;
    if (sub && this.subSocket && this.subSpin && f.subVisible > 0.001) {
      sub.visible = true;
      this.subSocket.position.set(f.subPos[0], f.subPos[1], f.subPos[2]);
      this.subSocket.rotation.set(f.subRot[0], f.subRot[1], f.subRot[2]);
      this.subSpin.rotation.y = f.subSpin;
    }
    const st = this.string;
    if (!st) return;
    const n = view?.stringColor !== undefined ? Math.min(VM_STRING_POINTS, Math.max(0, Math.floor(f.stringCount))) : 0;
    st.line.visible = n >= 2;
    if (n < 2 || view?.stringColor === undefined) return;
    const a = st.pos.array as Float32Array;
    for (let i = 0; i < n * 3; i++) a[i] = f.stringPts[i];
    st.pos.needsUpdate = true;
    st.line.geometry.setDrawRange(0, n);
    setHexVec(st.color, view.stringColor);
  }

  /** Nach der Welt ins aktuelle Render-Target: Tiefe leeren, Farbe behalten. */
  render(r: WebGLRenderer): void {
    const auto = r.autoClear;
    r.autoClear = false;
    r.clearDepth();
    r.render(this.scene, this.camera);
    r.autoClear = auto;
  }

  /** Tools (Bild-Hülle der Tricks): Dreh-Sockel des Gegenstands und Sockel des zweiten Körpers. */
  get itemSocket(): Group {
    return this.socket;
  }

  get subSocketGroup(): Group | null {
    return this.subSocket;
  }

  get lowResLines(): number {
    return this.lines;
  }

  /** Aktuelle Auflösung (setResolution) — das Selfie rendert kurz in 96×54 und stellt sie zurück. */
  get resolutionWidth(): number {
    return this.light.uRes.value.x;
  }

  get resolutionHeight(): number {
    return this.light.uRes.value.y;
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
