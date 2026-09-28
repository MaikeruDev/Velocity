import { Vector2, Vector3 } from 'three';
import type { IUniform } from 'three';

/**
 * Uniforms, die alle Szenen-Materialien teilen. Es sind dieselben Objekt-
 * Instanzen in jedem Material — ein Wert pro Frame setzen reicht, three.js lädt
 * ihn beim nächsten Draw hoch. Keine Allokation pro Frame.
 */
export interface SharedUniforms {
  readonly uTime: IUniform<number>;
  readonly uKick: IUniform<number>;
  readonly uEnergy: IUniform<number>;
  /** Neon-Helligkeit 0.75 + 0.25·kick + etwas energy. */
  readonly uPulse: IUniform<number>;
  /** Low-Res-Auflösung in Pixeln (Snapping, Mindestbreite der Trims). */
  readonly uRes: IUniform<Vector2>;
  readonly uSnap: IUniform<number>;
  readonly uAffine: IUniform<number>;
  readonly uFogColor: IUniform<Vector3>;
  readonly uFogNear: IUniform<number>;
  readonly uFogFar: IUniform<number>;
  readonly uSunDir: IUniform<Vector3>;
  readonly uSunColor: IUniform<Vector3>;
  readonly uAmbSky: IUniform<Vector3>;
  readonly uAmbGround: IUniform<Vector3>;
  /** Lichtwelle nach gutem Hop (RenderFx.landPos/landTime/landPower); Stärke 0 = aus. */
  readonly uLandPos: IUniform<Vector3>;
  readonly uLandTime: IUniform<number>;
  readonly uLandPower: IUniform<number>;
  /** Weich übergeblendete Tempostufe 0..3 (RenderFx.speedTier) und kurzer Aufblitz beim Hochschalten 0..1. */
  readonly uSpeedTier: IUniform<number>;
  readonly uTierFlash: IUniform<number>;
  /** Level-Trim-Farbe (nur diese Trims färbt die Tempostufe um) und Zweitfarbe. */
  readonly uTrimBase: IUniform<Vector3>;
  readonly uTrimAlt: IUniform<Vector3>;
  /** 0..1 Tempo (RenderFx.speed01) und Sekunden seit dem letzten Kick-Einsatz (Void-Gitter-Welle). */
  readonly uSpeed: IUniform<number>;
  readonly uKickAge: IUniform<number>;
}

export function createSharedUniforms(): SharedUniforms {
  return {
    uTime: { value: 0 },
    uKick: { value: 0 },
    uEnergy: { value: 0 },
    uPulse: { value: 0.75 },
    uRes: { value: new Vector2(480, 270) },
    uSnap: { value: 0.5 },
    uAffine: { value: 0.35 },
    uFogColor: { value: new Vector3(0.3, 0.1, 0.3) },
    uFogNear: { value: 900 },
    uFogFar: { value: 4200 },
    uSunDir: { value: new Vector3(0, 1, 0) },
    uSunColor: { value: new Vector3(1, 1, 1) },
    uAmbSky: { value: new Vector3(0.4, 0.4, 0.6) },
    uAmbGround: { value: new Vector3(0.1, 0.05, 0.1) },
    uLandPos: { value: new Vector3() },
    uLandTime: { value: -1e6 },
    uLandPower: { value: 0 },
    uSpeedTier: { value: 0 },
    uTierFlash: { value: 0 },
    uTrimBase: { value: new Vector3(0.2, 0.94, 1) },
    uTrimAlt: { value: new Vector3(1, 0.31, 0.85) },
    uSpeed: { value: 0 },
    uKickAge: { value: 1e6 },
  };
}

/** Vertex-Snapping des Clip-Space auf Pixel-Ecken des Low-Res-Rasters (PS1/PS2-Wackeln, dosiert). */
export const GLSL_SNAP = /* glsl */ `
uniform vec2 uRes;
uniform float uSnap;
vec4 snapClip(vec4 c) {
  // Hinter/nahe der Kamera nicht snappen — Division durch ~0 würde Vertices wegschleudern.
  if (c.w < 0.5 || uSnap <= 0.0) return c;
  vec2 px = (c.xy / c.w * 0.5 + 0.5) * uRes;
  vec2 snapped = floor(px + 0.5);
  px = mix(px, snapped, uSnap);
  return vec4((px / uRes * 2.0 - 1.0) * c.w, c.z, c.w);
}
`;

export const GLSL_FOG = /* glsl */ `
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
float fogFactor(float dist) {
  return clamp((dist - uFogNear) / max(uFogFar - uFogNear, 1.0), 0.0, 1.0);
}
`;

/**
 * Geordnete 4×4-Bayer-Schwelle (0..1) im Low-Res-Pixelraster. Eine Quelle für
 * Post-Quantisierung und Fern-LOD der Welt, damit beide exakt dasselbe Muster rastern.
 */
export const GLSL_BAYER = /* glsl */ `
const float BAYER4[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
float bayer4(ivec2 p) {
  return (BAYER4[(p.x & 3) + ((p.y & 3) << 2)] + 0.5) / 16.0;
}
`;
