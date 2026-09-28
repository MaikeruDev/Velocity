import { FrontSide, GLSL3, ShaderMaterial, Vector4 } from 'three';
import type { MaterialTextures } from '../textures';
import { TEXTURE_SIZE } from '../textures';
import { GLSL_BAYER, GLSL_FOG, GLSL_SNAP } from './shared';
import type { SharedUniforms } from './shared';

/**
 * PS2-Weltmaterial: Gouraud-Licht (Hemisphäre + Sonne) und linearer Fog im
 * VERTEX-Shader, Vertex-Snapping, Mischung aus perspektivischem und affinem
 * Texture-Mapping. Die Tesselierung in ~64-u-Zellen (levelMesh.ts) sorgt
 * dafür, dass Licht/Fog Stützstellen haben und das affine Warping dezent bleibt.
 *
 * Attribute: position, normal, uv (Weltprojektion / 256 u),
 *   aTint  – Brush-Tint × gebackene Variation (wirkt auch auf Emissiv-Texel),
 *   aShade – Fake-AO/Radiosity × Höhentönung (wirkt nur auf beleuchtete Texel),
 *   aTop   – 1 = Oberseiten-Textur, 0 = Seiten-Textur.
 *
 * Ohne Mipmaps (look.md) werden stark verkleinerte Texturen zu Pixelrauschen,
 * das bei Tempo flirrt und Kanten überdeckt. Deshalb wechselt der Fragment-Shader
 * ab ~1,1–2,6 Texeln pro Pixel zur Durchschnittsfarbe der Textur — ein
 * einstufiges "Fern-LOD". Der Übergang wird im Low-Res-Raster per Bayer
 * gedithert (Screen-Door), nicht überblendet: Überblenden wäre de facto
 * lineare Mip-Interpolation und wusch das Muster im Band aus.
 */
const VERT = /* glsl */ `
${GLSL_SNAP}
${GLSL_FOG}
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbSky;
uniform vec3 uAmbGround;
in vec3 aTint;
in vec3 aShade;
in float aTop;
out vec3 vTint;
out vec3 vShade;
out vec2 vUv;
out vec3 vUvW;
out float vFog;
out float vTop;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vec3 n = normalize(mat3(modelMatrix) * normal);
  vec3 amb = mix(uAmbGround, uAmbSky, n.y * 0.5 + 0.5);
  float sun = max(dot(n, uSunDir), 0.0);
  vShade = aShade * (amb * 1.15 + uSunColor * sun);
  vTint = aTint;
  vec4 view = viewMatrix * world;
  vFog = fogFactor(length(view.xyz));
  vec4 clip = snapClip(projectionMatrix * view);
  vUv = uv;
  // uv·w und w perspektivisch interpolieren → Quotient ist bildschirm-linear (affin).
  vUvW = vec3(uv * clip.w, clip.w);
  vTop = aTop;
  gl_Position = clip;
}
`;

const FRAG = /* glsl */ `
${GLSL_BAYER}
uniform sampler2D uTexTop;
uniform sampler2D uTexSide;
uniform vec4 uAvgTop;
uniform vec4 uAvgSide;
uniform float uTexSize;
uniform float uAffine;
uniform float uPulse;
uniform vec3 uFogColor;
in vec3 vTint;
in vec3 vShade;
in vec2 vUv;
in vec3 vUvW;
in float vFog;
in float vTop;
out vec4 fragColor;
void main() {
  vec2 uv = mix(vUv, vUvW.xy / vUvW.z, uAffine);
  vec2 dx = dFdx(uv);
  vec2 dy = dFdy(uv);
  // Geometrisches Mittel beider Achsen: bei flachem Blick auf den Boden ist nur
  // eine Achse stark verkleinert — max() würde das Muster schon auf der nächsten
  // Plattform glattbügeln, min() ließe das Flirren durch.
  float texels = sqrt(sqrt(dot(dx, dx) * dot(dy, dy))) * uTexSize;
  // Jeder Pixel ist entweder Textur oder Mittelwert — der Anteil wächst über das Band.
  float far = step(bayer4(ivec2(gl_FragCoord.xy)), smoothstep(1.1, 2.6, texels));
  bool top = vTop > 0.5;
  vec4 t = top ? texture(uTexTop, uv) : texture(uTexSide, uv);
  if (far > 0.5) t = top ? uAvgTop : uAvgSide;
  // Alpha 128 in der Textur = selbstleuchtend (Markierungen, LEDs).
  float emis = clamp((1.0 - t.a) * 2.0, 0.0, 1.0);
  vec3 base = t.rgb * vTint;
  vec3 c = base * mix(vShade, vec3(0.9 + 0.5 * uPulse), emis);
  c = mix(c, uFogColor, vFog * (1.0 - 0.6 * emis));
  fragColor = vec4(c, 1.0);
}
`;

export function createWorldMaterial(shared: SharedUniforms, tex: MaterialTextures): ShaderMaterial {
  return new ShaderMaterial({
    name: 'PS2World',
    glslVersion: GLSL3,
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: FrontSide,
    uniforms: {
      uRes: shared.uRes,
      uSnap: shared.uSnap,
      uAffine: shared.uAffine,
      uPulse: shared.uPulse,
      uFogColor: shared.uFogColor,
      uFogNear: shared.uFogNear,
      uFogFar: shared.uFogFar,
      uSunDir: shared.uSunDir,
      uSunColor: shared.uSunColor,
      uAmbSky: shared.uAmbSky,
      uAmbGround: shared.uAmbGround,
      uTexTop: { value: tex.top },
      uTexSide: { value: tex.side },
      uAvgTop: { value: new Vector4(...tex.avgTop) },
      uAvgSide: { value: new Vector4(...tex.avgSide) },
      uTexSize: { value: TEXTURE_SIZE },
    },
  });
}
