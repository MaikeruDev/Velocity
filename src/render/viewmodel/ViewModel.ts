import { BufferAttribute, BufferGeometry, GLSL3, Group, Line, Mesh, PerspectiveCamera, Points, Scene, ShaderMaterial, Vector3 } from 'three';
import type { EulerTuple, IUniform, Material, Object3D, Texture, WebGLRenderer } from 'three';
import type { EnvironmentDef } from '../../world/level/LevelFormat';
import { VM_ARM_BASE, VM_JOINT, VM_JOINT_COUNT, VM_RIG, VM_STRING_POINTS } from '../types';
import type { ViewModelFrame, ViewModelGlove, ViewModelItem } from '../types';
import { hexToRgb } from '../util';
import { ITEM_REGISTRY } from './items';
import { SKIN_REGISTRY } from './skins';
import { GloveSkin } from './skins/glove';
import type { ItemView, Part, SkinFrameFx, SkinView, VmBuildCtx, VmRig } from './vmBuild';
import { ScalarUniform, createVmLight, hexVec, setHexVec } from './vmMaterials';
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
/**
 * Schlagschatten der Schnur: dieselbe Linie 1 Low-Res-Pixel nach rechts unten (NDC 2/uRes je Pixel, im
 * Clip-Raum × w), in Konturfarbe. Die helle 1-px-Schnur verschwand vor dem weißen Handschuh (Review: Jo-Jo-
 * Wiege kaum lesbar); mit dunkler Kante liest sie sich auf Handschuh UND dunklem Grund — wie die Kontur.
 */
const LINE_SHADOW_VERT = /* glsl */ `
uniform vec2 uRes;
void main() {
  vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  clip.xy += vec2(2.0, -2.0) / uRes * clip.w;
  gl_Position = clip;
}
`;
/** Konturfarbe des Standard-Handschuhs (skins/glove classic.outline). */
const STRING_SHADOW = 0x0d0c14;

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
  /** Zuletzt gesetzte Lage des zweiten Körpers (NaN = noch keine). */
  private readonly subRotSeen = new Float32Array(3).fill(Number.NaN);
  /**
   * Zuletzt gesetzte Drehungen (NaN = noch keine): Gegenstand (Euler), Hand-Bewegung (pitch, yaw, roll), Eigendrehung
   * von Gegenstand und zweitem Körper — three-Setter nur bei Änderung (Review Phase 2: applyItem 2.0–2.1 KiB/s, der
   * Rest von applyRig 8.5–9.6 KiB/s waren je Frame neun geboxte Setter-Argumente). Plätze statt Felder: Kommazahlen
   * in einem Float64Array werden nie geboxt.
   */
  private readonly propRotSeen = new Float32Array(3).fill(Number.NaN);
  private readonly motionSeen = new Float64Array(3).fill(Number.NaN);
  private readonly spinSeen = new Float64Array(2).fill(Number.NaN);
  /** Zuletzt gesetzte Gelenke: Hand-Gelenke nur bei Änderung (in Ruhe stehen die Posen meist still). */
  private readonly jointsSeen = new Float32Array(VM_JOINT_COUNT).fill(Number.NaN);
  /**
   * Winkel für Euler.fromArray: Drehungen über ein Array statt über set(x, y, z) / .x = — Kommazahlen als
   * Argumente eines nicht geinlineten three-Setters boxte Maglev je Aufruf (paced Probe Jo-Jo + Katze: applyJoints
   * 7.5 KiB/s nach 60 s). fromArray setzt dieselben Felder und ruft denselben Callback (bitgleich); Index 3 bleibt
   * leer, die Reihenfolge (ZXY/YXZ) also erhalten. Mit Kommazahlen angelegt (Double-Elemente, nie geboxt).
   */
  private readonly eul: EulerTuple = [0.5, 0.5, 0.5];
  private string: { line: Line; shadow: Line; pos: BufferAttribute; color: Vector3 } | null = null;
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
    // Schatten zuerst, die helle Schnur darüber (gleiche Tiefe: die spätere gewinnt).
    line.renderOrder = 1;
    const shadowMat = this.track(new ShaderMaterial({ glslVersion: GLSL3, vertexShader: LINE_SHADOW_VERT, fragmentShader: LINE_FRAG, uniforms: { uColor: { value: hexVec(STRING_SHADOW) }, uRes: this.light.uRes } }));
    const shadow = new Line(g, shadowMat);
    shadow.frustumCulled = false;
    shadow.visible = false;
    this.wrist.add(shadow);
    this.wrist.add(line);
    this.string = { line, shadow, pos, color };
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
   * Argument als HeapNumber — gemessen 16 KiB/s Dauer-Müll (fallen.md #107).
   */
  apply(f: ViewModelFrame): void {
    if (f.glove !== this.glove) this.setGlove(f.glove);
    this.applyRig(f);
    this.activeSkin.apply(f, this.skinFx);
    const view = this.applyItem(f);
    this.applySub(view, f);
    this.applyString(view, f);
    this.applyPoof(f, view);
  }

  /** Hand: Anker, Bewegung, Handgelenk, Finger, Daumen (wie Plan 006). */
  private applyRig(f: ViewModelFrame): void {
    const hh = this.depth * TAN_HALF_FOV;
    // Position/Skalierung direkt in die Felder (Vector3 hat keinen Setter), Drehung nur bei Änderung (siehe motionSeen).
    const p = this.anchor.position;
    p.x = f.x * 2 * hh;
    p.y = -f.y * 2 * hh;
    p.z = -this.depth + f.z;
    const sq = f.squash > 0.2 ? f.squash : 1;
    const wide = 1 + (1 - sq) * 0.6;
    const sc = this.anchor.scale;
    sc.x = wide;
    sc.y = sq;
    sc.z = wide;
    const ms = this.motionSeen;
    if (f.pitch !== ms[0] || f.yaw !== ms[1] || f.roll !== ms[2]) {
      ms[0] = f.pitch;
      ms[1] = f.yaw;
      ms[2] = f.roll;
      const e = this.eul;
      e[0] = f.pitch;
      e[1] = f.yaw;
      e[2] = f.roll;
      this.motion.rotation.fromArray(e);
    }
    if (this.jointsChanged(f.joints)) this.applyJoints(f.joints);
  }

  /** Gelenke seit dem letzten apply verändert? (merkt sie sich) */
  private jointsChanged(j: Float32Array): boolean {
    const s = this.jointsSeen;
    let changed = false;
    for (let i = 0; i < j.length; i++) {
      if (j[i] !== s[i]) {
        s[i] = j[i];
        changed = true;
      }
    }
    return changed;
  }

  /** Handgelenk, Finger, Daumen (wie Plan 006) — nur bei geänderten Gelenken (applyRig), über fromArray (eul). */
  private applyJoints(j: Float32Array): void {
    const e = this.eul;
    e[0] = -j[VM_JOINT.wristFlex];
    e[1] = j[VM_JOINT.wristTwist];
    e[2] = j[VM_JOINT.wristDev];
    this.wrist.rotation.fromArray(e);
    for (let i = 0; i < 4; i++) {
      const b = VM_JOINT.finger + i * 4;
      e[0] = -j[b + 1];
      e[1] = 0;
      e[2] = j[b] + FINGERS[i].splay;
      this.fingerRoot[i].rotation.fromArray(e);
      // Mittel-/Endglied drehen nur um x (y, z bleiben 0 wie mit rotation.x =).
      e[0] = -j[b + 2];
      e[2] = 0;
      this.fingerPip[i].rotation.fromArray(e);
      e[0] = -j[b + 3];
      this.fingerDip[i].rotation.fromArray(e);
    }
    e[0] = THUMB.baseX - j[VM_JOINT.thumbOpp];
    e[1] = THUMB.baseY;
    e[2] = THUMB.baseZ + j[VM_JOINT.thumbAbd];
    this.thumbRoot.rotation.fromArray(e);
    e[0] = -j[VM_JOINT.thumbMcp];
    e[1] = 0;
    e[2] = 0;
    this.thumbMcp.rotation.fromArray(e);
    e[0] = -j[VM_JOINT.thumbIp];
    this.thumbIp.rotation.fromArray(e);
  }

  /** Gegenstand: Dreh-Sockel, sichtbare View (lazy gebaut) und ihre Kanäle. */
  private applyItem(f: ViewModelFrame): ItemView | null {
    const show = f.propVisible > 0.001;
    // Wie applyRig: Position/Skalierung direkt in die Felder, Drehungen nur bei Änderung.
    const sp = this.socket.position;
    sp.x = f.propPos[0];
    sp.y = f.propPos[1];
    sp.z = f.propPos[2];
    const r = f.propRot;
    const seen = this.propRotSeen;
    if (r[0] !== seen[0] || r[1] !== seen[1] || r[2] !== seen[2]) {
      seen[0] = r[0];
      seen[1] = r[1];
      seen[2] = r[2];
      const e = this.eul;
      e[0] = r[0];
      e[1] = r[1];
      e[2] = r[2];
      this.socket.rotation.fromArray(e);
    }
    const s = f.propScale > 0.001 ? f.propScale : 0.001;
    const sc = this.socket.scale;
    sc.x = s;
    sc.y = s;
    sc.z = s;
    if (f.propSpin !== this.spinSeen[0]) {
      this.spinSeen[0] = f.propSpin;
      const e = this.eul;
      e[0] = 0;
      e[1] = f.propSpin;
      e[2] = 0;
      this.spinner.rotation.fromArray(e);
    }
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

  /**
   * Zweiter Körper (nur Gegenstände, die ihn haben). Klein gehalten und ohne Schnur (applyString): mit ihr
   * wuchs die Methode, V8 inlinete die three-Setter nicht mehr und boxte deren Argumente (Review: 1.9 KiB/s,
   * fallen.md #107). Position direkt in die Felder (Vector3 hat keinen Setter).
   */
  private applySub(view: ItemView | null, f: ViewModelFrame): void {
    const sub = view?.sub;
    if (sub && this.subSocket && this.subSpin && f.subVisible > 0.001) {
      sub.visible = true;
      const p = this.subSocket.position;
      p.x = f.subPos[0];
      p.y = f.subPos[1];
      p.z = f.subPos[2];
      // Lage nur bei Änderung (Jo-Jo: konstant, Kendama: nur beim Drehen der Kugel) — spart drei geboxte Argumente.
      const r = f.subRot;
      const seen = this.subRotSeen;
      if (r[0] !== seen[0] || r[1] !== seen[1] || r[2] !== seen[2]) {
        seen[0] = r[0];
        seen[1] = r[1];
        seen[2] = r[2];
        const e = this.eul;
        e[0] = r[0];
        e[1] = r[1];
        e[2] = r[2];
        this.subSocket.rotation.fromArray(e);
      }
      if (f.subSpin !== this.spinSeen[1]) {
        this.spinSeen[1] = f.subSpin;
        const e = this.eul;
        e[0] = 0;
        e[1] = f.subSpin;
        e[2] = 0;
        this.subSpin.rotation.fromArray(e);
      }
    }
  }

  /** Schnur (Jo-Jo, Kendama) samt Schlagschatten. */
  private applyString(view: ItemView | null, f: ViewModelFrame): void {
    const st = this.string;
    if (!st) return;
    const n = view?.stringColor !== undefined ? Math.min(VM_STRING_POINTS, Math.max(0, Math.floor(f.stringCount))) : 0;
    st.line.visible = n >= 2;
    st.shadow.visible = n >= 2;
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
