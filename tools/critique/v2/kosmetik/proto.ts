/**
 * PROTOTYP (Kosmetik v2): neue Hand-Skins und Gegenstände am ECHTEN Viewmodel-Rig im Browser.
 * Seite: /tools/critique/v2/kosmetik/proto.html, gesteuert über window.__kos (shots.mjs).
 *
 * Kern der Architektur-Frage: Skins mit anderer Geometrie hängen an DENSELBEN Gelenk-Gruppen
 * (Handfläche, 4×3 Fingerglieder, 3 Daumenglieder, Unterarm) — Posen, Tricks, Griffe bleiben.
 * Der Prototyp blendet die Handschuh-Meshes aus und hängt je Slot EIN Lit-Mesh + EINE Hülle an
 * (Teile per Vertex-Farbe zusammengeführt → gleiche Draw-Call-Zahl wie der Handschuh).
 */
import { Vector2, BufferAttribute, BufferGeometry, DataTexture, Group, Line, Mesh, NearestFilter, NoColorSpace, PlaneGeometry, Quaternion, RGBAFormat, ShaderMaterial, UnsignedByteType, Vector3, GLSL3, Points } from 'three';
import type { IUniform, Material, Object3D, Texture } from 'three';
import { ViewModelPreview } from '../../../../src/render/viewmodel/ViewModelPreview';
import { createLitMaterial, createOutlineMaterial } from '../../../../src/render/viewmodel/vmMaterials';
import { discGeometry } from '../../../../src/render/viewmodel/vmGeometry';
import type { LitOptions, VmLightUniforms } from '../../../../src/render/viewmodel/vmMaterials';
import { GLSL_BAYER } from '../../../../src/render/materials/shared';
import { createViewModelFrame } from '../../../../src/render/types';
import type { ViewModelFrame, ViewModelItem } from '../../../../src/render/types';
import { HAND_POSES, POSE, POSE_JOINTS } from '../../../../src/ui/hand/poses';
import type { HandPose } from '../../../../src/ui/hand/poses';
import { VIEW_ALIGNED, VIEW_AXES } from '../../../../src/ui/hand/rot';
import { CAN_HOLD_POS, CAN_HOLD_ROT } from '../../../../src/ui/hand/canTricks';
import { findRig, inWrist } from './rig';
import type { Rig } from './rig';
import { merge, pbone, pcapsule, ptube, rgb, triCount } from './protoGeo';
import type { PRing } from './protoGeo';
import { YoyoTricks } from './yoyoTricks';
import type { YoyoTrick } from './yoyoTricks';

// ------------------------------------------------------------------ Rig-Maße (Kopie aus ViewModel.ts; Entwurf: VM_RIG)
const FINGERS = [
  { x: -3.15, y: 8.7, z: 0.2, r: 1.62, len: [3.2, 2.2, 1.9] },
  { x: -0.95, y: 9.1, z: 0.25, r: 1.66, len: [3.5, 2.4, 2.0] },
  { x: 1.25, y: 8.8, z: 0.2, r: 1.6, len: [3.3, 2.2, 1.9] },
  { x: 3.25, y: 8.0, z: 0.1, r: 1.45, len: [2.6, 1.8, 1.7] },
] as const;
const THUMB = { len: [3.3, 2.5, 2.1], r: [1.85, 1.6, 1.48] } as const;

export type SkinId = 'classic' | 'neon' | 'gold' | 'robot' | 'skeleton' | 'cat';
export type ProtoItem = 'none' | 'can' | 'yoyo' | 'spinner' | 'coin' | 'lighter' | 'kendama' | 'phone';

// ------------------------------------------------------------------ Materialien
function uni<T>(m: ShaderMaterial, name: string): IUniform<T> {
  const u = m.uniforms[name] as IUniform<T> | undefined;
  if (!u) throw new Error(`Uniform ${name} fehlt`);
  return u;
}

function lightOf(rig: Rig, hull: ShaderMaterial): VmLightUniforms {
  const palm = rig.wrist.children.find((c): c is Mesh => c instanceof Mesh);
  if (!palm || !(palm.material instanceof ShaderMaterial)) throw new Error('Handfläche nicht gefunden');
  const m = palm.material;
  return {
    uAmbSky: uni<Vector3>(m, 'uAmbSky'),
    uAmbGround: uni<Vector3>(m, 'uAmbGround'),
    uKeyDir: uni<Vector3>(m, 'uKeyDir'),
    uKeyColor: uni<Vector3>(m, 'uKeyColor'),
    uRimColor: uni<Vector3>(m, 'uRimColor'),
    uRes: uni<Vector2>(hull, 'uRes'),
    uTime: uni<number>(m, 'uTime'),
  };
}

function patch(src: string, find: string, add: string, before = false): string {
  if (!src.includes(find)) throw new Error(`Shader-Anker fehlt: ${find}`);
  return src.replace(find, before ? `${add}\n${find}` : `${find}\n${add}`);
}

/** Lit-Material mit Vertex-Farbe (Entwurf: `vertexColors` in LitOptions) und optional Glanzband (Gold). */
function vcLit(L: VmLightUniforms, o: LitOptions & { readonly sheen?: number }): ShaderMaterial {
  const m = createLitMaterial(L, o);
  m.vertexColors = true;
  let v = m.vertexShader;
  let f = m.fragmentShader;
  v = patch(v, 'out vec3 vPos;', 'out vec3 vCol;\nout float vSheen;');
  v = patch(v, 'vUv = uv;', `  vCol = color;
  vec3 rr = reflect(normalize(mv.xyz), n);
  // Umgebungs-Band: heller Horizont-Streifen + Himmelsglanz — gestuft, kein PBR.
  vSheen = smoothstep(0.05, 0.3, rr.y) * (1.0 - smoothstep(0.35, 0.6, rr.y)) + 0.8 * smoothstep(0.8, 0.98, rr.y);`);
  f = patch(f, 'in vec3 vPos;', 'in vec3 vCol;\nin float vSheen;\nuniform float uSheen;');
  if (!f.includes('vec3 base = uColor;')) throw new Error('Shader-Anker fehlt: base');
  f = f.replace('vec3 base = uColor;', 'vec3 base = uColor * vCol;');
  f = patch(f, '  if (uInk > 0.0', '  c += vec3(1.0, 0.93, 0.62) * (uSheen * floor(vSheen * 3.0 + 0.5) / 3.0);', true);
  m.vertexShader = v;
  m.fragmentShader = f;
  m.uniforms.uSheen = { value: o.sheen ?? 0 };
  return m;
}

const FLAME_VERT = /* glsl */ `
out vec2 vUv;
uniform float uScale;
void main() {
  vUv = uv;
  // Billboard: Mitte im View-Raum, Ecken in Bildebene (Flamme steht immer zur Kamera).
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  mv.xy += position.xy * uScale;
  gl_Position = projectionMatrix * mv;
}`;

const FLAME_FRAG = /* glsl */ `
${GLSL_BAYER}
uniform float uTime;
uniform float uLean;
uniform float uSize;
in vec2 vUv;
out vec4 fragColor;
void main() {
  float y = vUv.y;
  float x = vUv.x - 0.5 - uLean * y * y;
  float flick = 0.08 * sin(uTime * 23.0 + y * 9.0) + 0.05 * sin(uTime * 37.0 + y * 17.0);
  float w = 0.42 * pow(max(0.0, 1.0 - y), 0.55) * sqrt(max(0.0, y * 3.0)) * uSize;
  float d = abs(x + flick * y) / max(0.001, w);
  if (d > 1.0 || y > 0.98) discard;
  // Rand im Dither ausfransen (Screen-Door, kein Blending).
  float edge = 1.0 - smoothstep(0.7, 1.0, d);
  if (bayer4(ivec2(gl_FragCoord.xy)) > edge + 0.15) discard;
  vec3 c = d < 0.35 && y < 0.7 ? vec3(1.0, 0.97, 0.75) : d < 0.7 ? vec3(1.0, 0.7, 0.18) : vec3(0.95, 0.28, 0.1);
  if (y < 0.12 && d < 0.6) c = vec3(0.35, 0.6, 1.0);
  fragColor = vec4(c, 1.0);
}`;

const LINE_VERT = 'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
const LINE_FRAG = 'uniform vec3 uColor; out vec4 fragColor; void main() { fragColor = vec4(uColor, 1.0); }';

// ------------------------------------------------------------------ Aufbau
interface SkinSet {
  readonly objects: Object3D[];
  readonly claws: Group[];
  readonly led: ShaderMaterial | null;
}

interface Stats {
  drawCalls: number;
  triangles: number;
}

class Proto {
  readonly preview: ViewModelPreview;
  readonly rig: Rig;
  readonly L: VmLightUniforms;
  readonly handPx: IUniform<number> = { value: 2.5 };
  readonly propPx: IUniform<number> = { value: 1.5 };
  private readonly gloveMeshes: Mesh[] = [];
  private readonly skins = new Map<SkinId, SkinSet>();
  private readonly items = new Map<ProtoItem, Group>();
  readonly materials: Material[] = [];
  readonly textures: Texture[] = [];
  // Zweiter Körper + Schnur
  readonly sub = new Group();
  readonly stringLine: Line;
  private readonly stringPos: Float32Array;
  private readonly flameMat: ShaderMaterial;
  private yoyoBody: Group | null = null;
  private tama: Group | null = null;

  constructor(canvas: HTMLCanvasElement, w: number, h: number) {
    this.preview = new ViewModelPreview(canvas, w, h);
    this.rig = findRig(this.preview.vm);
    this.L = lightOf(this.rig, this.firstHull());
    this.handPx.value = Math.max(1.5, Math.min(4, Math.round((h / 100) * 2) / 2));
    this.propPx.value = Math.max(1, Math.min(3.5, Math.round((h / 115) * 2) / 2));
    this.collectGlove();
    this.rig.wrist.add(this.sub);
    this.stringPos = new Float32Array(9 * 3);
    const sg = new BufferGeometry();
    sg.setAttribute('position', new BufferAttribute(this.stringPos, 3));
    const lm = new ShaderMaterial({ glslVersion: GLSL3, vertexShader: LINE_VERT, fragmentShader: LINE_FRAG, uniforms: { uColor: { value: new Vector3(0.96, 0.95, 0.85) } } });
    this.stringLine = new Line(sg, lm);
    this.stringLine.frustumCulled = false;
    this.stringLine.visible = false;
    this.rig.wrist.add(this.stringLine);
    this.flameMat = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: FLAME_VERT,
      fragmentShader: FLAME_FRAG,
      uniforms: { uTime: { value: 0 }, uLean: { value: 0 }, uSize: { value: 1 }, uScale: { value: 1 } },
    });
  }

  private firstHull(): ShaderMaterial {
    let found: ShaderMaterial | null = null;
    this.rig.wrist.traverse((o) => {
      if (!found && o instanceof Mesh && o.material instanceof ShaderMaterial && o.material.name === 'VmOutline') found = o.material;
    });
    if (!found) throw new Error('Hülle nicht gefunden');
    return found;
  }

  /** Handschuh-Meshes (Handfläche, Glieder, Daumen, Stulpe, Band) — die blendet ein Skin aus. */
  private collectGlove(): void {
    const own = (g: Object3D): void => {
      for (const c of g.children) if (c instanceof Mesh) this.gloveMeshes.push(c);
    };
    own(this.rig.arm);
    own(this.rig.wrist);
    for (const f of this.rig.fingers) for (const s of f) own(s);
    for (const s of this.rig.thumb) own(s);
  }

  private track<T extends Material>(m: T): T {
    this.materials.push(m);
    return m;
  }

  private add(parent: Object3D, geo: BufferGeometry, mat: ShaderMaterial, outline: ShaderMaterial | null, hullGeo?: BufferGeometry): Object3D[] {
    const lit = new Mesh(geo, mat);
    lit.frustumCulled = false;
    parent.add(lit);
    if (!outline) return [lit];
    const hull = new Mesh(hullGeo ?? geo, outline);
    hull.frustumCulled = false;
    parent.add(hull);
    return [lit, hull];
  }

  // ---------------------------------------------------------------- Skins
  private buildSkin(id: SkinId): SkinSet {
    const L = this.L;
    const objects: Object3D[] = [];
    const claws: Group[] = [];
    let led: ShaderMaterial | null = null;
    const rig = this.rig;
    if (id === 'gold') {
      // Gold = Material auf der Handschuh-Geometrie (wie Neon), mit gestuftem Glanzband.
      const gold = this.track(vcLit(L, { color: 0xe0aa2a, rim: 0.6, wrap: 0.1, ink: 0.24, inkColor: 0x4a2a06, sheen: 0.55 }));
      const cuff = this.track(vcLit(L, { color: 0xf0c64a, rim: 0.5, wrap: 0.15, sheen: 0.45 }));
      const band = this.track(vcLit(L, { color: 0x3a220a, rim: 0.2, wrap: 0.5 }));
      const outline = this.track(createOutlineMaterial(L, 0x2a1604, this.handPx));
      let armLit = 0;
      for (const m of this.gloveMeshes) {
        const isHull = m.material instanceof ShaderMaterial && m.material.name === 'VmOutline';
        const onArm = m.parent === rig.arm;
        const mat = isHull ? outline : onArm ? (armLit++ === 0 ? cuff : band) : gold;
        const clone = new Mesh(m.geometry, mat);
        if (!m.geometry.getAttribute('color')) {
          const c = new Float32Array(m.geometry.getAttribute('position').count * 3).fill(1);
          m.geometry.setAttribute('color', new BufferAttribute(c, 3));
        }
        clone.frustumCulled = false;
        m.parent?.add(clone);
        objects.push(clone);
      }
      return { objects, claws, led };
    }
    if (id === 'robot') {
      const metal = rgb(0xc3ccd8);
      const dark = rgb(0x3a414e);
      const rivet = rgb(0x1c2028);
      const lit = this.track(vcLit(L, { color: 0xffffff, rim: 0.45, wrap: 0.2, ink: 0.2, inkColor: 0x10131a, sheen: 0.25 }));
      const outline = this.track(createOutlineMaterial(L, 0x0c0e14, this.handPx));
      // Handfläche: Platte mit abgerundeten Kanten, Mittelnaht, Nieten, Knöchel-Achse.
      const palmRings: PRing[] = [
        { y: -0.6, rx: 2.9, rz: 1.9, n: 4 },
        { y: 0.8, rx: 3.6, rz: 2.05, n: 4 },
        { y: 4.0, rx: 4.2, rz: 2.1, n: 4 },
        { y: 7.2, rx: 4.3, rz: 2.0, n: 4 },
        { y: 8.3, rx: 4.05, rz: 1.8, n: 4 },
      ];
      const palm = ptube(palmRings, 16, {
        poleStart: -1.1,
        poleEnd: 8.8,
        color: metal,
        colorAt: (x, y, z, c) => {
          if (z > 1.5 && Math.abs(x) < 0.22 && y > 0.5 && y < 7.8) c.splice(0, 3, ...dark);
          if (z > 1.5 && y > 3.6 && y < 3.9) c.splice(0, 3, ...dark);
        },
      });
      const parts = [palm];
      for (const [x, y] of [
        [-2.9, 1.2],
        [2.9, 1.2],
        [-3.3, 6.6],
        [3.3, 6.6],
      ] as const) {
        const r = ptube(
          [
            { y: 0, rx: 0.42, rz: 0.42 },
            { y: 0.25, rx: 0.36, rz: 0.36 },
          ],
          6,
          { poleEnd: 0.4, color: rivet },
        );
        r.rotateX(Math.PI / 2);
        r.translate(x, y, 1.95);
        parts.push(r);
      }
      const axle = ptube(
        [
          { y: -4.3, rx: 0.75, rz: 0.75 },
          { y: 4.3, rx: 0.75, rz: 0.75 },
        ],
        8,
        { poleStart: -4.6, poleEnd: 4.6, color: dark },
      );
      axle.rotateZ(Math.PI / 2);
      axle.translate(0, 8.5, 0.3);
      parts.push(axle);
      objects.push(...this.add(rig.wrist, merge(parts), lit, outline));
      // Fingerglieder: kantige Hülsen mit Spalt, Gelenk-Achse quer.
      const seg = (len: number, r: number, tip: boolean): BufferGeometry => {
        const body = pcapsule(len * 0.78, r * 0.74, r * 0.7, 10, { n: 4, squash: 0.92, color: metal });
        body.translate(0, len * 0.12, 0);
        const hinge = ptube(
          [
            { y: -r * 0.8, rx: r * 0.5, rz: r * 0.5 },
            { y: r * 0.8, rx: r * 0.5, rz: r * 0.5 },
          ],
          8,
          { poleStart: -r * 0.9, poleEnd: r * 0.9, color: dark },
        );
        hinge.rotateZ(Math.PI / 2);
        const list = [body, hinge];
        if (tip) {
          // Fingerkuppe: dunkles Sensor-Pad auf der Handflächenseite.
          const pad = ptube(
            [
              { y: 0, rx: r * 0.42, rz: r * 0.2 },
              { y: len * 0.5, rx: r * 0.42, rz: r * 0.2 },
            ],
            8,
            { poleStart: -0.2, poleEnd: len * 0.5 + 0.2, color: dark },
          );
          pad.translate(0, len * 0.25, -r * 0.62);
          list.push(pad);
        }
        return merge(list);
      };
      FINGERS.forEach((f, i) => {
        for (let k = 0; k < 3; k++) objects.push(...this.add(rig.fingers[i][k], seg(f.len[k], f.r, k === 2), lit, outline));
      });
      for (let k = 0; k < 3; k++) objects.push(...this.add(rig.thumb[k], seg(THUMB.len[k], THUMB.r[k], k === 2), lit, outline));
      // Unterarm: gerippte Metallröhre, LED-Band leuchtet (Entwurf: pulst mit der Kick).
      const ribs: PRing[] = [];
      for (let y = 0.4; y > -40; y -= 1.4) {
        ribs.push({ y, rx: 3.9, rz: 3.2, n: 3 });
        ribs.push({ y: y - 0.7, rx: 4.15, rz: 3.4, n: 3 });
      }
      objects.push(...this.add(rig.arm, ptube(ribs, 12, { poleStart: 0.9, color: rgb(0xa8b2c0) }), lit, outline));
      led = this.track(createLitMaterial(L, { color: 0x1a4a55, rim: 0, wrap: 0.3, emissive: 0x2fd8ff }));
      const ledGeo = ptube(
        [
          { y: -1.0, rx: 4.3, rz: 3.55, n: 3 },
          { y: -2.0, rx: 4.3, rz: 3.55, n: 3 },
        ],
        12,
        { color: [1, 1, 1] },
      );
      objects.push(...this.add(rig.arm, ledGeo, led, outline));
      return { objects, claws, led };
    }
    if (id === 'skeleton') {
      const boneC = rgb(0xefe7cf);
      const lit = this.track(vcLit(L, { color: 0xffffff, rim: 0.35, wrap: 0.35, ink: 0.26, inkColor: 0x2b2216 }));
      const outline = this.track(createOutlineMaterial(L, 0x1c160e, this.handPx));
      // Handfläche: Mittelhandknochen fächern vom Handgelenk zu den Fingerwurzeln + Handwurzel.
      const parts: BufferGeometry[] = [];
      const up = new Vector3(0, 1, 0);
      for (const f of FINGERS) {
        const from = new Vector3(f.x * 0.45, 1.1, -0.2);
        const to = new Vector3(f.x, f.y - 0.5, f.z);
        const d = to.clone().sub(from);
        const b = pbone(d.length(), f.r * 0.5, f.r * 0.3, 8, { color: boneC });
        b.applyQuaternion(new Quaternion().setFromUnitVectors(up, d.normalize()));
        b.translate(from.x, from.y, from.z);
        parts.push(b);
      }
      for (const [x, y, r] of [
        [-1.9, 0.2, 0.95],
        [-0.3, -0.1, 1.05],
        [1.4, 0.1, 0.95],
        [2.6, 0.7, 0.8],
        [-2.4, 1.3, 0.8],
      ] as const) {
        const c = pcapsule(0.3, r, r, 8, { color: boneC });
        c.translate(x, y, -0.2);
        parts.push(c);
      }
      objects.push(...this.add(rig.wrist, merge(parts), lit, outline));
      FINGERS.forEach((f, i) => {
        for (let k = 0; k < 3; k++) {
          const len = f.len[k];
          const g = k < 2 ? pbone(len * 0.92, f.r * 0.52, f.r * 0.3, 8, { color: boneC }) : pcapsule(len * 0.7, f.r * 0.45, f.r * 0.28, 8, { color: boneC });
          if (k < 2) g.translate(0, len * 0.04, 0);
          objects.push(...this.add(rig.fingers[i][k], g, lit, outline));
        }
      });
      for (let k = 0; k < 3; k++) {
        const len = THUMB.len[k];
        const g = k < 2 ? pbone(len * 0.9, THUMB.r[k] * 0.5, THUMB.r[k] * 0.3, 8, { color: boneC }) : pcapsule(len * 0.7, THUMB.r[k] * 0.42, THUMB.r[k] * 0.26, 8, { color: boneC });
        objects.push(...this.add(rig.thumb[k], g, lit, outline));
      }
      // Unterarm: Elle und Speiche, dazu ein schwarzes Schweißband (Silhouette bleibt lesbar).
      const arm: BufferGeometry[] = [];
      for (const x of [-1.6, 1.7]) {
        const b = pbone(38, 1.25, 0.8, 8, { color: boneC });
        b.rotateZ(Math.PI);
        b.translate(x, -1.2, -0.2);
        arm.push(b);
      }
      objects.push(...this.add(rig.arm, merge(arm), lit, outline));
      const bandLit = this.track(vcLit(L, { color: 0x17161c, rim: 0.15, wrap: 0.5 }));
      const band = ptube(
        [
          { y: -3.6, rx: 3.3, rz: 2.4 },
          { y: -4.2, rx: 3.45, rz: 2.55 },
          { y: -6.4, rx: 3.5, rz: 2.6 },
          { y: -6.9, rx: 3.35, rz: 2.45 },
        ],
        12,
        { color: [1, 1, 1] },
      );
      objects.push(...this.add(rig.arm, band, bandLit, outline));
      return { objects, claws, led };
    }
    if (id === 'cat') {
      const fur = rgb(0xeb9540);
      const stripe = rgb(0xb8601c);
      const pink = rgb(0xf49ab2);
      const cream = rgb(0xfff4e2);
      const lit = this.track(vcLit(L, { color: 0xffffff, rim: 0.35, wrap: 0.45, ink: 0.2, inkColor: 0x3a1c08 }));
      const outline = this.track(createOutlineMaterial(L, 0x2a1406, this.handPx));
      const tabby = (x: number, y: number, z: number, c: [number, number, number]): void => {
        // Ringe quer zum Glied (Tabby), auf Rücken und Seiten; Innenseite bleibt hell.
        if (z > -0.6 && Math.sin(y * 2.3 + x * 0.5) > 0.35) c.splice(0, 3, ...stripe);
      };
      // Handfläche: runder, pummeliger; Hülle mit Zacken (Fell-Silhouette), großer Ballen innen.
      const palmRings: PRing[] = [
        { y: -1.0, rx: 3.3, rz: 2.5 },
        { y: 0.8, rx: 4.1, rz: 2.7 },
        { y: 4.0, rx: 4.8, rz: 2.8 },
        { y: 7.1, rx: 4.9, rz: 2.6 },
        { y: 8.9, rx: 4.6, rz: 2.2 },
      ];
      const palm = ptube(palmRings, 14, { poleStart: -1.8, poleEnd: 10.2, color: fur, colorAt: tabby });
      const palmHull = ptube(palmRings, 14, { poleStart: -1.8, poleEnd: 10.2, fur: 0.14 });
      const bean = ptube(
        [
          { y: 3.0, rx: 1.2, rz: 0.5 },
          { y: 4.2, rx: 2.3, rz: 0.75 },
          { y: 5.6, rx: 2.0, rz: 0.6 },
        ],
        10,
        { poleStart: 2.4, poleEnd: 6.2, color: pink },
      );
      bean.translate(0, 0, -2.45);
      objects.push(...this.add(rig.wrist, merge([palm, bean]), lit, outline, palmHull));
      FINGERS.forEach((f, i) => {
        for (let k = 0; k < 3; k++) {
          const len = f.len[k];
          const r0 = f.r * (k === 2 ? 1.12 : 1.06);
          const g = pcapsule(len, r0, r0 * (k === 2 ? 1.05 : 0.98), 10, { squash: 0.92, color: fur, colorAt: tabby });
          const hull = pcapsule(len, r0, r0 * (k === 2 ? 1.05 : 0.98), 10, { squash: 0.92, fur: 0.12 });
          const list = [g];
          if (k === 2) {
            // Zehenballen auf der Innenseite.
            const toe = ptube(
              [
                { y: 0, rx: r0 * 0.45, rz: 0.35 },
                { y: len * 0.45, rx: r0 * 0.62, rz: 0.45 },
                { y: len * 0.9, rx: r0 * 0.45, rz: 0.35 },
              ],
              8,
              { poleStart: -0.3, poleEnd: len * 0.9 + 0.3, color: pink },
            );
            toe.translate(0, len * 0.2, -r0 * 0.86);
            list.push(toe);
          }
          objects.push(...this.add(rig.fingers[i][k], merge(list), lit, outline, hull));
          if (k === 2) {
            // Kralle: eigene Gruppe, damit sie ausfahren kann (Entwurf: skinFx 0..1 → scale).
            const claw = new Group();
            claw.position.set(0, len + r0 * 0.55, -r0 * 0.25);
            const cg = ptube(
              [
                { y: 0, rx: 0.62, rz: 0.45 },
                { y: 1.2, rx: 0.4, rz: 0.3, cz: -0.35 },
                { y: 2.1, rx: 0.12, rz: 0.12, cz: -1.1 },
              ],
              6,
              { poleStart: -0.25, poleEnd: 2.25, color: cream },
            );
            objects.push(...this.add(claw, cg, lit, this.track(createOutlineMaterial(L, 0x2a1406, this.propPx))));
            rig.fingers[i][k].add(claw);
            claws.push(claw);
          }
        }
      });
      for (let k = 0; k < 3; k++) {
        const len = THUMB.len[k];
        const r0 = THUMB.r[k] * 0.95;
        const g = pcapsule(len, r0, r0 * 0.96, 10, { squash: 0.92, color: fur, colorAt: tabby });
        objects.push(...this.add(rig.thumb[k], g, lit, outline, pcapsule(len, r0, r0 * 0.96, 10, { squash: 0.92, fur: 0.12 })));
      }
      // Weiße "Socke" statt Stulpe (Fell-Kontur), rotes Halsband mit goldenem Glöckchen.
      const sock: PRing[] = [
        { y: 0.8, rx: 3.8, rz: 3.0 },
        { y: 0.1, rx: 4.3, rz: 3.5 },
        { y: -2.5, rx: 4.5, rz: 3.65 },
        { y: -9, rx: 4.6, rz: 3.75 },
        { y: -40, rx: 5.2, rz: 4.3 },
      ];
      objects.push(...this.add(rig.arm, ptube(sock, 14, { poleStart: 1.0, color: cream }), lit, outline, ptube(sock, 14, { poleStart: 1.0, fur: 0.12 })));
      const collar = ptube(
        [
          { y: -2.6, rx: 4.62, rz: 3.78 },
          { y: -3.0, rx: 4.75, rz: 3.9 },
          { y: -4.6, rx: 4.78, rz: 3.92 },
          { y: -5.0, rx: 4.64, rz: 3.8 },
        ],
        14,
        { color: rgb(0xd8263a) },
      );
      const bell = pcapsule(0.2, 1.05, 1.05, 8, { color: rgb(0xf2c230) });
      bell.translate(-4.9, -4.2, 1.2);
      objects.push(...this.add(rig.arm, merge([collar, bell]), lit, outline));
      return { objects, claws, led };
    }
    return { objects, claws, led };
  }

  setSkin(id: SkinId, clawsOut = 0): Stats {
    for (const s of this.skins.values()) for (const o of s.objects) o.visible = false;
    const classic = id === 'classic' || id === 'neon';
    for (const m of this.gloveMeshes) m.visible = classic;
    if (!classic) {
      let s = this.skins.get(id);
      if (!s) {
        s = this.buildSkin(id);
        this.skins.set(id, s);
      }
      for (const o of s.objects) o.visible = true;
      for (const c of s.claws) c.scale.setScalar(Math.max(0.001, clawsOut));
    }
    return this.stats(this.rig.arm, this.rig.socket);
  }

  // ---------------------------------------------------------------- Gegenstände
  private tex(w: number, h: number, draw: (set: (x: number, y: number, c: number, glow?: boolean) => void) => void): DataTexture {
    const data = new Uint8Array(w * h * 4);
    const set = (xf: number, yf: number, c: number, glow = false): void => {
      const x = Math.round(xf);
      const y = Math.round(yf);
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const i = (y * w + x) * 4;
      data[i] = (c >> 16) & 255;
      data[i + 1] = (c >> 8) & 255;
      data[i + 2] = c & 255;
      data[i + 3] = glow ? 128 : 255;
    };
    draw(set);
    const t = new DataTexture(data, w, h, RGBAFormat, UnsignedByteType);
    t.magFilter = NearestFilter;
    t.minFilter = NearestFilter;
    t.generateMipmaps = false;
    t.colorSpace = NoColorSpace;
    t.needsUpdate = true;
    this.textures.push(t);
    return t;
  }

  private buildItem(id: ProtoItem): Group {
    const L = this.L;
    const g = new Group();
    const outline = this.track(createOutlineMaterial(L, 0x0d0c14, this.propPx));
    const lit = this.track(vcLit(L, { color: 0xffffff, rim: 0.25, wrap: 0.45 }));
    if (id === 'yoyo') {
      // Zwei Hälften mit Rand-Ring, Achse zur Kamera (man sieht das Muster), Nut für die Schnur.
      const half = (y0: number, y1: number): BufferGeometry =>
        ptube(
          [
            { y: y0, rx: 1.4, rz: 1.4 },
            { y: y0 + (y1 - y0) * 0.15, rx: 2.5, rz: 2.5 },
            { y: y0 + (y1 - y0) * 0.75, rx: 2.6, rz: 2.6 },
            { y: y1, rx: 2.2, rz: 2.2 },
          ],
          12,
          {
            poleStart: y0 - (y1 - y0) * 0.1,
            poleEnd: y1 + (y1 - y0) * 0.05,
            color: rgb(0xe8308c),
            colorAt: (x, y, z, c) => {
              const r = Math.hypot(x, z);
              if (r > 2.35) c.splice(0, 3, ...rgb(0x3cf0ff));
              else if (r < 0.9 && Math.abs(y) > 0.9) c.splice(0, 3, ...rgb(0xf6f6f6));
              else if (Math.abs(y) > 0.9 && Math.sin(Math.atan2(x, z) * 3) > 0.6) c.splice(0, 3, ...rgb(0xffd23c));
            },
          },
        );
      const axle = ptube(
        [
          { y: -0.2, rx: 0.5, rz: 0.5 },
          { y: 0.2, rx: 0.5, rz: 0.5 },
        ],
        8,
        { color: rgb(0x303038) },
      );
      const body = merge([half(0.15, 1.15), half(-0.15, -1.15), axle]);
      body.rotateX(Math.PI / 2);
      this.add(g, body, lit, outline);
      this.yoyoBody = g;
      return g;
    }
    if (id === 'spinner') {
      // Drei Lappen (Profil), Lager-Gewichte, leuchtende Mitte (Entwurf: Drehzahl = Tempo).
      const body = ptube(
        [
          { y: -0.45, rx: 3.3, rz: 3.3 },
          { y: -0.25, rx: 3.6, rz: 3.6 },
          { y: 0.25, rx: 3.6, rz: 3.6 },
          { y: 0.45, rx: 3.3, rz: 3.3 },
        ],
        36,
        { poleStart: -0.5, poleEnd: 0.5, lobes: { k: 3, depth: 0.62 }, color: rgb(0xff7a1a) },
      );
      const parts = [body];
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2;
        const w = ptube(
          [
            { y: -0.55, rx: 0.95, rz: 0.95 },
            { y: 0.55, rx: 0.95, rz: 0.95 },
          ],
          10,
          { poleStart: -0.6, poleEnd: 0.6, color: rgb(0xd7dde6) },
        );
        w.translate(Math.sin(a) * 2.45, 0, Math.cos(a) * 2.45);
        parts.push(w);
      }
      const geo = merge(parts);
      geo.rotateX(Math.PI / 2);
      this.add(g, geo, lit, outline);
      const hub = ptube(
        [
          { y: -0.7, rx: 1.0, rz: 1.0 },
          { y: 0.7, rx: 1.0, rz: 1.0 },
        ],
        10,
        { poleStart: -0.75, poleEnd: 0.75, color: [1, 1, 1] },
      );
      hub.rotateX(Math.PI / 2);
      this.add(g, hub, this.track(createLitMaterial(L, { color: 0x2080a0, rim: 0, wrap: 0.3, emissive: 0x33f0ff })), outline);
      return g;
    }
    if (id === 'coin') {
      const face = this.tex(16, 16, (set) => {
        for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) set(x, y, (x + y) % 5 === 0 ? 0xb07424 : 0xd9953a);
        for (let i = 0; i < 6; i++) {
          set(4 + i / 2, 12 - i * 1.5, 0x6a3a10);
          set(5 + i / 2, 12 - i * 1.5, 0x6a3a10);
          set(11 - i / 2, 12 - i * 1.5, 0x6a3a10);
          set(10 - i / 2, 12 - i * 1.5, 0x6a3a10);
        }
      });
      const rim = ptube(
        [
          { y: -0.2, rx: 2.1, rz: 2.1 },
          { y: 0.2, rx: 2.1, rz: 2.1 },
        ],
        14,
        { poleStart: -0.21, poleEnd: 0.21, color: rgb(0xd9953a) },
      );
      rim.rotateX(Math.PI / 2);
      this.add(g, rim, this.track(vcLit(L, { color: 0xffffff, rim: 0.5, wrap: 0.15, sheen: 0.5 })), outline);
      const fm = this.track(createLitMaterial(L, { color: 0xffffff, map: face, rim: 0.3, wrap: 0.2 }));
      for (const side of [1, -1]) {
        const d = discGeometry(1.95, 14, 0);
        d.rotateX((side * Math.PI) / 2);
        const f = new Mesh(d, fm);
        f.position.z = 0.215 * side;
        f.frustumCulled = false;
        g.add(f);
      }
      return g;
    }
    if (id === 'lighter') {
      // Sturmfeuerzeug (generisch, ohne Marke): Körper, Deckel am Scharnier, Kamin, Rad, Flamme.
      const chrome = rgb(0xc9ced8);
      const body = ptube(
        [
          { y: -3.0, rx: 1.75, rz: 0.72, n: 6 },
          { y: -2.8, rx: 1.85, rz: 0.78, n: 6 },
          { y: 0.3, rx: 1.85, rz: 0.78, n: 6 },
          { y: 0.4, rx: 1.8, rz: 0.75, n: 6 },
        ],
        16,
        { poleStart: -3.05, poleEnd: 0.45, color: chrome, colorAt: (x, y, _z, c) => (y > 0.0 && y < 0.3 ? c.splice(0, 3, ...rgb(0x707888)) : Math.abs(x) < 0.25 && y < -0.5 && y > -2.5 ? c.splice(0, 3, ...rgb(0xe8ecf2)) : undefined) },
      );
      this.add(g, body, this.track(vcLit(L, { color: 0xffffff, rim: 0.5, wrap: 0.15, sheen: 0.55 })), outline);
      const chimney = ptube(
        [
          { y: 0.4, rx: 1.0, rz: 0.55, n: 5 },
          { y: 1.7, rx: 1.0, rz: 0.55, n: 5 },
        ],
        12,
        { poleEnd: 1.72, color: rgb(0x8a92a0), colorAt: (x, y, _z, c) => ((Math.round(x * 2.2) + Math.round(y * 2.2)) % 2 === 0 && y > 0.7 && y < 1.5 ? c.splice(0, 3, ...rgb(0x202430)) : undefined) },
      );
      chimney.translate(0.35, 0, 0);
      this.add(g, chimney, lit, outline);
      const wheel = ptube(
        [
          { y: -0.35, rx: 0.42, rz: 0.42 },
          { y: 0.35, rx: 0.42, rz: 0.42 },
        ],
        8,
        { poleStart: -0.4, poleEnd: 0.4, color: rgb(0x505866) },
      );
      wheel.rotateX(Math.PI / 2);
      wheel.translate(-0.95, 1.2, 0);
      this.add(g, wheel, lit, outline);
      const lid = new Group();
      lid.name = 'lid';
      lid.position.set(1.85, 0.4, 0);
      const lidGeo = ptube(
        [
          { y: 0, rx: 1.85, rz: 0.78, n: 6 },
          { y: 1.7, rx: 1.85, rz: 0.78, n: 6 },
          { y: 1.85, rx: 1.75, rz: 0.72, n: 6 },
        ],
        16,
        { poleEnd: 1.9, color: chrome },
      );
      lidGeo.translate(-1.85, 0, 0);
      this.add(lid, lidGeo, this.track(vcLit(L, { color: 0xffffff, rim: 0.5, wrap: 0.15, sheen: 0.55 })), outline);
      g.add(lid);
      const flame = new Mesh(new PlaneGeometry(1.6, 3.2), this.flameMat);
      flame.name = 'flame';
      flame.position.set(0.35, 3.1, 0);
      flame.frustumCulled = false;
      flame.renderOrder = 5;
      g.add(flame);
      return g;
    }
    if (id === 'kendama') {
      const wood = rgb(0xe3c08a);
      const woodD = rgb(0xb88d52);
      const parts: BufferGeometry[] = [];
      const handle = ptube(
        [
          { y: -4.0, rx: 1.15, rz: 1.15 },
          { y: -3.6, rx: 0.95, rz: 0.95 },
          { y: 1.2, rx: 0.78, rz: 0.78 },
          { y: 1.8, rx: 0.9, rz: 0.9 },
        ],
        10,
        { color: wood },
      );
      parts.push(handle);
      const base = ptube(
        [
          { y: -4.0, rx: 1.15, rz: 1.15 },
          { y: -4.5, rx: 1.6, rz: 1.6 },
          { y: -4.9, rx: 1.75, rz: 1.75 },
        ],
        10,
        { poleStart: -4.4, color: woodD },
      );
      parts.push(base);
      const spike = ptube(
        [
          { y: 1.8, rx: 0.7, rz: 0.7 },
          { y: 3.6, rx: 0.35, rz: 0.35 },
        ],
        8,
        { poleEnd: 4.4, color: wood },
      );
      parts.push(spike);
      const cross = ptube(
        [
          { y: -2.4, rx: 1.0, rz: 1.0 },
          { y: 2.2, rx: 1.0, rz: 1.0 },
        ],
        10,
        { color: woodD },
      );
      cross.rotateZ(Math.PI / 2);
      cross.translate(0, 0.6, 0);
      parts.push(cross);
      const cup = (x: number, r: number, dir: number): BufferGeometry => {
        const c = ptube(
          [
            { y: 0, rx: r * 0.6, rz: r * 0.6 },
            { y: 0.8, rx: r, rz: r },
            { y: 1.0, rx: r * 1.05, rz: r * 1.05 },
          ],
          12,
          { poleEnd: 0.55, color: woodD },
        );
        c.rotateZ((-dir * Math.PI) / 2);
        c.translate(x, 0.6, 0);
        return c;
      };
      parts.push(cup(-2.4, 1.7, -1), cup(2.2, 1.35, 1));
      this.add(g, merge(parts), lit, outline);
      // Kugel (zweiter Körper): rot mit weißem Streifen, dunkles Loch.
      const t = new Group();
      const ball = pcapsule(0.01, 1.9, 1.9, 12, {
        color: rgb(0xd8263a),
        colorAt: (_x, y, z, c) => {
          if (Math.abs(y) < 0.28) c.splice(0, 3, ...rgb(0xf4f4f4));
          if (z > 1.55 && Math.abs(y) < 0.5) c.splice(0, 3, ...rgb(0x1a1016));
        },
      });
      this.add(t, ball, lit, outline);
      this.tama = t;
      return g;
    }
    if (id === 'phone') {
      const screen = this.tex(24, 48, (set) => {
        for (let y = 0; y < 48; y++) for (let x = 0; x < 24; x++) set(x, y, 0x121628, true);
        // "Feed": Karten mit Avatar-Kreis und Balken (kein echter Text, keine echte App).
        for (let k = 0; k < 4; k++) {
          const y0 = 4 + k * 11;
          for (let y = y0; y < y0 + 9; y++) for (let x = 2; x < 22; x++) set(x, y, 0x232a48, true);
          for (let y = y0 + 1; y < y0 + 4; y++) for (let x = 3; x < 6; x++) set(x, y, [0xff4fd8, 0x33f0ff, 0xffd23c, 0x7cff6b][k], true);
          for (let x = 7; x < 19; x++) set(x, y0 + 2, 0xaab4d0, true);
          for (let x = 3; x < 20 - k * 2; x++) set(x, y0 + 6, 0x6c7698, true);
        }
        for (let x = 0; x < 24; x++) set(x, 47, 0x33f0ff, true);
      });
      const shell = ptube(
        [
          { y: -4.3, rx: 2.15, rz: 0.26, n: 8 },
          { y: -4.1, rx: 2.3, rz: 0.3, n: 8 },
          { y: 4.1, rx: 2.3, rz: 0.3, n: 8 },
          { y: 4.3, rx: 2.15, rz: 0.26, n: 8 },
        ],
        20,
        { poleStart: -4.35, poleEnd: 4.35, color: rgb(0x23232e) },
      );
      const bump = ptube(
        [
          { y: 0, rx: 0.55, rz: 0.55 },
          { y: 0.25, rx: 0.5, rz: 0.5 },
        ],
        8,
        { poleEnd: 0.3, color: rgb(0x0e0e14) },
      );
      bump.rotateX(-Math.PI / 2);
      bump.translate(-1.2, 3.2, -0.3);
      this.add(g, merge([shell, bump]), lit, outline);
      const sm = this.track(createLitMaterial(L, { color: 0xffffff, map: screen, rim: 0, wrap: 0.5 }));
      const s = new Mesh(new PlaneGeometry(4.1, 8.0), sm);
      s.position.z = 0.32;
      s.frustumCulled = false;
      g.add(s);
      return g;
    }
    return g;
  }

  setItem(id: ProtoItem): Group | null {
    for (const [k, g] of this.items) g.visible = k === id;
    if (this.yoyoBody) this.yoyoBody.visible = false;
    if (this.tama) this.tama.visible = false;
    this.stringLine.visible = false;
    if (id === 'none' || id === 'can') return null;
    let g = this.items.get(id);
    if (!g) {
      g = this.buildItem(id);
      this.items.set(id, g);
      if (id === 'yoyo') this.sub.add(g);
      else this.rig.spinner.add(g);
      if (this.tama) this.sub.add(this.tama);
    }
    g.visible = id !== 'yoyo';
    return g;
  }

  setSub(p: ArrayLike<number>, spin: number, which: 'yoyo' | 'tama'): void {
    this.sub.position.set(p[0], p[1], p[2]);
    this.sub.rotation.set(VIEW_ALIGNED[0], VIEW_ALIGNED[1], VIEW_ALIGNED[2]);
    this.sub.rotateZ(spin);
    if (this.yoyoBody) this.yoyoBody.visible = which === 'yoyo';
    if (this.tama) this.tama.visible = which === 'tama';
  }

  setString(pts: ArrayLike<number> | null, n = 9): void {
    if (!pts) {
      this.stringLine.visible = false;
      return;
    }
    this.stringPos.set(Array.from(pts).slice(0, n * 3));
    (this.stringLine.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
    this.stringLine.geometry.setDrawRange(0, n);
    this.stringLine.visible = true;
  }

  setFlame(on: boolean, lean: number, t: number, lidOpen: number): void {
    const g = this.items.get('lighter');
    if (!g) return;
    const lid = g.getObjectByName('lid');
    if (lid) lid.rotation.z = -lidOpen * 2.6;
    const fl = g.getObjectByName('flame');
    if (fl) fl.visible = on;
    const u = this.flameMat.uniforms;
    (u.uTime as IUniform<number>).value = t;
    (u.uLean as IUniform<number>).value = lean;
  }

  stats(root: Object3D, skip: Object3D | null = null): Stats {
    let drawCalls = 0;
    let triangles = 0;
    root.traverseVisible((o) => {
      for (let q: Object3D | null = o; q; q = q.parent) if (q === skip || q === this.sub || q === this.stringLine) return;
      if (o instanceof Mesh) {
        drawCalls++;
        triangles += triCount(o.geometry);
      } else if (o instanceof Line || o instanceof Points) drawCalls++;
    });
    return { drawCalls, triangles };
  }
}

// ------------------------------------------------------------------ Szenen
interface Cell {
  readonly label: string;
  readonly skin: SkinId;
  readonly pose: HandPose;
  readonly item?: ProtoItem;
  readonly claws?: number;
  readonly thumb?: readonly number[];
  readonly setup?: (p: Proto, f: ViewModelFrame) => void;
}

const sheet = document.getElementById('sheet') as HTMLDivElement;
let proto: Proto | null = null;
let size = { w: 0, h: 0 };

function frameFor(c: Cell, x: number, y: number): ViewModelFrame {
  const f = createViewModelFrame();
  f.visible = true;
  f.x = x;
  f.y = y;
  f.glove = c.skin === 'neon' ? 'neon' : 'classic';
  const item: ViewModelItem = c.item === 'can' ? 'can' : 'none';
  f.item = item;
  f.joints.set(POSE_JOINTS[POSE[c.pose]]);
  if (c.thumb) for (let i = 0; i < c.thumb.length; i++) f.joints[3 + i] = c.thumb[i];
  if (c.item === 'can') {
    f.propPos.set(CAN_HOLD_POS);
    f.propRot.set(CAN_HOLD_ROT);
  }
  return f;
}

function viewAlignedRot(f: ViewModelFrame, extra?: (q: Quaternion) => void): void {
  // Euler XYZ = VIEW_ALIGNED, danach optional Zusatzdrehung (Bildachsen).
  f.propRot.set(VIEW_ALIGNED);
  if (extra) {
    const g = new Group();
    g.rotation.set(VIEW_ALIGNED[0], VIEW_ALIGNED[1], VIEW_ALIGNED[2]);
    const q = new Quaternion();
    extra(q);
    g.quaternion.premultiply(q);
    f.propRot.set([g.rotation.x, g.rotation.y, g.rotation.z]);
  }
}

/** Drehung um eine Bildachse (rechts/oben/Kamera) als Quaternion im Handgelenk-Raum. */
function viewQ(ax: 'right' | 'up' | 'cam', angle: number): Quaternion {
  const a = VIEW_AXES[ax];
  return new Quaternion().setFromAxisAngle(new Vector3(a[0], a[1], a[2]), angle);
}

function place(f: ViewModelFrame, base: readonly number[], right: number, up: number, cam: number): void {
  const A = VIEW_AXES;
  for (let k = 0; k < 3; k++) f.propPos[k] = base[k] + A.right[k] * right + A.up[k] * up + A.cam[k] * cam;
}

function yoyoAt(p: Proto, trick: YoyoTrick | 'none', at: number): { sub: Float32Array; rope: Float32Array | null; spin: number } {
  const rig = p.rig;
  const anchor = inWrist(rig, rig.fingers[1][1], new Vector3(0, 1.2, 0));
  const tipI = inWrist(rig, rig.fingers[0][2], new Vector3(0, 1.9, 0));
  const tipM = inWrist(rig, rig.fingers[1][2], new Vector3(0, 2.0, 0));
  const hold = new Vector3(0, 6.5, -2.4).add(tipI).add(tipM).multiplyScalar(1 / 3);
  const y = new YoyoTricks([anchor.x, anchor.y, anchor.z], [hold.x, hold.y, hold.z]);
  if (trick !== 'none') y.debugPlay(trick);
  const steps = Math.round(at * 60);
  for (let i = 0; i < steps; i++) {
    // Kleiner seitlicher Schwung der Hand, damit das Pendel lebt.
    y.setHandMotion(i > 30 && i < 40 ? 300 : 0, 0, 4 * Math.sin(i / 12));
    y.update(1 / 60, { speed: 0, onGround: true, surfing: trick === 'sleeper' && at > 2 });
  }
  return { sub: y.sub, rope: y.stringOn ? y.rope.out : null, spin: y.subSpin };
}

function scene(name: string): Cell[] {
  const skins: SkinId[] = ['classic', 'gold', 'robot', 'skeleton', 'cat'];
  if (name === 'skins') {
    const cells: Cell[] = [];
    for (const s of skins) {
      cells.push({ label: `${s} · relaxed`, skin: s, pose: 'relaxed' });
      cells.push({ label: `${s} · open (Luft)`, skin: s, pose: 'open' });
      cells.push({ label: `${s} · thumbsUp`, skin: s, pose: 'thumbsUp', claws: 1 });
      cells.push({ label: `${s} · grip + Dose`, skin: s, pose: 'grip', item: 'can' });
    }
    return cells;
  }
  if (name === 'props') {
    return [
      { label: 'Jo-Jo · Ruhe (Faust)', skin: 'classic', pose: 'run', item: 'yoyo', setup: (p) => sub(p, 'none', 0) },
      { label: 'Jo-Jo · Sleeper 0.8 s', skin: 'classic', pose: 'relaxed', item: 'yoyo', setup: (p) => sub(p, 'sleeper', 0.8) },
      { label: 'Jo-Jo · Around 0.45 s', skin: 'classic', pose: 'run', item: 'yoyo', setup: (p) => sub(p, 'around', 0.45) },
      { label: 'Jo-Jo · Pass 0.3 s', skin: 'classic', pose: 'relaxed', item: 'yoyo', setup: (p) => sub(p, 'pass', 0.3) },
      {
        label: 'Spinner · Pinch',
        skin: 'classic',
        pose: 'pinch',
        item: 'spinner',
        setup: (_p, f) => {
          place(f, [-5.6, 11.9, -1.2], 0.6, -0.8, 0.3);
          viewAlignedRot(f, (q) => q.copy(viewQ('up', 0.5)).multiply(viewQ('right', -0.2)));
        },
      },
      {
        label: 'Spinner · Fingerspitze (Surf)',
        skin: 'classic',
        pose: 'point',
        item: 'spinner',
        setup: (p, f) => {
          const tip = inWrist(p.rig, p.rig.fingers[0][2], new Vector3(0, 2.6, 0));
          place(f, [tip.x, tip.y, tip.z], 0, 0.7, 0);
          viewAlignedRot(f, (q) => q.copy(viewQ('right', -0.95)));
        },
      },
      {
        label: 'Münze · Knöchel (Faust)',
        skin: 'classic',
        pose: 'fist',
        item: 'coin',
        setup: (p, f) => {
          const k = inWrist(p.rig, p.rig.fingers[1][1], new Vector3(0, 0, 1.3));
          place(f, [k.x, k.y, k.z], 0, 0.9, 0.2);
          viewAlignedRot(f, (q) => q.copy(viewQ('right', -1.2)).multiply(viewQ('up', 0.3)));
        },
      },
      {
        label: 'Münze · Flip (Luft)',
        skin: 'classic',
        pose: 'thumbsUp',
        item: 'coin',
        setup: (p, f) => {
          const t = inWrist(p.rig, p.rig.thumb[2], new Vector3(0, 2.4, 0));
          place(f, [t.x, t.y, t.z], 0, 5.5, 0);
          viewAlignedRot(f, (q) => q.copy(viewQ('right', 0.9)));
        },
      },
      {
        label: 'Feuerzeug · zu',
        skin: 'classic',
        pose: 'grip',
        item: 'lighter',
        setup: (p, f) => {
          lighterGrip(f);
          p.setFlame(false, 0, 1, 0);
        },
      },
      {
        label: 'Feuerzeug · offen + Flamme',
        skin: 'classic',
        pose: 'grip',
        item: 'lighter',
        setup: (p, f) => {
          lighterGrip(f);
          p.setFlame(true, 0, 1.3, 1);
        },
      },
      {
        label: 'Feuerzeug · Fahrtwind 900 u/s',
        skin: 'classic',
        pose: 'grip',
        item: 'lighter',
        setup: (p, f) => {
          lighterGrip(f);
          p.setFlame(true, 0.9, 2.1, 1);
        },
      },
      {
        label: 'Kendama · Ruhe (Kugel hängt)',
        skin: 'classic',
        pose: 'grip',
        item: 'kendama',
        setup: (p, f) => kendama(p, f, 'hang'),
      },
      {
        label: 'Kendama · großer Becher',
        skin: 'classic',
        pose: 'grip',
        item: 'kendama',
        setup: (p, f) => kendama(p, f, 'cup'),
      },
      {
        label: 'Kendama · Kugel fliegt',
        skin: 'classic',
        pose: 'grip',
        item: 'kendama',
        setup: (p, f) => kendama(p, f, 'air'),
      },
      {
        label: 'Handy · Feed (Daumen scrollt)',
        skin: 'classic',
        pose: 'grip',
        item: 'phone',
        thumb: [0.35, 0.2, 0.3, 0.2],
        setup: (_p, f) => {
          place(f, CAN_HOLD_POS, -2.2, 1.6, 2.2);
          viewAlignedRot(f, (q) => q.copy(viewQ('up', 0.45)).multiply(viewQ('cam', 0.3)));
        },
      },
      {
        label: 'Handy · hoch (Ziel-Foto)',
        skin: 'classic',
        pose: 'grip',
        item: 'phone',
        thumb: [0.35, 0.2, 0.3, 0.2],
        setup: (_p, f) => {
          f.x -= 0.1;
          f.y -= 0.12;
          place(f, CAN_HOLD_POS, -2.2, 1.6, 2.2);
          viewAlignedRot(f, (q) => q.copy(viewQ('up', 0.1)).multiply(viewQ('cam', 1.5)));
        },
      },
    ];
  }
  if (name === 'combos') {
    return [
      { label: 'Roboter + Jo-Jo Around', skin: 'robot', pose: 'run', item: 'yoyo', setup: (p) => sub(p, 'around', 0.5) },
      { label: 'Skelett + Feuerzeug', skin: 'skeleton', pose: 'grip', item: 'lighter', setup: (p, f) => lighterAt(p, f) },
      { label: 'Gold + Münze', skin: 'gold', pose: 'fist', item: 'coin', setup: (p, f) => coinAt(p, f) },
      { label: 'Katze · Krallen raus (open)', skin: 'cat', pose: 'open', claws: 1 },
      { label: 'Katze · Krallen drin (open)', skin: 'cat', pose: 'open', claws: 0 },
      { label: 'Katze + Kendama', skin: 'cat', pose: 'grip', item: 'kendama', setup: (p, f) => kendama(p, f, 'cup') },
      { label: 'Neon (Referenz)', skin: 'neon', pose: 'relaxed' },
      { label: 'Roboter · fist', skin: 'robot', pose: 'fist' },
      { label: 'Katze · relaxed, Krallen raus', skin: 'cat', pose: 'relaxed', claws: 1 },
      { label: 'Katze · fist (Checkpoint)', skin: 'cat', pose: 'fist', claws: 0 },
    ];
  }
  if (name === 'ingame') {
    const phone = (_p: Proto, f: ViewModelFrame): void => {
      place(f, CAN_HOLD_POS, -2.2, 1.6, 2.2);
      viewAlignedRot(f, (q) => q.copy(viewQ('up', 0.45)).multiply(viewQ('cam', 0.3)));
    };
    return [
      { label: 'Spielgröße 480×270 · Roboter + Jo-Jo Sleeper', skin: 'robot', pose: 'relaxed', item: 'yoyo', setup: (p) => sub(p, 'sleeper', 0.8) },
      { label: 'Katze (Krallen raus) + Spinner', skin: 'cat', pose: 'pinch', item: 'spinner', claws: 1, setup: (_p, f) => {
          place(f, [-5.6, 11.9, -1.2], 0.6, -0.8, 0.3);
          viewAlignedRot(f, (q) => q.copy(viewQ('up', 0.5)).multiply(viewQ('right', -0.2)));
        } },
      { label: 'Skelett + Kendama (großer Becher)', skin: 'skeleton', pose: 'grip', item: 'kendama', setup: (p, f) => kendama(p, f, 'cup') },
      { label: 'Gold + Handy (Feed)', skin: 'gold', pose: 'grip', item: 'phone', thumb: [0.35, 0.2, 0.3, 0.2], setup: phone },
      { label: 'Standard + Feuerzeug, Fahrtwind', skin: 'classic', pose: 'grip', item: 'lighter', setup: (p, f) => {
          lighterGrip(f);
          p.setFlame(true, 0.9, 2.1, 1);
        } },
      { label: 'Neon + Münze (Flip)', skin: 'neon', pose: 'thumbsUp', item: 'coin', setup: (p, f) => {
          const t = inWrist(p.rig, p.rig.thumb[2], new Vector3(0, 2.4, 0));
          place(f, [t.x, t.y, t.z], 0, 5.5, 0);
          viewAlignedRot(f, (q) => q.copy(viewQ('right', 0.9)));
        } },
    ];
  }
  return [];
}

function sub(p: Proto, trick: YoyoTrick | 'none', at: number): void {
  const r = yoyoAt(p, trick, at);
  p.setSub(r.sub, r.spin, 'yoyo');
  p.setString(r.rope);
}

function lighterAt(p: Proto, f: ViewModelFrame): void {
  lighterGrip(f);
  p.setFlame(true, 0.2, 1.7, 1);
}

/** Wie die Dose gegriffen (CAN_HOLD_ROT: Achse quer, Deckel zum Daumen), entlang der Achse zum Daumen geschoben. */
function lighterGrip(f: ViewModelFrame): void {
  f.propPos.set([CAN_HOLD_POS[0] - 5.2, CAN_HOLD_POS[1] + 0.3, CAN_HOLD_POS[2] + 0.6]);
  f.propRot.set(CAN_HOLD_ROT);
}

function coinAt(p: Proto, f: ViewModelFrame): void {
  const k = inWrist(p.rig, p.rig.fingers[1][1], new Vector3(0, 0, 1.3));
  place(f, [k.x, k.y, k.z], 0, 0.9, 0.2);
  viewAlignedRot(f, (q) => q.copy(viewQ('right', -1.2)).multiply(viewQ('up', 0.3)));
}

function kendama(p: Proto, f: ViewModelFrame, mode: 'hang' | 'cup' | 'air'): void {
  place(f, CAN_HOLD_POS, -1.6, 0.4, 1.4);
  viewAlignedRot(f, (q) => q.copy(viewQ('cam', -0.35)));
  p.preview.vm.apply(f);
  p.preview.vm.scene.updateMatrixWorld(true);
  const ken = p.rig.spinner;
  const hole = inWrist(p.rig, ken, new Vector3(0, 0.1, 0.9));
  const cupTop = inWrist(p.rig, ken, new Vector3(-3.8, 0.6, 0));
  const A = VIEW_AXES;
  const at = (base: Vector3, r: number, u: number, c: number): Float32Array => {
    const o = new Float32Array(3);
    for (let k = 0; k < 3; k++) o[k] = base.getComponent(k) + A.right[k] * r + A.up[k] * u + A.cam[k] * c;
    return o;
  };
  const tama = mode === 'hang' ? at(hole, 0.8, -9.5, 0.5) : mode === 'cup' ? at(cupTop, -1.2, 1.5, 0) : at(hole, -3.5, 7.5, 1.5);
  p.setSub(tama, mode === 'air' ? 1.2 : 0, 'tama');
  // Schnur: einfache Kettenlinie (im Prototyp ohne Physik — der Jo-Jo zeigt die Verlet-Schnur).
  const pts = new Float32Array(27);
  const L = 11;
  const d = Math.hypot(tama[0] - hole.x, tama[1] - hole.y, tama[2] - hole.z);
  const sag = 0.5 * Math.sqrt(Math.max(0, L * L - d * d));
  for (let i = 0; i < 9; i++) {
    const u = i / 8;
    const s = sag * 4 * u * (1 - u);
    for (let k = 0; k < 3; k++) pts[i * 3 + k] = hole.getComponent(k) + (tama[k] - hole.getComponent(k)) * u - A.up[k] * s;
  }
  p.setString(pts);
}

interface RenderOptions {
  readonly w: number;
  readonly h: number;
  readonly zoom: number;
  readonly depth: number;
  readonly x: number;
  readonly y: number;
}

function render(name: string, o: RenderOptions): Record<string, Stats> {
  sheet.textContent = '';
  if (!proto || size.w !== o.w || size.h !== o.h) {
    proto?.preview.dispose();
    const cv = document.createElement('canvas');
    proto = new Proto(cv, o.w, o.h);
    size = { w: o.w, h: o.h };
  }
  const p = proto;
  p.preview.vm.depth = o.depth;
  p.preview.setBackground('#141030', '#3a2458', '#1a2340', '#33f0ff', 0.28);
  const stats: Record<string, Stats> = {};
  for (const c of scene(name)) {
    const f = frameFor(c, o.x, o.y);
    const st = p.setSkin(c.skin, c.claws ?? 0);
    const item = c.item ?? 'none';
    p.setItem(item);
    p.preview.prewarm(f.item, f.glove);
    p.preview.vm.apply(f);
    p.preview.vm.scene.updateMatrixWorld(true);
    c.setup?.(p, f);
    p.preview.render(f, 1.3);
    stats[c.label] = p.stats(p.preview.vm.scene);
    if (item === 'none' || item === 'can') stats[`${c.skin} (nur Hand)`] = st;
    const out = document.createElement('canvas');
    out.width = o.w * o.zoom;
    out.height = o.h * o.zoom;
    const ctx = out.getContext('2d');
    if (!ctx) continue;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(p.preview.canvas, 0, 0, out.width, out.height);
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.append(out);
    const lab = document.createElement('div');
    lab.textContent = c.label;
    cell.append(lab);
    sheet.append(cell);
  }
  return stats;
}

declare global {
  interface Window {
    __kos?: { render: typeof render; poses: readonly string[] };
  }
}
window.__kos = { render, poses: HAND_POSES };
