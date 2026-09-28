import { DoubleSide, GLSL3, Group, Mesh, ShaderMaterial, Vector3 } from 'three';
import type { IUniform } from 'three';
import { GLSL_BAYER } from '../../materials/shared';
import { VM_PARAM } from '../../types';
import type { ViewModelFrame } from '../../types';
import { annulusGeometry, mergeGeometries, rgb, tubeGeometry } from '../vmGeometry';
import { ScalarUniform, createLitMaterial, createOutlineMaterial, setHexVec } from '../vmMaterials';
import { PROP_OUTLINE } from '../vmBuild';
import type { ItemView, VmBuildCtx } from '../vmBuild';

/**
 * Fidget-Spinner (Plan 007, K5): drei Lappen (Lappen-Profil), drei Chrom-Gewichte, leuchtende
 * Nabe. Achse = z des Gegenstands (zur Kamera, wenn er flach im Pinch liegt). Kanäle (VM_PARAM):
 * Winkel des Rotors (die UI deckelt den angezeigten Schritt gegen Wagenrad-Aliasing), Unschärfe
 * 0..1 (Ring als Bayer-Screen-Door in Körper-/Trim-Farbe, kein Blending) und Nabe −1/0/+1
 * (rot = hinter der Bestzeit, cyan, grün = vorn — Checkpoint-Blinken).
 */

const BODY = 0xff7a1a;
const WEIGHT = 0xd7dde6;
const HUB_BASE = 0x33f0ff;
const HUB_AHEAD = 0x30ff30;
const HUB_BEHIND = 0xff2a3a;

const BLUR_VERT = /* glsl */ `
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const BLUR_FRAG = /* glsl */ `
${GLSL_BAYER}
uniform float uBlur;
uniform vec3 uBody;
uniform vec3 uRimColor;
out vec4 fragColor;
void main() {
  // Screen-Door: Dichte = Unschärfe (kein Blending, look.md).
  if (bayer4(ivec2(gl_FragCoord.xy)) >= uBlur) discard;
  fragColor = vec4(mix(uBody, uRimColor, 0.35), 1.0);
}
`;

export function buildSpinner(ctx: VmBuildCtx): ItemView {
  const L = ctx.light;
  const outline = ctx.track(createOutlineMaterial(L, PROP_OUTLINE, ctx.propPx));
  const lit = ctx.track(createLitMaterial(L, { color: 0xffffff, rim: 0.3, wrap: 0.4, sheen: 0.3, vertexColors: true }));
  const hubMat = ctx.track(createLitMaterial(L, { color: 0x1a3440, rim: 0, wrap: 0.3, emissive: HUB_BASE }));
  const blur: IUniform<number> = new ScalarUniform(0);
  const blurMat = ctx.track(
    new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: BLUR_VERT,
      fragmentShader: BLUR_FRAG,
      side: DoubleSide,
      uniforms: { uBlur: blur, uBody: { value: new Vector3(...rgb(BODY)) }, uRimColor: L.uRimColor },
    }),
  );

  const group = new Group();
  const rotor = new Group();
  group.add(rotor);
  // Körper: drei Lappen + drei Gewichte in EINER Geometrie (ein Mesh + eine Hülle).
  const body = tubeGeometry(
    [
      { y: -0.45, rx: 3.3, rz: 3.3 },
      { y: -0.25, rx: 3.6, rz: 3.6 },
      { y: 0.25, rx: 3.6, rz: 3.6 },
      { y: 0.45, rx: 3.3, rz: 3.3 },
    ],
    36,
    { poleStart: -0.5, poleEnd: 0.5, lobes: { k: 3, depth: 0.62 }, color: rgb(BODY) },
  );
  const parts = [body];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const w = tubeGeometry(
      [
        { y: -0.55, rx: 0.95, rz: 0.95 },
        { y: 0.55, rx: 0.95, rz: 0.95 },
      ],
      10,
      { poleStart: -0.6, poleEnd: 0.6, color: rgb(WEIGHT) },
    );
    w.translate(Math.sin(a) * 2.45, 0, Math.cos(a) * 2.45);
    parts.push(w);
  }
  const rotorGeo = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  rotorGeo.rotateX(Math.PI / 2);
  ctx.part(rotor, rotorGeo, lit, outline, null);
  // Unschärfe-Ring knapp vor der Vorderseite, nur sichtbar ab dem Aliasing-Deckel.
  const ringGeo = ctx.trackGeo(annulusGeometry(1.2, 3.75, 24));
  ringGeo.rotateX(Math.PI / 2);
  const ring = new Mesh(ringGeo, blurMat);
  ring.position.z = 0.62;
  ring.frustumCulled = false;
  ring.visible = false;
  rotor.add(ring);
  // Nabe (Lager) steht still — man hält den Spinner an ihr.
  const hub = tubeGeometry(
    [
      { y: -0.7, rx: 1.0, rz: 1.0 },
      { y: 0.7, rx: 1.0, rz: 1.0 },
    ],
    10,
    { poleStart: -0.75, poleEnd: 0.75 },
  );
  hub.rotateX(Math.PI / 2);
  ctx.part(group, hub, hubMat, outline, null);
  group.visible = false;

  const emis = hubMat.uniforms.uEmissive.value as Vector3;
  const base = setHexVec(new Vector3(), HUB_BASE);
  const ahead = setHexVec(new Vector3(), HUB_AHEAD);
  const behind = setHexVec(new Vector3(), HUB_BEHIND);
  const P = VM_PARAM.spinner;
  return {
    group,
    apply(f: ViewModelFrame): void {
      rotor.rotation.z = f.propParam[P.angle];
      const b = f.propParam[P.blur];
      blur.value = b > 0 ? (b < 1 ? b : 1) : 0;
      ring.visible = blur.value > 0.02;
      const h = f.propParam[P.hub];
      const k = h > 0 ? (h < 1 ? h : 1) : h < 0 ? (h > -1 ? -h : 1) : 0;
      emis.lerpVectors(base, h >= 0 ? ahead : behind, k);
    },
  };
}
