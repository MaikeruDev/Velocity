/**
 * Shader der PS2-Front-Door. Farben sind roh (0..1 wie im Hex-Code), es gibt kein Farbraum-Umrechnen —
 * das Low-Res-Bild geht durch einen eigenen Post-Pass (5 Bit + Bayer 4×4 im Low-Res-Raster) direkt auf den Schirm.
 */

const BAYER = /* glsl */ `
float bayer4(vec2 p) {
  vec2 q = mod(floor(p), 4.0);
  // 4×4-Bayer als Formel (kein Array: WebGL1-sicher und billig)
  float a = mod(q.x, 2.0), b = mod(q.y, 2.0), c = floor(q.x / 2.0), d = floor(q.y / 2.0);
  float v = 8.0 * mod(a + b, 2.0) + 4.0 * b + 2.0 * mod(c + d, 2.0) + d;
  return (v + 0.5) / 16.0;
}
`;

/** Gouraud wie die Welt: Hemisphäre + Schlüssellicht + Rim, Glanz je Vertex (facettierte Blitzer). */
export const LIT_VERT = /* glsl */ `
attribute vec3 color;
attribute float aFx;
uniform float uDim;
uniform float uGlow;
uniform float uSpec;
uniform float uTime;
uniform vec3 uRim;
varying vec3 vCol;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 n = normalize(normalMatrix * normal);
  vec3 v = normalize(-mv.xyz);
  vec3 L = normalize(vec3(-0.45, 0.75, 0.55));
  float diff = max(dot(n, L), 0.0);
  float hemi = n.y * 0.5 + 0.5;
  vec3 amb = mix(vec3(0.08, 0.05, 0.17), vec3(0.27, 0.25, 0.42), hemi);
  float ndv = max(dot(n, v), 0.0);
  float rim = pow(1.0 - ndv, 2.0);
  vec3 base = color;
  float spec = pow(max(dot(reflect(-L, n), v), 0.0), 10.0) * uSpec;
  if (aFx > 0.5 && aFx < 1.5) {
    // Datenseite der Disc: Regenbogen über Blickwinkel + Ort — dreht mit, schillert beim Kippen
    float h = ndv * 1.6 + position.x * 2.2 + position.z * 1.4 + uTime * 0.05;
    vec3 rb = 0.5 + 0.5 * cos(6.2831 * (h + vec3(0.0, 0.33, 0.67)));
    base = mix(base, rb, 0.6);
    spec += pow(max(dot(reflect(-L, n), v), 0.0), 6.0) * 0.6;
  }
  vec3 lit = base * (amb + diff * vec3(0.88, 0.84, 0.78)) + spec * vec3(1.0, 0.97, 0.9) + rim * uRim;
  if (aFx > 1.5) lit = base * 1.15;
  // Auswahl: heller + leicht Richtung Weiß; nicht gewählt: abgedunkelt Richtung Nacht-Violett
  lit = mix(vec3(0.03, 0.02, 0.08), lit, uDim) + uGlow * (0.04 + 0.35 * rim) * vec3(0.8, 0.95, 1.0);
  vCol = lit;
  gl_Position = projectionMatrix * mv;
}
`;

export const LIT_FRAG = /* glsl */ `
varying vec3 vCol;
void main() {
  gl_FragColor = vec4(vCol, 1.0);
}
`;

/** Glas-Türme: additiv, Fresnel-Rand hell, unten Licht, mit Entfernung in den Nebel. Instanziert (Farbe je Turm). */
export const GLASS_VERT = /* glsl */ `
attribute vec3 aColor;
uniform float uRise;
uniform float uTime;
uniform float uMirror;
uniform float uDim;
varying vec3 vCol;
void main() {
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  wp.y *= uRise * uMirror;
  vec4 mv = viewMatrix * wp;
  vec3 n = normalize(mat3(viewMatrix) * mat3(modelMatrix) * mat3(instanceMatrix) * normal);
  vec3 v = normalize(-mv.xyz);
  float fres = pow(1.0 - abs(dot(n, v)), 1.5);
  float h = clamp(abs(wp.y) / 14.0, 0.0, 1.0);
  float fog = clamp((-mv.z - 12.0) / 90.0, 0.0, 1.0);
  float shimmer = 0.85 + 0.15 * sin(uTime * 0.7 + wp.x * 0.3 + wp.z * 0.2);
  vCol = aColor * (0.05 + fres * 0.55) * (1.0 - h * 0.65) * (1.0 - fog * 0.85) * shimmer * uDim;
  gl_Position = projectionMatrix * mv;
}
`;

export const GLASS_FRAG = LIT_FRAG;

/** Leucht-Trims an den Turmkronen (wie die Level-Kanten): pulsen mit der Kick. */
export const TRIM_VERT = /* glsl */ `
attribute vec3 aColor;
uniform float uRise;
uniform float uKick;
uniform float uMirror;
uniform float uDim;
varying vec3 vCol;
void main() {
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  wp.y *= uRise * uMirror;
  vec4 mv = viewMatrix * wp;
  float fog = clamp((-mv.z - 12.0) / 90.0, 0.0, 1.0);
  vCol = aColor * (0.75 + 0.6 * uKick) * (1.0 - fog * 0.8) * uRise * uDim;
  gl_Position = projectionMatrix * mv;
}
`;

/** Boden: Void-Gitter in Weltkoordinaten, Ring läuft auf der Kick vom Zentrum weg. */
export const GRID_VERT = /* glsl */ `
varying vec3 vWorld;
varying float vDepth;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vec4 mv = viewMatrix * wp;
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

export const GRID_FRAG = /* glsl */ `
uniform float uRing;
uniform float uFade;
varying vec3 vWorld;
varying float vDepth;
void main() {
  vec2 g = abs(fract(vWorld.xz / 4.0 - 0.5) - 0.5) / fwidth(vWorld.xz / 4.0);
  float line = 1.0 - min(min(g.x, g.y), 1.0);
  float fog = clamp((vDepth - 6.0) / 80.0, 0.0, 1.0);
  // nah gedämpft: unter der Infotafel soll das Gitter nicht flimmern, die Tiefe liest sich trotzdem
  float nearDim = 0.45 + 0.55 * smoothstep(8.0, 30.0, vDepth);
  float r = length(vWorld.xz - vec2(0.0, -30.0));
  // breit und leise: ein Lichtsaum, der langsam über den Boden zieht, kein Blitz
  float fadeR = clamp(uRing / 90.0, 0.0, 1.0);
  float ring = (1.0 - smoothstep(0.0, 6.0, abs(r - uRing))) * smoothstep(0.0, 0.15, fadeR) * (1.0 - fadeR) * 0.55;
  vec3 base = vec3(0.012, 0.008, 0.04);
  vec3 col = base + line * (vec3(0.2, 0.09, 0.4) + ring * vec3(0.2, 0.7, 0.9)) * (1.0 - fog) * nearDim;
  gl_FragColor = vec4(col * uFade, 1.0);
}
`;

/** Himmel als Vollbild-Dreieck hinter allem (Clip-Raum, keine Kamera). */
export const SKY_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.9999, 1.0);
}
`;

export const SKY_FRAG = /* glsl */ `
uniform float uHorizon;
uniform float uCold;
varying vec2 vUv;
void main() {
  float y = vUv.y;
  vec3 top = vec3(0.012, 0.01, 0.045);
  vec3 mid = mix(vec3(0.07, 0.03, 0.17), vec3(0.02, 0.07, 0.16), uCold);
  vec3 glow = mix(vec3(0.30, 0.08, 0.36), vec3(0.06, 0.22, 0.40), uCold);
  float d = y - uHorizon;
  vec3 col = d >= 0.0 ? mix(mid, top, clamp(d / 0.6, 0.0, 1.0)) : mix(mid * 0.55, vec3(0.006, 0.004, 0.02), clamp(-d / 0.35, 0.0, 1.0));
  // Horizont-Streifen: schmal, hart gestuft durch den Post-Pass — kein weicher Bloom
  col += glow * exp(-abs(d) * 16.0) * 0.8;
  col += vec3(0.05, 0.12, 0.2) * exp(-abs(d) * 60.0);
  gl_FragColor = vec4(col, 1.0);
}
`;

/** Partikel: steigen langsam, wickeln oben um, funkeln. Bewegung ganz im Shader (kein CPU-Update je Frame). */
export const DUST_VERT = /* glsl */ `
attribute float aSeed;
uniform float uTime;
uniform float uFade;
varying float vA;
void main() {
  vec3 p = position;
  p.y = mod(p.y + uTime * (0.25 + aSeed * 0.5), 22.0) - 1.0;
  p.x += sin(uTime * 0.2 + aSeed * 40.0) * 0.6;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float fog = clamp((-mv.z - 4.0) / 70.0, 0.0, 1.0);
  vA = (0.35 + 0.65 * (0.5 + 0.5 * sin(uTime * (1.5 + aSeed * 3.0) + aSeed * 90.0))) * (1.0 - fog) * uFade;
  gl_PointSize = aSeed > 0.86 ? 2.0 : 1.0;
  gl_Position = projectionMatrix * mv;
}
`;

export const DUST_FRAG = /* glsl */ `
varying float vA;
void main() {
  gl_FragColor = vec4(vec3(0.55, 0.85, 1.0) * vA, 1.0);
}
`;

/** Halo: gestufte Leuchtringe (der Post-Pass quantisiert, darum keine weiche Glocke auf dem Schirm). */
export const HALO_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const HALO_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uPower;
uniform float uRays;
varying vec2 vUv;
void main() {
  float r = length(vUv - 0.5) * 2.0;
  float a = pow(max(1.0 - r, 0.0), 2.2) * uPower;
  // vier Strahlen (Kreuz) — "Lichtfleck auf der Röhre", hart, dünn
  vec2 q = abs(vUv - 0.5) * 2.0;
  float rays = max(max(0.0, 1.0 - q.y * 40.0) * pow(max(1.0 - q.x, 0.0), 3.0), max(0.0, 1.0 - q.x * 40.0) * pow(max(1.0 - q.y, 0.0), 3.0)) * 0.35 * uPower * uRays;
  gl_FragColor = vec4(uColor * (a + rays), 1.0);
}
`;

/** Logo der Boot-Sequenz: löst sich per Bayer-Schwelle von oben nach unten auf (Screen-Door, kein Blending). */
export const LOGO_VERT = HALO_VERT;

export const LOGO_FRAG = /* glsl */ `
uniform sampler2D tLogo;
uniform float uReveal;
uniform float uFlash;
varying vec2 vUv;
${BAYER}
void main() {
  vec4 t = texture2D(tLogo, vUv);
  float th = bayer4(gl_FragCoord.xy);
  float edge = uReveal * 1.5 - (1.0 - vUv.y) * 0.5;
  if (t.a < 0.5 || th > edge) discard;
  float rim = clamp((edge - th) * 6.0, 0.0, 1.0);
  vec3 c = mix(vec3(1.0), t.rgb, rim);
  gl_FragColor = vec4(c + uFlash, 1.0);
}
`;

/** Post: Abdunkeln (Boot), Vignette, Quantisierung auf 5 Bit mit Bayer 4×4 im Low-Res-Raster. */
export const POST_VERT = SKY_VERT;

export const POST_FRAG = /* glsl */ `
uniform sampler2D tScene;
uniform float uFade;
uniform vec2 uRes;
varying vec2 vUv;
${BAYER}
void main() {
  vec3 c = texture2D(tScene, vUv).rgb * uFade;
  vec2 d = vUv - 0.5;
  d.x *= uRes.x / uRes.y * 0.5;
  c *= 1.0 - dot(d, d) * 0.55;
  float levels = 31.0;
  c = floor(c * levels + bayer4(gl_FragCoord.xy)) / levels;
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;
