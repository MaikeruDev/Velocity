import { AdditiveBlending, BufferAttribute, BufferGeometry, DoubleSide, GLSL3, ShaderMaterial } from 'three';
import type { Box3 } from 'three';
import type { CompiledLevel } from '../world/level/compileLevel';
import { GLSL_FOG, GLSL_SNAP } from './materials/shared';
import type { SharedUniforms } from './materials/shared';
import { KIND_COLORS } from './palette';
import { hexToRgb } from './util';

/**
 * Start/Checkpoint/Ziel als additive Lichtsäulen (die vier Seiten der Trigger-
 * Box, nach oben verlängert): schwacher Schleier, dünne nach oben laufende
 * Scanlines, leuchtende Eckkanten und ein kräftiger Fußring, der die Zonengrenze
 * am Boden markiert. Ziel bekommt ein Karo-Band am Fuß.
 *
 * Lesbarkeit geht vor: steht die Kamera in der Zone (Start!), bleiben nur Fußring
 * und Kanten — sonst schaut man durch einen Streifenvorhang auf die nächste Plattform.
 * Nahe Wände blenden zusätzlich aus.
 */

const VERT = /* glsl */ `
${GLSL_SNAP}
${GLSL_FOG}
in vec3 aColor;
in vec4 aLocal;
in vec4 aBounds;
out vec3 vColor;
out vec4 vLocal;
out vec3 vWorld;
out float vFog;
out float vInside;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vColor = aColor;
  vLocal = aLocal;
  vec3 cp = cameraPosition;
  float m = 24.0;
  vInside = (cp.x > aBounds.x - m && cp.x < aBounds.z + m && cp.z > aBounds.y - m && cp.z < aBounds.w + m) ? 1.0 : 0.0;
  vec4 view = viewMatrix * wp;
  vFog = fogFactor(length(view.xyz));
  gl_Position = snapClip(projectionMatrix * view);
}
`;

const FRAG = /* glsl */ `
uniform float uTime;
uniform float uPulse;
in vec3 vColor;
in vec4 vLocal;
in vec3 vWorld;
in float vFog;
in float vInside;
out vec4 fragColor;
void main() {
  // vLocal: x = Position entlang der Seite (u), y = Höhe über Trigger-Boden (u),
  //         z = Seitenlänge (u), w = Säulenhöhe + Art/10 (Art ≥ 3: Luft-Trigger, siehe AIR_KIND)
  float kind = fract(vLocal.w) * 10.0;
  float air = step(2.5, kind);
  kind -= 3.0 * air;
  float height = floor(vLocal.w);
  float h = clamp(vLocal.y / height, 0.0, 1.0);
  // Boden-Säule: hell am Fuß, nach oben weg. Luft-Tor: gleichmäßig — man fliegt irgendwo
  // mittendurch, die Rampe verdeckt per Tiefentest den Teil unter ihrer Fläche.
  float fall = mix((1.0 - h) * (1.0 - h), 0.55, air);

  float veil = fall * 0.075;
  // Dünne Scanlines laufen nach oben; werden sie dichter als ~3 px, bleibt nur der Schleier.
  float sl = vLocal.y / 18.0 - uTime * 1.8;
  float fw = fwidth(sl);
  float line = step(fract(sl), max(fw, 0.1)) * (1.0 - smoothstep(0.2, 0.4, fw));
  float lines = line * fall * 0.12;
  // Senkrechte Eckkanten (mind. 1 px).
  float du = min(vLocal.x, vLocal.z - vLocal.x);
  float edge = step(du, max(1.5, fwidth(vLocal.x) * 1.2)) * (0.12 + 0.3 * fall);
  // Ring an der Zonengrenze (mind. 1 px): am Fuß, beim Luft-Tor oben (der Fuß liegt tief im Void).
  float ringY = mix(vLocal.y, height - vLocal.y, air);
  float ring = step(ringY, max(3.0, fwidth(vLocal.y) * 1.2)) * 0.7;

  float body = veil + lines;
  if (kind > 1.5 && vLocal.y < 48.0) {
    float ch = mod(floor(vLocal.x / 24.0) + floor(vLocal.y / 24.0), 2.0);
    body += ch * 0.14;
  }
  float d = distance(vWorld, cameraPosition);
  // Nah fast weg (Ring + Kanten reichen, die Linien würden die nächste Plattform
  // verschleiern), fern kräftiger: aus der Distanz ist die Säule ein Leuchtfeuer.
  body *= smoothstep(120.0, 800.0, d) * mix(1.0, 2.4, smoothstep(900.0, 2400.0, d));
  float inside = vInside > 0.5 ? 0.0 : 1.0;
  float a = body * inside + edge * mix(0.12, 1.0, inside) + ring;
  a *= 0.75 + 0.3 * uPulse;
  a *= 1.0 - vFog * 0.3;
  fragColor = vec4(vColor * a, 1.0);
}
`;

const KIND_INDEX = { start: 0, checkpoint: 1, finish: 2 } as const;
/** Aufschlag auf KIND_INDEX für Luft-Trigger (Shader: gleichmäßiger Schleier, Ring oben). */
const AIR_KIND = 3;
/** Normale Säulen: so hoch höchstens (u). Höhere Trigger sind Luft-Tore (Surf-Checkpoints). */
const MAX_COLUMN = 640;

/** Boden-Suche unter einem hohen Trigger: Brush-Oberkante so weit unter/über der Trigger-Unterkante. */
const GROUND_BELOW = 16;
const GROUND_ABOVE = 160;

/**
 * Steht der Trigger auf etwas? (Kollidierender Brush mit Oberkante nahe der
 * Trigger-Unterkante, in xz überlappend — z. B. Zielplattform, Landeinsel.)
 */
function grounded(level: CompiledLevel, b: Box3): boolean {
  for (const br of level.brushes) {
    if (!br.collide) continue;
    const top = br.bounds.max.y;
    if (top < b.min.y - GROUND_BELOW || top > b.min.y + GROUND_ABOVE) continue;
    if (br.bounds.max.x > b.min.x && br.bounds.min.x < b.max.x && br.bounds.max.z > b.min.z && br.bounds.min.z < b.max.z) return true;
  }
  return false;
}

/**
 * Höhenband der Säule. Boden-Trigger: ab Unterkante, 192–640 u hoch.
 * Luft-Trigger (höher als MAX_COLUMN und ohne Boden darunter, z. B.
 * Checkpoints um Surf-Übergänge mit Unterkante tief unter den Rampen): die
 * ganze Trigger-Höhe — genau dort fliegt man durch. Ab der Unterkante
 * gezeichnet stünde die Säule unsichtbar im Void.
 */
function columnBand(level: CompiledLevel, b: Box3): { readonly y0: number; readonly height: number; readonly air: boolean } {
  const trigH = b.max.y - b.min.y;
  if (trigH > MAX_COLUMN && !grounded(level, b)) return { y0: b.min.y, height: Math.round(trigH), air: true };
  return { y0: b.min.y, height: Math.round(Math.min(MAX_COLUMN, Math.max(192, trigH * 2.5))), air: false };
}

export function buildTriggerGeometry(level: CompiledLevel): BufferGeometry | null {
  const pos: number[] = [];
  const col: number[] = [];
  const loc: number[] = [];
  const bnd: number[] = [];
  const idx: number[] = [];
  for (const t of level.triggers) {
    if (t.kind === 'kill') continue;
    const c = hexToRgb(KIND_COLORS[t.kind]);
    const b = t.bounds;
    const band = columnBand(level, b);
    const height = band.height;
    const packed = height + (KIND_INDEX[t.kind] + (band.air ? AIR_KIND : 0)) / 10 + 0.01;
    const y0 = band.y0;
    const y1 = band.y0 + height;
    const corners: Array<[number, number]> = [
      [b.min.x, b.min.z],
      [b.max.x, b.min.z],
      [b.max.x, b.max.z],
      [b.min.x, b.max.z],
    ];
    for (let i = 0; i < 4; i++) {
      const [ax, az] = corners[i];
      const [bx, bz] = corners[(i + 1) % 4];
      const len = Math.hypot(bx - ax, bz - az);
      const base = pos.length / 3;
      // Vertikal in 64-u-Zeilen unterteilen, damit der Vertex-Fog Stützstellen hat.
      const rows = Math.max(1, Math.ceil(height / 64));
      for (let r = 0; r <= rows; r++) {
        const y = y0 + ((y1 - y0) * r) / rows;
        pos.push(ax, y, az, bx, y, bz);
        col.push(c[0], c[1], c[2], c[0], c[1], c[2]);
        loc.push(0, y - y0, len, packed, len, y - y0, len, packed);
        bnd.push(b.min.x, b.min.z, b.max.x, b.max.z, b.min.x, b.min.z, b.max.x, b.max.z);
      }
      for (let r = 0; r < rows; r++) {
        const i0 = base + r * 2;
        idx.push(i0, i0 + 1, i0 + 3, i0, i0 + 3, i0 + 2);
      }
    }
  }
  if (pos.length === 0) return null;
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('aColor', new BufferAttribute(new Float32Array(col), 3));
  g.setAttribute('aLocal', new BufferAttribute(new Float32Array(loc), 4));
  g.setAttribute('aBounds', new BufferAttribute(new Float32Array(bnd), 4));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

export function createTriggerMaterial(shared: SharedUniforms): ShaderMaterial {
  return new ShaderMaterial({
    name: 'PS2Trigger',
    glslVersion: GLSL3,
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
    uniforms: {
      uRes: shared.uRes,
      uSnap: shared.uSnap,
      uTime: shared.uTime,
      uPulse: shared.uPulse,
      uFogColor: shared.uFogColor,
      uFogNear: shared.uFogNear,
      uFogFar: shared.uFogFar,
    },
  });
}
