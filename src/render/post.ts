import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  DataTexture,
  GLSL3,
  Mesh,
  NearestFilter,
  NoColorSpace,
  OrthographicCamera,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
} from 'three';
import type { Texture } from 'three';
import { GLSL_BAYER } from './materials/shared';
import type { RenderSettings } from './types';
import { setVecFromHex } from './util';

/**
 * Finaler Pass: Low-Res-Szene → Canvas (ebenfalls Low-Res, CSS skaliert ganzzahlig).
 * Alles per texelFetch auf gl_FragCoord — exakt 1:1 im Pixelraster, kein Filter.
 *
 * Reihenfolge: chromatische Aberration → Vignette → Speed-Streifen → Flash →
 * Fade → Scanlines → Quantisierung mit 4×4-Bayer → HUD (nach der Quantisierung,
 * damit die Schrift nicht zerdithert wird).
 */

const VERT = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAG = /* glsl */ `
${GLSL_BAYER}
uniform sampler2D uScene;
uniform sampler2D uHud;
uniform float uHasHud;
uniform vec2 uRes;
uniform float uTime;
uniform float uSpeed;
uniform float uChromatic;
uniform float uScan;
uniform float uDither;
uniform float uLevels;
uniform float uFlash;
uniform vec3 uFlashColor;
uniform float uFade;
uniform vec3 uStreakColor;
uniform float uStreakGain;
uniform float uKick;
out vec4 fragColor;

vec3 fetchScene(ivec2 p) {
  p = clamp(p, ivec2(0), ivec2(uRes) - 1);
  return texelFetch(uScene, p, 0).rgb;
}

float hash11(float n) {
  return fract(sin(n * 12.9898) * 43758.5453);
}

void main() {
  ivec2 ip = ivec2(gl_FragCoord.xy);
  vec2 c = (gl_FragCoord.xy - uRes * 0.5) / (uRes.y * 0.5);
  float rMax = length(vec2(uRes.x / uRes.y, 1.0));
  float r = length(c) / rMax; // 0 Mitte, 1 Ecke

  // Radiale CA in ganzen Low-Res-Pixeln (Nearest → erst ab 0,5 px sichtbar):
  // Mitte bleibt sauber, am Rand ~chromatic·(0.35 + 1.2·speed), max 2 px.
  float ca = min(uChromatic * (0.35 + uSpeed * 1.2) * 1.3 * pow(r, 1.5), 2.0);
  vec2 dir = length(c) > 1e-4 ? normalize(c) : vec2(0.0);
  ivec2 o = ivec2(round(dir * ca));
  vec3 col = vec3(fetchScene(ip + o).r, fetchScene(ip).g, fetchScene(ip - o).b);

  col *= 1.0 - 0.3 * smoothstep(0.4, 1.05, r);

  // Radiale Speed-Streifen in Trim-Farbe, ab speed01 0.15 (~380 u/s), nach der
  // Vignette (sonst schluckt sie die Ecken). Innen (r < 0.55) nie: Lesbarkeit der
  // nächsten Plattform. 720 Sektoren → am Rand 1–2 Low-Res-Pixel breit. Stärke
  // ~0.24 bei 800 u/s (vorher 0.03 = unter einer 5-Bit-Stufe), Dichte und Länge
  // wachsen mit Tempo, Helligkeit je Streifen verschieden stark mit der Kick.
  float s = smoothstep(0.15, 0.85, uSpeed) * uStreakGain;
  if (s > 0.0 && r > 0.55) {
    float ang = atan(c.y, c.x);
    float id = floor((ang / 6.2831853 + 0.5) * 720.0);
    float h = hash11(id + 7.0);
    if (h > 0.86 - 0.16 * s) {
      float h2 = hash11(id * 1.37 + 3.0);
      float seg = fract(r * 1.2 - uTime * (1.4 + h2 * 2.2) * (0.6 + uSpeed) + h * 17.0);
      float on = step(seg, 0.1 + 0.3 * s) * smoothstep(0.55, 0.75, r);
      float beat = 0.7 + 0.6 * uKick * (0.5 + h2);
      col += uStreakColor * (on * s * 0.3 * beat);
    }
  }

  col += uFlashColor * uFlash * 0.7;
  col *= 1.0 - uFade;
  // Jede 2. Low-Res-Zeile dunkler: scanlines = 1 → 16 %, Default 0.25 → 4 %. Mit
  // 8 % Vollausschlag lag der Default (2 %) unter einer 5-Bit-Stufe (3,2 %) und war
  // praktisch aus (Look-Kritik 003); jetzt ist die ganze Reglerspanne sichtbar.
  if ((ip.y & 1) == 1) col *= 1.0 - uScan * 0.16;

  col = clamp(col, 0.0, 1.0);
  if (uDither > 0.5) {
    col = floor(col * uLevels + bayer4(ip)) / uLevels;
  } else {
    col = floor(col * uLevels + 0.5) / uLevels;
  }

  if (uHasHud > 0.5) {
    ivec2 hs = textureSize(uHud, 0);
    // Oben links ausrichten, falls der HUD-Canvas kurz eine andere Größe hat.
    ivec2 hp = ivec2(ip.x, ip.y - (int(uRes.y) - hs.y));
    if (hp.x >= 0 && hp.y >= 0 && hp.x < hs.x && hp.y < hs.y) {
      vec4 hud = texelFetch(uHud, hp, 0);
      col = mix(col, hud.rgb, hud.a);
    }
  }
  fragColor = vec4(col, 1.0);
}
`;

export interface PostParams {
  time: number;
  speed01: number;
  kick: number;
  flash: number;
  flashColor: readonly [number, number, number];
  fade: number;
}

export class PostPass {
  readonly scene = new Scene();
  readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly material: ShaderMaterial;
  private readonly mesh: Mesh;
  private readonly emptyHud: DataTexture;
  private hudTexture: CanvasTexture | null = null;
  private hudCanvas: HTMLCanvasElement | null = null;
  private hudW = 0;
  private hudH = 0;

  constructor(sceneTexture: Texture) {
    this.emptyHud = new DataTexture(new Uint8Array(4), 1, 1, RGBAFormat);
    this.emptyHud.needsUpdate = true;
    this.material = new ShaderMaterial({
      name: 'PS2Post',
      glslVersion: GLSL3,
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uScene: { value: sceneTexture },
        uHud: { value: this.emptyHud },
        uHasHud: { value: 0 },
        uRes: { value: new Vector2(1, 1) },
        uTime: { value: 0 },
        uSpeed: { value: 0 },
        uChromatic: { value: 0.5 },
        uScan: { value: 0.25 },
        uDither: { value: 1 },
        uLevels: { value: 31 },
        uFlash: { value: 0 },
        uFlashColor: { value: new Vector3(1, 1, 1) },
        uFade: { value: 0 },
        uStreakColor: { value: new Vector3(0.75, 0.95, 1.0) },
        uStreakGain: { value: 1 },
        uKick: { value: 0 },
      },
    });
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.mesh = new Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  setSceneTexture(t: Texture): void {
    this.material.uniforms.uScene.value = t;
  }

  setResolution(w: number, h: number): void {
    (this.material.uniforms.uRes.value as Vector2).set(w, h);
  }

  setSettings(s: RenderSettings): void {
    const u = this.material.uniforms;
    u.uChromatic.value = s.chromatic;
    u.uScan.value = s.scanlines;
    u.uStreakGain.value = Math.max(0, Math.min(1, s.speedLines ?? 1));
    u.uDither.value = s.dither ? 1 : 0;
    const bits = Math.max(1, Math.min(8, Math.round(s.colorBits)));
    u.uLevels.value = (1 << bits) - 1;
  }

  /** Speed-Streifen in der Trim-Farbe des Levels. */
  setStreakColor(hex: string): void {
    setVecFromHex(this.material.uniforms.uStreakColor.value as Vector3, hex);
  }

  setHud(canvas: HTMLCanvasElement | null): void {
    if (canvas === this.hudCanvas) return;
    this.hudCanvas = canvas;
    this.recreateHudTexture();
  }

  private recreateHudTexture(): void {
    this.hudTexture?.dispose();
    this.hudTexture = null;
    const u = this.material.uniforms;
    if (!this.hudCanvas) {
      u.uHud.value = this.emptyHud;
      u.uHasHud.value = 0;
      return;
    }
    const t = new CanvasTexture(this.hudCanvas);
    t.magFilter = NearestFilter;
    t.minFilter = NearestFilter;
    t.generateMipmaps = false;
    t.colorSpace = NoColorSpace;
    t.premultiplyAlpha = false;
    this.hudTexture = t;
    this.hudW = this.hudCanvas.width;
    this.hudH = this.hudCanvas.height;
    u.uHud.value = t;
    u.uHasHud.value = 1;
  }

  /** Pro Frame. HUD-Canvas wird jedes Mal neu hochgeladen (das HUD zeichnet selbst pro Frame). */
  update(p: PostParams): void {
    const u = this.material.uniforms;
    u.uTime.value = p.time;
    u.uSpeed.value = p.speed01;
    u.uKick.value = p.kick;
    u.uFlash.value = p.flash;
    (u.uFlashColor.value as Vector3).set(p.flashColor[0], p.flashColor[1], p.flashColor[2]);
    u.uFade.value = p.fade;
    if (this.hudCanvas) {
      // Größenwechsel → neue Textur (three.js alloziert Texturspeicher unveränderlich).
      if (this.hudCanvas.width !== this.hudW || this.hudCanvas.height !== this.hudH) this.recreateHudTexture();
      if (this.hudTexture) this.hudTexture.needsUpdate = true;
    }
  }

  dispose(): void {
    this.hudTexture?.dispose();
    this.emptyHud.dispose();
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
