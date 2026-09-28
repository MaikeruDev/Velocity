import { BoxGeometry, DoubleSide, GLSL3, ShaderMaterial, Vector3 } from 'three';
import { GLSL_BAYER, GLSL_FOG, GLSL_SNAP } from './shared';
import type { SharedUniforms } from './shared';

/**
 * Ghost der Bestzeit: die Spieler-Hull (32×72, Ursprung an den Füßen) als
 * Neon-Hologramm. Durchsichtig per Dither-Alpha (Screen-Door im Low-Res-Raster,
 * PS2-typisch, kein Blending → keine Sortierprobleme, schreibt Tiefe):
 * - Kanten 1 Low-Res-Pixel breit und fast deckend (aus jeder Entfernung lesbar),
 * - Flächen zu ~15–26 % mit aufsteigenden Scan-Bändern (Hologramm, nicht Wand),
 * - Visier auf Augenhöhe an der Vorderseite zeigt die Blickrichtung,
 * - nah an der Kamera (< ~180 u) blendet er aus: beim Überholen/Überholtwerden
 *   steht sonst eine Wand im Bild.
 * Beide Seiten gezeichnet: die hinteren Kanten scheinen durch die Löcher der
 * vorderen Fläche — liest sich als Drahtgitter-Box.
 */

export const GHOST_WIDTH = 32;
export const GHOST_HEIGHT = 72;

const VERT = /* glsl */ `
${GLSL_SNAP}
${GLSL_FOG}
out vec3 vLocal;
out float vFog;
out float vNear;
void main() {
  vLocal = position;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vec3 center = (modelMatrix * vec4(0.0, ${GHOST_HEIGHT / 2}.0, 0.0, 1.0)).xyz;
  vNear = smoothstep(56.0, 180.0, distance(cameraPosition, center));
  vec4 view = viewMatrix * w;
  vFog = fogFactor(length(view.xyz));
  gl_Position = snapClip(projectionMatrix * view);
}
`;

const FRAG = /* glsl */ `
${GLSL_BAYER}
uniform vec3 uGhostColor;
uniform vec3 uFogColor;
uniform float uPulse;
uniform float uTime;
uniform float uGhostFill;
in vec3 vLocal;
in float vFog;
in float vNear;
out vec4 fragColor;
const vec3 HALF = vec3(${GHOST_WIDTH / 2}.0, ${GHOST_HEIGHT / 2}.0, ${GHOST_WIDTH / 2}.0);
void main() {
  vec3 p = vLocal - vec3(0.0, HALF.y, 0.0);
  // Abstand zu den drei Flächenpaaren; die eigene Fläche ist ~0, der
  // Kantenabstand ist also der mittlere Wert.
  vec3 d = HALF - abs(p);
  float e = max(min(d.x, d.y), min(max(d.x, d.y), d.z));
  float edge = 1.0 - step(1.0, e / max(fwidth(e), 1e-4));
  // Visier: Band auf Augenhöhe (~64 u) über die Vorderseite (lokal −Z). Nur von vorn —
  // durch die Löcher der Rückseite gesehen las es sich als Zahlenreihe.
  float visor = (gl_FrontFacing ? 1.0 : 0.0) * step(d.z, 0.5) * step(p.z, 0.0) * step(abs(vLocal.y - 61.0), 3.5) * step(abs(p.x), HALF.x - 3.0);
  float band = step(0.45, fract((vLocal.y - uTime * 28.0) / 9.0));
  float alpha = max(max(edge * 0.95, visor * 0.9), uGhostFill * (0.55 + 0.45 * band)) * vNear;
  if (alpha <= bayer4(ivec2(gl_FragCoord.xy))) discard;
  vec3 c = uGhostColor * (0.75 + 0.35 * uPulse);
  c = mix(c, vec3(1.0), max(edge * 0.45, visor * 0.7));
  c = mix(c, uFogColor, vFog * 0.5);
  fragColor = vec4(c, 1.0);
}
`;

export function createGhostGeometry(): BoxGeometry {
  const g = new BoxGeometry(GHOST_WIDTH, GHOST_HEIGHT, GHOST_WIDTH);
  g.translate(0, GHOST_HEIGHT / 2, 0);
  // Nur position wird gebraucht (lokale Koordinaten im Shader).
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  return g;
}

export function createGhostMaterial(shared: SharedUniforms): ShaderMaterial {
  return new ShaderMaterial({
    name: 'PS2Ghost',
    glslVersion: GLSL3,
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: DoubleSide,
    uniforms: {
      uRes: shared.uRes,
      uSnap: shared.uSnap,
      uFogColor: shared.uFogColor,
      uFogNear: shared.uFogNear,
      uFogFar: shared.uFogFar,
      uPulse: shared.uPulse,
      uTime: shared.uTime,
      uGhostColor: { value: new Vector3(1, 0.5, 0.9) },
      uGhostFill: { value: 0.26 },
    },
  });
}
