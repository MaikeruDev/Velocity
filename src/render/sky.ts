import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  GLSL3,
  Matrix4,
  Mesh,
  Points,
  ShaderMaterial,
  Vector3,
} from 'three';
import type { PerspectiveCamera, Scene } from 'three';
import type { EnvironmentDef } from '../world/level/LevelFormat';
import type { SharedUniforms } from './materials/shared';
import { hexToRgb, mulberry32, setVecFromHex } from './util';

/**
 * Himmel in drei Schichten, alle "unendlich weit" (folgen der Kamera, schreiben
 * keine Tiefe, werden vor der Welt gezeichnet):
 *  1. Vollbild-Dreieck: Gradient + Synthwave-Sonne, pro Low-Res-Pixel aus der
 *     Blickrichtung berechnet → Scheibe und Streifen sind pixelscharf.
 *  2. Sterne als GL_POINTS mit 1–2 px — immer exakt Pixelgröße, kein Aliasing.
 *  3. Low-Poly-Silhouettenring (Berge + Hochhäuser mit Fensterpixeln).
 *
 * Die Sonnenscheibe steht in Azimut-Richtung von sunDir, aber knapp über dem
 * Horizont: bei den typischen sunDir-Höhen (30°+) läge sie sonst außerhalb des
 * Bildes, sobald man geradeaus schaut. Die Beleuchtung nutzt weiter sunDir.
 */

const SKY_VERT = /* glsl */ `
out vec2 vNdc;
void main() {
  vNdc = position.xy;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const SKY_FRAG = /* glsl */ `
uniform mat4 uInvViewRot;
uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyBottom;
uniform vec3 uSunSkyDir;
uniform vec3 uSunRight;
uniform vec3 uSunUp;
uniform vec3 uSunTop;
uniform vec3 uSunBottom;
uniform float uSunRadius;
uniform float uTime;
in vec2 vNdc;
out vec4 fragColor;
void main() {
  vec4 p = uInvViewRot * vec4(vNdc, 1.0, 1.0);
  vec3 dir = normalize(p.xyz / p.w);
  float e = dir.y;
  vec3 col;
  if (e >= 0.0) {
    col = mix(uSkyHorizon, uSkyTop, pow(clamp(e / 0.6, 0.0, 1.0), 0.55));
  } else {
    col = mix(uSkyHorizon, uSkyBottom, smoothstep(0.0, 0.2, -e));
  }
  float sd = dot(dir, uSunSkyDir);
  if (sd > 0.0) {
    vec2 sp = vec2(dot(dir, uSunRight), dot(dir, uSunUp)) / uSunRadius;
    float r = length(sp);
    // Dezenter Dunst um die Scheibe (Teil der Himmelsmalerei, kein Bloom).
    col += uSunBottom * 0.22 * (1.0 - smoothstep(0.9, 2.4, r)) * step(-0.02, e);
    if (r < 1.0 && e > -0.004) {
      vec3 sc = mix(uSunBottom, uSunTop, smoothstep(-0.7, 0.8, sp.y));
      // Outrun-Streifen: gleicher Abstand, Lücken werden nach unten breiter.
      float depth = 0.3 - sp.y;
      float ph = fract(depth * 6.0 - uTime * 0.25);
      float gap = clamp(depth * 0.42, 0.0, 0.62);
      bool cut = depth > 0.0 && ph < gap;
      if (!cut) col = sc;
    }
  }
  fragColor = vec4(col, 1.0);
}
`;

const STAR_VERT = /* glsl */ `
in float aSize;
in float aPhase;
in float aBright;
uniform float uTime;
out float vB;
void main() {
  vec4 clip = projectionMatrix * viewMatrix * vec4(position + cameraPosition, 1.0);
  // Auf die Far-Plane legen, aber nie dahinter (sonst wegge-clippt, egal wie weit far ist).
  clip.z = clip.w * 0.99999;
  gl_Position = clip;
  gl_PointSize = aSize;
  float tw = 0.7 + 0.3 * sin(uTime * (0.8 + aPhase * 2.5) + aPhase * 40.0);
  vB = aBright * tw * smoothstep(0.03, 0.3, normalize(position).y);
}
`;

const STAR_FRAG = /* glsl */ `
in float vB;
out vec4 fragColor;
void main() {
  fragColor = vec4(vec3(0.86, 0.84, 1.0) * vB, 1.0);
}
`;

const RING_VERT = /* glsl */ `
in vec3 aLocal;
out vec3 vLocal;
out float vEl;
void main() {
  vLocal = aLocal;
  vEl = normalize(position).y;
  vec4 clip = projectionMatrix * viewMatrix * vec4(position + cameraPosition, 1.0);
  clip.z = clip.w * 0.99998;
  gl_Position = clip;
}
`;

const RING_FRAG = /* glsl */ `
uniform vec3 uMtnBase;
uniform vec3 uMtnTop;
uniform vec3 uCity;
uniform vec3 uCityTop;
uniform vec3 uWindow;
uniform float uTime;
in vec3 vLocal;
in float vEl;
out vec4 fragColor;
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
void main() {
  vec3 col;
  if (vLocal.z < 0.0) {
    // Berge: dunstig, oben heller (Horizontlicht), unten im Himmelsgrund verschwindend.
    col = mix(uMtnBase, uMtnTop, smoothstep(-0.06, 0.07, vEl));
  } else {
    col = mix(uCity, uCityTop, smoothstep(-0.04, 0.12, vEl) * 0.6);
    // Fensterraster in Winkel-Einheiten (~1 Low-Res-Pixel pro Fenster).
    vec2 cell = floor(vLocal.xy / vec2(0.0085, 0.0095));
    vec2 f = fract(vLocal.xy / vec2(0.0085, 0.0095));
    float lit = step(0.8, hash21(cell + vLocal.z * 17.0));
    float blink = step(0.02, fract(hash21(cell * 1.7 + vLocal.z) + uTime * 0.03));
    if (f.x < 0.55 && f.y < 0.5 && vLocal.y > 0.006) col = mix(col, uWindow, lit * blink);
  }
  fragColor = vec4(col, 1.0);
}
`;

const RADIUS = 1000;

function dirFromAngles(az: number, el: number, out: Vector3): Vector3 {
  return out.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).multiplyScalar(RADIUS);
}

function buildStars(): BufferGeometry {
  const rng = mulberry32(0x5eed57a7);
  const n = 320;
  const pos = new Float32Array(n * 3);
  const size = new Float32Array(n);
  const phase = new Float32Array(n);
  const bright = new Float32Array(n);
  const v = new Vector3();
  for (let i = 0; i < n; i++) {
    const az = rng() * Math.PI * 2;
    // Gleichverteilt auf der oberen Halbkugel, Horizontnähe ausgedünnt.
    const el = Math.asin(0.06 + rng() * 0.94);
    dirFromAngles(az, el, v);
    pos.set([v.x, v.y, v.z], i * 3);
    size[i] = rng() < 0.08 ? 2 : 1;
    phase[i] = rng();
    bright[i] = 0.35 + 0.65 * rng() * rng();
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('aSize', new BufferAttribute(size, 1));
  g.setAttribute('aPhase', new BufferAttribute(phase, 1));
  g.setAttribute('aBright', new BufferAttribute(bright, 1));
  return g;
}

/** Berg-Grat + Hochhaus-Cluster als Ring. aLocal.z < 0 = Berg, sonst Gebäude-Seed. */
function buildSkyline(): BufferGeometry {
  const rng = mulberry32(0x0c17a11e);
  const pos: number[] = [];
  const local: number[] = [];
  const idx: number[] = [];
  const v = new Vector3();
  const base = -0.14;
  const push = (az: number, el: number, lx: number, ly: number, lz: number): number => {
    dirFromAngles(az, el, v);
    pos.push(v.x, v.y, v.z);
    local.push(lx, ly, lz);
    return pos.length / 3 - 1;
  };

  // Berge: zackiger Grat aus zwei überlagerten Frequenzen + Zufall.
  const segs = 120;
  const ridge: number[] = [];
  const o1 = rng() * 10;
  const o2 = rng() * 10;
  for (let i = 0; i <= segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    const h = 0.03 + 0.022 * Math.sin(a * 3 + o1) + 0.014 * Math.sin(a * 7 + o2) + 0.018 * rng();
    ridge.push(Math.max(0.008, h));
  }
  ridge[segs] = ridge[0];
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2;
    const a1 = ((i + 1) / segs) * Math.PI * 2;
    const b0 = push(a0, base, 0, 0, -1);
    const t0 = push(a0, ridge[i], 0, 0, -1);
    const b1 = push(a1, base, 0, 0, -1);
    const t1 = push(a1, ridge[i + 1], 0, 0, -1);
    idx.push(b0, t0, t1, b0, t1, b1);
  }

  // Hochhaus-Cluster ("ferne Städte").
  const clusters = 5;
  for (let c = 0; c < clusters; c++) {
    const center = rng() * Math.PI * 2;
    const count = 14 + Math.floor(rng() * 14);
    for (let k = 0; k < count; k++) {
      const spread = (rng() + rng() + rng() - 1.5) * 0.35;
      const az = center + spread;
      const w = 0.012 + rng() * 0.026;
      const falloff = 1 - Math.min(1, Math.abs(spread) / 0.55);
      const h = 0.02 + (0.03 + rng() * 0.065) * falloff;
      const seed = 1 + c * 100 + k;
      const b0 = push(az, base, 0, 0, seed);
      const t0 = push(az, h, 0, h - base, seed);
      const b1 = push(az + w, base, w, 0, seed);
      const t1 = push(az + w, h, w, h - base, seed);
      idx.push(b0, t0, t1, b0, t1, b1);
    }
  }

  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('aLocal', new BufferAttribute(new Float32Array(local), 3));
  g.setIndex(idx);
  return g;
}

function fullscreenTriangle(): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  return g;
}

export class SkyLayers {
  private readonly skyMat: ShaderMaterial;
  private readonly starMat: ShaderMaterial;
  private readonly ringMat: ShaderMaterial;
  private readonly skyMesh: Mesh;
  private readonly stars: Points;
  private readonly ring: Mesh;
  private readonly invViewRot = new Matrix4();

  constructor(scene: Scene, shared: SharedUniforms) {
    this.skyMat = new ShaderMaterial({
      name: 'PS2Sky',
      glslVersion: GLSL3,
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uInvViewRot: { value: this.invViewRot },
        uSkyTop: { value: new Vector3() },
        uSkyHorizon: { value: new Vector3() },
        uSkyBottom: { value: new Vector3() },
        uSunSkyDir: { value: new Vector3(0, 0, -1) },
        uSunRight: { value: new Vector3(1, 0, 0) },
        uSunUp: { value: new Vector3(0, 1, 0) },
        uSunTop: { value: new Vector3() },
        uSunBottom: { value: new Vector3() },
        uSunRadius: { value: 0.17 },
        uTime: shared.uTime,
      },
    });
    this.skyMesh = new Mesh(fullscreenTriangle(), this.skyMat);
    this.skyMesh.frustumCulled = false;
    this.skyMesh.renderOrder = -30;

    this.starMat = new ShaderMaterial({
      name: 'PS2Stars',
      glslVersion: GLSL3,
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      depthTest: false,
      depthWrite: false,
      blending: AdditiveBlending,
      uniforms: { uTime: shared.uTime },
    });
    this.stars = new Points(buildStars(), this.starMat);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -29;

    this.ringMat = new ShaderMaterial({
      name: 'PS2Skyline',
      glslVersion: GLSL3,
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide,
      uniforms: {
        uMtnBase: { value: new Vector3() },
        uMtnTop: { value: new Vector3() },
        uCity: { value: new Vector3() },
        uCityTop: { value: new Vector3() },
        uWindow: { value: new Vector3() },
        uTime: shared.uTime,
      },
    });
    this.ring = new Mesh(buildSkyline(), this.ringMat);
    this.ring.frustumCulled = false;
    this.ring.renderOrder = -28;

    scene.add(this.skyMesh, this.stars, this.ring);
  }

  setEnvironment(env: EnvironmentDef): void {
    const u = this.skyMat.uniforms;
    setVecFromHex(u.uSkyTop.value as Vector3, env.skyTop);
    setVecFromHex(u.uSkyHorizon.value as Vector3, env.skyHorizon);
    setVecFromHex(u.uSkyBottom.value as Vector3, env.skyBottom);

    // Sonnenscheibe: Azimut aus sunDir, Höhe auf den Horizontbereich begrenzt (siehe oben).
    const sd = new Vector3(...env.sunDir);
    if (sd.lengthSq() < 1e-8) sd.set(0, 1, -1);
    sd.normalize();
    const horiz = new Vector3(sd.x, 0, sd.z);
    if (horiz.lengthSq() < 1e-6) horiz.set(0, 0, -1);
    horiz.normalize();
    const el = Math.min(Math.asin(Math.max(-1, Math.min(1, sd.y))), 0.1);
    const skyDir = horiz.clone().multiplyScalar(Math.cos(el)).setY(Math.sin(el)).normalize();
    (u.uSunSkyDir.value as Vector3).copy(skyDir);
    const right = new Vector3().crossVectors(skyDir, new Vector3(0, 1, 0)).normalize();
    (u.uSunRight.value as Vector3).copy(right);
    (u.uSunUp.value as Vector3).crossVectors(right, skyDir).normalize();

    const sun = hexToRgb(env.sunColor);
    const alt = hexToRgb(env.trimColorAlt ?? '#ff3fd0');
    const hor = hexToRgb(env.skyHorizon);
    // Oben warmes Gelb aus der Sonnenfarbe, unten heißes Pink aus Horizont + Alt-Neon.
    (u.uSunTop.value as Vector3).set(Math.min(1, sun[0] * 1.05 + 0.05), Math.min(1, sun[1] * 1.02 + 0.06), sun[2] * 0.55);
    (u.uSunBottom.value as Vector3).set(
      (hor[0] + alt[0]) * 0.5,
      (hor[1] + alt[1]) * 0.35,
      (hor[2] + alt[2]) * 0.5,
    );

    const fog = hexToRgb(env.fogColor);
    const bottom = hexToRgb(env.skyBottom);
    const r = this.ringMat.uniforms;
    (r.uMtnTop.value as Vector3).set(
      (fog[0] * 0.55 + hor[0] * 0.45) * 0.75,
      (fog[1] * 0.55 + hor[1] * 0.45) * 0.75,
      (fog[2] * 0.55 + hor[2] * 0.45) * 0.75,
    );
    (r.uMtnBase.value as Vector3).set(bottom[0] * 1.2, bottom[1] * 1.2, bottom[2] * 1.2);
    (r.uCity.value as Vector3).set(bottom[0] * 0.8, bottom[1] * 0.8, bottom[2] * 0.85);
    (r.uCityTop.value as Vector3).set(
      (bottom[0] + fog[0]) * 0.5,
      (bottom[1] + fog[1]) * 0.5,
      (bottom[2] + fog[2]) * 0.5,
    );
    (r.uWindow.value as Vector3).set((alt[0] + sun[0]) * 0.5, (alt[1] + sun[1]) * 0.5, (alt[2] + sun[2]) * 0.5);
  }

  /** Pro Frame: Blickrichtungs-Matrix (nur Rotation) für den Gradienten-Pass. */
  update(camera: PerspectiveCamera): void {
    this.invViewRot.extractRotation(camera.matrixWorld).multiply(camera.projectionMatrixInverse);
  }

  dispose(): void {
    this.skyMesh.geometry.dispose();
    this.stars.geometry.dispose();
    this.ring.geometry.dispose();
    this.skyMat.dispose();
    this.starMat.dispose();
    this.ringMat.dispose();
  }
}
