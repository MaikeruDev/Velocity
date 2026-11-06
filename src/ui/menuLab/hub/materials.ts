// Stil 'hub' — Shader im PS2-Look des Spiels (Gouraud im Vertex-Shader, linearer Fog, Vertex-Snapping, Bayer erst im Post).
// Eigene kleine Kopien statt src/render-Materialien: die hängen an SharedUniforms/Level-Daten, die es im Menü nicht gibt.
import {
  DoubleSide,
  GLSL3,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
} from 'three';
import type { IUniform, Texture } from 'three';
import type { LevelTheme, Rgb } from './theme';
import { PAL } from './theme';

export const MAX_GROUPS = 32;
/** Farbige Punktlichter (je Station eins): färben Säulen und Boden in Trim-Farbe — Gouraud wie PS2. */
export const MAX_LIGHTS = 12;

/** Uniforms, die alle Hub-Materialien teilen (dieselben Objekte → ein Wert pro Frame). */
export interface HubUniforms {
  readonly uTime: IUniform<number>;
  /** Neon-Helligkeit 0.8 + 0.35·kick. */
  readonly uPulse: IUniform<number>;
  /** 0..1 innerhalb des Beats (Bodenwelle). */
  readonly uBeat: IUniform<number>;
  /** 0 = reducedMotion (kein Flackern, keine Wellen, keine Laufschrift). */
  readonly uMotion: IUniform<number>;
  readonly uRes: IUniform<Vector2>;
  readonly uFogColor: IUniform<Vector3>;
  readonly uFogNear: IUniform<number>;
  readonly uFogFar: IUniform<number>;
  /** Hervorhebung je Station 0..1 (Fokus 1, Hover ~0.55); Index NO_GROUP = Umgebung. */
  readonly uGlow: IUniform<Float32Array>;
  /** xyz + Reichweite. */
  readonly uLPos: IUniform<Vector4[]>;
  /** rgb + Stärke (je Frame aus Fokus/Kick). */
  readonly uLCol: IUniform<Vector4[]>;
}

const v3 = (c: Rgb): Vector3 => new Vector3(c[0], c[1], c[2]);

export function createHubUniforms(): HubUniforms {
  const glow = new Float32Array(MAX_GROUPS);
  glow[MAX_GROUPS - 1] = 0.5;
  return {
    uTime: { value: 0 },
    uPulse: { value: 0.85 },
    uBeat: { value: 0 },
    uMotion: { value: 1 },
    uRes: { value: new Vector2(480, 270) },
    uFogColor: { value: v3(PAL.fog) },
    uFogNear: { value: 18 },
    uFogFar: { value: 170 },
    uGlow: { value: glow },
    uLPos: { value: Array.from({ length: MAX_LIGHTS }, () => new Vector4(0, -100, 0, 1)) },
    uLCol: { value: Array.from({ length: MAX_LIGHTS }, () => new Vector4(0, 0, 0, 0)) },
  };
}

const GLSL_LIGHTS = /* glsl */ `
uniform vec4 uLPos[${MAX_LIGHTS}];
uniform vec4 uLCol[${MAX_LIGHTS}];
vec3 pointLights(vec3 p, vec3 n) {
  vec3 acc = vec3(0.0);
  for (int i = 0; i < ${MAX_LIGHTS}; i++) {
    vec3 d = uLPos[i].xyz - p;
    float l = length(d);
    float att = max(0.0, 1.0 - l / uLPos[i].w);
    att *= att;
    acc += uLCol[i].rgb * (uLCol[i].a * att * (0.3 + 0.7 * max(dot(n, d / max(l, 1e-3)), 0.0)));
  }
  return acc;
}
`;

const GLSL_COMMON = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
`;

const GLSL_SNAP = /* glsl */ `
uniform vec2 uRes;
vec4 snapClip(vec4 c) {
  // Nur halb einrasten: PS2-Wackeln ja, aber die Kamera gleitet — volles Snapping zittert dann sichtbar.
  if (c.w < 0.5) return c;
  vec2 px = (c.xy / c.w * 0.5 + 0.5) * uRes;
  px = mix(px, floor(px + 0.5), 0.5);
  return vec4((px / uRes * 2.0 - 1.0) * c.w, c.z, c.w);
}
`;

// ---------------------------------------------------------------------------------------------------- Lit (Welt)

const LIT_VERT = /* glsl */ `
${GLSL_SNAP}
${GLSL_LIGHTS}
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbSky;
uniform vec3 uAmbGround;
uniform float uFogNear;
uniform float uFogFar;
uniform float uGlow[${MAX_GROUPS}];
in vec3 aColor;
in vec3 aMeta;
out vec3 vCol;
out vec3 vLight;
out float vFog;
out vec3 vWorld;
out vec3 vN;
flat out float vEmit;
flat out float vMode;
flat out float vGroup;
out float vGlow;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vec3 n = normalize(mat3(modelMatrix) * normal);
  vec3 amb = mix(uAmbGround, uAmbSky, n.y * 0.5 + 0.5);
  float sun = max(dot(n, uSunDir), 0.0);
  vLight = amb * 1.05 + uSunColor * sun * 0.75 + pointLights(world.xyz, n);
  vCol = aColor;
  vEmit = aMeta.x;
  vGroup = aMeta.y;
  vMode = aMeta.z;
  vGlow = uGlow[int(aMeta.y + 0.5)];
  vec4 view = viewMatrix * world;
  vFog = clamp((length(view.xyz) - uFogNear) / max(uFogFar - uFogNear, 1.0), 0.0, 1.0);
  vWorld = world.xyz;
  vN = n;
  gl_Position = snapClip(projectionMatrix * view);
}
`;

const LIT_FRAG = /* glsl */ `
${GLSL_COMMON}
${GLSL_LIGHTS}
uniform vec3 uAmbSky;
uniform float uTime;
uniform float uPulse;
uniform float uBeat;
uniform float uMotion;
uniform vec3 uFogColor;
in vec3 vCol;
in vec3 vLight;
in float vFog;
in vec3 vWorld;
in vec3 vN;
flat in float vEmit;
flat in float vMode;
flat in float vGroup;
in float vGlow;
out vec4 fragColor;

void main() {
  vec3 base = vCol;
  float emit = vEmit;
  int mode = int(vMode + 0.5);
  float glowK = 0.62 + 0.62 * vGlow;
  if (mode == 1) {
    // Stadtfassaden: Fensterraster in Weltkoordinaten, nur auf senkrechten Flächen.
    if (abs(vN.y) < 0.5) {
      vec2 f = abs(vN.x) > 0.5 ? vec2(vWorld.z, vWorld.y) : vec2(vWorld.x, vWorld.y);
      vec2 cell = floor(f / vec2(3.0, 4.0));
      vec2 fc = fract(f / vec2(3.0, 4.0));
      float h = hash12(cell + floor(vWorld.xz * 0.02) * 17.0);
      bool win = fc.x > 0.36 && fc.x < 0.66 && fc.y > 0.36 && fc.y < 0.7;
      if (win && h > 0.8) {
        float t = hash12(cell * 1.7 + 3.0);
        base = t < 0.55 ? vec3(1.0, 0.62, 0.88) : (t < 0.85 ? vec3(0.45, 0.95, 1.0) : vec3(1.0, 0.85, 0.5));
        // Selten ein Fenster, das an/aus geht.
        if (uMotion > 0.5 && h > 0.985) base *= step(0.5, fract(uTime * 0.21 + t * 7.0));
        emit = 1.0;
      }
    }
  } else if (mode == 2) {
    // Dachboden: Kacheln 2 m, 1-px-Fugen in Cyan; eine Lichtwelle läuft auf der Kick nach außen.
    vec2 g = vWorld.xz * 0.5;
    vec2 fw = max(fwidth(g), vec2(1e-4));
    vec2 d = abs(fract(g - 0.5) - 0.5) / fw;
    float line = step(min(d.x, d.y), 0.75);
    float chk = mod(floor(g.x) + floor(g.y), 2.0);
    base *= 0.92 + 0.12 * chk;
    float r = length(vWorld.xz);
    float wave = uMotion * smoothstep(1.6, 0.0, abs(r - uBeat * 16.0)) * (1.0 - uBeat);
    vec3 lineCol = vec3(0.2, 0.94, 1.0) * (0.42 + 0.6 * wave) * step(r, 13.6);
    // Boden je Pixel beleuchten (Lichtpfützen unter den Stationen), in Stufen — wie gemalte PS2-Lightmaps.
    vec3 pl = pointLights(vWorld + vec3(0.0, 0.05, 0.0), vec3(0.0, 1.0, 0.0));
    pl = floor(pl * 6.0 + hash12(floor(gl_FragCoord.xy)) * 0.9) / 6.0;
    vec3 lit = base * (uAmbSky * 0.55 + pl * 1.4);
    vec3 c = mix(lit, lineCol + lit * 0.4, line);
    c = mix(c, uFogColor, vFog);
    fragColor = vec4(c, 1.0);
    return;
  } else if (mode == 3) {
    // Flackernde Röhre: meist an, ab und zu kurz aus (je Station eigener Takt).
    float k = floor(uTime * 14.0);
    float f = hash12(vec2(k, vGroup * 7.31));
    float off = step(0.94, f) * step(0.5, hash12(vec2(floor(uTime * 0.7), vGroup)));
    emit *= 1.0 - 0.8 * off * uMotion;
  } else if (mode == 4) {
    // Röhrenmonitor: Zeilen laufen nach oben, Rauschpunkte.
    float row = floor(gl_FragCoord.y * 0.5 + uTime * 9.0 * uMotion);
    base *= 0.72 + 0.28 * step(0.5, fract(row * 0.5));
    base *= 0.85 + 0.3 * hash12(vec2(row, floor(gl_FragCoord.x * 0.25)));
  } else if (mode == 5) {
    float s = step(0.5, fract((vWorld.x + vWorld.y + vWorld.z) * 1.6));
    base = mix(vec3(0.06, 0.05, 0.1), vec3(1.0, 0.8, 0.15), s);
  } else if (mode == 6) {
    // Bodenpfeile zum gewählten Portal: Lauflicht nach außen.
    float r = length(vWorld.xz);
    float run = step(0.55, fract(r * 0.42 - uTime * 1.1 * uMotion));
    base *= 0.35 + 0.75 * run;
  }
  vec3 c;
  if (emit > 1.5) c = base * uPulse * glowK;
  else if (emit > 0.5) c = base * glowK;
  else c = base * vLight * (0.85 + 0.2 * vGlow);
  c = mix(c, uFogColor, vFog * (emit > 0.5 ? 0.55 : 1.0));
  fragColor = vec4(c, 1.0);
}
`;

export function createLitMaterial(u: HubUniforms): ShaderMaterial {
  return new ShaderMaterial({
    name: 'HubLit',
    glslVersion: GLSL3,
    vertexShader: LIT_VERT,
    fragmentShader: LIT_FRAG,
    uniforms: {
      uTime: u.uTime,
      uPulse: u.uPulse,
      uBeat: u.uBeat,
      uMotion: u.uMotion,
      uRes: u.uRes,
      uFogColor: u.uFogColor,
      uFogNear: u.uFogNear,
      uFogFar: u.uFogFar,
      uGlow: u.uGlow,
      uLPos: u.uLPos,
      uLCol: u.uLCol,
      uSunDir: { value: new Vector3(-0.2, 0.35, 1).normalize() },
      uSunColor: { value: v3(PAL.sunCol) },
      uAmbSky: { value: v3(PAL.ambSky) },
      uAmbGround: { value: v3(PAL.ambGround) },
    },
  });
}

// ---------------------------------------------------------------------------------------------------- Himmel

const SKY_VERT = /* glsl */ `
out vec2 vNdc;
void main() {
  vNdc = position.xy;
  gl_Position = vec4(position.xy, 0.99999, 1.0);
}
`;

const SKY_FRAG = /* glsl */ `
${GLSL_COMMON}
uniform mat4 uInvViewProj;
uniform vec3 uTop;
uniform vec3 uMid;
uniform vec3 uHorizon;
uniform vec3 uBottom;
uniform vec3 uSunDir;
uniform vec3 uSunTop;
uniform vec3 uSunBottom;
uniform float uTime;
uniform float uMotion;
in vec2 vNdc;
out vec4 fragColor;
void main() {
  vec4 p = uInvViewProj * vec4(vNdc, 1.0, 1.0);
  vec3 dir = normalize(p.xyz / p.w);
  float e = dir.y;
  vec3 col;
  // Harte Stufen statt glattem Verlauf: das Post-Dithering macht daraus die PS2-Bänder.
  if (e >= 0.0) {
    col = mix(uHorizon, uMid, smoothstep(0.0, 0.16, e));
    col = mix(col, uTop, smoothstep(0.12, 0.62, e));
  } else {
    col = mix(uHorizon * 0.8, uBottom, smoothstep(0.0, 0.25, -e));
  }
  // Sonne knapp über dem Horizont, Outrun-Streifen unten.
  vec3 sr = normalize(cross(uSunDir, vec3(0.0, 1.0, 0.0)));
  vec3 su = cross(sr, uSunDir);
  float sd = dot(dir, uSunDir);
  if (sd > 0.0) {
    vec2 sp = vec2(dot(dir, sr), dot(dir, su)) / 0.13;
    float r = length(sp);
    col += uSunBottom * 0.16 * (1.0 - smoothstep(0.9, 2.6, r)) * step(-0.02, e);
    if (r < 1.0) {
      vec3 sc = mix(uSunBottom, uSunTop, smoothstep(-0.8, 0.8, sp.y));
      float depth = 0.25 - sp.y;
      float ph = fract(depth * 5.5 - uTime * 0.18 * uMotion);
      float gap = clamp(depth * 0.4, 0.0, 0.6);
      if (!(depth > 0.0 && ph < gap)) col = sc;
    }
  }
  // Zwei dünne Wolkenbänder vor der Sonne (Silhouette, Wellenkante).
  float az = atan(dir.x, -dir.z);
  float b1 = abs(e - 0.045 - 0.012 * sin(az * 9.0 + 1.3) - 0.006 * sin(az * 23.0));
  float b2 = abs(e - 0.105 - 0.01 * sin(az * 6.0 + 4.0) - 0.004 * sin(az * 31.0));
  if (b1 < 0.007 || b2 < 0.005) col = mix(col, uMid * 0.55, 0.85);
  // Hohe, vom Sonnenuntergang angestrahlte Streifenwolken (langsam ziehend) — geben dem leeren Himmel Tiefe.
  float drift = uTime * 0.004 * uMotion;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float ce = 0.2 + fi * 0.09 + 0.018 * sin(az * (3.0 + fi) + fi * 2.1 + drift * (1.0 + fi));
    float th = 0.006 + 0.005 * sin(az * (7.0 + fi * 3.0) + fi + drift * 3.0);
    float on = step(abs(e - ce), max(th, 0.0)) * step(0.15, sin(az * (2.0 + fi) + fi * 4.0 + drift));
    col = mix(col, mix(uHorizon, uMid, 0.35 + fi * 0.2), on * (0.55 - fi * 0.12));
  }
  fragColor = vec4(col, 1.0);
}
`;

export function createSkyMaterial(u: HubUniforms): ShaderMaterial {
  return new ShaderMaterial({
    name: 'HubSky',
    glslVersion: GLSL3,
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    depthWrite: false,
    depthTest: false,
    uniforms: {
      uInvViewProj: { value: null },
      uTop: { value: v3(PAL.skyTop) },
      uMid: { value: v3(PAL.skyMid) },
      uHorizon: { value: v3(PAL.skyHorizon) },
      uBottom: { value: v3(PAL.fog) },
      uSunDir: { value: new Vector3(0.3, 0.075, 1).normalize() },
      uSunTop: { value: v3(PAL.sunTop) },
      uSunBottom: { value: v3(PAL.sunBottom) },
      uTime: u.uTime,
      uMotion: u.uMotion,
    },
  });
}

// ---------------------------------------------------------------------------------------------------- Punkte (Sterne, Funken)

const STAR_VERT = /* glsl */ `
in float aB;
uniform float uTime;
uniform float uMotion;
out float vB;
void main() {
  vec4 clip = projectionMatrix * viewMatrix * vec4(position * 300.0 + cameraPosition, 1.0);
  clip.z = clip.w * 0.99998;
  gl_Position = clip;
  gl_PointSize = aB > 0.9 ? 2.0 : 1.0;
  float tw = 0.75 + 0.25 * sin(uTime * (0.6 + aB * 2.0) * uMotion + aB * 60.0);
  vB = aB * tw * smoothstep(0.08, 0.35, normalize(position).y);
}
`;

const STAR_FRAG = /* glsl */ `
in float vB;
out vec4 fragColor;
void main() {
  if (vB < 0.12) discard;
  fragColor = vec4(vec3(0.9, 0.86, 1.0) * vB, 1.0);
}
`;

export function createStarMaterial(u: HubUniforms): ShaderMaterial {
  return new ShaderMaterial({
    name: 'HubStars',
    glslVersion: GLSL3,
    vertexShader: STAR_VERT,
    fragmentShader: STAR_FRAG,
    depthWrite: false,
    uniforms: { uTime: u.uTime, uMotion: u.uMotion },
  });
}

const SPARK_VERT = /* glsl */ `
in vec4 aSeed;
in vec3 aColor;
uniform float uTime;
uniform float uMotion;
uniform float uPulse;
out vec3 vC;
void main() {
  // Funken steigen langsam, wickeln oben um; Bewegung nur im Shader (keine CPU-Arbeit je Frame).
  float t = uTime * uMotion;
  float y = mod(aSeed.y + t * aSeed.w, 9.0);
  vec3 p = vec3(aSeed.x + sin(t * 0.6 + aSeed.z * 6.0) * 0.25, y, aSeed.z + cos(t * 0.5 + aSeed.x) * 0.25);
  vec4 view = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * view;
  float d = -view.z;
  gl_PointSize = d < 3.0 ? 2.0 : 1.0;
  float fade = smoothstep(0.0, 1.0, y) * (1.0 - smoothstep(6.5, 9.0, y));
  vC = aColor * fade * (0.45 + 0.35 * uPulse) * (1.0 - smoothstep(20.0, 40.0, d));
}
`;

const SPARK_FRAG = /* glsl */ `
in vec3 vC;
out vec4 fragColor;
void main() {
  if (max(vC.r, max(vC.g, vC.b)) < 0.1) discard;
  fragColor = vec4(vC, 1.0);
}
`;

export function createSparkMaterial(u: HubUniforms): ShaderMaterial {
  return new ShaderMaterial({
    name: 'HubSparks',
    glslVersion: GLSL3,
    vertexShader: SPARK_VERT,
    fragmentShader: SPARK_FRAG,
    uniforms: { uTime: u.uTime, uMotion: u.uMotion, uPulse: u.uPulse },
  });
}

// ---------------------------------------------------------------------------------------------------- Portal

const PORTAL_VERT = /* glsl */ `
${GLSL_SNAP}
out vec2 vUv;
out float vFog;
uniform float uFogNear;
uniform float uFogFar;
void main() {
  vUv = uv;
  vec4 view = viewMatrix * modelMatrix * vec4(position, 1.0);
  vFog = clamp((length(view.xyz) - uFogNear) / max(uFogFar - uFogNear, 1.0), 0.0, 1.0);
  gl_Position = snapClip(projectionMatrix * view);
}
`;

const PORTAL_FRAG = /* glsl */ `
${GLSL_COMMON}
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uBottom;
uniform vec3 uSun;
uniform vec3 uTrim;
uniform vec3 uTrimAlt;
uniform float uMoon;
uniform float uTime;
uniform float uMotion;
uniform float uActive;
uniform float uPulse;
uniform float uAspect;
uniform float uSeed;
in vec2 vUv;
in float vFog;
out vec4 fragColor;
void main() {
  vec2 uv = vUv;
  float t = uTime * uMotion;
  float hz = 0.4;
  vec3 col;
  // Blick in die Welt des Levels: Himmel des Levels, Sonne/Mond, darunter ein laufendes Void-Gitter in Trim-Farbe.
  if (uv.y > hz) {
    float e = (uv.y - hz) / (1.0 - hz);
    col = mix(uHorizon, uTop, pow(e, 0.55));
  } else {
    float d = hz - uv.y;
    float z = 0.22 / max(d, 0.003);
    float x = (uv.x - 0.5) * z * 3.2;
    float zz = z + t * (0.6 + 1.4 * uActive);
    vec2 g = vec2(x, zz);
    vec2 fw = max(fwidth(g), vec2(1e-4));
    vec2 dd = abs(fract(g) - 0.5) / fw;
    float line = step(min(dd.x, dd.y), 0.9) * smoothstep(0.0, 0.05, d);
    col = mix(uHorizon * 0.45, uBottom, smoothstep(0.0, 0.25, d));
    col += uTrim * line * (0.45 + 0.55 * uActive);
  }
  vec2 sp = vec2((uv.x - 0.5) * uAspect, uv.y - hz - 0.13) / 0.17;
  float r = length(sp);
  if (r < 1.0) {
    if (uMoon > 0.5) {
      vec2 m1 = sp - vec2(-0.3, 0.2);
      vec2 m2 = sp - vec2(0.26, -0.22);
      float mare = min(1.0, step(dot(m1, m1), 0.07) + step(dot(m2, m2), 0.04));
      col = uSun * (1.0 - 0.18 * mare) * (1.0 - 0.12 * step(0.82, r));
    } else {
      float depth = 0.25 - sp.y;
      float ph = fract(depth * 5.0 - t * 0.3);
      if (!(depth > 0.0 && ph < clamp(depth * 0.45, 0.0, 0.6))) col = mix(uTrimAlt, uSun, smoothstep(-0.8, 0.6, sp.y));
    }
  } else if (uv.y > hz) {
    col += uSun * 0.18 * (1.0 - smoothstep(1.0, 2.4, r));
  }
  // Energie-Bänder laufen nach oben (Übertragung), stärker beim gewählten Portal.
  float band = step(0.93, fract(uv.y * 3.0 - t * 0.35 + uSeed));
  col += uTrimAlt * band * (0.12 + 0.18 * uActive);
  // Innenkante: 1–2 px Trim-Rahmen, pulst mit der Kick.
  vec2 e2 = min(uv, 1.0 - uv) / max(fwidth(uv), vec2(1e-4));
  float edge = step(min(e2.x, e2.y), 0.5 + uActive);
  col = mix(col, uTrim * (0.9 + 0.4 * uPulse), edge);
  // Nicht gewählt: gedimmt + leichtes Rauschen (Signal schwach).
  float n = hash12(floor(gl_FragCoord.xy) + floor(t * 12.0));
  col *= mix(0.55 + 0.12 * n, 1.0, uActive);
  col = mix(col, vec3(0.35, 0.12, 0.35), vFog * 0.5);
  fragColor = vec4(col, 1.0);
}
`;

export function createPortalMaterial(u: HubUniforms, th: LevelTheme, aspect: number, seed: number): ShaderMaterial {
  return new ShaderMaterial({
    name: 'HubPortal',
    glslVersion: GLSL3,
    vertexShader: PORTAL_VERT,
    fragmentShader: PORTAL_FRAG,
    side: DoubleSide,
    uniforms: {
      uRes: u.uRes,
      uFogNear: u.uFogNear,
      uFogFar: u.uFogFar,
      uTime: u.uTime,
      uMotion: u.uMotion,
      uPulse: u.uPulse,
      uTop: { value: v3(th.skyTop) },
      uHorizon: { value: v3(th.skyHorizon) },
      uBottom: { value: v3(th.skyBottom) },
      uSun: { value: v3(th.sun) },
      uTrim: { value: v3(th.trim) },
      uTrimAlt: { value: v3(th.trimAlt) },
      uMoon: { value: th.moon ? 1 : 0 },
      uActive: { value: 0 },
      uAspect: { value: aspect },
      uSeed: { value: seed },
    },
  });
}

// ---------------------------------------------------------------------------------------------------- Schild (Textur)

const SIGN_VERT = /* glsl */ `
${GLSL_SNAP}
out vec2 vUv;
out float vFog;
uniform float uFogNear;
uniform float uFogFar;
void main() {
  vUv = uv;
  vec4 view = viewMatrix * modelMatrix * vec4(position, 1.0);
  vFog = clamp((length(view.xyz) - uFogNear) / max(uFogFar - uFogNear, 1.0), 0.0, 1.0);
  gl_Position = snapClip(projectionMatrix * view);
}
`;

const SIGN_FRAG = /* glsl */ `
${GLSL_COMMON}
uniform sampler2D uMap;
uniform vec3 uColor;
uniform float uGlow;
uniform float uPulse;
uniform float uTime;
uniform float uMotion;
uniform float uFlicker;
uniform float uTint;
uniform vec3 uFogColor;
in vec2 vUv;
in float vFog;
out vec4 fragColor;
void main() {
  vec4 t = texture(uMap, vUv);
  if (t.a < 0.5) discard;
  vec3 c = mix(t.rgb, t.rgb * uColor, uTint) * (0.7 + 0.45 * uGlow) * mix(1.0, uPulse, 0.6);
  float off = step(0.965, hash12(vec2(floor(uTime * 13.0), uFlicker))) * uFlicker * uMotion;
  c *= 1.0 - 0.75 * off;
  c = mix(c, uFogColor, vFog * 0.5);
  fragColor = vec4(c, 1.0);
}
`;

export interface SignMaterialOpts {
  readonly color: Rgb;
  /** 1 = Textur weiß, wird mit color eingefärbt; 0 = Texturfarben (Logo). */
  readonly tint: number;
  /** >0 = flackert ab und zu (Wert = Zufallssamen). */
  readonly flicker: number;
}

export function createSignMaterial(u: HubUniforms, map: Texture, o: SignMaterialOpts): ShaderMaterial {
  return new ShaderMaterial({
    name: 'HubSign',
    glslVersion: GLSL3,
    vertexShader: SIGN_VERT,
    fragmentShader: SIGN_FRAG,
    side: DoubleSide,
    uniforms: {
      uRes: u.uRes,
      uFogNear: u.uFogNear,
      uFogFar: u.uFogFar,
      uFogColor: u.uFogColor,
      uTime: u.uTime,
      uMotion: u.uMotion,
      uPulse: u.uPulse,
      uMap: { value: map },
      uColor: { value: v3(o.color) },
      uGlow: { value: 0.5 },
      uTint: { value: o.tint },
      uFlicker: { value: o.flicker },
    },
  });
}

// ---------------------------------------------------------------------------------------------------- Post

const POST_VERT = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const POST_FRAG = /* glsl */ `
uniform sampler2D uScene;
uniform vec2 uRes;
uniform float uFade;
out vec4 fragColor;
const float BAYER4[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
void main() {
  ivec2 ip = ivec2(gl_FragCoord.xy);
  vec2 c = (gl_FragCoord.xy - uRes * 0.5) / (uRes.y * 0.5);
  float r = length(c) / length(vec2(uRes.x / uRes.y, 1.0));
  // Wie das Spiel (render/post.ts): 1 px CA am Rand, Vignette, 4-%-Scanlines, 5 Bit + Bayer 4×4.
  float ca = r > 0.86 ? 1.0 : 0.0;
  vec2 dir = length(c) > 1e-4 ? normalize(c) : vec2(0.0);
  ivec2 o = ivec2(round(dir * ca));
  ivec2 mx = ivec2(uRes) - 1;
  vec3 col = vec3(
    texelFetch(uScene, clamp(ip + o, ivec2(0), mx), 0).r,
    texelFetch(uScene, ip, 0).g,
    texelFetch(uScene, clamp(ip - o, ivec2(0), mx), 0).b);
  col *= 1.0 - 0.32 * smoothstep(0.42, 1.05, r);
  if ((ip.y & 1) == 1) col *= 0.96;
  col *= 1.0 - uFade;
  col = clamp(col, 0.0, 1.0);
  float b = (BAYER4[(ip.x & 3) + ((ip.y & 3) << 2)] + 0.5) / 16.0;
  col = floor(col * 31.0 + b) / 31.0;
  fragColor = vec4(col, 1.0);
}
`;

export function createPostMaterial(scene: Texture, res: Vector2): ShaderMaterial {
  return new ShaderMaterial({
    name: 'HubPost',
    glslVersion: GLSL3,
    vertexShader: POST_VERT,
    fragmentShader: POST_FRAG,
    depthTest: false,
    depthWrite: false,
    uniforms: { uScene: { value: scene }, uRes: { value: res }, uFade: { value: 0 } },
  });
}
