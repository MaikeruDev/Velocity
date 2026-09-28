import { FrontSide, GLSL3, ShaderMaterial } from 'three';
import { GLSL_FOG, GLSL_SNAP } from './shared';
import type { SharedUniforms } from './shared';

/**
 * Emissive Neon-Trims.
 *
 * Attribute: position = Kantenpunkt des Brushs (identisch mit dem Flächen-Vertex
 * der Tesselierung), aLift = kleiner Abstand über/vor der Fläche, aExtrude =
 * Bandrichtung·Breite, aEdge wählt Kanten- (1) oder Innenseite (0).
 *
 * Snapping: Das ganze Band wird starr um den Snap-Versatz des Brush-Vertex
 * verschoben, nicht jeder Band-Vertex einzeln gerundet. Einzeln gerundet rissen
 * Kanten- und Innenvertex eines 0,1-px-Bandes bis 0,5 px auseinander, ohne dass
 * sich ihre Tiefe änderte — das Band lag dann schief zur Fläche und verlor den
 * Tiefentest. Starr verschoben sitzt es exakt auf der gesnappten Silhouette.
 *
 * Mindestbreite: Ist das Band am Bildschirm SENKRECHT zur Kante schmaler als
 * uTrimMinPx, werden die KANTEN-Vertices nach außen über die Silhouette
 * geschoben — nie die Innen-Vertices auf die eigene Fläche. Ein aufgeweiteter
 * Vertex behält seine Tiefe; nach innen landet er über Flächen, die dort
 * (Hinterkante, flacher Blick) zig Units näher sind, und verliert den Tiefentest
 * → die Hinterkante der nächsten Plattform flackerte im Anlauf. Außen liegt nur
 * Hintergrund oder die angrenzende Seitenfläche derselben Kante.
 * Senkrecht messen, nicht entlang der Extrusion: sonst wird das Band bei schräg
 * laufenden Kanten nur Bruchteile eines Pixels breit → Sägezahn/Lücken.
 *
 * Fog wirkt nur zu uTrimFog (30 %) — die Route leuchtet auch in der Ferne.
 *
 * Flow-Feedback (Plan 003, nur hier auf den Trims, damit Flächen ruhig und die
 * nächste Plattform lesbar bleiben):
 * - Tempostufe (uSpeedTier 0..3), zweifarbig: das obere Band (die Kante, die man
 *   liest) wird stufig heißer bis weiß, das Seitenband darunter nimmt die Zweitfarbe
 *   an (Cyan → Magenta-Unterstrich → weiß-heiß). Komplett auf die Zweitfarbe umfärben
 *   (Plan-Vorschlag) kostete in Level 1 20–28 % Kanten-Kontrast (ΔE76 gegen die
 *   Umgebung, tools/shoot-render.mjs --fx r2): Cyan ist dort DIE Gegenfarbe zur
 *   Magenta-/Orange-Welt und zum Gitter. Zweifarbig sind es 5–15 %, die Luma der
 *   Kante steigt ab Stufe 2. Start/Checkpoint/Ziel-Farben sind Signale und bleiben.
 * - Landewelle (uLandPos/-Time/-Power): Lichtring mit 3600 u/s um den Absprungpunkt
 *   eines guten Hops — eine saubere Kette hinterlässt eine leuchtende Spur. Die Welle
 *   hellt auf (weiß-heiß) UND weitet das Band kurz um bis zu uTrimWavePx nach AUSSEN
 *   (wie die Mindestbreite, fallen.md #24): ferne Trims sind nur ~1 px breit, und
 *   Cyan hat bis Weiß nur ~40 % Luma-Reserve — ohne Aufweiten blieb die Welle blass.
 */
const GLSL_LAND_WAVE = /* glsl */ `
uniform float uTime;
uniform vec3 uLandPos;
uniform float uLandTime;
uniform float uLandPower;
// Ring mit 3600 u/s: scharfe Front (64 u), Nachglühen über ~220 u, nach 0.3 s aus —
// erreicht so die nächsten zwei Plattformen (~1000 u); mit 3000 u/s/0.25 s war er
// nach ~600 u verglüht und traf die Sprungziele kaum.
float landWave(vec3 p) {
  float age = uTime - uLandTime;
  if (uLandPower <= 0.0 || age < 0.0 || age >= 0.3) return 0.0;
  float x = age * 3600.0 - distance(p, uLandPos);
  float ring = x < 0.0 ? 1.0 - smoothstep(0.0, 64.0, -x) : exp(-x / 220.0);
  float k = age / 0.3;
  return uLandPower * ring * (1.0 - k * k);
}
`;

const VERT = /* glsl */ `
${GLSL_SNAP}
${GLSL_FOG}
${GLSL_LAND_WAVE}
uniform float uTrimMinPx;
uniform float uTrimWavePx;
uniform float uSpeedTier;
uniform vec3 uTrimBase;
uniform vec3 uTrimAlt;
in vec3 aLift;
in vec3 aExtrude;
in vec3 aOther;
in vec3 aColor;
in float aEdge;
out vec3 vColor;
out float vFog;
out float vEdge;
out vec3 vWorld;
// Stufen 1..3: Oberband Grundfarbe immer heißer, Seitenband Zweitfarbe → weiß.
// t weich (Renderer blendet über), side = 1 für das Band die Seitenfläche hinunter.
vec3 tierColor(vec3 base, float t, float side) {
  // Seitenband aufgehellt: reines Magenta (Luma ~0.5) senkte den Luma-Kontrast der Kante.
  vec3 hot1 = side > 0.5 ? mix(uTrimAlt, vec3(1.0), 0.25) : mix(base, vec3(1.0), 0.3);
  vec3 hot2 = side > 0.5 ? mix(uTrimAlt, vec3(1.0), 0.4) : mix(base, vec3(1.0), 0.5);
  vec3 hot3 = side > 0.5 ? mix(uTrimAlt, vec3(1.0), 0.6) : mix(base, vec3(1.0), 0.75);
  vec3 c = mix(base, hot1, clamp(t, 0.0, 1.0));
  c = mix(c, hot2, clamp(t - 1.0, 0.0, 1.0));
  return mix(c, hot3, clamp(t - 2.0, 0.0, 1.0));
}
vec2 toPx(vec4 c) {
  return (c.xy / c.w * 0.5 + 0.5) * uRes;
}
void main() {
  mat4 vp = projectionMatrix * viewMatrix;
  vec4 wB = modelMatrix * vec4(position, 1.0);
  vec3 wE = wB.xyz + aLift;
  vWorld = aEdge > 0.5 ? wE : wE + aExtrude;
  vec4 cB = vp * wB;
  vec4 cE = vp * vec4(wE, 1.0);
  vec4 cI = vp * vec4(wE + aExtrude, 1.0);
  vec4 clip = aEdge > 0.5 ? cE : cI;
  // Nahe/hinter der Kamera weder snappen noch aufweiten (Division durch ~0).
  if (cB.w > 0.5 && cE.w > 0.5 && cI.w > 0.5) {
    vec2 snap = toPx(snapClip(cB)) - toPx(cB);
    vec2 pE = toPx(cE) + snap;
    vec2 pI = toPx(cI) + snap;
    vec2 px = aEdge > 0.5 ? pE : pI;
    vec4 cO = vp * (modelMatrix * vec4(aOther, 1.0));
    if (aEdge > 0.5 && cO.w > 0.5) {
      vec2 dir = pI - pE;
      // Ungesnappte Kantenrichtung: für beide Teilkanten an einem gemeinsamen
      // Vertex gleich, sonst reißt der Stoß auf. Dass Snapping kurze Teilkanten
      // in der Ferne um bis zu ~30° dreht, deckt die Reserve in uTrimMinPx ab.
      vec2 e = toPx(cO) - toPx(cB);
      float el = length(e);
      if (el > 1e-3) dir -= e * (dot(dir, e) / (el * el));
      float pl = length(dir);
      float push = max(uTrimMinPx - pl, 0.0) + uTrimWavePx * landWave(vWorld);
      if (pl > 1e-6 && push > 0.0) px -= dir / pl * push;
    }
    clip = vec4((px / uRes * 2.0 - 1.0) * clip.w, clip.z, clip.w);
  }
  vFog = fogFactor(length((viewMatrix * vec4(wE, 1.0)).xyz));
  vColor = aColor;
  if (uSpeedTier > 0.0 && distance(aColor, uTrimBase) < 0.01) {
    // Seitenband: Extrusion zeigt die Seitenfläche hinunter (Oberband: in die Fläche).
    float side = step(0.6, -aExtrude.y / max(length(aExtrude), 1e-4));
    vColor = tierColor(aColor, uSpeedTier, side);
  }
  vEdge = aEdge;
  gl_Position = clip;
}
`;

const FRAG = /* glsl */ `
uniform float uPulse;
uniform float uTrimFog;
uniform vec3 uFogColor;
${GLSL_LAND_WAVE}
uniform float uTierFlash;
in vec3 vColor;
in float vFog;
in float vEdge;
in vec3 vWorld;
out vec4 fragColor;
void main() {
  vec3 c = vColor * uPulse;
  // Heller Kern direkt an der Kante: liest sich wie Neonröhre statt wie Farbstreifen.
  c = mix(c, vec3(1.0), vEdge * vEdge * 0.35 * uPulse);
  // Helligkeit pro Fragment (Stützstellen liegen 64 u auseinander, die Front läuft
  // 50 u pro 60-Hz-Frame — pro Vertex spränge der Ring in Stücken), Breite pro Vertex.
  float w = landWave(vWorld);
  if (w > 0.0) c = mix(c, min(vec3(1.0), mix(vColor, vec3(1.0), 0.7) * 1.3), min(1.0, w * 1.4));
  // Hochschalten der Tempostufe: kurzer Aufblitz (~0.1 s).
  if (uTierFlash > 0.0) c = mix(c, vec3(1.0), uTierFlash * 0.6);
  c = mix(c, uFogColor, vFog * uTrimFog);
  fragColor = vec4(c, 1.0);
}
`;

export function createTrimMaterial(shared: SharedUniforms): ShaderMaterial {
  return new ShaderMaterial({
    name: 'PS2Trim',
    glslVersion: GLSL3,
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: FrontSide,
    // Das Band folgt dem Snap-Versatz seines Kantenvertex, die Fläche darunter
    // interpoliert aber zwischen 64 u entfernten, verschieden gesnappten Vertices —
    // der Rest-Versatz ist bei flachem Blick/in der Ferne mehr Tiefe als LIFT. Der
    // Steigungsfaktor deckt ~1 px davon ab, die Units den Rest in der Ferne.
    // Unbedenklich, weil die Bänder einseitig sind: abgewandte Bänder werden
    // gecullt und können nicht vor die Oberseite gezogen werden.
    polygonOffset: true,
    polygonOffsetFactor: -1.5,
    polygonOffsetUnits: -24,
    uniforms: {
      uRes: shared.uRes,
      uSnap: shared.uSnap,
      uPulse: shared.uPulse,
      uFogColor: shared.uFogColor,
      uFogNear: shared.uFogNear,
      uFogFar: shared.uFogFar,
      uTime: shared.uTime,
      uLandPos: shared.uLandPos,
      uLandTime: shared.uLandTime,
      uLandPower: shared.uLandPower,
      uSpeedTier: shared.uSpeedTier,
      uTierFlash: shared.uTierFlash,
      uTrimBase: shared.uTrimBase,
      uTrimAlt: shared.uTrimAlt,
      // 1 px + Reserve für gesnappte, gedrehte Teilkanten (cos 37° · 1.25 = 1 px).
      uTrimMinPx: { value: 1.25 },
      // Zusätzliche Breite (Low-Res-Pixel) auf dem Wellenkamm.
      uTrimWavePx: { value: 2 },
      uTrimFog: { value: 0.3 },
    },
  });
}
