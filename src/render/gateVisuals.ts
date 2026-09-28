import { AdditiveBlending, BufferAttribute, BufferGeometry, DoubleSide, GLSL3, ShaderMaterial } from 'three';
import type { CompiledLevel } from '../world/level/compileLevel';
import { GLSL_BAYER, GLSL_FOG, GLSL_SNAP } from './materials/shared';
import type { SharedUniforms } from './materials/shared';
import { hexToRgb } from './util';

/**
 * Tore einer Lektion (Plan 007, TU5): additiver Laser-Vorhang in der Tor-Farbe (GateDef.tint, sonst
 * Trim-Farbe des Levels) — schwacher Schleier, nach oben laufende Scanlines, leuchtender Rahmen und
 * ein Schloss in der Mitte großer Flächen. Öffnen: Screen-Door-Auflösen im Low-Res-Raster (Bayer 4×4)
 * mit gateOpen 0 → 1; die Pixel knapp über der Schwelle glühen weiß auf ("Poof", look.md: Pixel-Punkte
 * statt weichem Glow). Bei 1 ist das Tor weg (Mesh unsichtbar, sobald alle offen sind).
 *
 * Ohne Tore baut setLevel nichts — Level ohne Lektion rendern pixelgleich wie vorher.
 */

/** Höchstens so viele Tore je Level im Shader (Plan 007: ≤ 4 je Lektion). */
export const MAX_GATES = 8;
/** Zellgröße der Unterteilung (u): Vertex-Fog braucht Stützstellen wie die Welt (~64 u). */
const CELL = 64;

const VERT = /* glsl */ `
${GLSL_SNAP}
${GLSL_FOG}
in vec3 aColor;
in vec4 aLocal;
in float aGate;
out vec3 vColor;
out vec4 vLocal;
out float vFog;
flat out int vGate;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vColor = aColor;
  vLocal = aLocal;
  vGate = int(aGate + 0.5);
  vec4 view = viewMatrix * wp;
  vFog = fogFactor(length(view.xyz));
  gl_Position = snapClip(projectionMatrix * view);
}
`;

const FRAG = /* glsl */ `
${GLSL_BAYER}
uniform float uTime;
uniform float uPulse;
uniform float uGateOpen[${MAX_GATES}];
in vec3 vColor;
in vec4 vLocal;
in float vFog;
flat in int vGate;
out vec4 fragColor;

// Schloss (gefüllte Formen, keine 1-Texel-Diagonalen — fallen.md #25). p in u relativ zur Mitte.
float lockShape(vec2 p) {
  float body = step(abs(p.x), 17.0) * step(-20.0, p.y) * step(p.y, 4.0);
  // Schlüsselloch: Kreis + Schlitz ausgespart.
  float hole = step(length(p - vec2(0.0, -6.0)), 4.0) + step(abs(p.x), 1.6) * step(-16.0, p.y) * step(p.y, -6.0);
  vec2 q = p - vec2(0.0, 4.0);
  float r = length(q);
  float shackle = step(0.0, q.y) * step(9.0, r) * step(r, 14.0);
  // Bügel-Füße bis zum Körper.
  float legs = step(9.0, abs(p.x)) * step(abs(p.x), 14.0) * step(0.0, q.y) * step(q.y, 4.0);
  return clamp(body * (1.0 - clamp(hole, 0.0, 1.0)) + shackle + legs, 0.0, 1.0);
}

void main() {
  float open = uGateOpen[vGate];
  float b = bayer4(ivec2(gl_FragCoord.xy));
  // Screen-Door: je offener, desto mehr Pixel fehlen — bei 1 ist nichts mehr da.
  if (b < open) discard;
  float u = vLocal.x;
  float v = vLocal.y;
  float W = vLocal.z;
  float H = vLocal.w;
  float veil = 0.12;
  // Scanlines laufen nach oben; dichter als ~3 px bleibt nur der Schleier.
  float sl = v / 16.0 - uTime * 1.2;
  float fw = fwidth(sl);
  float line = step(fract(sl), max(fw, 0.12)) * (1.0 - smoothstep(0.25, 0.5, fw)) * 0.3;
  // Rahmen, mindestens 1 px breit.
  float eu = min(u, W - u);
  float ev = min(v, H - v);
  float edge = max(step(eu, max(3.0, fwidth(u) * 1.5)), step(ev, max(3.0, fwidth(v) * 1.5))) * 0.9;
  // Schloss nur auf Flächen, auf denen es Platz hat; Größe folgt der Flächenhöhe.
  float k = clamp(H / 150.0, 0.7, 1.8);
  float lock = (W > 90.0 && H > 90.0) ? lockShape((vec2(u, v) - vec2(W, H) * 0.5) / k) * 0.75 : 0.0;
  float a = veil + line + max(edge, lock);
  // Beim Auflösen kurz heller (0.25 → ×1.75), damit das Öffnen aus dem Augenwinkel auffällt.
  a *= (0.8 + 0.3 * uPulse) * (1.0 + 3.0 * open * (1.0 - open));
  a *= 1.0 - vFog * 0.5;
  vec3 col = vColor * a;
  // Poof: Pixel knapp über der Schwelle glühen weiß (nur während des Auflösens).
  float burn = open > 0.0 ? step(b, open + 0.19) : 0.0;
  col = mix(col, vec3(1.0), burn * 0.85);
  fragColor = vec4(col, 1.0);
}
`;

/** Vier Seiten + Deckel je Tor, in ~64-u-Zellen unterteilt. null = keine Tore (dann kein Mesh). */
export function buildGateGeometry(level: CompiledLevel, trimColor: string): BufferGeometry | null {
  if (level.gates.length === 0) return null;
  const pos: number[] = [];
  const col: number[] = [];
  const loc: number[] = [];
  const gate: number[] = [];
  const idx: number[] = [];
  const n = Math.min(level.gates.length, MAX_GATES);
  for (let gi = 0; gi < n; gi++) {
    const g = level.gates[gi];
    const c = hexToRgb(g.tint ?? trimColor);
    const b = g.bounds;
    const x0 = b.min.x;
    const x1 = b.max.x;
    const y0 = b.min.y;
    const y1 = b.max.y;
    const z0 = b.min.z;
    const z1 = b.max.z;
    // Fläche: Ursprung o, Richtung a (Breite), Richtung b (Höhe); Punkt = o + a·s + b·t.
    const face = (ox: number, oy: number, oz: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number): void => {
      const W = Math.hypot(ax, ay, az);
      const H = Math.hypot(bx, by, bz);
      if (W < 1e-3 || H < 1e-3) return;
      const cols = Math.max(1, Math.ceil(W / CELL));
      const rows = Math.max(1, Math.ceil(H / CELL));
      const base = pos.length / 3;
      for (let r = 0; r <= rows; r++) {
        const t = r / rows;
        for (let q = 0; q <= cols; q++) {
          const s = q / cols;
          pos.push(ox + ax * s + bx * t, oy + ay * s + by * t, oz + az * s + bz * t);
          col.push(c[0], c[1], c[2]);
          loc.push(W * s, H * t, W, H);
          gate.push(gi);
        }
      }
      for (let r = 0; r < rows; r++) {
        for (let q = 0; q < cols; q++) {
          const i0 = base + r * (cols + 1) + q;
          const i1 = i0 + 1;
          const i2 = i0 + cols + 1;
          const i3 = i2 + 1;
          idx.push(i0, i1, i3, i0, i3, i2);
        }
      }
    };
    face(x0, y0, z0, x1 - x0, 0, 0, 0, y1 - y0, 0); // −Z
    face(x1, y0, z1, x0 - x1, 0, 0, 0, y1 - y0, 0); // +Z
    face(x0, y0, z1, 0, 0, z0 - z1, 0, y1 - y0, 0); // −X
    face(x1, y0, z0, 0, 0, z1 - z0, 0, y1 - y0, 0); // +X
    face(x0, y1, z0, x1 - x0, 0, 0, 0, 0, z1 - z0); // Deckel
  }
  if (pos.length === 0) return null;
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('aColor', new BufferAttribute(new Float32Array(col), 3));
  geo.setAttribute('aLocal', new BufferAttribute(new Float32Array(loc), 4));
  geo.setAttribute('aGate', new BufferAttribute(new Float32Array(gate), 1));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

export function createGateMaterial(shared: SharedUniforms): ShaderMaterial {
  return new ShaderMaterial({
    name: 'PS2Gate',
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
      uGateOpen: { value: new Float32Array(MAX_GATES) },
    },
  });
}

/**
 * RenderFx.gateOpen (0..1 je Tor) in die Uniform kopieren. Rückgabe: ist noch ein Tor sichtbar
 * (< 1)? Fehlt `open`, sind alle zu. Frame-Pfad: kopiert nur Zahlen.
 */
export function applyGateOpen(material: ShaderMaterial, open: Float32Array | undefined, count: number): boolean {
  const u: unknown = material.uniforms.uGateOpen.value;
  if (!(u instanceof Float32Array)) return count > 0;
  let visible = false;
  const n = count < MAX_GATES ? count : MAX_GATES;
  for (let i = 0; i < n; i++) {
    const v = open !== undefined && i < open.length ? open[i] : 0;
    const c = v < 0 ? 0 : v > 1 ? 1 : v;
    u[i] = c;
    if (c < 1) visible = true;
  }
  return visible;
}
