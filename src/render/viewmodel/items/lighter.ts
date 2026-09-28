import { BufferAttribute, BufferGeometry, GLSL3, Group, Mesh, PlaneGeometry, Points, ShaderMaterial, Vector3 } from 'three';
import type { IUniform } from 'three';
import { GLSL_BAYER } from '../../materials/shared';
import { VM_PARAM } from '../../types';
import type { ViewModelFrame } from '../../types';
import { mergeGeometries, rgb, tubeGeometry } from '../vmGeometry';
import { ScalarUniform, createLitMaterial, createOutlineMaterial } from '../vmMaterials';
import { PROP_OUTLINE } from '../vmBuild';
import type { ItemView, VmBuildCtx } from '../vmBuild';

/**
 * Sturmfeuerzeug (Plan 007, KI2), generisch, ohne Marke: Chrom-Körper (Superellipse n = 6) mit
 * Glanzband, Kamin mit Lochraster, Reibrad, Deckel am Scharnier. Flamme = Billboard im View-Raum
 * (steht immer nach oben im Bild, egal wie das Feuerzeug liegt), Tropfenform mit 3 Farbstufen und
 * blauem Fuß, Rand im Bayer-Dither — KEIN Blending (look.md). Funken (Zünden) und Rauch (ausgeblasen)
 * als eigene Pixel-Partikel aus f.poof (ownPoof).
 *
 * Kanäle (VM_PARAM.lighter): Deckel 0..1 (Überschwinger > 1 erlaubt), Flamme 0..1.6 (> 1 =
 * Aufflackern; < 0 = gerade ausgeblasen → f.poof zeigt Rauch statt Funken), Windneigung −1..1, Rad-Winkel.
 * Achse y = Deckel oben. Draw Calls: Körper 2, Deckel 2, Flamme 1, Partikel 1.
 */

const CHROME = rgb(0xc9ced8);
const SEAM = rgb(0x6c7484);
const STRIPE = rgb(0xeef2f8);
const CHIMNEY = rgb(0x8a92a0);
const HOLE = rgb(0x1c2030);
const WHEEL = rgb(0x4a5260);
const LID_INSIDE = rgb(0x7c8494);

function setRgb(c: [number, number, number], v: readonly [number, number, number]): void {
  c[0] = v[0];
  c[1] = v[1];
  c[2] = v[2];
}

/** Kamin-Oberkante (Flammenfuß) und Scharnier im Gegenstands-Raum. */
export const LIGHTER_FLAME_BASE: readonly [number, number, number] = [0.35, 1.75, 0];
const HINGE_X = 1.85;
const HINGE_Y = 0.4;
/** Deckel voll offen (rad) — 1 im Kanal. */
const LID_OPEN = 2.95;

const FLAME_VERT = /* glsl */ `
uniform float uScale;
uniform float uSize;
out vec2 vUv;
void main() {
  vUv = uv;
  // Billboard: Fuß im View-Raum, Ecken in der Bildebene (y von 0 = Fuß nach oben); Größe = Flamme.
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  mv.xy += vec2(position.x * (0.75 + 0.25 * uSize), position.y * uSize) * uScale;
  gl_Position = projectionMatrix * mv;
}
`;

const FLAME_FRAG = /* glsl */ `
${GLSL_BAYER}
uniform float uTime;
uniform float uLean;
uniform float uSize;
in vec2 vUv;
out vec4 fragColor;
void main() {
  float y = vUv.y;
  if (y > 0.98) discard;
  float x = vUv.x - 0.5 - uLean * 0.45 * y * y;
  float flick = 0.08 * sin(uTime * 23.0 + y * 9.0) + 0.05 * sin(uTime * 37.0 + y * 17.0);
  float w = 0.42 * pow(max(0.0, 1.0 - y), 0.55) * sqrt(max(0.0, y * 3.0));
  float d = abs(x + flick * y) / max(0.001, w);
  if (d > 1.0) discard;
  // Rand im Dither ausfransen (Screen-Door, kein Blending).
  float edge = 1.0 - smoothstep(0.7, 1.0, d);
  if (bayer4(ivec2(gl_FragCoord.xy)) > edge + 0.15) discard;
  vec3 c = d < 0.35 && y < 0.7 ? vec3(1.0, 0.97, 0.75) : d < 0.7 ? vec3(1.0, 0.7, 0.18) : vec3(0.95, 0.28, 0.1);
  if (y < 0.12 && d < 0.6) c = vec3(0.35, 0.6, 1.0);
  fragColor = vec4(c, 1.0);
}
`;

const SPARK_N = 10;
const SPARK_VERT = /* glsl */ `
uniform float uT;
uniform float uSmoke;
uniform float uSize;
uniform float uLean;
in vec3 aDir;
out float vK;
void main() {
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float e = 1.0 - (1.0 - uT) * (1.0 - uT);
  vec2 off;
  float size;
  if (uSmoke > 0.5) {
    // Rauch: graue Wölkchen steigen, weiten sich, treiben mit dem Wind.
    off = vec2(aDir.x * (0.6 + 1.8 * uT) + uLean * 2.0 * uT, 0.8 + aDir.y * 0.8 + 4.5 * uT);
    size = uSize * (1.6 + 2.0 * uT) * (0.7 + 0.5 * fract(aDir.z * 5.3));
  } else {
    // Funken: fliegen schräg hoch aus dem Rad, fallen wieder.
    off = vec2(aDir.x * 3.2 * e, (0.4 + aDir.y * 2.6) * e - 2.6 * uT * uT);
    size = uSize * (1.0 - 0.6 * uT);
  }
  mv.xy += off;
  gl_Position = projectionMatrix * mv;
  vK = fract(aDir.z * 7.1 + aDir.x * 3.3);
  gl_PointSize = max(1.0, floor(size + 0.5));
}
`;
const SPARK_FRAG = /* glsl */ `
${GLSL_BAYER}
uniform float uT;
uniform float uSmoke;
in float vK;
out vec4 fragColor;
void main() {
  if (uSmoke > 0.5) {
    // Auflösen per Screen-Door (kein Blending).
    if (bayer4(ivec2(gl_FragCoord.xy)) > 0.85 - 0.8 * uT) discard;
    fragColor = vec4(mix(vec3(0.78, 0.78, 0.82), vec3(0.55, 0.55, 0.62), vK), 1.0);
  } else {
    fragColor = vec4(vK > 0.5 ? vec3(1.0, 0.95, 0.55) : vec3(1.0, 0.55, 0.12), 1.0);
  }
}
`;

function bodyGeometry(): BufferGeometry {
  const body = tubeGeometry(
    [
      { y: -3.0, rx: 1.75, rz: 0.72, n: 6 },
      { y: -2.8, rx: 1.85, rz: 0.78, n: 6 },
      { y: 0.3, rx: 1.85, rz: 0.78, n: 6 },
      { y: 0.4, rx: 1.8, rz: 0.75, n: 6 },
    ],
    16,
    {
      poleStart: -3.05,
      poleEnd: 0.45,
      color: CHROME,
      colorAt: (x, y, _z, c) => {
        const col = y > 0.0 && y < 0.3 ? SEAM : Math.abs(x) < 0.25 && y < -0.5 && y > -2.5 ? STRIPE : null;
        if (col) {
          c[0] = col[0];
          c[1] = col[1];
          c[2] = col[2];
        }
      },
    },
  );
  const chimney = tubeGeometry(
    [
      { y: 0.4, rx: 1.0, rz: 0.55, n: 5 },
      { y: 1.7, rx: 1.0, rz: 0.55, n: 5 },
    ],
    12,
    {
      poleEnd: 1.72,
      color: CHIMNEY,
      colorAt: (x, y, _z, c) => {
        // Lochraster (Windschutz).
        if ((Math.round(x * 2.2) + Math.round(y * 2.2)) % 2 === 0 && y > 0.7 && y < 1.5) {
          c[0] = HOLE[0];
          c[1] = HOLE[1];
          c[2] = HOLE[2];
        }
      },
    },
  );
  chimney.translate(LIGHTER_FLAME_BASE[0], 0, 0);
  const wheel = tubeGeometry(
    [
      { y: -0.35, rx: 0.45, rz: 0.45 },
      { y: 0.35, rx: 0.45, rz: 0.45 },
    ],
    8,
    { poleStart: -0.4, poleEnd: 0.4, color: WHEEL },
  );
  wheel.rotateX(Math.PI / 2);
  wheel.translate(-0.95, 1.25, 0);
  const parts = [body, chimney, wheel];
  const g = mergeGeometries(parts);
  for (const q of parts) q.dispose();
  return g;
}

export function buildLighter(ctx: VmBuildCtx): ItemView {
  const L = ctx.light;
  const outline = ctx.track(createOutlineMaterial(L, PROP_OUTLINE, ctx.propPx));
  const chrome = ctx.track(createLitMaterial(L, { color: 0xffffff, rim: 0.5, wrap: 0.15, sheen: 0.55, sheenColor: 0xf4f8ff, vertexColors: true }));
  const group = new Group();
  ctx.part(group, bodyGeometry(), chrome, outline, null);
  const lid = new Group();
  lid.position.set(HINGE_X, HINGE_Y, 0);
  const lidGeo = tubeGeometry(
    [
      { y: 0, rx: 1.85, rz: 0.78, n: 6 },
      { y: 1.7, rx: 1.85, rz: 0.78, n: 6 },
      { y: 1.85, rx: 1.75, rz: 0.72, n: 6 },
    ],
    16,
    // Unterseite geschlossen (dunkles Innenblech): offen sähe man sonst in die leere Hülle (schwarz).
    { poleStart: -0.02, poleEnd: 1.9, color: CHROME, colorAt: (_x, y, _z, c) => (y < -0.01 ? setRgb(c, LID_INSIDE) : undefined) },
  );
  lidGeo.translate(-HINGE_X, 0, 0);
  ctx.part(lid, lidGeo, chrome, outline, null);
  group.add(lid);

  const size: IUniform<number> = new ScalarUniform(1);
  const lean: IUniform<number> = new ScalarUniform(0);
  // Cartoon-groß: bei 270 Zeilen sonst nur ein oranger Punkt über dem Kamin.
  const scale: IUniform<number> = new ScalarUniform(1.7);
  const flameMat = ctx.track(
    new ShaderMaterial({ glslVersion: GLSL3, vertexShader: FLAME_VERT, fragmentShader: FLAME_FRAG, uniforms: { uTime: L.uTime, uLean: lean, uSize: size, uScale: scale } }),
  );
  const flameGeo = ctx.trackGeo(new PlaneGeometry(1.6, 3.2));
  flameGeo.translate(0, 1.6, 0);
  const flame = new Mesh(flameGeo, flameMat);
  flame.position.set(LIGHTER_FLAME_BASE[0], LIGHTER_FLAME_BASE[1], LIGHTER_FLAME_BASE[2]);
  flame.frustumCulled = false;
  flame.visible = false;
  flame.renderOrder = 5;
  group.add(flame);

  const t: IUniform<number> = new ScalarUniform(0);
  const smoke: IUniform<number> = new ScalarUniform(0);
  const sparkMat = ctx.track(
    new ShaderMaterial({ glslVersion: GLSL3, vertexShader: SPARK_VERT, fragmentShader: SPARK_FRAG, uniforms: { uT: t, uSmoke: smoke, uSize: ctx.pointPx, uLean: lean } }),
  );
  const pg = ctx.trackGeo(new BufferGeometry());
  const dirs = new Float32Array(SPARK_N * 3);
  let seed = 11;
  const rnd = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < SPARK_N; i++) {
    dirs[i * 3] = rnd() * 2 - 1;
    dirs[i * 3 + 1] = rnd();
    dirs[i * 3 + 2] = rnd();
  }
  pg.setAttribute('position', new BufferAttribute(new Float32Array(SPARK_N * 3), 3));
  pg.setAttribute('aDir', new BufferAttribute(dirs, 3));
  const sparks = new Points(pg, sparkMat);
  sparks.position.set(-0.6, 1.5, 0);
  sparks.frustumCulled = false;
  sparks.visible = false;
  sparks.renderOrder = 10;
  group.add(sparks);
  group.visible = false;

  const P = VM_PARAM.lighter;
  return {
    group,
    ownPoof: true,
    apply(f: ViewModelFrame): void {
      const p = f.propParam;
      lid.rotation.z = -p[P.lid] * LID_OPEN;
      const fl = p[P.flame];
      const w = p[P.wind];
      lean.value = w > -1 ? (w < 1 ? w : 1) : -1;
      flame.visible = fl > 0.02;
      size.value = fl > 0 ? fl : 0;
      const ph = f.poof;
      sparks.visible = ph >= 0 && ph < 1;
      if (sparks.visible) {
        t.value = ph;
        smoke.value = fl < 0 ? 1 : 0;
      }
    },
  };
}
