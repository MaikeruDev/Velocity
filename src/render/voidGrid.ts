import { AdditiveBlending, BufferAttribute, BufferGeometry, DoubleSide, GLSL3, Mesh, ShaderMaterial, Vector3 } from 'three';
import type { Scene } from 'three';
import type { EnvironmentDef } from '../world/level/LevelFormat';
import type { SharedUniforms } from './materials/shared';
import { setVecFromHex } from './util';

/**
 * Leuchtendes Gitter tief unten (environment.voidY) — gibt dem Fallen Tiefe
 * und Tempo-Referenz. Die Ebene folgt der Kamera in XZ, die Linien liegen aber
 * im Weltraum (Fragment rechnet mit Weltkoordinaten), also kein "Mitschwimmen".
 * Linien sind genau 1 Low-Res-Pixel breit (fwidth). Wo das Gitter dichter als
 * ~3 px wird, blendet es aus — sonst Moiré am Horizont.
 *
 * Mit Tempo (uSpeed = RenderFx.speed01) atmet es stärker, und auf jeder Kick läuft
 * ein Lichtring vom Spieler weg (3D-Abstand, Start direkt unter ihm). Bei Tempo 0
 * exakt wie vorher.
 */

const HALF = 30000;
const SPACING = 256;

const VERT = /* glsl */ `
uniform float uVoidY;
out vec3 vWorld;
void main() {
  vec3 wp = vec3(position.x + cameraPosition.x, uVoidY, position.z + cameraPosition.z);
  vWorld = wp;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const FRAG = /* glsl */ `
uniform vec3 uGridColor;
uniform float uKick;
uniform float uEnergy;
uniform float uTime;
uniform float uSpacing;
uniform float uFar;
uniform float uSpeed;
uniform float uKickAge;
uniform float uVoidY;
in vec3 vWorld;
out vec4 fragColor;
float lineMask(vec2 g, vec2 fw) {
  vec2 d = abs(fract(g - 0.5) - 0.5) / max(fw, vec2(1e-5));
  return step(min(d.x, d.y), 0.5);
}
void main() {
  vec2 g = vWorld.xz / uSpacing;
  vec2 fw = fwidth(g);
  float density = max(fw.x, fw.y);
  float minor = lineMask(g, fw) * (1.0 - smoothstep(0.14, 0.32, density));
  vec2 gm = g * 0.25;
  vec2 fwm = fw * 0.25;
  float major = lineMask(gm, fwm) * (1.0 - smoothstep(0.14, 0.32, max(fwm.x, fwm.y)));
  float dist = length(vWorld.xz - cameraPosition.xz);
  // Vor der Far-Plane ausblenden, sonst reißt das Gitter dort hart ab.
  float fadeEnd = clamp(uFar * 0.85, 1200.0, 18000.0);
  float fade = 1.0 - smoothstep(fadeEnd * 0.15, fadeEnd, dist);
  // Welle läuft im Takt vom Spieler weg — Gitter "atmet" mit der Kick.
  float wave = 0.5 + 0.5 * sin(dist * 0.004 - uTime * 3.0);
  float pulse = 0.5 + 0.35 * uKick + 0.15 * uEnergy + 0.12 * wave;
  if (uSpeed > 0.0) {
    // Front bei |Höhe über dem Gitter| + 9000 u/s·Alter: beginnt senkrecht unter dem
    // Spieler und erreicht nach einem Beat (0.45 s) den Horizont-Bereich.
    float d3 = length(vWorld - cameraPosition);
    float front = abs(cameraPosition.y - uVoidY) + uKickAge * 9000.0;
    float x = (d3 - front) / 420.0;
    float ring = exp(-x * x) * max(0.0, 1.0 - uKickAge / 0.45);
    pulse += uSpeed * (0.2 * wave + 0.75 * ring);
  }
  float a = max(minor * 0.55, major) * fade * pulse;
  fragColor = vec4(uGridColor * a, 1.0);
}
`;

export class VoidGrid {
  private readonly mesh: Mesh;
  private readonly material: ShaderMaterial;

  constructor(scene: Scene, shared: SharedUniforms) {
    const g = new BufferGeometry();
    g.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-HALF, 0, -HALF, HALF, 0, -HALF, HALF, 0, HALF, -HALF, 0, HALF]), 3),
    );
    g.setIndex([0, 2, 1, 0, 3, 2]);
    this.material = new ShaderMaterial({
      name: 'PS2VoidGrid',
      glslVersion: GLSL3,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
      uniforms: {
        uVoidY: { value: -2000 },
        uGridColor: { value: new Vector3(1, 0.2, 0.8) },
        uSpacing: { value: SPACING },
        uFar: { value: 20000 },
        uKick: shared.uKick,
        uEnergy: shared.uEnergy,
        uTime: shared.uTime,
        uSpeed: shared.uSpeed,
        uKickAge: shared.uKickAge,
      },
    });
    this.mesh = new Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -5;
    scene.add(this.mesh);
  }

  setEnvironment(env: EnvironmentDef): void {
    this.material.uniforms.uVoidY.value = env.voidY;
    setVecFromHex(this.material.uniforms.uGridColor.value as Vector3, env.trimColorAlt ?? env.trimColor);
  }

  /** Pro Frame: Ausblenddistanz an die Far-Plane der Kamera koppeln. */
  update(cameraFar: number): void {
    this.material.uniforms.uFar.value = cameraFar;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
